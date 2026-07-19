/**
 * gateinitiative: Rule Evaluation Engine
 *
 * Evaluates files against parsed gate definitions.
 * Handles glob matching, regex pattern evaluation, and violation reporting.
 *
 * Security note: gate patterns are user-supplied regular expressions executed
 * in-process against file content. A catastrophically backtracking pattern can
 * stall evaluation (ReDoS). Keep patterns simple; the file-size guard below
 * bounds the damage but cannot eliminate it.
 */

import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

/**
 * @typedef {Object} Violation
 * @property {string} gateId - Which gate was violated
 * @property {string} file - File path that violated
 * @property {'block'|'warn'|'info'} severity - Enforcement level
 * @property {string} message - Human-readable explanation
 * @property {number} [line] - Line number of violation (if applicable)
 * @property {string} [match] - The matched content (truncated)
 * @property {string} source - Gate definition source file
 */

/** Skip files larger than this by default (keeps the <60ms eval target honest) */
export const DEFAULT_MAX_FILE_BYTES = 1_048_576; // 1MB

// Filesystems on Windows and macOS are case-insensitive by default;
// Linux is case-sensitive. Glob matching follows the platform.
const GLOB_FLAGS = process.platform === 'win32' || process.platform === 'darwin' ? 'i' : '';

// Compiled-regex caches — patterns repeat on every file event, compiling
// per event is the main cold cost against the performance targets.
const globCache = new Map();
const patternCache = new Map();

/**
 * Minimal glob-to-regex converter (handles common patterns without dependencies)
 * Supports: *, **, ?, {a,b}, [abc]
 * Results are memoized.
 * @param {string} glob - Glob pattern
 * @returns {RegExp}
 */
export function globToRegex(glob) {
  const cached = globCache.get(glob);
  if (cached) return cached;

  let regex = '';
  let i = 0;

  while (i < glob.length) {
    const c = glob[i];

    if (c === '*') {
      if (glob[i + 1] === '*') {
        // ** matches any path segment(s)
        if (glob[i + 2] === '/' || glob[i + 2] === '\\') {
          regex += '(?:.+[\\\\/])?';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
      } else {
        // * matches anything except path separator
        regex += '[^\\\\/]*';
        i++;
      }
    } else if (c === '?') {
      regex += '[^\\\\/]';
      i++;
    } else if (c === '{') {
      // Brace expansion {a,b,c}
      const close = glob.indexOf('}', i);
      if (close === -1) {
        regex += '\\{';
        i++;
      } else {
        const options = glob.slice(i + 1, close).split(',');
        regex += '(?:' + options.map(o => escapeRegex(o)).join('|') + ')';
        i = close + 1;
      }
    } else if (c === '[') {
      const close = glob.indexOf(']', i);
      if (close === -1) {
        regex += '\\[';
        i++;
      } else {
        regex += glob.slice(i, close + 1);
        i = close + 1;
      }
    } else if (c === '/' || c === '\\') {
      regex += '[\\\\/]';
      i++;
    } else {
      regex += escapeRegex(c);
      i++;
    }
  }

  const compiled = new RegExp('^' + regex + '$', GLOB_FLAGS);
  globCache.set(glob, compiled);
  return compiled;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generate a concrete example path from a glob by replacing wildcards and
 * brace options with simple placeholders. Used for coverage checks, not
 * for actual matching.
 * @param {string} glob
 * @returns {string}
 */
export function globToExamplePath(glob) {
  return glob
    .replace(/\*\*/g, 'X')
    .replace(/\*/g, 'X')
    .replace(/\?/g, 'X')
    .replace(/\{([^,}]+)[^}]*\}/g, '$1')
    .replace(/\[[^\]]*\]/g, 'X');
}

/**
 * Heuristic check for patterns that are likely to be vulnerable to
 * catastrophic backtracking (ReDoS). Scans the pattern structurally:
 * flags any group that is repeated (unbounded or with a large/open bound)
 * and itself contains a repeated sub-expression at any nesting depth —
 * the classic (a+)+ / ((ab)+)* / (a{1,50})+ shapes. Also flags long runs
 * of unbounded wildcards. This is intentionally conservative: it warns
 * rather than rejects.
 * @param {string} pattern - Raw pattern string (may include /.../flags wrapper)
 * @returns {boolean}
 */
export function looksUnsafeRegex(pattern) {
  // Strip /.../flags wrapper if present
  const body = pattern.startsWith('/')
    ? pattern.replace(/^\/(.*)\/[a-z]*$/, '$1')
    : pattern;

  // Three or more consecutive .* (unbounded wildcards)
  if (/(\.\*){3,}/.test(body)) return true;

  return hasNestedQuantifier(body);
}

/** Bounded repeats up to this count are considered harmless when nested. */
const SAFE_BOUNDED_REPEAT = 10;

/**
 * Returns true if the quantifier following position `i` in `body` is
 * "dangerous" (unbounded, or a bounded repeat with an open/large upper
 * bound), and the index just past the quantifier. Lazy/possessive suffixes
 * are consumed but do not change the verdict (lazy still backtracks).
 * @param {string} body
 * @param {number} i - Index of the first character after an atom
 * @returns {{dangerous: boolean, end: number}}
 */
function readQuantifier(body, i) {
  const ch = body[i];
  if (ch === '+' || ch === '*') {
    let end = i + 1;
    if (body[end] === '?' || body[end] === '+') end++;
    return { dangerous: true, end };
  }
  if (ch === '?') {
    let end = i + 1;
    if (body[end] === '?') end++;
    return { dangerous: false, end };
  }
  if (ch === '{') {
    const m = /^\{(\d+)(,(\d*)?)?\}/.exec(body.slice(i));
    if (!m) return { dangerous: false, end: i };
    let end = i + m[0].length;
    if (body[end] === '?' || body[end] === '+') end++;
    const hasComma = m[2] !== undefined;
    const upper = m[3] === undefined || m[3] === '' ? Infinity : Number(m[3]);
    const max = hasComma ? upper : Number(m[1]);
    return { dangerous: max > SAFE_BOUNDED_REPEAT, end };
  }
  return { dangerous: false, end: i };
}

/**
 * Structural scan for a repeated group that contains a repeated
 * sub-expression at any depth (e.g. (a+)+, ((ab)+)*, (\w{2,})+ ).
 * Character classes and escapes are skipped so `[+*]` never false-positives.
 * @param {string} body - Regex source without /.../flags wrapper
 * @returns {boolean}
 */
function hasNestedQuantifier(body) {
  // Stack of group states: for each open group, whether a dangerous
  // quantifier has been seen anywhere inside it (at any depth).
  const stack = [];
  let i = 0;

  while (i < body.length) {
    const ch = body[i];

    if (ch === '\\') {
      i += 2;
      const q = readQuantifier(body, i);
      i = q.end;
      if (q.dangerous && stack.length > 0) {
        stack[stack.length - 1].sawDangerous = true;
      }
      continue;
    }

    if (ch === '[') {
      // Skip character class ([] contents can't nest quantifiers)
      i++;
      if (body[i] === '^') i++;
      if (body[i] === ']') i++; // leading ] is a literal
      while (i < body.length && body[i] !== ']') {
        if (body[i] === '\\') i++;
        i++;
      }
      i++; // consume closing ]
      const q = readQuantifier(body, i);
      i = q.end;
      if (q.dangerous && stack.length > 0) {
        stack[stack.length - 1].sawDangerous = true;
      }
      continue;
    }

    if (ch === '(') {
      stack.push({ sawDangerous: false });
      // Skip group-type prefix: (?:, (?=, (?!, (?<name>, (?<=, (?<!
      i++;
      if (body[i] === '?') {
        i++;
        if (body[i] === '<' && body[i + 1] !== '=' && body[i + 1] !== '!') {
          // Named group — skip to closing >
          while (i < body.length && body[i] !== '>') i++;
          i++;
        } else {
          i++; // :, =, !, or < of lookbehind (next char handled in loop)
        }
      }
      continue;
    }

    if (ch === ')') {
      const state = stack.pop();
      i++;
      const q = readQuantifier(body, i);
      i = q.end;
      if (state) {
        if (q.dangerous && state.sawDangerous) return true;
        const inner = q.dangerous || state.sawDangerous;
        if (inner && stack.length > 0) {
          stack[stack.length - 1].sawDangerous = true;
        }
      }
      continue;
    }

    // Plain atom — check if it's quantified
    i++;
    const q = readQuantifier(body, i);
    i = q.end;
    if (q.dangerous && stack.length > 0) {
      stack[stack.length - 1].sawDangerous = true;
    }
  }

  return false;
}

/**
 * Check if a file path matches a gate's trigger glob
 * @param {string} filePath - Relative file path
 * @param {string} triggerGlob - Gate trigger pattern
 * @returns {boolean}
 */
export function matchesTrigger(filePath, triggerGlob) {
  // Normalize separators
  const normalized = filePath.replace(/\\/g, '/');
  return globToRegex(triggerGlob).test(normalized);
}

/**
 * Check if a file path matches any of the exclude globs
 * @param {string} filePath - Relative file path
 * @param {string[]} excludeGlobs - Patterns to exclude
 * @returns {boolean}
 */
export function matchesExclude(filePath, excludeGlobs) {
  if (!excludeGlobs || excludeGlobs.length === 0) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return excludeGlobs.some(glob => globToRegex(glob).test(normalized));
}

/**
 * Compile a gate pattern string to a RegExp.
 * Accepts: /pattern/flags or plain string (treated as literal).
 * Results (including failures) are memoized.
 * @param {string} pattern
 * @returns {RegExp|null} - null when the regex is invalid
 */
export function compilePattern(pattern) {
  if (patternCache.has(pattern)) return patternCache.get(pattern);

  let compiled = null;
  try {
    const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
    if (regexMatch) {
      // Strip 'g' — stateful lastIndex breaks repeated .test()/.match() calls
      compiled = new RegExp(regexMatch[1], regexMatch[2].replace(/g/g, ''));
    } else {
      compiled = new RegExp(escapeRegex(pattern));
    }
  } catch {
    compiled = null;
  }

  patternCache.set(pattern, compiled);
  return compiled;
}

/**
 * Return the 1-based line number for a character index in a string.
 * @param {string} content
 * @param {number} index
 * @returns {number}
 */
function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Evaluate a single gate against file content
 * @param {import('./parser.mjs').Gate} gate - Gate definition
 * @param {string} content - File content
 * @param {string} filePath - File path (relative)
 * @returns {Violation|null} - Violation if gate is violated, null if passes
 */
export function evaluateGate(gate, content, filePath) {
  // Pattern match: violation if regex IS found in content
  if (gate.pattern) {
    const regex = compilePattern(gate.pattern);
    if (!regex) return null; // Invalid regex (parser warns at load time)

    // If the regex carries the `s` (dotAll) flag, match against the whole file
    // so multi-line patterns work; otherwise match per-line for crisp line numbers.
    if (regex.flags.includes('s')) {
      const match = regex.exec(content);
      if (match) {
        return {
          gateId: gate.id,
          file: filePath,
          severity: gate.severity,
          message: gate.message,
          line: lineNumberAt(content, match.index),
          match: truncate(match[0], 60),
          source: gate.source,
          overridable: gate.overridable,
        };
      }
    } else {
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(regex);
        if (match) {
          return {
            gateId: gate.id,
            file: filePath,
            severity: gate.severity,
            message: gate.message,
            line: i + 1,
            match: truncate(match[0], 60),
            source: gate.source,
            overridable: gate.overridable,
          };
        }
      }
    }
  }

  // Antipattern match: violation if regex is NOT found in content
  if (gate.antipattern) {
    const regex = compilePattern(gate.antipattern);
    if (!regex) return null;

    if (!regex.test(content)) {
      return {
        gateId: gate.id,
        file: filePath,
        severity: gate.severity,
        message: gate.message,
        line: null,
        match: null,
        source: gate.source,
        overridable: gate.overridable,
      };
    }
  }

  return null; // Gate passes
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

/**
 * Filter gates down to those whose trigger/exclude apply to a file
 * @param {import('./parser.mjs').Gate[]} gates
 * @param {string} relPath - Project-relative path
 * @returns {import('./parser.mjs').Gate[]}
 */
export function applicableGates(gates, relPath) {
  return gates.filter(gate => {
    if (!matchesTrigger(relPath, gate.trigger)) return false;
    if (matchesExclude(relPath, gate.exclude)) return false;
    return true;
  });
}

/**
 * Evaluate all gates against already-read file content (no I/O).
 * @param {import('./parser.mjs').Gate[]} gates - All loaded gates
 * @param {string} content - File content
 * @param {string} relPath - Project-relative path
 * @returns {Violation[]}
 */
export function evaluateContent(gates, content, relPath) {
  const violations = [];
  for (const gate of applicableGates(gates, relPath)) {
    const violation = evaluateGate(gate, content, relPath);
    if (violation) violations.push(violation);
  }
  return violations;
}

/**
 * Heuristic binary check: NUL byte in the first 8KB
 * @param {string} content
 * @returns {boolean}
 */
export function looksBinary(content) {
  return content.slice(0, 8192).includes('\0');
}

/**
 * Read a file for evaluation, applying size and binary guards.
 * @param {string} filePath - Absolute path
 * @param {number} [maxBytes]
 * @returns {Promise<string|null>} - Content, or null when skipped/missing
 */
export async function readFileGuarded(filePath, maxBytes = DEFAULT_MAX_FILE_BYTES) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return null; // Deleted between event and evaluation
  }
  if (!fileStat.isFile() || fileStat.size > maxBytes) return null;

  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
    throw err;
  }

  if (looksBinary(content)) return null;
  return content;
}

/**
 * Evaluate all gates against a single file
 * @param {import('./parser.mjs').Gate[]} gates - All loaded gates
 * @param {string} filePath - Absolute path to the changed file
 * @param {string} projectRoot - Project root for relative path calculation
 * @param {Object} [options]
 * @param {number} [options.maxFileBytes] - Skip files larger than this
 * @returns {Promise<Violation[]>}
 */
export async function evaluateFile(gates, filePath, projectRoot, options = {}) {
  const relPath = relative(resolve(projectRoot), resolve(filePath)).replace(/\\/g, '/');

  if (applicableGates(gates, relPath).length === 0) return [];

  const content = await readFileGuarded(filePath, options.maxFileBytes);
  if (content === null) return [];

  return evaluateContent(gates, content, relPath);
}

/**
 * Evaluate all gates against multiple files (batch mode / --check).
 * Concurrency is bounded to avoid EMFILE on large repositories.
 * @param {import('./parser.mjs').Gate[]} gates
 * @param {string[]} filePaths - Absolute paths
 * @param {string} projectRoot
 * @param {Object} [options]
 * @param {number} [options.concurrency=16]
 * @param {number} [options.maxFileBytes]
 * @returns {Promise<Violation[]>}
 */
export async function evaluateFiles(gates, filePaths, projectRoot, options = {}) {
  const concurrency = options.concurrency || 16;
  const results = [];
  let index = 0;

  async function worker() {
    while (index < filePaths.length) {
      const fp = filePaths[index++];
      results.push(await evaluateFile(gates, fp, projectRoot, options));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, filePaths.length) }, worker));
  return results.flat();
}

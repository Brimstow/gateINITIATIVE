// gateinitiative: Gate Definition Parser
//
// Extracts machine-parseable gate definitions from markdown files.
// Gates are defined in fenced code blocks with `yaml gate` or `gate` language identifier,
// OR in dedicated .gates.yml files. Parsing is delegated to the `yaml` package
// (spec-compliant, zero transitive dependencies).
//
// Gate Definition Format (in markdown):
//
//   ```gate
//   id: no-secrets-in-source
//   trigger: "src/**/*.{ts,js,env,json}"
//   severity: block
//   pattern: /(sk-|pk_live_|AKIA[A-Z0-9]{16})/
//   message: "Potential secret/API key detected"
//   ```

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { compilePattern, looksUnsafeRegex } from './evaluator.mjs';

/**
 * @typedef {Object} Gate
 * @property {string} id - Unique gate identifier
 * @property {string} trigger - Glob pattern for files this gate applies to
 * @property {'block'|'warn'|'info'} severity - Enforcement level
 * @property {string} [pattern] - Regex pattern to search for (violation if found)
 * @property {string} [antipattern] - Regex pattern required to be present (violation if absent)
 * @property {string} message - Human-readable violation message
 * @property {string} [source] - File this gate was parsed from
 * @property {string[]} [exclude] - Glob patterns to exclude
 */

/**
 * @callback WarnFn
 * @param {string} message - Diagnostic message about a skipped/invalid definition
 */

const noop = () => {};

/**
 * Validate and normalize a raw parsed object into a Gate.
 * Reports the reason via onWarn when a definition is rejected,
 * so typos never silently disable a rule.
 * @param {Object} raw - Parsed YAML object
 * @param {string} sourceFile - Where it came from
 * @param {WarnFn} [onWarn]
 * @returns {Gate|null}
 */
function normalizeGate(raw, sourceFile, onWarn = noop) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const keys = Object.keys(raw);
  if (keys.length === 1 && keys[0] === 'version') return null;

  const gate = { ...raw, source: sourceFile };
  const label = gate.id ? `gate "${gate.id}"` : 'gate <missing id>';

  const missing = ['id', 'trigger', 'severity', 'message'].filter(f => !gate[f]);
  if (missing.length > 0) {
    onWarn(`${sourceFile}: ${label} skipped — missing required field(s): ${missing.join(', ')}`);
    return null;
  }

  if (!['block', 'warn', 'info'].includes(gate.severity)) {
    onWarn(`${sourceFile}: ${label} has invalid severity "${gate.severity}" — defaulting to "warn"`);
    gate.severity = 'warn';
  }

  if (gate.overridable === undefined) {
    gate.overridable = true;
  } else {
    gate.overridable = Boolean(gate.overridable);
  }

  if (!gate.pattern && !gate.antipattern) {
    onWarn(`${sourceFile}: ${label} skipped — needs a "pattern" or "antipattern"`);
    return null;
  }

  for (const field of ['pattern', 'antipattern']) {
    if (gate[field] !== undefined) {
      gate[field] = String(gate[field]);
      if (compilePattern(gate[field]) === null) {
        onWarn(`${sourceFile}: ${label} skipped — invalid regex in "${field}": ${gate[field]}`);
        return null;
      }
      // 1.7: warn on patterns that look vulnerable to catastrophic backtracking
      if (looksUnsafeRegex(gate[field])) {
        onWarn(`${sourceFile}: ${label} "${field}" may be vulnerable to ReDoS (catastrophic backtracking): ${gate[field]}`);
      }
    }
  }

  if (gate.exclude !== undefined && !Array.isArray(gate.exclude)) {
    gate.exclude = [String(gate.exclude)];
  }

  gate.trigger = String(gate.trigger);
  gate.message = String(gate.message);

  // 2.8: brace expansion currently treats options as regex-escaped literals,
  // so `{src/**,lib/**}` silently matches nothing. Warn the user.
  const braceWithWildcards = gate.trigger.match(/\{[^}]*[*?][^}]*\}/);
  if (braceWithWildcards) {
    onWarn(`${sourceFile}: ${label} trigger brace option contains a wildcard — brace options are literal-only today: ${braceWithWildcards[0]}`);
  }

  return gate;
}

/**
 * Parse YAML content that may contain multiple `---`-separated documents
 * into plain objects, reporting parse errors via onWarn.
 * @param {string} content
 * @param {string} sourceFile
 * @param {WarnFn} [onWarn]
 * @returns {Object[]}
 */
export function parseYamlDocuments(content, sourceFile, onWarn = noop) {
  const objects = [];
  let docs;
  try {
    docs = parseAllDocuments(content);
  } catch (err) {
    onWarn(`${sourceFile}: YAML parse failure — ${err.message}`);
    return objects;
  }

  for (const doc of docs) {
    if (doc.errors && doc.errors.length > 0) {
      onWarn(`${sourceFile}: YAML error — ${doc.errors[0].message.split('\n')[0]}`);
      continue;
    }
    const obj = doc.toJS();
    if (obj !== null && obj !== undefined) objects.push(obj);
  }

  return objects;
}

/**
 * Parse a single gate code block content into a Gate object
 * @param {string} content - Raw YAML content from a gate code block
 * @param {string} sourceFile - Path of the markdown file containing this gate
 * @param {WarnFn} [onWarn]
 * @returns {Gate|null}
 */
export function parseGateBlock(content, sourceFile, onWarn = noop) {
  const objects = parseYamlDocuments(content, sourceFile, onWarn);
  if (objects.length === 0) return null;
  return normalizeGate(objects[0], sourceFile, onWarn);
}

/**
 * Extract all gate blocks from a markdown file's content
 * @param {string} markdown - Markdown file content
 * @param {string} filePath - Path of the file (for source tracking)
 * @param {WarnFn} [onWarn]
 * @returns {Gate[]}
 */
export function extractGates(markdown, filePath, onWarn = noop) {
  const gates = [];

  // Match fenced code blocks with gate language identifier
  // Supports: ```gate, ```yaml gate, ```gates
  const gateBlockRegex = /```(?:yaml\s+)?gates?\s*\r?\n([\s\S]*?)```/g;
  let match;

  while ((match = gateBlockRegex.exec(markdown)) !== null) {
    for (const obj of parseYamlDocuments(match[1], filePath, onWarn)) {
      const gate = normalizeGate(obj, filePath, onWarn);
      if (gate) gates.push(gate);
    }
  }

  return gates;
}

/**
 * Load gates from a gatefile (dedicated .gates.yml or .gates.yaml)
 * @param {string} content - File content
 * @param {string} filePath - Path of the file
 * @param {WarnFn} [onWarn]
 * @returns {Gate[]}
 */
export function extractGatesFromYaml(content, filePath, onWarn = noop) {
  const gates = [];
  for (const obj of parseYamlDocuments(content, filePath, onWarn)) {
    const gate = normalizeGate(obj, filePath, onWarn);
    if (gate) gates.push(gate);
  }
  return gates;
}

/**
 * Recursively find and load all gates from a directory
 * @param {string} dir - Directory to scan for gate definitions
 * @param {WarnFn} [onWarn]
 * @param {Object} [options]
 * @param {boolean} [options.anyYaml=false] - Treat every .yml/.yaml file as a gate file
 *   (used for the dedicated .gates/ directory)
 * @returns {Promise<Gate[]>}
 */
export async function loadGatesFromDirectory(dir, onWarn = noop, options = {}) {
  const gates = [];
  const resolvedDir = resolve(dir);

  let entries;
  try {
    entries = await readdir(resolvedDir, { withFileTypes: true, recursive: true });
  } catch (err) {
    if (err.code === 'ENOENT') return gates;
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const fullPath = join(entry.parentPath || entry.path, entry.name);
    const ext = extname(entry.name);

    try {
      if (ext === '.md') {
        const content = await readFile(fullPath, 'utf-8');
        gates.push(...extractGates(content, fullPath, onWarn));
      } else if (entry.name.match(/\.gates\.(ya?ml)$/) || (options.anyYaml && /\.(ya?ml)$/.test(entry.name))) {
        const content = await readFile(fullPath, 'utf-8');
        gates.push(...extractGatesFromYaml(content, fullPath, onWarn));
      }
    } catch (err) {
      // Skip files we can't read
      if (err.code !== 'EACCES') throw err;
    }
  }

  return gates;
}

/**
 * Load gates from the default locations in a project
 * @param {string} projectRoot - Project root directory
 * @param {Object} [options]
 * @param {WarnFn} [options.onWarn] - Receives diagnostics for invalid/skipped gates
 * @returns {Promise<Gate[]>}
 */
export async function loadProjectGates(projectRoot, options = {}) {
  const onWarn = options.onWarn || noop;
  const gates = [];
  const root = resolve(projectRoot);

  // Priority loading order:
  // 1. docs/agents/*.md (primary gate source)
  // 2. .gates/ directory (dedicated gate files)
  // 3. Root .gates.yml (project-level overrides)

  const dirGates = [
    ...(await loadGatesFromDirectory(join(root, 'docs', 'agents'), onWarn)),
    ...(await loadGatesFromDirectory(join(root, '.gates'), onWarn, { anyYaml: true })),
  ];

  // Also check for root gatefile — root definitions override directory gates
  let rootGates = [];
  let rootSource = null;
  for (const name of ['.gates.yml', '.gates.yaml', 'gates.yml']) {
    try {
      const content = await readFile(join(root, name), 'utf-8');
      rootSource = join(root, name);
      rootGates = extractGatesFromYaml(content, rootSource, onWarn);
      break;
    } catch { /* not found, try next */ }
  }

  // 1.6: root .gates.yml wins on duplicate ids — later definitions override earlier ones
  const combined = [...dirGates, ...rootGates];
  const byId = new Map();
  for (const gate of combined) {
    if (byId.has(gate.id)) {
      const previous = byId.get(gate.id);
      onWarn(`${previous.source}: gate id "${gate.id}" overridden by ${gate.source}`);
    }
    byId.set(gate.id, gate);
  }
  return Array.from(byId.values());
}

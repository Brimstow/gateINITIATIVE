// gateinitiative: Context Load Detector
//
// Watches file changes and emits context recommendations based on
// file path patterns. Maps the AGENTS.md "Context Enhancement" table
// into machine-enforceable, real-time detection.
//
// This module provides a SECOND trigger type alongside violation gates:
//   - Gates: "this file violates a rule" → alert/revert
//   - Context: "this file change implies you need X loaded" → signal

import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { globToRegex } from './evaluator.mjs';
import { parseYamlDocuments } from './parser.mjs';
import { getStateSecret, readVerifiedState } from './playbook-state.mjs';

/**
 * @typedef {Object} ContextRule
 * @property {string} id - Rule identifier
 * @property {string[]} filePatterns - Glob patterns that trigger this context
 * @property {string[]} keywords - Content keywords that trigger this context
 * @property {string} contextFile - The doc to recommend loading
 * @property {string} description - What this context provides
 * @property {string} [source] - Where the rule was defined
 * @property {boolean} [enforce] - If true, this rule is mandatory (not just advisory)
 * @property {'block'|'warn'|'info'} [severity] - Enforcement severity (default: 'warn')
 * @property {number} [ttl] - TTL in seconds for state_key freshness (default: 3600)
 */

/**
 * @typedef {Object} ContextSignal
 * @property {string} contextFile - Recommended file to load
 * @property {string} reason - Why this context is recommended
 * @property {string} trigger - What triggered it (file path or keyword)
 * @property {'file'|'content'} matchType - How it was triggered
 * @property {number} confidence - 0-1 confidence score
 * @property {boolean} [enforce] - Whether this signal is mandatory
 * @property {'block'|'warn'|'info'} [severity] - Enforcement severity
 * @property {number} [ttl] - TTL in seconds for enforcement check
 */

/**
 * Default context rules derived from a standard AGENTS.md Context Enhancement table.
 * These can be overridden or extended via ```context blocks in markdown.
 * @returns {ContextRule[]}
 */
export function getDefaultContextRules() {
  // Universal scaffolding only. Project-specific rules belong in onboarding-generated
  // output (Phase 4) or markdown ```context blocks, not hard-coded defaults.
  return [
    {
      id: 'testing-conventions',
      filePatterns: ['**/*.test.*', '**/*.spec.*', '**/tests/**', '**/__tests__/**'],
      keywords: ['describe(', 'it(', 'test(', 'expect(', 'jest', 'vitest'],
      contextFile: 'docs/agents/testing-conventions.md',
      description: 'Testing conventions hub — unit, integration, e2e, security test guidance',
    },
    {
      id: 'authentication',
      filePatterns: ['**/auth/**', '**/middleware/auth*', '**/login*', '**/session*', '**/token*', '**/password*'],
      keywords: ['jwt', 'bcrypt', 'cookie', 'session', 'refreshToken', 'authenticate'],
      contextFile: 'docs/agents/authentication.md',
      description: 'Authentication and session security guidance',
    },
    {
      id: 'security-sensitive',
      filePatterns: ['**/cors*', '**/helmet*', '**/csp*', '**/upload*', '**/payment*', '**/stripe*', '**/webhook*'],
      keywords: ['cors(', 'helmet(', 'Content-Security-Policy', 'upload', 'stripe', 'webhook', 'secret'],
      contextFile: 'docs/agents/security-sensitive.md',
      description: 'Security-sensitive areas: auth, uploads, payments, CORS/CSP',
    },
  ];
}

/**
 * Parse context rules from a markdown ```context block
 * 
 * Format:
 * ```context
 * id: my-context
 * filePatterns: ["src/auth/**", "**\/login*"]
 * keywords: ["jwt", "token"]
 * contextFile: docs/agents/authentication.md
 * description: Auth context
 * ```
 * 
 * @param {string} content - Block content
 * @param {string} sourceFile - Source file path
 * @returns {ContextRule|null}
 */
export function parseContextBlock(content, sourceFile, onWarn = () => {}) {
  const objects = parseYamlDocuments(content, sourceFile, onWarn);
  if (objects.length === 0) return null;
  return normalizeContextRule(objects[0], sourceFile, onWarn);
}

/**
 * Validate and normalize a raw parsed object into a ContextRule
 * @param {Object} raw
 * @param {string} sourceFile
 * @param {(msg: string) => void} [onWarn]
 * @returns {ContextRule|null}
 */
function normalizeContextRule(raw, sourceFile, onWarn = () => {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const rule = { ...raw, source: sourceFile };

  if (!rule.id || !rule.contextFile) {
    onWarn(`${sourceFile}: context rule skipped — "id" and "contextFile" are required`);
    return null;
  }

  // Normalize arrays
  if (typeof rule.filePatterns === 'string') rule.filePatterns = [rule.filePatterns];
  if (typeof rule.keywords === 'string') rule.keywords = [rule.keywords];
  if (!Array.isArray(rule.filePatterns)) rule.filePatterns = [];
  if (!Array.isArray(rule.keywords)) rule.keywords = [];

  // Normalize enforcement fields (yaml parses booleans/numbers natively,
  // but tolerate string forms from hand-written blocks)
  if (typeof rule.enforce === 'string') {
    rule.enforce = rule.enforce === 'true';
  }
  if (typeof rule.ttl === 'string') {
    rule.ttl = parseInt(rule.ttl, 10) || 3600;
  }

  return rule;
}

/**
 * Extract context rules from markdown
 * @param {string} markdown
 * @param {string} filePath
 * @returns {ContextRule[]}
 */
export function extractContextRules(markdown, filePath, onWarn = () => {}) {
  const rules = [];
  const regex = /```context\s*\r?\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(markdown)) !== null) {
    for (const obj of parseYamlDocuments(match[1], filePath, onWarn)) {
      const rule = normalizeContextRule(obj, filePath, onWarn);
      if (rule) rules.push(rule);
    }
  }

  return rules;
}

/**
 * Context Detector: evaluates file changes against context rules
 */
export class ContextDetector {
  #rules;
  #recentSignals; // Dedup: don't re-emit the same signal within cooldown
  #cooldownMs;

  /**
   * @param {ContextRule[]} rules
   * @param {Object} [options]
   * @param {number} [options.cooldownMs=30000] - Don't re-emit same signal within this window
   */
  constructor(rules, options = {}) {
    this.#rules = rules;
    this.#recentSignals = new Map(); // contextFile → timestamp
    this.#cooldownMs = options.cooldownMs || 30000; // 30s default
  }

  /**
   * Detect which context files should be loaded based on a file change
   * @param {string} filePath - Relative path of the changed file
   * @param {string} [content] - File content (for keyword matching)
   * @returns {ContextSignal[]}
   */
  detect(filePath, content = null) {
    const signals = [];
    const normalized = filePath.replace(/\\/g, '/');
    const now = Date.now();

    for (const rule of this.#rules) {
      // Check cooldown
      const lastEmit = this.#recentSignals.get(rule.contextFile);
      if (lastEmit && (now - lastEmit) < this.#cooldownMs) continue;

      let matched = false;
      let reason = '';
      let matchType = 'file';
      let confidence = 0;

      // File pattern matching
      for (const pattern of rule.filePatterns) {
        const regex = globToRegex(pattern);
        if (regex.test(normalized)) {
          matched = true;
          reason = `File matches pattern: ${pattern}`;
          matchType = 'file';
          confidence = 0.9;
          break;
        }
      }

      // Keyword matching (in content)
      if (!matched && content && rule.keywords.length > 0) {
        for (const keyword of rule.keywords) {
          if (content.includes(keyword)) {
            matched = true;
            reason = `Content contains keyword: "${keyword}"`;
            matchType = 'content';
            confidence = 0.7;
            break;
          }
        }
      }

      // Keyword in file path (lower confidence)
      if (!matched && rule.keywords.length > 0) {
        for (const keyword of rule.keywords) {
          if (normalized.toLowerCase().includes(keyword.toLowerCase())) {
            matched = true;
            reason = `Path contains keyword: "${keyword}"`;
            matchType = 'file';
            confidence = 0.5;
            break;
          }
        }
      }

      if (matched) {
        signals.push({
          contextFile: rule.contextFile,
          reason,
          trigger: filePath,
          matchType,
          confidence,
          enforce: rule.enforce || false,
          severity: rule.severity || 'warn',
          ttl: rule.ttl || 3600,
        });
        this.#recentSignals.set(rule.contextFile, now);
      }
    }

    // Sort by confidence (highest first), deduplicate by contextFile
    const seen = new Set();
    return signals
      .sort((a, b) => b.confidence - a.confidence)
      .filter(s => {
        if (seen.has(s.contextFile)) return false;
        seen.add(s.contextFile);
        return true;
      });
  }

  /**
   * Reset cooldowns (useful for testing or mode switches)
   */
  resetCooldowns() {
    this.#recentSignals.clear();
  }

  get ruleCount() {
    return this.#rules.length;
  }
}

/**
 * @typedef {Object} ContextViolation
 * @property {string} id - Rule ID that produced this violation
 * @property {string} contextFile - The doc that should have been loaded
 * @property {string} trigger - File that triggered the context requirement
 * @property {string} reason - Why this context was required
 * @property {'block'|'warn'|'info'} severity - Violation severity
 * @property {string} message - Human-readable violation message
 * @property {number|null} age_seconds - Age of stale evidence, or null if never recorded
 */

/**
 * Check enforced context signals against playbook-state.json.
 * For each signal with `enforce: true`, verifies that a corresponding
 * `read:<contextFile>` state_key exists and is within TTL.
 *
 * @param {ContextSignal[]} signals - Signals from ContextDetector.detect()
 * @param {string} projectRoot - Project root path
 * @param {Object} [options]
 * @param {boolean} [options.enforceAll=false] - Treat ALL signals as mandatory (ignores per-rule enforce flag)
 * @returns {Promise<ContextViolation[]>}
 */
export async function enforceContextSignals(signals, projectRoot, options = {}) {
  const enforceAll = options.enforceAll || false;
  const enforceableSignals = enforceAll
    ? signals
    : signals.filter(s => s.enforce);

  if (enforceableSignals.length === 0) return [];

  // Read and verify playbook-state.json (ignore tampered/forged entries)
  const secret = await getStateSecret(projectRoot, options.shadowDir);
  const state = await readVerifiedState(projectRoot, secret);

  const violations = [];

  for (const signal of enforceableSignals) {
    const stateKey = `read:${signal.contextFile}`;
    const ttlMs = (signal.ttl || 3600) * 1000;
    const timestamp = state.completed[stateKey];

    let met = false;
    let ageSeconds = null;

    if (timestamp) {
      const ageMs = Date.now() - timestamp;
      if (ageMs < ttlMs) {
        met = true;
      }
      ageSeconds = Math.round(ageMs / 1000);
    }

    if (!met) {
      violations.push({
        id: `context:${signal.contextFile.replace(/[/\\]/g, ':')}`,
        contextFile: signal.contextFile,
        trigger: signal.trigger,
        reason: signal.reason,
        severity: signal.severity || 'warn',
        message: `Context not loaded: ${signal.contextFile} — required before editing ${signal.trigger}`,
        age_seconds: ageSeconds,
      });
    }
  }

  return violations;
}

/**
 * Load context rules from project (defaults + any custom ones in docs/agents/*.md).
 * Default rules only activate when their contextFile actually exists in the
 * project — recommending docs that don't exist is pure noise. Custom rules are
 * kept regardless (the user asked for them explicitly) but produce a warning.
 * @param {string} projectRoot
 * @param {Object} [options]
 * @param {(msg: string) => void} [options.onWarn]
 * @returns {Promise<ContextRule[]>}
 */
export async function loadContextRules(projectRoot, options = {}) {
  const onWarn = options.onWarn || (() => {});
  const rules = [];

  const contextFileExists = async (contextFile) => {
    try {
      await access(join(projectRoot, contextFile));
      return true;
    } catch {
      return false;
    }
  };

  for (const rule of getDefaultContextRules()) {
    if (await contextFileExists(rule.contextFile)) rules.push(rule);
  }

  // Load context rules generated by `gateinit onboard`
  const generatedRulesPath = join(projectRoot, '.gateinitiative', 'context-rules.json');
  try {
    const generated = JSON.parse(await readFile(generatedRulesPath, 'utf-8'));
    if (Array.isArray(generated)) {
      for (const rule of generated) {
        if (rule?.id && rule?.contextFile) rules.push(rule);
      }
    }
  } catch { /* absent or malformed */ }

  // Also scan docs/agents/*.md for custom ```context blocks
  const docsDir = join(projectRoot, 'docs', 'agents');
  try {
    const entries = await readdir(docsDir);
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      try {
        const content = await readFile(join(docsDir, entry), 'utf-8');
        const custom = extractContextRules(content, join(docsDir, entry), onWarn);
        for (const rule of custom) {
          if (!await contextFileExists(rule.contextFile)) {
            onWarn(`${rule.source}: context rule "${rule.id}" points to missing doc: ${rule.contextFile}`);
          }
          rules.push(rule);
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* no docs/agents dir */ }

  return rules;
}

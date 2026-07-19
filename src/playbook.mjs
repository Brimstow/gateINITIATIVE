// gateinitiative: Playbook Enforcement Module
//
// Loads playbook definitions from .playbooks/*.yaml and verifies
// that prerequisite steps were completed before allowing edits to
// governed files. Uses two evidence sources:
//   1. Filesystem evidence (fresh output files — works in all IDEs)
//   2. State file evidence (.gateinitiative/playbook-state.json — hook-capable IDEs)
//
// Playbooks don't EXECUTE steps — they VERIFY steps happened before
// allowing edits. gateINITIATIVE is passive enforcement, not an executor.
//
// Architecture:
//   playbook.mjs (this file)
//     ├── loadPlaybooks(projectRoot) → Playbook[]
//     ├── findApplicablePlaybook(filePath, playbooks) → Playbook | null
//     ├── checkPrerequisites(playbook, projectRoot) → PrerequisiteResult[]
//     └── PlaybookEnforcer class (stateful, session-scoped)

import { readFile, readdir, stat, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { matchesTrigger } from './evaluator.mjs';
import { parseYamlDocuments } from './parser.mjs';
import { getStateSecret, readVerifiedState } from './playbook-state.mjs';

/**
 * @typedef {Object} Evidence
 * @property {string} [file_fresh] - Relative path to a file that must be recently modified
 * @property {string} [state_key] - Key in playbook-state.json that must exist and be fresh
 * @property {string} [file_exists] - Relative path to a file that must exist
 */

/**
 * @typedef {Object} Prerequisite
 * @property {string} id - Step identifier (e.g., "tests-passed")
 * @property {Evidence} evidence - How to verify this step was completed
 * @property {number} ttl - Time-to-live in seconds (how fresh the evidence must be)
 * @property {string} message - Human-readable message shown on violation
 * @property {'block'|'warn'|'info'} [severity] - Override severity for this prerequisite
 */

/**
 * @typedef {Object} Playbook
 * @property {string} name - Playbook identifier
 * @property {number} [version] - Version number
 * @property {string} description - What this playbook enforces
 * @property {string|string[]} trigger - Glob pattern(s) for files this playbook governs
 * @property {Prerequisite[]} prerequisites - Steps that must complete before edit is allowed
 * @property {Object} [on_violation] - Violation behavior overrides
 * @property {'block'|'warn'|'info'} [on_violation.severity] - Default severity
 * @property {'inherit'|'warn'|'strict'|'audit'} [on_violation.mode] - Mode override
 * @property {string} source - File this playbook was loaded from
 */

/**
 * @typedef {Object} PrerequisiteResult
 * @property {string} id - Prerequisite ID
 * @property {boolean} met - Whether evidence was found and fresh
 * @property {string} message - Human-readable explanation
 * @property {'block'|'warn'|'info'} severity - Severity of this prerequisite
 * @property {string} [evidence_type] - Which evidence type was checked
 * @property {number} [age_seconds] - How old the evidence is (if found)
 */

/**
 * Parse a YAML playbook file into a Playbook object.
 * Multi-document files are tolerated (the first document containing a
 * playbook definition wins).
 * @param {string} content - Raw YAML content
 * @param {string} sourceFile - Path of the playbook file
 * @param {(msg: string) => void} [onWarn]
 * @returns {Playbook|null}
 */
export function parsePlaybook(content, sourceFile, onWarn = () => {}) {
  for (const raw of parseYamlDocuments(content, sourceFile, onWarn)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

    const playbook = {
      source: sourceFile,
      name: raw.name,
      description: raw.description !== undefined ? String(raw.description) : undefined,
      trigger: raw.trigger,
      on_violation: raw.on_violation && typeof raw.on_violation === 'object'
        ? raw.on_violation
        : undefined,
      prerequisites: [],
    };

    if (raw.version !== undefined) {
      playbook.version = parseInt(raw.version, 10) || 1;
    }

    if (Array.isArray(raw.prerequisites)) {
      for (const p of raw.prerequisites) {
        if (!p || typeof p !== 'object' || !p.id) continue;
        playbook.prerequisites.push({
          id: String(p.id),
          evidence: p.evidence && typeof p.evidence === 'object' ? p.evidence : {},
          ttl: parseInt(p.ttl, 10) || 300,
          message: p.message !== undefined ? String(p.message) : '',
          severity: ['block', 'warn', 'info'].includes(p.severity) ? p.severity : 'block',
        });
      }
    }

    // Validate required fields
    if (!playbook.name || !playbook.trigger || playbook.prerequisites.length === 0) {
      if (playbook.name || playbook.trigger) {
        onWarn(`${sourceFile}: playbook skipped — requires name, trigger, and at least one prerequisite`);
      }
      continue;
    }

    return playbook;
  }

  return null;
}

/**
 * Load all playbook definitions from .playbooks/ directory
 * @param {string} projectRoot - Project root path
 * @param {(msg: string) => void} [onWarn]
 * @returns {Promise<Playbook[]>}
 */
export async function loadPlaybooks(projectRoot, onWarn = () => {}) {
  const playbookDir = join(projectRoot, '.playbooks');
  const playbooks = [];

  try {
    await access(playbookDir);
  } catch {
    return playbooks; // No .playbooks directory — not an error
  }

  let files;
  try {
    files = await readdir(playbookDir);
  } catch {
    return playbooks;
  }

  for (const file of files) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;

    try {
      const filePath = join(playbookDir, file);
      const content = await readFile(filePath, 'utf8');
      const playbook = parsePlaybook(content, filePath, onWarn);
      if (playbook) {
        playbooks.push(playbook);
      }
    } catch (err) {
      onWarn(`${join(playbookDir, file)}: unreadable playbook — ${err.message}`);
    }
  }

  return playbooks;
}

/**
 * Find the most applicable playbook that governs a given file path.
 * When multiple playbooks match, highest severity wins. Among equal severity,
 * most specific trigger wins (fewer glob wildcards = more specific).
 * @param {string} filePath - Relative file path to check
 * @param {Playbook[]} playbooks - Loaded playbook definitions
 * @returns {Playbook|null}
 */
export function findApplicablePlaybook(filePath, playbooks) {
  const SEVERITY_RANK = { block: 3, warn: 2, info: 1 };
  const matches = [];

  for (const playbook of playbooks) {
    const triggers = Array.isArray(playbook.trigger) ? playbook.trigger : [playbook.trigger];
    for (const trigger of triggers) {
      if (matchesTrigger(filePath, trigger)) {
        matches.push({ playbook, trigger });
        break; // One match per playbook is enough
      }
    }
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].playbook;

  // Sort by: severity (block > warn > info), then specificity (fewer wildcards wins)
  matches.sort((a, b) => {
    const sevA = SEVERITY_RANK[a.playbook.on_violation?.severity || 'block'] || 0;
    const sevB = SEVERITY_RANK[b.playbook.on_violation?.severity || 'block'] || 0;
    if (sevB !== sevA) return sevB - sevA; // Higher severity first

    // More specific trigger wins (fewer ** and * chars)
    const specA = (a.trigger.match(/\*/g) || []).length;
    const specB = (b.trigger.match(/\*/g) || []).length;
    return specA - specB; // Fewer wildcards = more specific = wins
  });

  return matches[0].playbook;
}

/**
 * Check if a file exists and was modified within the TTL window
 * @param {string} filePath - Absolute path to evidence file
 * @param {number} ttlMs - Maximum age in milliseconds
 * @returns {Promise<{fresh: boolean, ageMs: number|null}>}
 */
async function checkFileFreshness(filePath, ttlMs) {
  try {
    const fileStat = await stat(filePath);
    const ageMs = Date.now() - fileStat.mtimeMs;
    return { fresh: ageMs < ttlMs, ageMs };
  } catch {
    return { fresh: false, ageMs: null };
  }
}

/**
 * Check all prerequisites for a playbook
 * @param {Playbook} playbook - The applicable playbook
 * @param {string} projectRoot - Project root path
 * @param {Object} [options]
 * @param {string} [options.secret] - HMAC secret for playbook-state.json
 * @returns {Promise<PrerequisiteResult[]>}
 */
export async function checkPrerequisites(playbook, projectRoot, options = {}) {
  const state = await readVerifiedState(projectRoot, options.secret);
  const results = [];

  for (const prereq of playbook.prerequisites) {
    const ttlMs = prereq.ttl * 1000;
    let met = false;
    let evidenceType = null;
    let ageSeconds = null;

    // Check filesystem evidence (universal — works in all IDEs)
    if (prereq.evidence.file_fresh) {
      evidenceType = 'file_fresh';
      const filePath = resolve(projectRoot, prereq.evidence.file_fresh);
      const result = await checkFileFreshness(filePath, ttlMs);
      if (result.fresh) {
        met = true;
        ageSeconds = Math.round(result.ageMs / 1000);
      }
    }

    // Check file existence (simpler — just needs to exist)
    if (!met && prereq.evidence.file_exists) {
      evidenceType = 'file_exists';
      try {
        await access(resolve(projectRoot, prereq.evidence.file_exists));
        met = true;
      } catch {
        // File doesn't exist
      }
    }

    // Check state file evidence (hook-capable IDEs write this)
    if (!met && prereq.evidence.state_key) {
      evidenceType = 'state_key';
      const timestamp = state.completed?.[prereq.evidence.state_key];
      if (timestamp) {
        const ageMs = Date.now() - timestamp;
        if (ageMs < ttlMs) {
          met = true;
          ageSeconds = Math.round(ageMs / 1000);
        } else {
          ageSeconds = Math.round(ageMs / 1000);
        }
      }
    }

    results.push({
      id: prereq.id,
      met,
      message: prereq.message,
      severity: prereq.severity || playbook.on_violation?.severity || 'block',
      evidence_type: evidenceType,
      age_seconds: ageSeconds
    });
  }

  return results;
}

/**
 * PlaybookEnforcer — integrates with the existing gateinitiative pipeline.
 * Call evaluateEdit() from the watcher callback alongside gate evaluation.
 */
export class PlaybookEnforcer {
  /**
   * @param {string} projectRoot
   * @param {Object} [options]
   * @param {(msg: string) => void} [options.onWarn]
   * @param {string} [options.shadowDir] - Override for external data dir
   */
  constructor(projectRoot, options = {}) {
    this.projectRoot = projectRoot;
    this.playbooks = [];
    this.loaded = false;
    this.secret = null;
    this.shadowDir = options.shadowDir;
    this.onWarn = options.onWarn || (() => {});
  }

  /** Load playbook definitions and state secret (call once at startup) */
  async load() {
    this.playbooks = await loadPlaybooks(this.projectRoot, this.onWarn);
    this.secret = await getStateSecret(this.projectRoot, this.shadowDir);
    this.loaded = true;
    return this.playbooks.length;
  }

  /** @returns {number} Number of loaded playbooks */
  get count() {
    return this.playbooks.length;
  }

  /**
   * Evaluate whether an edit to a file is allowed by its governing playbook.
   * @param {string} filePath - Relative path of the edited file
   * @returns {Promise<{governed: boolean, playbook: string|null, violations: PrerequisiteResult[]}>}
   */
  async evaluateEdit(filePath) {
    if (!this.loaded) await this.load();

    const playbook = findApplicablePlaybook(filePath, this.playbooks);
    if (!playbook) {
      return { governed: false, playbook: null, violations: [] };
    }

    const results = await checkPrerequisites(playbook, this.projectRoot, { secret: this.secret });
    const violations = results.filter(r => !r.met);

    return {
      governed: true,
      playbook: playbook.name,
      violations
    };
  }
}

/**
 * gateinitiative: Enforcement Actions
 * 
 * Handles what happens when a gate violation is detected.
 * Supports: alert, revert (shadow copy), log, and configurable actions.
 */

import { appendFile, mkdir, copyFile, rename, stat, readdir, unlink, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { getShadowDir, getQuarantineDir, ensureProjectRootMarker } from './platform-paths.mjs';
import { evaluateContent, applicableGates, readFileGuarded } from './evaluator.mjs';
import { SafeEvaluator } from './safe-eval.mjs';
import { checkOverride, recordPendingDecision, recordOverride } from './decisions.mjs';

/**
 * @typedef {'alert'|'revert'|'log'|'block'} EnforcementAction
 */

/**
 * @typedef {Object} EnforcerConfig
 * @property {string} projectRoot - Project root directory
 * @property {'strict'|'warn'|'audit'} mode - Enforcement mode
 *   - strict: revert + alert for block-severity, alert for warn
 *   - warn: alert only (never revert), exit code still reflects violations
 *   - audit: log only (silent, writes to .gateinitiative/violations.log)
 * @property {string} [logFile] - Path to violation log (default: .gateinitiative/violations.log)
 * @property {string} [shadowDir] - Override external data dir (contains shadow/<hash> and quarantine/<hash>)
 * @property {string} [sessionId] - Current daemon/watch session id for session-scoped overrides
 * @property {number} [maxFileBytes] - Max file size to read for evaluation
 * @property {boolean} [notifications] - Enable desktop notifications (default: false)
 * @property {boolean} [sound] - Enable terminal bell on violations (default: false)
 * @property {(msg: string) => void} [output] - Sink for human-readable output
 * @property {import('./health.mjs').HealthMonitor} [health] - Health event sink
 * @property {import('./notify.mjs').Notifier} [notifier] - Routed notification sender
 * @property {(event: {gateId: string, file: string, reason: string}) => Promise<'quarantine'|'override'|'ignore'>} [promptHandler] - TTY prompt for revert failures
 * @property {{threshold: number, windowMinutes: number}} [escalation] - Repeat violation escalation config
 *   (default: console.log; daemon mode injects a timestamping/ANSI-stripping logger)
 */

// ANSI color codes for terminal output
const COLORS = {
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

const ICONS = {
  block: `${COLORS.red}✖${COLORS.reset}`,
  warn: `${COLORS.yellow}⚠${COLORS.reset}`,
  info: `${COLORS.blue}ℹ${COLORS.reset}`,
  pass: `${COLORS.cyan}✓${COLORS.reset}`,
  revert: `${COLORS.red}↩${COLORS.reset}`,
};

/**
 * Shadow Store: maintains known-good copies of files outside the project tree.
 *
 * Shadows live in the platform data dir, keyed by a hash of the project root,
 * so they cannot be committed or edited by agents working inside the repo.
 * A manifest records SHA-256 fingerprints of each shadow; reverts verify the
 * shadow has not been tampered with before restoring it.
 */
export class ShadowStore {
  #root;
  #shadowDir;
  #manifestPath;
  #quarantineDir;
  #manifestQueue = Promise.resolve(); // serialize manifest read-modify-write

  constructor(projectRoot, dataDirOverride) {
    this.#root = resolve(projectRoot);
    this.#shadowDir = getShadowDir(projectRoot, dataDirOverride);
    this.#manifestPath = join(this.#shadowDir, '.manifest.json');
    this.#quarantineDir = getQuarantineDir(projectRoot, dataDirOverride);
    // Record project root in external data dir for `gateinit clean`
    ensureProjectRootMarker(projectRoot, dataDirOverride).catch(() => {});
  }

  /**
   * Serialize operations that read-modify-write the manifest so concurrent
   * snapshots cannot overwrite each other's entries.
   */
  #withManifestUpdate(fn) {
    const result = this.#manifestQueue.then(() => fn());
    // Keep the queue alive even if one update fails, and wait for completion
    // before allowing the next update to start.
    this.#manifestQueue = result.catch(() => {});
    return result;
  }

  /**
   * Get the shadow path for a source file
   * @param {string} filePath - Absolute source path
   * @returns {string}
   */
  #getShadowPath(filePath) {
    const rel = relative(this.#root, resolve(filePath));
    return join(this.#shadowDir, rel);
  }

  /**
   * Normalized manifest key for a source file
   * @param {string} filePath
   * @returns {string}
   */
  #getRelKey(filePath) {
    return relative(this.#root, resolve(filePath)).replace(/\\/g, '/');
  }

  async #loadManifest() {
    try {
      const content = await readFile(this.#manifestPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  async #saveManifest(manifest) {
    await mkdir(this.#shadowDir, { recursive: true });
    await writeFile(this.#manifestPath, JSON.stringify(manifest, null, 2));
  }

  async #hashFile(filePath) {
    const content = await readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Snapshot a file (save known-good copy) and record its hash in the manifest.
   * @param {string} filePath - Absolute path to snapshot
   */
  async snapshot(filePath) {
    const shadowPath = this.#getShadowPath(filePath);
    await mkdir(dirname(shadowPath), { recursive: true });
    await copyFile(filePath, shadowPath);

    const hash = await this.#hashFile(shadowPath);
    return this.#withManifestUpdate(async () => {
      const manifest = await this.#loadManifest();
      manifest[this.#getRelKey(filePath)] = hash;
      await this.#saveManifest(manifest);
    });
  }

  /**
   * Check if a shadow copy exists
   * @param {string} filePath
   * @returns {Promise<boolean>}
   */
  async has(filePath) {
    const shadowPath = this.#getShadowPath(filePath);
    try {
      await stat(shadowPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the quarantine path for a source file
   * @param {string} filePath - Absolute source path
   * @param {number} [timestamp]
   * @returns {string}
   */
  #getQuarantinePath(filePath, timestamp = Date.now()) {
    const rel = relative(this.#root, resolve(filePath));
    return join(this.#quarantineDir, String(timestamp), rel);
  }

  /**
   * Quarantine a violating file (move it out of the project tree)
   * @param {string} filePath - Absolute path to quarantine
   * @returns {Promise<string|null>} - quarantine path or null on failure
   */
  async quarantine(filePath) {
    const quarantinePath = this.#getQuarantinePath(filePath);
    try {
      await mkdir(dirname(quarantinePath), { recursive: true });
      await copyFile(filePath, quarantinePath);
      await unlink(filePath);
      return quarantinePath;
    } catch {
      return null;
    }
  }

  /**
   * Restore a deleted governed file from its shadow copy.
   * Verifies the shadow fingerprint before restoring.
   * @param {string} filePath - Absolute source path
   * @returns {Promise<{success: boolean, tamper?: boolean}>}
   */
  async restoreDeleted(filePath) {
    const shadowPath = this.#getShadowPath(filePath);
    try {
      const currentHash = await this.#hashFile(shadowPath);
      const manifest = await this.#loadManifest();
      const expectedHash = manifest[this.#getRelKey(filePath)];
      // Fail closed: a shadow without integrity metadata is treated as tampered.
      // Restoring unverified content would let an attacker who can wipe the
      // manifest (or corrupt it) smuggle arbitrary bytes back into the project.
      if (!expectedHash || currentHash !== expectedHash) {
        return { success: false, tamper: true, missingBaseline: !expectedHash };
      }
      await mkdir(dirname(filePath), { recursive: true });
      await copyFile(shadowPath, filePath);
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  /**
   * Revert a file to its shadow copy atomically.
   * Uses temp-file + rename so concurrent readers never see truncated content.
   * Verifies the shadow fingerprint before restoring.
   * @param {string} filePath - Absolute path to revert
   * @returns {Promise<{success: boolean, tamper?: boolean}>}
   *   success=true on revert; success=false + tamper=true if shadow was altered
   */
  async revert(filePath) {
    const shadowPath = this.#getShadowPath(filePath);
    const target = resolve(filePath);
    const targetDir = dirname(target);
    const tmpName = `.gk-revert-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
    const tmpPath = join(targetDir, tmpName);
    try {
      const currentHash = await this.#hashFile(shadowPath);
      const manifest = await this.#loadManifest();
      const expectedHash = manifest[this.#getRelKey(filePath)];
      // Fail closed: no integrity metadata means the shadow cannot be trusted.
      if (!expectedHash || currentHash !== expectedHash) {
        return { success: false, tamper: true, missingBaseline: !expectedHash };
      }
      await copyFile(shadowPath, tmpPath);
      await rename(tmpPath, target);
      return { success: true };
    } catch {
      // Best-effort cleanup of temp file
      try { await unlink(tmpPath); } catch { /* ignore */ }
      return { success: false };
    }
  }

  /**
   * Update shadow after a file passes all gates (new known-good state)
   * @param {string} filePath
   */
  async update(filePath) {
    await this.snapshot(filePath);
  }

  /**
   * Delete shadow copies older than maxAgeMs and remove their manifest entries.
   * @param {number} maxAgeMs - Age threshold (default: 30 days)
   * @returns {Promise<number>} - Number of shadow files removed
   */
  async prune(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
    let removed = 0;
    let entries;
    try {
      entries = await readdir(this.#shadowDir, { withFileTypes: true, recursive: true });
    } catch {
      return removed; // No shadow dir yet
    }

    const manifest = await this.#loadManifest();
    const cutoff = Date.now() - maxAgeMs;
    const remaining = { ...manifest };

    for (const entry of entries) {
      if (!entry.isFile() || entry.name === '.manifest.json') continue;
      const fullPath = join(entry.parentPath || entry.path, entry.name);
      const relKey = relative(this.#shadowDir, fullPath).replace(/\\/g, '/');
      try {
        const s = await stat(fullPath);
        if (s.mtimeMs < cutoff) {
          await unlink(fullPath);
          delete remaining[relKey];
          removed++;
        }
      } catch { /* raced with another process — skip */ }
    }

    // Clean manifest entries whose shadow file no longer exists
    for (const key of Object.keys(remaining)) {
      try {
        await stat(join(this.#shadowDir, key));
      } catch {
        delete remaining[key];
      }
    }

    await this.#withManifestUpdate(async () => {
      // Re-load inside the queue in case snapshots landed during prune
      const latest = await this.#loadManifest();
      for (const key of Object.keys(latest)) {
        try {
          await stat(join(this.#shadowDir, key));
        } catch {
          delete latest[key];
        }
      }
      for (const [key, value] of Object.entries(remaining)) {
        if (latest[key] === undefined) latest[key] = value;
      }
      await this.#saveManifest(latest);
    });
    return removed;
  }

  get shadowDir() {
    return this.#shadowDir;
  }

  get quarantineDir() {
    return this.#quarantineDir;
  }
}

/**
 * Violation Logger: writes violations to a log file
 */
export class ViolationLogger {
  #logPath;

  constructor(projectRoot, logFile) {
    this.#logPath = logFile || join(projectRoot, '.gateinitiative', 'violations.log');
  }

  /**
   * Append a violation entry to the log
   * @param {import('./evaluator.mjs').Violation} violation
   */
  async log(violation) {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...violation,
    }) + '\n';

    await mkdir(dirname(this.#logPath), { recursive: true });
    await appendFile(this.#logPath, entry);
  }

  get logPath() {
    return this.#logPath;
  }
}

/**
 * Main Enforcer: orchestrates enforcement actions based on violations
 */
export class Enforcer {
  #config;
  #shadow;
  #logger;
  #stats;
  #output;
  #health;
  #notifier;
  #escalations = new Map(); // key → timestamps[]

  /**
   * @param {EnforcerConfig} config
   */
  constructor(config) {
    this.#config = config;
    this.#shadow = new ShadowStore(config.projectRoot, config.shadowDir);
    this.#logger = new ViolationLogger(config.projectRoot, config.logFile);
    this.#stats = { violations: 0, reverts: 0, quarantines: 0, filesChecked: 0 };
    this.#output = config.output || ((msg) => console.log(msg));
    this.#health = config.health || null;
    this.#notifier = config.notifier || null;
  }

  /**
   * Fire a routed notification if a notifier is configured.
   * @param {string} severity
   * @param {string} title
   * @param {string} message
   * @param {string} [category]
   */
  #notify(severity, title, message, category) {
    if (!this.#notifier) return Promise.resolve([]);
    return this.#notifier.notify({ severity, title, message, category });
  }

  #report(category, severity, message, details = {}) {
    if (this.#health) {
      this.#health.report({ category, severity, message, ...details });
    }
  }

  #escalationKey(violation) {
    return `${violation.gateId}:${violation.file}`;
  }

  /**
   * Track repeated violations of the same gate+file within the configured window.
   * Returns true when the count crosses the escalation threshold.
   */
  #isEscalated(violation) {
    const threshold = this.#config.escalation?.threshold ?? 3;
    const windowMinutes = this.#config.escalation?.windowMinutes ?? 10;
    const windowMs = windowMinutes * 60_000;
    const now = Date.now();
    const key = this.#escalationKey(violation);

    let history = this.#escalations.get(key) || [];
    history = history.filter(ts => now - ts < windowMs);
    history.push(now);
    this.#escalations.set(key, history);

    return history.length >= threshold;
  }

  /**
   * Handle violations for a single file
   * @param {string} filePath - Absolute path of the file
   * @param {import('./evaluator.mjs').Violation[]} violations
   * @returns {Promise<{reverted: boolean, blocked: boolean, quarantined: boolean}>}
   */
  async enforce(filePath, violations) {
    if (violations.length === 0) {
      // File passes all gates — update shadow copy
      this.#stats.filesChecked++;
      await this.#shadow.update(filePath);
      return { reverted: false, blocked: false };
    }

    this.#stats.filesChecked++;
    let reverted = false;
    let blocked = false;
    let quarantined = false;
    const pendingBlocks = []; // strict-mode block violations, enforced once after logging

    for (const violation of violations) {
      this.#stats.violations++;

      // Always log
      await this.#logger.log(violation);

      // 2.5: repeat-violation escalation — mark before recording so the bridge sees it
      if (this.#isEscalated(violation)) {
        violation.escalated = true;
      }

      // Track recent violations for agent feedback via the bridge
      await this.#recordViolation(violation);

      // Display based on mode
      if (this.#config.mode !== 'audit') {
        this.#printViolation(violation);
      }

      if (violation.escalated) {
        this.#output(
          `    ${COLORS.red}ESCALATED${COLORS.reset} ${COLORS.gray}(${this.#config.escalation?.threshold || 3} violations of ${violation.gateId} on ${violation.file} within ${this.#config.escalation?.windowMinutes || 10} minutes)${COLORS.reset}`
        );
        this.#report(
          'repeat_violation',
          'warn',
          `Repeated ${violation.severity} violations of ${violation.gateId} on ${violation.file} — agent may be in a revert loop`,
          { file: violation.file, error: null }
        );
      }

      // Collect block-severity violations in strict mode; enforcement runs
      // once per file after every violation has been logged and displayed.
      if (this.#config.mode === 'strict' && violation.severity === 'block') {
        blocked = true;
        pendingBlocks.push(violation);
      }
    }

    if (pendingBlocks.length > 0) {
      // 2A.6: overrides are strictly gate-scoped — each block violation is
      // checked individually, and a single unoverridden violation is enough
      // to enforce. An override for gate A must never let gate B through.
      const unoverridden = [];
      for (const violation of pendingBlocks) {
        if (violation.overridable !== false && await checkOverride(this.#config.projectRoot, violation.gateId, violation.file, this.#config.sessionId, this.#config.shadowDir)) {
          this.#output(`    ${COLORS.gray}OVERRIDE active for ${violation.gateId} on ${violation.file} — enforcement skipped for this gate${COLORS.reset}`);
        } else {
          unoverridden.push(violation);
        }
      }

      if (unoverridden.length > 0) {
        // Enforce once per file, attributed to the first unoverridden violation
        const violation = unoverridden[0];
        const gateIds = [...new Set(unoverridden.map(v => v.gateId))].join(', ');

        const hasShadow = await this.#shadow.has(filePath);
        let revertResult = { success: false };
        if (hasShadow) {
          revertResult = await this.#shadow.revert(filePath);
        }
        if (revertResult.success) {
          reverted = true;
          this.#stats.reverts++;
          this.#printRevert(filePath);
        } else {
          const rel = relative(this.#config.projectRoot, filePath);
          const reason = revertResult.tamper
            ? (revertResult.missingBaseline
              ? 'shadow integrity metadata missing — manual review required'
              : 'shadow manifest mismatch — manual review required')
            : 'no usable shadow baseline — file quarantined';

          // 2A.5: foreground TTY prompt lets a human decide in attached watch
          // mode — only offered when every unoverridden gate is overridable
          let decision = 'quarantine';
          if (this.#config.promptHandler && unoverridden.every(v => v.overridable !== false)) {
            try {
              decision = await this.#config.promptHandler({ gateId: gateIds, file: violation.file, reason });
            } catch {
              decision = 'quarantine';
            }
          }

          if (decision === 'override') {
            for (const v of unoverridden) {
              await recordOverride(
                this.#config.projectRoot,
                { gateId: v.gateId, file: v.file, scope: 'session', sessionId: this.#config.sessionId, reason: 'approved via foreground prompt' },
                this.#config.shadowDir
              );
              this.#output(`    ${COLORS.gray}OVERRIDE granted by prompt for ${v.gateId} on ${v.file}${COLORS.reset}`);
            }
          } else if (decision === 'ignore') {
            this.#output(`    ${COLORS.gray}IGNORED by prompt: ${gateIds} on ${violation.file}${COLORS.reset}`);
          } else if (revertResult.tamper) {
            // Default/fallback: quarantine or report tamper
            this.#printTamper(filePath);
            this.#report('tamper_suspected', 'critical', `Shadow verification failed for ${rel} (${reason})`, { file: rel });
            await recordPendingDecision(
              this.#config.projectRoot,
              { gateId: violation.gateId, file: violation.file, reason, severity: 'critical' },
              this.#config.shadowDir
            );
            this.#notify('block', `gateinitiative: tamper suspected`, `Shadow verification failed for ${rel}. Run \`gateinit review\`.`, 'tamper_suspected').catch(() => {});
          } else {
            const quarantinePath = await this.#shadow.quarantine(filePath);
            if (quarantinePath) {
              quarantined = true;
              this.#stats.quarantines++;
              this.#printQuarantine(filePath, quarantinePath);
              await recordPendingDecision(
                this.#config.projectRoot,
                { gateId: violation.gateId, file: violation.file, reason: `file quarantined to ${quarantinePath}`, severity: 'block' },
                this.#config.shadowDir
              );
              this.#notify('block', `gateinitiative: file quarantined`, `${rel} was moved to quarantine. Run \`gateinit review approve <id>\` to override.`, 'quarantine').catch(() => {});
            } else {
              this.#report('quarantine_failed', 'error', `Could not quarantine ${rel}`, { file: rel });
              this.#notify('health', `gateinitiative: quarantine failed`, `Could not quarantine ${rel}. Check permissions.`, 'quarantine_failed').catch(() => {});
            }
          }
        }
      }
    }

    // Sound alert if configured
    if (this.#config.sound && violations.some(v => v.severity === 'block')) {
      process.stdout.write('\x07'); // Terminal bell
    }

    return { reverted, blocked, quarantined };
  }

  /**
   * Handle a file that passes all gates.
   * @param {string} filePath
   * @param {boolean} [shouldSnapshot=true] — only snapshot files covered by block gates
   */
  async markClean(filePath, shouldSnapshot = true) {
    this.#stats.filesChecked++;
    if (shouldSnapshot) {
      try {
        await this.#shadow.update(filePath);
      } catch (err) {
        this.#report('shadow_write_failed', 'error', `Failed to update shadow for ${relative(this.#config.projectRoot, filePath)}`, { file: relative(this.#config.projectRoot, filePath), error: err });
        throw err;
      }
    }
  }

  /**
   * Initialize shadow copies for existing files.
   * Only snapshots files covered by block-severity gates, and evaluates each file
   * before seeding so pre-existing violations don't become "known-good" baselines.
   *
   * Evaluation is timeout-bounded to prevent a pathological gate regex from
   * stalling strict-mode startup. Provide a shared SafeEvaluator to avoid
   * spawning extra workers; one is created lazily if omitted.
   *
   * @param {string[]} filePaths - Absolute paths to snapshot
   * @param {import('./parser.mjs').Gate[]} gates - Loaded gates
   * @param {import('./safe-eval.mjs').SafeEvaluator} [safeEvaluator] - Optional shared safe evaluator
   */
  async initShadows(filePaths, gates = [], safeEvaluator) {
    const evaluator = safeEvaluator || new SafeEvaluator({ timeoutMs: 500, log: this.#output });
    const blockGates = gates.filter(g => g.severity === 'block');
    try {
      for (const fp of filePaths) {
        const rel = relative(this.#config.projectRoot, fp).replace(/\\/g, '/');

        // 1.10: don't shadow files that no block gate cares about
        if (applicableGates(blockGates, rel).length === 0) {
          continue;
        }

        if (await this.#shadow.has(fp)) continue;

        // 1.2: evaluate before seeding — a violating file gets no baseline.
        // Use the safe evaluator so a ReDoS pattern cannot freeze startup.
        const content = await readFileGuarded(fp, this.#config.maxFileBytes);
        if (content === null) continue;
        const violations = await evaluator.evaluate(gates, content, rel);
        const poisoned = new Set(evaluator.poisonedGateIds);
        const timedOut = applicableGates(blockGates, rel).find(gate => poisoned.has(gate.id));
        if (timedOut) {
          this.#output(
            `  ${ICONS.warn} ${COLORS.yellow}No baseline${COLORS.reset} ${rel} ` +
            `${COLORS.gray}(gate ${timedOut.id} timed out during evaluation)${COLORS.reset}`
          );
          continue;
        }
        if (violations.length > 0) {
          this.#output(
            `  ${ICONS.warn} ${COLORS.yellow}No baseline${COLORS.reset} ${rel} ` +
            `${COLORS.gray}(existing ${violations[0].severity} violation — fix before it can be reverted)${COLORS.reset}`
          );
          continue;
        }

        try {
          await this.#shadow.snapshot(fp);
        } catch (err) {
          this.#report('shadow_write_failed', 'error', `Failed to seed shadow for ${rel}`, { file: rel, error: err });
        }
      }
    } finally {
      // If we created a lazy evaluator, clean it up; caller-owned evaluators
      // are left alone so they can be reused for the startup scan.
      if (!safeEvaluator) {
        await evaluator.dispose();
      }
    }
  }

  /**
   * Print a formatted violation to terminal
   * @param {import('./evaluator.mjs').Violation} violation
   */
  #printViolation(violation) {
    const icon = ICONS[violation.severity] || ICONS.warn;
    const loc = violation.line ? `:${violation.line}` : '';
    const matchStr = violation.match
      ? `${COLORS.gray} → "${violation.match}"${COLORS.reset}`
      : '';

    this.#output(
      `  ${icon} ${COLORS.bold}${violation.gateId}${COLORS.reset} ` +
      `${violation.file}${loc}${matchStr}`
    );
    this.#output(
      `    ${COLORS.gray}${violation.message}${COLORS.reset}`
    );
  }

  /**
   * Print revert notification
   * @param {string} filePath
   */
  #printRevert(filePath) {
    const rel = relative(this.#config.projectRoot, filePath);
    this.#output(
      `  ${ICONS.revert} ${COLORS.red}REVERTED${COLORS.reset} ${rel} ` +
      `${COLORS.gray}(restored from shadow copy)${COLORS.reset}`
    );
  }

  /**
   * Print quarantine notification
   * @param {string} filePath
   * @param {string} quarantinePath
   */
  #printQuarantine(filePath, quarantinePath) {
    const rel = relative(this.#config.projectRoot, filePath);
    this.#output(
      `  ${ICONS.block} ${COLORS.red}QUARANTINED${COLORS.reset} ${rel} ` +
      `${COLORS.gray}(moved to ${quarantinePath})${COLORS.reset}`
    );
  }

  /**
   * Print shadow tamper notification
   * @param {string} filePath
   */
  #printTamper(filePath) {
    const rel = relative(this.#config.projectRoot, filePath);
    this.#output(
      `  ${ICONS.block} ${COLORS.red}SHADOW TAMPERED${COLORS.reset} ${rel} ` +
      `${COLORS.gray}(shadow fingerprint mismatch — refusing revert)${COLORS.reset}`
    );
  }

  /**
   * Append a violation to `.gateinitiative/last-violations.json` for bridge feedback.
   * Keeps only the most recent 50 entries.
   */
  async #recordViolation(violation) {
    try {
      const dir = join(this.#config.projectRoot, '.gateinitiative');
      const path = join(dir, 'last-violations.json');
      await mkdir(dir, { recursive: true });

      let existing = [];
      try {
        const raw = await readFile(path, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          existing = parsed;
        } else if (parsed && Array.isArray(parsed.violations)) {
          existing = parsed.violations;
        }
      } catch { /* file missing or corrupt — start fresh */ }

      existing.push({
        ...violation,
        timestamp: new Date().toISOString(),
      });

      const trimmed = existing.slice(-50);
      await writeFile(path, JSON.stringify({ version: 1, violations: trimmed }, null, 2), 'utf-8');
    } catch (err) {
      this.#report('context_write_failed', 'warn', `Could not write last-violations.json: ${err.message}`, { error: err });
    }
  }

  /** Get current stats */
  get stats() {
    return { ...this.#stats };
  }

  /** Get shadow store (for external use) */
  get shadow() {
    return this.#shadow;
  }
}

/**
 * Print a summary line
 * @param {Object} stats
 * @param {number} gateCount
 */
export function printSummary(stats, gateCount) {
  const { violations, reverts, filesChecked } = stats;

  if (violations === 0) {
    console.log(
      `\n  ${ICONS.pass} ${COLORS.cyan}All clear${COLORS.reset} — ` +
      `${filesChecked} files checked against ${gateCount} gates\n`
    );
  } else {
    console.log(
      `\n  ${COLORS.red}${COLORS.bold}${violations} violation(s)${COLORS.reset} ` +
      `across ${filesChecked} files` +
      (reverts > 0 ? `, ${reverts} reverted` : '') +
      `\n`
    );
  }
}

/**
 * gateinitiative: Health Monitor
 *
 * Centralized self-health logging. Every operational failure that could cause
 * enforcement to silently stop or corrupt state is recorded here as a structured
 * JSONL event with a human-readable remediation hint.
 *
 * Categories:
 *   revert_failed, shadow_write_failed, watcher_error, context_write_failed,
 *   gate_load_error, tamper_suspected, daemon_crash, quarantine_failed,
 *   notify_failed
 *
 * This log is strictly separate from violations.log (which records gate
 * violations). It is the developer-facing "fix gateinitiative" log.
 */

import { appendFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const HEALTH_LOG_FILE = 'health.log';
export const HEALTH_LOG_MAX_BYTES = 1_048_576; // 1 MB

const DEFAULT_HINTS = {
  revert_failed: 'Check shadow store permissions and disk space. The file may need manual review.',
  shadow_write_failed: 'Ensure the platform data directory is writable. Run `gateinit doctor`.',
  watcher_error: 'The watcher may have hit an OS limit (e.g., inotify). Restart gateinitiative or increase the limit.',
  context_write_failed: 'Verify `.gateinitiative/` is writable and not locked by another process.',
  gate_load_error: 'Check `.gates.yml` and docs gate blocks for YAML/regex syntax errors.',
  tamper_suspected: 'A shadow manifest or playbook-state signature mismatch was detected. Investigate external changes.',
  daemon_crash: 'The daemon exited unexpectedly. Review the daemon log and recent health events.',
  quarantine_failed: 'Could not move the violating file out of the project. Check permissions.',
  notify_failed: 'Desktop notification could not be shown. The event was still logged and enforced.',
};

export class HealthMonitor {
  #projectRoot;
  #runtimeDir;
  #logPath;
  #inMemory = [];
  #warnOnce = new Set();

  constructor(projectRoot, runtimeDir) {
    this.#projectRoot = projectRoot;
    this.#runtimeDir = runtimeDir;
    this.#logPath = join(runtimeDir, HEALTH_LOG_FILE);
  }

  /**
   * Report a health event.
   * @param {Object} event
   * @param {string} event.category - Event category
   * @param {'info'|'warn'|'error'|'critical'} [event.severity='error']
   * @param {string} event.message - Human-readable description
   * @param {string} [event.file] - Relative file path, if relevant
   * @param {Error|Object} [event.error] - Optional error detail
   * @param {string} [event.hint] - Optional remediation hint
   */
  async report(event) {
    const severity = event.severity || 'error';
    const category = event.category;
    const hint = event.hint || DEFAULT_HINTS[category] || 'Run `gateinit doctor` for diagnostics.';

    const record = {
      timestamp: new Date().toISOString(),
      category,
      severity,
      message: event.message,
      file: event.file || null,
      hint,
      error: event.error
        ? { message: event.error.message, code: event.error.code || null, stack: event.error.stack || null }
        : null,
    };

    this.#inMemory.push(record);
    if (this.#inMemory.length > 1000) this.#inMemory = this.#inMemory.slice(-500);

    try {
      await mkdir(dirname(this.#logPath), { recursive: true });
      await rotateIfNeeded(this.#logPath);
      await appendFile(this.#logPath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (err) {
      // Absolute last resort — do not let health logging break enforcement.
      if (!this.#warnOnce.has('health_log_write_failed')) {
        console.error('[gateinitiative] Failed to write health.log:', err.message);
        this.#warnOnce.add('health_log_write_failed');
      }
    }
  }

  /**
   * Convenience: report an error with a category.
   */
  async error(category, message, details = {}) {
    await this.report({ category, severity: 'error', message, ...details });
  }

  async warn(category, message, details = {}) {
    await this.report({ category, severity: 'warn', message, ...details });
  }

  async critical(category, message, details = {}) {
    await this.report({ category, severity: 'critical', message, ...details });
  }

  /**
   * Return recent in-memory events, newest first.
   * @param {number} [limit=20]
   */
  recent(limit = 20) {
    return this.#inMemory.slice(-limit).reverse();
  }

  /**
   * Read the tail of the persisted health log.
   * @param {number} [limit=50]
   */
  async tail(limit = 50) {
    try {
      const content = await readFile(this.#logPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      return lines.slice(-limit).map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }

  /**
   * Count events by severity seen in-memory.
   */
  counters() {
    const counts = { info: 0, warn: 0, error: 0, critical: 0 };
    for (const ev of this.#inMemory) counts[ev.severity] = (counts[ev.severity] || 0) + 1;
    return counts;
  }

  /**
   * Get the path to the health log.
   */
  get logPath() {
    return this.#logPath;
  }
}

async function rotateIfNeeded(logPath) {
  try {
    const s = await stat(logPath);
    if (s.size <= HEALTH_LOG_MAX_BYTES) return;

    const content = await readFile(logPath, 'utf-8');
    const keepFrom = Math.max(0, content.length - 512_000);
    const trimmed = content.slice(keepFrom);
    const separator = `\n--- Health log rotated at ${new Date().toISOString()} ---\n\n`;
    await writeFile(logPath, separator + trimmed, 'utf-8');
  } catch {
    // File doesn't exist or can't be read — nothing to rotate
  }
}

/**
 * Compute a stable short id for a pending decision/review item.
 * Not cryptographically secure, but collision-resistant enough for CLI display.
 */
export function decisionId(projectRoot, category, file, timestamp = Date.now()) {
  return createHash('sha1')
    .update(`${projectRoot}|${category}|${file}|${timestamp}`)
    .digest('hex')
    .slice(0, 8);
}

// gateinitiative: Watch Pipeline Orchestrator
//
// Connects the pieces for a single file event:
//   read (once) → gate evaluation → enforcement → playbook check → context detection
//
// Concurrency invariants:
//   - Events for the SAME file are serialized (a revert and a shadow update
//     can never interleave and poison the shadow store).
//   - After a revert, only the exact echo of the revert (matching SHA-256 of
//     the reverted-to content) is swallowed. A different write is treated as a
//     new event, so agent re-violations inside the old suppression window are
//     still enforced. This also breaks the infinite revert loop that occurs when
//     a stale shadow itself violates a gate.

import { resolve, relative, join } from 'node:path';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { applicableGates, readFileGuarded, matchesTrigger } from './evaluator.mjs';
import { SafeEvaluator } from './safe-eval.mjs';
import { enforceContextSignals } from './context-detector.mjs';

const C = {
  bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m',
  red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

/**
 * @typedef {Object} PipelineConfig
 * @property {string} projectRoot
 * @property {'strict'|'warn'|'audit'} mode
 * @property {import('./parser.mjs').Gate[]} gates
 * @property {import('./enforcer.mjs').Enforcer} enforcer
 * @property {import('./context-detector.mjs').ContextDetector} [contextDetector]
 * @property {import('./playbook.mjs').PlaybookEnforcer} [playbookEnforcer]
 * @property {boolean} [contextEnabled=true]
 * @property {boolean} [contextEnforce=false]
 * @property {boolean} [contextEnforceAll=false]
 * @property {number} [maxFileBytes]
 * @property {number} [evalTimeoutMs] - Per-gate regex execution budget (0 disables the worker sandbox)
 * @property {string} [shadowDir] - External data dir override
 * @property {string[]} [gateSourcePatterns] - Patterns that identify gate-definition files
 * @property {import('./health.mjs').HealthMonitor} [health] - Health event sink
 * @property {(signals: Array) => Promise<void>|void} [onContextWritten] - Callback after context.json is written
 * @property {boolean} [verbose=false]
 * @property {(msg: string) => void} [log]
 */

export class Pipeline {
  #cfg;
  #log;
  #safeEval;
  #queues = new Map();        // absolute path → tail promise (per-file serialization)
  #revertedHashes = new Map(); // absolute path → sha256 of content we reverted to

  /** @param {PipelineConfig} config */
  constructor(config) {
    this.#cfg = { contextEnabled: true, verbose: false, ...config };
    this.#log = config.log || ((msg) => console.log(msg));
    this.#safeEval = new SafeEvaluator({
      timeoutMs: this.#cfg.evalTimeoutMs,
      log: (msg) => this.#log(`  ${C.yellow}⚠${C.reset} ${msg}`),
      onSlowGate: (gate, timeoutMs) => {
        if (this.#cfg.health) {
          this.#cfg.health.report({
            category: 'slow_gate',
            severity: 'warn',
            message: `Gate "${gate.id}" exceeded ${timeoutMs}ms regex budget and was disabled for this session (possible ReDoS)`,
          });
        }
      },
    });
  }

  /**
   * Entry point for watcher events. Serializes per file.
   * @param {string} filePath - Absolute path
   * @param {string} event - 'add' | 'change'
   * @returns {Promise<void>} - Resolves when this event is fully processed
   */
  handleEvent(filePath, event) {
    const key = resolve(filePath);
    const prev = this.#queues.get(key) || Promise.resolve();
    const next = prev
      .then(() => this.#process(key, event))
      .catch((err) => {
        this.#log(`  ${C.red}✖${C.reset} pipeline error for ${key}: ${err.message}`);
        if (this.#cfg.health) {
          this.#cfg.health.report({ category: 'pipeline_error', severity: 'error', message: err.message, file: relative(this.#cfg.projectRoot, key).replace(/\\/g, '/'), error: err });
        }
      });

    this.#queues.set(key, next);
    next.finally(() => {
      if (this.#queues.get(key) === next) this.#queues.delete(key);
    });
    return next;
  }

  async #process(filePath, event) {
    const { projectRoot, mode, gates, enforcer } = this.#cfg;
    const rel = relative(projectRoot, filePath).replace(/\\/g, '/');
    const timestamp = new Date().toLocaleTimeString();

    const gateSourceChanged = this.#cfg.gateSourcePatterns?.some(p => matchesTrigger(rel, p));
    const protectedPath = this.#cfg.protectedPaths?.includes(resolve(filePath));
    if (gateSourceChanged) {
      this.#log(`  ${C.yellow}⚠${C.reset} ${C.bold}GATE SOURCE CHANGED${C.reset} ${rel} ${C.gray}(restart gateinitiative to reload definitions)${C.reset}`);
    }

    // ── Deletion handling ────────────────────────────────────────────
    // Deleting a governed file must not bypass gates. Restore from shadow in strict mode.
    if (event === 'unlink') {
      const governed = protectedPath || applicableGates(gates, rel).length > 0;
      if (governed) {
        this.#log(`  ${C.gray}${timestamp}${C.reset} ${C.dim}unlink${C.reset} ${rel} — governed file deleted`);
        if (mode === 'strict') {
          const result = await enforcer.shadow.restoreDeleted(filePath);
          if (result.success) {
            this.#log(`  ${C.red}↩${C.reset} ${C.red}RESTORED${C.reset} ${rel} ${C.gray}(restored from shadow after deletion)${C.reset}`);
          } else if (result.tamper) {
            this.#log(`  ${C.red}✖${C.reset} ${C.red}SHADOW TAMPERED${C.reset} ${rel} ${C.gray}(refusing restore)${C.reset}`);
          }
        }
      } else if (this.#cfg.verbose) {
        this.#log(`  ${C.gray}${timestamp} unlink ${rel}${C.reset}`);
      }
      return;
    }

    const content = await readFileGuarded(filePath, this.#cfg.maxFileBytes);
    if (content === null) return; // Deleted, oversized, or binary

    // Swallow only the exact echo of our own revert (hash must match reverted-to content).
    // A different write inside the old suppression window is now treated as a new event.
    const expectedHash = this.#revertedHashes.get(filePath);
    if (expectedHash && this.#hash(content) === expectedHash) {
      this.#revertedHashes.delete(filePath);
      return;
    }

    let allViolations = [];

    // ── Gate evaluation ──────────────────────────────────────────────
    const gateViolations = applicableGates(gates, rel).length > 0
      ? await this.#safeEval.evaluate(gates, content, rel)
      : [];
    if (protectedPath) {
      gateViolations.push({
        gateId: 'gateinitiative:self-protection',
        file: rel,
        severity: 'block',
        message: 'Gate configuration is protected and may only be changed after re-trusting it.',
        source: 'gateinitiative:built-in',
        overridable: false,
      });
    }
    allViolations = allViolations.concat(gateViolations);

    if (gateViolations.length > 0) {
      this.#log(`  ${C.gray}${timestamp}${C.reset} ${C.dim}${event}${C.reset} ${rel}`);
      const result = await enforcer.enforce(filePath, gateViolations);
      if (result.reverted) {
        await this.#recordRevertedHash(filePath);
      }
      if (result.quarantined) return; // file is gone, nothing more to do
    }

    // ── Playbook enforcement (sequencing rules) ──────────────────────
    const playbookEnforcer = this.#cfg.playbookEnforcer;
    if (playbookEnforcer && playbookEnforcer.count > 0) {
      const pbResult = await playbookEnforcer.evaluateEdit(rel);
      if (pbResult.governed && pbResult.violations.length > 0) {
        this.#log(`  ${C.gray}${timestamp}${C.reset} ${C.yellow}⚡ PLAYBOOK${C.reset} ${C.bold}${pbResult.playbook}${C.reset} — ${rel}`);
        for (const v of pbResult.violations) {
          const icon = v.severity === 'block' ? `${C.red}✖` : `${C.yellow}⚠`;
          this.#log(`    ${icon}${C.reset} [${v.id}] ${v.message}`);
          if (v.age_seconds !== null) {
            this.#log(`      ${C.gray}Evidence age: ${v.age_seconds}s (TTL exceeded)${C.reset}`);
          }
        }
        allViolations = allViolations.concat(pbResult.violations.map(v => ({
          gateId: `playbook:${pbResult.playbook}:${v.id}`,
          file: rel,
          severity: v.severity,
          message: v.message,
          source: `playbook:${pbResult.playbook}`,
        })));
        const hasBlock = pbResult.violations.some(v => v.severity === 'block');
        if (hasBlock && mode === 'strict') {
          const result = await enforcer.enforce(filePath, pbResult.violations.map(v => ({
            gateId: `playbook:${pbResult.playbook}:${v.id}`,
            file: rel,
            severity: v.severity,
            message: v.message,
            source: `playbook:${pbResult.playbook}`,
          })));
          if (result.reverted) {
            await this.#recordRevertedHash(filePath);
          }
          if (result.quarantined) return;
        }
      }
    }

    // ── Context detection (independent of gate pass/fail) ────────────
    const detector = this.#cfg.contextDetector;
    if (this.#cfg.contextEnabled && detector) {
      const signals = detector.detect(rel, content);
      for (const signal of signals) {
        this.#printContextSignal(signal, timestamp);
      }

      if (signals.length > 0) {
        await this.#writeContextSignals(signals);
      }

      if (this.#cfg.contextEnforce && signals.length > 0) {
        const contextViolations = await enforceContextSignals(
          signals, projectRoot, { enforceAll: this.#cfg.contextEnforceAll, shadowDir: this.#cfg.shadowDir }
        );
        for (const v of contextViolations) {
          const icon = v.severity === 'block' ? `${C.red}✖` : `${C.yellow}⚠`;
          this.#log(`  ${C.gray}${timestamp}${C.reset} ${icon}${C.reset} ${C.bold}CONTEXT${C.reset} ${v.message}`);
          this.#log(v.age_seconds !== null
            ? `    ${C.gray}Evidence age: ${v.age_seconds}s (TTL exceeded)${C.reset}`
            : `    ${C.gray}No read evidence found in playbook-state.json${C.reset}`);
        }
        allViolations = allViolations.concat(contextViolations.map(v => ({
          gateId: v.id,
          file: rel,
          severity: v.severity,
          message: v.message,
          source: 'context-enforcer',
        })));
        const hasBlock = contextViolations.some(v => v.severity === 'block');
        if (hasBlock && mode === 'strict') {
          const result = await enforcer.enforce(filePath, contextViolations.map(v => ({
            gateId: v.id,
            file: rel,
            severity: v.severity,
            message: v.message,
            source: 'context-enforcer',
          })));
          if (result.reverted) {
            await this.#recordRevertedHash(filePath);
          }
          if (result.quarantined) return;
        }
      }
    }

    // Only mark clean if gates, playbook, and context all pass.
    // Previously markClean ran before playbook/context checks, allowing a
    // strict-mode revert to copy the offending content back in as the new shadow.
    if (allViolations.length === 0) {
      // 1.10: only snapshot files covered by block-severity gates; shadows are
      // only used for block reverts, so snapshotting other files wastes space
      // and can retain since-removed secrets.
      const blockGates = gates.filter(g => g.severity === 'block');
      const shouldSnapshot = blockGates.length > 0 && applicableGates(blockGates, rel).length > 0;
      await enforcer.markClean(filePath, shouldSnapshot);
      if (this.#cfg.verbose) {
        this.#log(`  ${C.gray}${timestamp} ${event} ${rel} — ok${C.reset}`);
      }
    }
  }

  #hash(content) {
    return createHash('sha256').update(content).digest('hex');
  }

  async #recordRevertedHash(filePath) {
    try {
      const revertedContent = await readFile(filePath, 'utf-8');
      this.#revertedHashes.set(filePath, this.#hash(revertedContent));
    } catch {
      // If read fails, don't suppress the next event; process it normally
      this.#revertedHashes.delete(filePath);
    }
  }

  #printContextSignal(signal, timestamp) {
    const confStr = signal.confidence >= 0.8
      ? ''
      : ` ${C.gray}(${Math.round(signal.confidence * 100)}%)${C.reset}`;
    this.#log(
      `  ${C.gray}${timestamp}${C.reset} ${C.cyan}⟡${C.reset} ` +
      `${C.bold}LOAD${C.reset} ${C.cyan}${signal.contextFile}${C.reset}${confStr}`
    );
    this.#log(`    ${C.gray}${signal.reason}${C.reset}`);
  }

  async #writeContextSignals(signals) {
    const dir = join(this.#cfg.projectRoot, '.gateinitiative');
    try {
      await mkdir(dir, { recursive: true });
      const payload = {
        version: 1,
        timestamp: new Date().toISOString(),
        signals: signals.map(s => ({
          contextFile: s.contextFile,
          reason: s.reason,
          trigger: s.trigger,
          confidence: s.confidence,
        })),
      };
      await writeFile(join(dir, 'context.json'), JSON.stringify(payload, null, 2));
      if (this.#cfg.onContextWritten) {
        try {
          await this.#cfg.onContextWritten(signals);
        } catch (err) {
          if (this.#cfg.health) {
            this.#cfg.health.report({ category: 'context_write_failed', severity: 'warn', message: `onContextWritten callback failed: ${err.message}`, error: err });
          }
        }
      }
    } catch (err) {
      if (this.#cfg.health) {
        this.#cfg.health.report({ category: 'context_write_failed', severity: 'warn', message: `Failed to write context.json: ${err.message}`, error: err });
      }
    }
  }

  /** Wait for all in-flight events to finish (used by tests and shutdown) */
  async drain() {
    while (this.#queues.size > 0) {
      await Promise.all([...this.#queues.values()]);
    }
  }

  /** Release resources (evaluation worker). Call on shutdown. */
  async dispose() {
    await this.#safeEval.dispose();
  }
}

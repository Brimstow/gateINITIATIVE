// gateinitiative: Safe (timeout-bounded) Gate Evaluation
//
// Executes gate regexes in a persistent worker thread with a per-gate
// execution timeout. This is the hard backstop behind the load-time
// looksUnsafeRegex() heuristic: even a pattern the heuristic misses cannot
// stall the daemon for more than `timeoutMs` per gate.
//
// Behavior on timeout:
//   - The worker is terminated and respawned.
//   - The offending gate is "poisoned" (skipped for the rest of the session)
//     and reported via onSlowGate — fail-open with visibility, mirroring the
//     project's existing enforcement philosophy.
//   - Evaluation continues with the remaining gates, so one bad pattern
//     never disables the others.
//
// If worker threads are unavailable for any reason, evaluation falls back
// to the in-process synchronous path (fail-open, warned once).

import { Worker } from 'node:worker_threads';
import { relative } from 'node:path';
import { applicableGates, evaluateContent, readFileGuarded } from './evaluator.mjs';

/** Per-gate regex execution budget. Generous vs. the <60ms whole-file target. */
export const DEFAULT_GATE_TIMEOUT_MS = 500;

const noop = () => {};

export class SafeEvaluator {
  #timeoutMs;
  #onSlowGate;
  #log;
  #worker = null;
  #workerFailed = false;
  #poisoned = new Set();
  #queue = Promise.resolve(); // serialize evaluations through the single worker
  #nextId = 1;

  /**
   * @param {Object} [options]
   * @param {number} [options.timeoutMs] - Per-gate execution budget in ms
   * @param {(gate: {id: string, source?: string}, timeoutMs: number) => void} [options.onSlowGate]
   *   Called once when a gate is poisoned after exceeding its budget
   * @param {(msg: string) => void} [options.log]
   */
  constructor(options = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    this.#onSlowGate = options.onSlowGate || noop;
    this.#log = options.log || noop;
  }

  /** Gate ids disabled this session after exceeding the execution budget */
  get poisonedGateIds() {
    return [...this.#poisoned];
  }

  /**
   * Evaluate gates against content with a per-gate timeout.
   * Drop-in async equivalent of evaluateContent().
   * @param {import('./parser.mjs').Gate[]} gates
   * @param {string} content
   * @param {string} relPath
   * @returns {Promise<import('./evaluator.mjs').Violation[]>}
   */
  evaluate(gates, content, relPath) {
    const active = applicableGates(gates, relPath).filter(g => !this.#poisoned.has(g.id));
    if (active.length === 0) return Promise.resolve([]);

    // Synchronous fallback path (timeout disabled or worker unavailable)
    if (this.#timeoutMs === 0 || this.#workerFailed) {
      return Promise.resolve(evaluateContent(active, content, relPath));
    }

    const run = this.#queue.then(() => this.#runInWorker(active, content, relPath));
    // Keep the chain alive even if a run rejects
    this.#queue = run.catch(() => {});
    return run;
  }

  /**
   * Send one evaluation request to the worker. On per-gate timeout:
   * terminate, poison the running gate, respawn, and continue with the rest.
   * @returns {Promise<import('./evaluator.mjs').Violation[]>}
   */
  async #runInWorker(gates, content, relPath) {
    const violations = [];
    let remaining = gates;

    while (remaining.length > 0) {
      let worker;
      try {
        worker = this.#getWorker();
      } catch (err) {
        this.#workerFailed = true;
        this.#log(`safe-eval: worker unavailable (${err.message}) — falling back to in-process evaluation`);
        return violations.concat(evaluateContent(remaining, content, relPath));
      }

      const outcome = await this.#dispatch(worker, remaining, content, relPath);
      violations.push(...outcome.violations);

      if (outcome.done) break;

      // Timeout: poison the gate that was running, respawn, resume with the rest
      const slow = outcome.slowGate;
      if (slow) {
        this.#poisoned.add(slow.id);
        this.#onSlowGate(slow, this.#timeoutMs);
        this.#log(
          `safe-eval: gate "${slow.id}" exceeded ${this.#timeoutMs}ms and was disabled for this session (possible ReDoS)`
        );
      }
      await this.#destroyWorker();

      const completed = new Set(outcome.completedIds);
      const next = remaining.filter(g => !completed.has(g.id) && (!slow || g.id !== slow.id));

      // No progress (worker died before attributing a gate): fall back to
      // in-process evaluation rather than respawn-looping forever.
      if (next.length === remaining.length) {
        this.#log('safe-eval: worker made no progress — falling back to in-process evaluation for this file');
        return violations.concat(evaluateContent(next, content, relPath));
      }
      remaining = next;
    }

    return violations;
  }

  /**
   * Post one request and collect results until 'done' or a per-gate timeout.
   * The timer restarts on every message, so the budget applies to each gate
   * individually rather than the whole file.
   * @returns {Promise<{done: boolean, violations: Array, completedIds: string[], slowGate: Object|null}>}
   */
  #dispatch(worker, gates, content, relPath) {
    const id = this.#nextId++;

    return new Promise((resolvePromise) => {
      const violations = [];
      const completedIds = [];
      let currentGate = null;
      let timer = null;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        resolvePromise(result);
      };

      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          finish({ done: false, violations, completedIds, slowGate: currentGate });
        }, this.#timeoutMs);
      };

      const onMessage = (msg) => {
        if (msg.id !== id) return; // stale message from a terminated request
        if (msg.type === 'gate-start') {
          currentGate = gates.find(g => g.id === msg.gateId) || { id: msg.gateId };
          resetTimer();
        } else if (msg.type === 'gate-result') {
          if (msg.violation) violations.push(msg.violation);
          completedIds.push(msg.gateId);
          currentGate = null;
          resetTimer();
        } else if (msg.type === 'done') {
          finish({ done: true, violations, completedIds, slowGate: null });
        }
      };

      const onError = () => {
        finish({ done: false, violations, completedIds, slowGate: currentGate });
      };
      const onExit = () => {
        finish({ done: false, violations, completedIds, slowGate: currentGate });
      };

      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      resetTimer();
      worker.postMessage({ id, gates, content, relPath });
    });
  }

  #getWorker() {
    if (!this.#worker) {
      this.#worker = new Worker(new URL('./safe-eval-worker.mjs', import.meta.url));
      // Don't hold the process open — the daemon's own lifecycle governs exit
      this.#worker.unref();
    }
    return this.#worker;
  }

  async #destroyWorker() {
    const worker = this.#worker;
    this.#worker = null;
    if (worker) {
      try {
        await worker.terminate();
      } catch { /* already dead */ }
    }
  }

  /** Terminate the worker (shutdown / test cleanup). Safe to call repeatedly. */
  async dispose() {
    await this.#destroyWorker();
  }
}

/**
 * Timeout-bounded equivalent of evaluateFiles() for batch paths
 * (`gateinit check`, daemon startup scan). A catastrophically backtracking
 * pattern can no longer stall CI or daemon startup: the offending gate is
 * poisoned and the scan continues.
 *
 * File reads run with bounded concurrency; evaluation is serialized through
 * the evaluator's single worker.
 *
 * @param {SafeEvaluator} evaluator
 * @param {import('./parser.mjs').Gate[]} gates
 * @param {string[]} filePaths - Absolute paths
 * @param {string} projectRoot
 * @param {Object} [options]
 * @param {number} [options.concurrency=16]
 * @param {number} [options.maxFileBytes]
 * @returns {Promise<import('./evaluator.mjs').Violation[]>}
 */
export async function evaluateFilesSafe(evaluator, gates, filePaths, projectRoot, options = {}) {
  const concurrency = options.concurrency || 16;
  const results = [];
  let index = 0;

  async function worker() {
    while (index < filePaths.length) {
      const fp = filePaths[index++];
      const content = await readFileGuarded(fp, options.maxFileBytes);
      if (content === null) continue; // missing, oversized, or binary
      const relPath = relative(projectRoot, fp).replace(/\\/g, '/');
      results.push(await evaluator.evaluate(gates, content, relPath));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, filePaths.length) }, worker));
  return results.flat();
}

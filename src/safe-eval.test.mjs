// gateinitiative: SafeEvaluator tests
// Run with: node --test src/safe-eval.test.mjs

import { describe, it, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SafeEvaluator, evaluateFilesSafe } from './safe-eval.mjs';
import { evaluateContent, evaluateFiles } from './evaluator.mjs';

const gate = (id, pattern, extra = {}) => ({
  id,
  trigger: '**/*.ts',
  severity: 'block',
  pattern,
  message: `msg-${id}`,
  overridable: true,
  ...extra,
});

// A pattern that catastrophically backtracks on this input for far longer
// than any reasonable timeout. The 's' flag routes it through whole-file
// matching (per-line splitting would shorten the input).
const REDOS_GATE = gate('redos', '/(a+)+b$/s');
const REDOS_CONTENT = 'a'.repeat(40) + 'c';

const evaluators = [];
function makeEvaluator(options) {
  const ev = new SafeEvaluator(options);
  evaluators.push(ev);
  return ev;
}

after(async () => {
  await Promise.all(evaluators.map(ev => ev.dispose()));
});

describe('SafeEvaluator', () => {
  it('matches evaluateContent for well-behaved gates', async () => {
    const gates = [
      gate('no-console', '/console\\.log\\(/'),
      gate('no-any', '/:\\s*any\\b/'),
    ];
    const content = 'const x: any = 1;\nconsole.log(x);\n';
    const ev = makeEvaluator();

    const viaWorker = await ev.evaluate(gates, content, 'src/a.ts');
    const viaSync = evaluateContent(gates, content, 'src/a.ts');
    assert.deepEqual(viaWorker, viaSync);
    assert.equal(viaWorker.length, 2);
  });

  it('returns [] when no gates apply', async () => {
    const ev = makeEvaluator();
    const result = await ev.evaluate([gate('g', '/x/')], 'x', 'README.md');
    assert.deepEqual(result, []);
  });

  it('terminates a catastrophic pattern, poisons the gate, and keeps the rest', async () => {
    const slow = [];
    const ev = makeEvaluator({
      timeoutMs: 200,
      onSlowGate: (g, ms) => slow.push({ id: g.id, ms }),
    });
    const gates = [
      gate('before', '/console\\.log\\(/'),
      REDOS_GATE,
      gate('after', '/eslint-disable/'),
    ];
    const content = `console.log(1); // eslint-disable\n${REDOS_CONTENT}`;

    const start = Date.now();
    const violations = await ev.evaluate(gates, content, 'src/a.ts');
    const elapsed = Date.now() - start;

    // Hard guarantee: the ReDoS pattern did not stall evaluation
    assert.ok(elapsed < 5000, `evaluation took ${elapsed}ms`);
    // Gates before AND after the poisoned one still evaluated
    const ids = violations.map(v => v.gateId).sort();
    assert.deepEqual(ids, ['after', 'before']);
    // The offending gate was reported and poisoned
    assert.deepEqual(slow, [{ id: 'redos', ms: 200 }]);
    assert.deepEqual(ev.poisonedGateIds, ['redos']);
  });

  it('skips a poisoned gate on subsequent evaluations', async () => {
    const slow = [];
    const ev = makeEvaluator({ timeoutMs: 200, onSlowGate: (g) => slow.push(g.id) });

    await ev.evaluate([REDOS_GATE], REDOS_CONTENT, 'src/a.ts');
    assert.deepEqual(slow, ['redos']);

    // Second run: poisoned gate is skipped instantly, no second report
    const start = Date.now();
    const violations = await ev.evaluate([REDOS_GATE], REDOS_CONTENT, 'src/a.ts');
    assert.ok(Date.now() - start < 100);
    assert.deepEqual(violations, []);
    assert.deepEqual(slow, ['redos']);
  });

  it('recovers after a timeout: worker respawns for later evaluations', async () => {
    const ev = makeEvaluator({ timeoutMs: 200 });
    await ev.evaluate([REDOS_GATE], REDOS_CONTENT, 'src/a.ts');

    const gates = [gate('ok', '/TODO/')];
    const violations = await ev.evaluate(gates, 'x // TODO fix', 'src/b.ts');
    assert.equal(violations.length, 1);
    assert.equal(violations[0].gateId, 'ok');
  });

  it('serializes concurrent evaluations without cross-talk', async () => {
    const ev = makeEvaluator();
    const g = [gate('g1', '/marker/')];
    const [a, b, c] = await Promise.all([
      ev.evaluate(g, 'has marker', 'src/a.ts'),
      ev.evaluate(g, 'clean', 'src/b.ts'),
      ev.evaluate(g, 'another marker', 'src/c.ts'),
    ]);
    assert.equal(a.length, 1);
    assert.equal(b.length, 0);
    assert.equal(c.length, 1);
  });

  it('timeoutMs: 0 disables the worker (sync fallback)', async () => {
    const ev = makeEvaluator({ timeoutMs: 0 });
    const gates = [gate('g', '/foo/')];
    const violations = await ev.evaluate(gates, 'foo bar', 'src/a.ts');
    assert.equal(violations.length, 1);
  });

  it('dispose is idempotent', async () => {
    const ev = makeEvaluator();
    await ev.evaluate([gate('g', '/x/')], 'x', 'src/a.ts');
    await ev.dispose();
    await ev.dispose();
  });
});

describe('evaluateFilesSafe', () => {
  const TMP = join(process.cwd(), '.tmp-safe-batch-test');

  beforeEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    await mkdir(join(TMP, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it('matches evaluateFiles for well-behaved gates', async () => {
    const a = join(TMP, 'src', 'a.ts');
    const b = join(TMP, 'src', 'b.ts');
    await writeFile(a, 'console.log(1);\n');
    await writeFile(b, 'const clean = 1;\n');

    const gates = [gate('no-console', '/console\\.log\\(/')];
    const ev = makeEvaluator();
    const safe = await evaluateFilesSafe(ev, gates, [a, b], TMP);
    const sync = await evaluateFiles(gates, [a, b], TMP);
    assert.deepEqual(safe, sync);
    assert.equal(safe.length, 1);
    assert.equal(safe[0].file, 'src/a.ts');
  });

  it('a ReDoS gate cannot stall a batch scan (check / startup scan)', async () => {
    const bad = join(TMP, 'src', 'bad.ts');
    const good = join(TMP, 'src', 'good.ts');
    await writeFile(bad, REDOS_CONTENT);
    await writeFile(good, 'console.log(1);\n');

    const slow = [];
    const ev = makeEvaluator({ timeoutMs: 200, onSlowGate: (g) => slow.push(g.id) });
    const gates = [REDOS_GATE, gate('no-console', '/console\\.log\\(/')];

    const start = Date.now();
    const violations = await evaluateFilesSafe(ev, gates, [bad, good], TMP);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 5000, `batch scan took ${elapsed}ms`);
    assert.deepEqual(slow, ['redos']);
    // The well-behaved gate still evaluated across the batch
    assert.ok(violations.some(v => v.gateId === 'no-console' && v.file === 'src/good.ts'));
  });

  it('skips missing files without failing the batch', async () => {
    const missing = join(TMP, 'src', 'nope.ts');
    const ev = makeEvaluator();
    const violations = await evaluateFilesSafe(ev, [gate('g', '/x/')], [missing], TMP);
    assert.deepEqual(violations, []);
  });
});

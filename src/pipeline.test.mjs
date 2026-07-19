// gateinitiative: Pipeline orchestrator tests
// Run with: node --test src/pipeline.test.mjs

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Enforcer } from './enforcer.mjs';
import { Pipeline } from './pipeline.mjs';

const TMP = join(process.cwd(), '.tmp-pipeline-test');

async function freshDir() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(join(TMP, 'src'), { recursive: true });
}

async function cleanup() {
  await rm(TMP, { recursive: true, force: true });
}

describe('Pipeline', () => {
  beforeEach(freshDir);
  afterEach(cleanup);

  it('reverts a block-severity violation in strict mode (with a baseline shadow)', async () => {
    const file = join(TMP, 'src', 'app.ts');
    await writeFile(file, 'const good = 1;\n');

    const gates = [
      { id: 'no-eval', trigger: '**/*.ts', severity: 'block', pattern: '/eval\\(/', message: 'no eval', source: 't' },
    ];

    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    await enforcer.initShadows([file], gates);

    const pipeline = new Pipeline({
      projectRoot: TMP,
      mode: 'strict',
      gates,
      enforcer,
      contextEnabled: false,
      log: () => {},
    });

    // Write a violating change and process it as a watcher event would
    await writeFile(file, 'eval("evil")\n');
    await pipeline.handleEvent(file, 'change');

    // The file should have been reverted to the shadow baseline
    assert.equal(await readFile(file, 'utf-8'), 'const good = 1;\n');
    assert.equal(enforcer.stats.reverts, 1);
  });

  it('reverts edits to a protected gate configuration path', async () => {
    const file = join(TMP, '.gates.yml');
    await writeFile(file, 'version: 1\n');
    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    await enforcer.shadow.snapshot(file);
    const pipeline = new Pipeline({
      projectRoot: TMP,
      mode: 'strict',
      gates: [],
      enforcer,
      protectedPaths: [file],
      contextEnabled: false,
      log: () => {},
    });

    await writeFile(file, 'version: 1\n# disabled\n');
    await pipeline.handleEvent(file, 'change');

    assert.equal(await readFile(file, 'utf-8'), 'version: 1\n');
    assert.equal(enforcer.stats.reverts, 1);
  });

  it('does not revert in warn mode', async () => {
    const file = join(TMP, 'src', 'app.ts');
    await writeFile(file, 'const good = 1;\n');

    const gates = [
      { id: 'no-eval', trigger: '**/*.ts', severity: 'block', pattern: '/eval\\(/', message: 'no eval', source: 't' },
    ];

    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'warn', output: () => {} });
    await enforcer.initShadows([file], gates);

    const pipeline = new Pipeline({
      projectRoot: TMP,
      mode: 'warn',
      gates,
      enforcer,
      contextEnabled: false,
      log: () => {},
    });

    await writeFile(file, 'eval("evil")\n');
    await pipeline.handleEvent(file, 'change');

    assert.equal(await readFile(file, 'utf-8'), 'eval("evil")\n');
    assert.equal(enforcer.stats.reverts, 0);
  });

  it('updates the shadow when a file passes all gates', async () => {
    const file = join(TMP, 'src', 'app.ts');
    await writeFile(file, 'v1\n');

    const gates = [
      { id: 'no-eval', trigger: '**/*.ts', severity: 'block', pattern: '/eval\\(/', message: 'no eval', source: 't' },
    ];

    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    await enforcer.initShadows([file], gates);

    const pipeline = new Pipeline({
      projectRoot: TMP,
      mode: 'strict',
      gates,
      enforcer,
      contextEnabled: false,
      log: () => {},
    });

    // A clean edit becomes the new known-good state (shadow updates)
    await writeFile(file, 'const clean = 2;\n');
    await pipeline.handleEvent(file, 'change');

    // Now write a violation — revert should land on "const clean = 2", not "v1"
    await writeFile(file, 'eval("x")\n');
    await pipeline.handleEvent(file, 'change');

    assert.equal(await readFile(file, 'utf-8'), 'const clean = 2;\n');
  });

  it('serializes events for the same file (no interleaving)', async () => {
    const file = join(TMP, 'src', 'app.ts');
    await writeFile(file, '0\n');

    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'warn', output: () => {} });

    const gates = [
      { id: 'g', trigger: '**/*.ts', severity: 'warn', pattern: '/bad/', message: 'm', source: 't' },
    ];

    const order = [];
    const pipeline = new Pipeline({
      projectRoot: TMP,
      mode: 'warn',
      gates,
      enforcer,
      contextEnabled: false,
      log: () => {},
    });

    // Stagger several events; they should be processed in arrival order, not interleaved
    const p1 = pipeline.handleEvent(file, 'change').then(() => order.push(1));
    await writeFile(file, '1\n');
    const p2 = pipeline.handleEvent(file, 'change').then(() => order.push(2));
    await writeFile(file, '2\n');
    const p3 = pipeline.handleEvent(file, 'change').then(() => order.push(3));

    await Promise.all([p1, p2, p3]);
    assert.deepEqual(order, [1, 2, 3]);
  });

  it('defers markClean until after playbook enforcement (0.1)', async () => {
    const file = join(TMP, 'src', 'app.ts');
    await writeFile(file, 'const good = 1;\n');

    const gates = [
      { id: 'no-eval', trigger: '**/*.ts', severity: 'block', pattern: '/eval\\(/', message: 'no eval', source: 't' },
    ];

    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    await enforcer.initShadows([file], gates); // baseline is the good content

    const playbookEnforcer = {
      count: 1,
      evaluateEdit: async () => ({
        governed: true,
        playbook: 'test-pb',
        violations: [{ id: 'read-docs', severity: 'block', message: 'read the docs', age_seconds: null }],
      }),
    };

    const pipeline = new Pipeline({
      projectRoot: TMP,
      mode: 'strict',
      gates,
      enforcer,
      playbookEnforcer,
      contextEnabled: false,
      log: () => {},
    });

    // Write new content that passes gates but violates playbook
    await writeFile(file, 'const changed = 2;\n');
    await pipeline.handleEvent(file, 'change');

    // Because markClean was deferred until after playbook enforcement, the shadow
    // still contains the original good content, so the playbook violation reverts
    // the file instead of becoming a no-op.
    assert.equal(await readFile(file, 'utf-8'), 'const good = 1;\n');
    assert.equal(enforcer.stats.reverts, 1);
  });

  it('re-enforces a different write inside the old suppression window (0.2)', async () => {
    const file = join(TMP, 'src', 'app.ts');
    await writeFile(file, 'const good = 1;\n');

    const gates = [
      { id: 'no-eval', trigger: '**/*.ts', severity: 'block', pattern: '/eval\\(/', message: 'no eval', source: 't' },
    ];

    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    await enforcer.initShadows([file], gates);

    const pipeline = new Pipeline({
      projectRoot: TMP,
      mode: 'strict',
      gates,
      enforcer,
      contextEnabled: false,
      log: () => {},
    });

    // First violation is reverted
    await writeFile(file, 'eval("first")\n');
    await pipeline.handleEvent(file, 'change');
    assert.equal(await readFile(file, 'utf-8'), 'const good = 1;\n');
    assert.equal(enforcer.stats.reverts, 1);

    // A different violation immediately after must not be swallowed by the old
    // time-based suppression window. Hash-based suppression only ignores the
    // exact echo of the revert.
    await writeFile(file, 'eval("second")\n');
    await pipeline.handleEvent(file, 'change');
    assert.equal(await readFile(file, 'utf-8'), 'const good = 1;\n');
    assert.equal(enforcer.stats.reverts, 2);
  });

  it('restores a deleted governed file in strict mode (0.4)', async () => {
    const file = join(TMP, 'src', 'app.ts');
    await writeFile(file, 'const good = 1;\n');

    const gates = [
      { id: 'no-eval', trigger: '**/*.ts', severity: 'block', pattern: '/eval\\(/', message: 'no eval', source: 't' },
    ];

    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    await enforcer.initShadows([file], gates);

    const pipeline = new Pipeline({
      projectRoot: TMP,
      mode: 'strict',
      gates,
      enforcer,
      contextEnabled: false,
      log: () => {},
    });

    await rm(file);
    await pipeline.handleEvent(file, 'unlink');

    assert.equal(await readFile(file, 'utf-8'), 'const good = 1;\n');
  });

  it('alerts when gate-definition sources change (1.3)', async () => {
    const gateFile = join(TMP, '.gates.yml');
    await writeFile(gateFile, 'id: test\n');

    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'warn', output: () => {} });
    const logs = [];
    const pipeline = new Pipeline({
      projectRoot: TMP,
      mode: 'warn',
      gates: [],
      enforcer,
      contextEnabled: false,
      gateSourcePatterns: ['**/.gates.yml'],
      log: (msg) => logs.push(msg),
    });

    await pipeline.handleEvent(gateFile, 'change');
    assert.ok(logs.some(l => l.includes('GATE SOURCE CHANGED')));
  });
});

// gateinitiative: Enforcer + ShadowStore Tests
// Run with: node --test src/enforcer.test.mjs

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm, readFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Enforcer, ShadowStore } from './enforcer.mjs';

const TMP = join(process.cwd(), '.tmp-enforcer-test');

async function freshDir() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(join(TMP, 'src'), { recursive: true });
}

async function cleanup() {
  await rm(TMP, { recursive: true, force: true });
}

describe('ShadowStore', () => {
  beforeEach(freshDir);
  afterEach(cleanup);

  it('snapshots and reverts a file', async () => {
    const store = new ShadowStore(TMP, TMP);
    const file = join(TMP, 'src', 'app.ts');
    await writeFile(file, 'const original = 1;\n');

    await store.snapshot(file);
    assert.equal(await store.has(file), true);

    // Mutate
    await writeFile(file, 'const broken = 2;\n');
    const result = await store.revert(file);
    assert.equal(result.success, true);

    const content = await readFile(file, 'utf-8');
    assert.equal(content, 'const original = 1;\n');
  });

  it('revert returns false when no shadow exists', async () => {
    const store = new ShadowStore(TMP, TMP);
    const file = join(TMP, 'src', 'new.ts');
    await writeFile(file, 'x');
    const result = await store.revert(file);
    assert.equal(result.success, false);
  });

  it('has() returns false for never-snapshotted file', async () => {
    const store = new ShadowStore(TMP, TMP);
    assert.equal(await store.has(join(TMP, 'never.ts')), false);
  });

  it('update() overwrites the shadow with current content', async () => {
    const store = new ShadowStore(TMP, TMP);
    const file = join(TMP, 'src', 'app.ts');
    await writeFile(file, 'v1\n');
    await store.update(file);
    await writeFile(file, 'v2\n');
    await store.update(file); // v2 is now the known-good state
    await writeFile(file, 'bad\n');
    const result = await store.revert(file);
    assert.equal(result.success, true);
    assert.equal(await readFile(file, 'utf-8'), 'v2\n');
  });

  it('prune() removes shadows older than the threshold', async () => {
    const store = new ShadowStore(TMP, TMP);
    const file = join(TMP, 'src', 'old.ts');
    await writeFile(file, 'old\n');
    await store.snapshot(file);

    // Backdate the shadow's mtime by touching it to an old time
    const shadowPath = join(store.shadowDir, 'src', 'old.ts');
    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 days ago
    await new Promise((res, rej) => {
      import('node:fs').then(fs => fs.utimes(shadowPath, oldTime, oldTime, err => err ? rej(err) : res()));
    });

    const removed = await store.prune(30 * 24 * 60 * 60 * 1000); // 30-day threshold
    assert.equal(removed, 1);
    assert.equal(await store.has(file), false);
  });
});

describe('Enforcer', () => {
  beforeEach(freshDir);
  afterEach(cleanup);

  it('enforce() updates shadow when file passes (no violations)', async () => {
    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'warn', output: () => {} });
    const file = join(TMP, 'src', 'clean.ts');
    await writeFile(file, 'const x = 1;\n');

    await enforcer.enforce(file, []);
    assert.equal(await enforcer.shadow.has(file), true);
    assert.equal(enforcer.stats.filesChecked, 1);
    assert.equal(enforcer.stats.violations, 0);
  });

  it('enforce() logs and alerts on violations in warn mode (no revert)', async () => {
    const messages = [];
    const enforcer = new Enforcer({
      projectRoot: TMP,
      shadowDir: TMP,
      mode: 'warn',
      output: (m) => messages.push(m),
    });
    const file = join(TMP, 'src', 'bad.ts');
    await writeFile(file, 'console.log("leak")\n');

    // Seed a shadow so a revert *could* happen — but warn mode must not revert
    await enforcer.shadow.snapshot(file);

    const result = await enforcer.enforce(file, [{
      gateId: 'no-console',
      file: 'src/bad.ts',
      severity: 'block',
      message: 'no console.log',
      line: 1,
      match: 'console.log(',
      source: 'test',
    }]);

    assert.equal(result.reverted, false);
    assert.equal(result.blocked, false);
    assert.equal(enforcer.stats.violations, 1);
    // File is untouched (warn mode never reverts)
    assert.equal(await readFile(file, 'utf-8'), 'console.log("leak")\n');
    // Output was routed through the injected logger
    assert.ok(messages.some(m => m.includes('no-console')));
  });

  it('enforce() reverts block-severity violations in strict mode', async () => {
    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    const file = join(TMP, 'src', 'bad.ts');
    await writeFile(file, 'const good = 1;\n');
    await enforcer.shadow.snapshot(file); // baseline

    await writeFile(file, 'eval("evil")\n');
    const result = await enforcer.enforce(file, [{
      gateId: 'no-eval',
      file: 'src/bad.ts',
      severity: 'block',
      message: 'eval is forbidden',
      line: 1,
      match: 'eval(',
      source: 'test',
    }]);

    assert.equal(result.reverted, true);
    assert.equal(result.blocked, true);
    assert.equal(enforcer.stats.reverts, 1);
    assert.equal(await readFile(file, 'utf-8'), 'const good = 1;\n');
  });

  it('enforce() does not revert warn-severity in strict mode', async () => {
    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    const file = join(TMP, 'src', 'warn.ts');
    await writeFile(file, 'ok\n');
    await enforcer.shadow.snapshot(file);
    await writeFile(file, 'console.log(1)\n');

    const result = await enforcer.enforce(file, [{
      gateId: 'no-console',
      file: 'src/warn.ts',
      severity: 'warn',
      message: 'console.log',
      line: 1,
      match: 'console.log(',
      source: 'test',
    }]);

    assert.equal(result.reverted, false);
    assert.equal(await readFile(file, 'utf-8'), 'console.log(1)\n');
  });

  it('markClean() snapshots without counting a violation', async () => {
    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'warn', output: () => {} });
    const file = join(TMP, 'src', 'c.ts');
    await writeFile(file, 'x\n');
    await enforcer.markClean(file);
    assert.equal(await enforcer.shadow.has(file), true);
    assert.equal(enforcer.stats.violations, 0);
    assert.equal(enforcer.stats.filesChecked, 1);
  });

  it('escalates when the same gate+file is violated repeatedly (2.5)', async () => {
    const messages = [];
    const enforcer = new Enforcer({
      projectRoot: TMP,
      shadowDir: TMP,
      mode: 'warn',
      output: (m) => messages.push(m),
      escalation: { threshold: 2, windowMinutes: 10 },
    });
    const file = join(TMP, 'src', 'repeat.ts');
    await writeFile(file, 'bad\n');

    const violation = {
      gateId: 'no-bad',
      file: 'src/repeat.ts',
      severity: 'warn',
      message: 'bad found',
      line: 1,
      match: 'bad',
      source: 'test',
    };

    await enforcer.enforce(file, [violation]);
    assert.ok(!messages.some(m => m.includes('ESCALATED')));

    await enforcer.enforce(file, [violation]);
    assert.ok(messages.some(m => m.includes('ESCALATED')), 'should flag escalation after threshold');

    const lastViolations = JSON.parse(await readFile(join(TMP, '.gateinitiative', 'last-violations.json'), 'utf-8'));
    assert.ok(lastViolations.version === 1);
    assert.ok(lastViolations.violations[lastViolations.violations.length - 1].escalated);
  });

  it('initShadows() snapshots only files without an existing shadow', async () => {
    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    const a = join(TMP, 'src', 'a.ts');
    const b = join(TMP, 'src', 'b.ts');
    await writeFile(a, 'a\n');
    await writeFile(b, 'b\n');
    await enforcer.shadow.snapshot(a); // a already has a shadow

    const gates = [
      { id: 'g', trigger: '**/*.ts', severity: 'block', pattern: '/bad/', message: 'm', source: 't' },
    ];
    await enforcer.initShadows([a, b], gates);

    assert.equal(await enforcer.shadow.has(a), true);
    assert.equal(await enforcer.shadow.has(b), true);
    // a's shadow should still be the original, not overwritten
    await writeFile(a, 'mutated\n');
    const result = await enforcer.shadow.revert(a);
    assert.equal(result.success, true);
    assert.equal(await readFile(a, 'utf-8'), 'a\n');
  });

  it('enforce() quarantines a new file with a block violation when no shadow exists (0.3)', async () => {
    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    const file = join(TMP, 'src', 'new-secret.ts');
    await writeFile(file, 'const testSecretFixture = 1;\n');

    const result = await enforcer.enforce(file, [{
      gateId: 'no-secrets',
      file: 'src/new-secret.ts',
      severity: 'block',
      message: 'Secret detected',
      line: 1,
      match: 'testSecretFixture',
      source: 'test',
    }]);

    assert.equal(result.quarantined, true);
    assert.equal(result.blocked, true);
    assert.equal(result.reverted, false);
    assert.equal(enforcer.stats.quarantines, 1);
    // Original file is moved out of the project tree
    let stillExists = false;
    try {
      await stat(file);
      stillExists = true;
    } catch { /* expected */ }
    assert.equal(stillExists, false);
    // Quarantine copy exists (external data dir, hash-keyed)
    const qdir = enforcer.shadow.quarantineDir;
    const entries = await readdir(qdir, { withFileTypes: true });
    assert.ok(entries.some(e => e.isDirectory()));
  });

  it('enforce() reverts only once even when multiple block violations exist (0.6)', async () => {
    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    const file = join(TMP, 'src', 'bad.ts');
    await writeFile(file, 'const good = 1;\n');
    await enforcer.shadow.snapshot(file);

    await writeFile(file, 'eval("evil"); console.log(testSecretFixture);\n');
    const result = await enforcer.enforce(file, [
      { gateId: 'no-eval', file: 'src/bad.ts', severity: 'block', message: 'no eval', line: 1, match: 'eval(', source: 'test' },
      { gateId: 'no-secrets', file: 'src/bad.ts', severity: 'block', message: 'no secrets', line: 1, match: 'testSecretFixture', source: 'test' },
    ]);

    assert.equal(result.reverted, true);
    assert.equal(enforcer.stats.reverts, 1);
    assert.equal(await readFile(file, 'utf-8'), 'const good = 1;\n');
  });

  it('shadow store lives outside the project tree (1.1)', async () => {
    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    const file = join(TMP, 'src', 'app.ts');
    await writeFile(file, 'ok\n');
    await enforcer.markClean(file);

    // Shadow is under the external data dir (test override), not .gateinitiative/shadow
    assert.ok(enforcer.shadow.shadowDir.includes('shadow'));
    assert.equal(await enforcer.shadow.has(file), true);
  });

  it('refuses revert when shadow manifest fingerprint mismatches (1.1)', async () => {
    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    const file = join(TMP, 'src', 'app.ts');
    await writeFile(file, 'const good = 1;\n');
    await enforcer.markClean(file);

    // Tamper with the shadow copy
    const shadowPath = join(enforcer.shadow.shadowDir, 'src', 'app.ts');
    await writeFile(shadowPath, 'tampered\n');

    await writeFile(file, 'const bad = eval("evil");\n');
    const result = await enforcer.shadow.revert(file);
    assert.equal(result.success, false);
    assert.equal(result.tamper, true);
  });

  it('initShadows skips files that already violate gates (1.2)', async () => {
    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    const file = join(TMP, 'src', 'bad.ts');
    await writeFile(file, 'eval("already bad")\n');

    const gates = [
      { id: 'no-eval', trigger: '**/*.ts', severity: 'block', pattern: '/eval\\(/', message: 'no eval', source: 't' },
    ];
    await enforcer.initShadows([file], gates);

    assert.equal(await enforcer.shadow.has(file), false);
  });

  it('initShadows only snapshots files covered by block-severity gates (1.10)', async () => {
    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'warn', output: () => {} });
    const file = join(TMP, 'src', 'app.ts');
    await writeFile(file, 'const good = 1;\n');

    const gates = [
      { id: 'warn-only', trigger: '**/*.ts', severity: 'warn', pattern: '/eval\\(/', message: 'no eval', source: 't' },
    ];
    await enforcer.initShadows([file], gates);

    assert.equal(await enforcer.shadow.has(file), false);
  });

  it('concurrent snapshots retain all manifest entries (1.11)', async () => {
    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    const files = Array.from({ length: 40 }, (_, i) => join(TMP, `f${i}.ts`));
    const gates = [
      { id: 'g', trigger: '**/*.ts', severity: 'block', pattern: '/bad/', message: 'm', source: 't' },
    ];
    await Promise.all(files.map(f => writeFile(f, `// ${f}\n`)));
    await Promise.all(files.map(f => enforcer.shadow.snapshot(f)));

    const manifest = JSON.parse(await readFile(join(enforcer.shadow.shadowDir, '.manifest.json'), 'utf8'));
    const keys = Object.keys(manifest).sort();
    assert.equal(keys.length, 40);
    for (let i = 0; i < 40; i++) {
      assert.ok(keys.includes(`f${i}.ts`), `missing manifest entry for f${i}.ts`);
    }
  });

  it('initShadows() survives a pathological ReDoS gate (1.12)', async () => {
    const { SafeEvaluator } = await import('./safe-eval.mjs');
    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    const file = join(TMP, 'src', 'redos.ts');
    // A long run of 'a's followed by '!' defeats naive (a+)+ implementations
    const payload = 'a'.repeat(100_000) + '!';
    await writeFile(file, payload);

    const gates = [
      { id: 'redos', trigger: '**/*.ts', severity: 'block', pattern: '/(a+)+$/', message: 'redos probe', source: 't' },
    ];
    const safe = new SafeEvaluator({ timeoutMs: 50 });
    const start = Date.now();
    await enforcer.initShadows([file], gates, safe);
    const elapsed = Date.now() - start;

    // Hang-detector, not a benchmark. The 50ms budget bounds regex execution
    // inside the worker, but total elapsed also includes worker-thread
    // startup, which on slow CI runners (windows-latest, 2026-07-21) can
    // exceed 1s on its own. A genuine unbounded stall runs for minutes, and
    // if the worker path ever fell back to in-process evaluation this test
    // would hang outright regardless of any wall-clock assert — so 15s
    // separates "slow spawn" from a real stall with a wide margin. The
    // functional asserts below carry the actual behavior.
    assert.ok(elapsed < 15_000, `initShadows took ${elapsed}ms — possible ReDoS stall`);
    // Gate should have been poisoned (no baseline seeded for this file)
    assert.ok(safe.poisonedGateIds.includes('redos'));
    assert.equal(await enforcer.shadow.has(file), false);
    await safe.dispose();
  });

  it('enforce() skips revert when an active override exists (2A.6)', async () => {
    const { recordOverride } = await import('./decisions.mjs');
    await recordOverride(TMP, { gateId: 'no-eval', file: 'src/bad.ts', scope: 'once' }, TMP);

    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    const file = join(TMP, 'src', 'bad.ts');
    await writeFile(file, 'eval("ok because override");\n');

    const result = await enforcer.enforce(file, [
      { gateId: 'no-eval', file: 'src/bad.ts', severity: 'block', message: 'no eval', line: 1, match: 'eval(', source: 'test', overridable: true },
    ]);

    assert.equal(result.reverted, false);
    assert.equal(result.blocked, true);
    assert.equal(await readFile(file, 'utf-8'), 'eval("ok because override");\n');
  });

  it('enforce() ignores overrides when gate is not overridable (2A.6)', async () => {
    const { recordOverride } = await import('./decisions.mjs');
    await recordOverride(TMP, { gateId: 'no-secrets', file: 'src/secret.ts', scope: 'once' }, TMP);

    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', output: () => {} });
    const file = join(TMP, 'src', 'secret.ts');
    await writeFile(file, 'const good = 1;\n');
    await enforcer.shadow.snapshot(file);
    await writeFile(file, 'const testSecretFixture = 1;\n');

    const result = await enforcer.enforce(file, [
      { gateId: 'no-secrets', file: 'src/secret.ts', severity: 'block', message: 'secret', line: 1, match: 'testSecretFixture', source: 'test', overridable: false },
    ]);

    assert.equal(result.reverted, true);
    assert.equal(await readFile(file, 'utf-8'), 'const good = 1;\n');
  });

  it('enforce() uses prompt override instead of quarantine when configured (2A.5)', async () => {
    const enforcer = new Enforcer({
      projectRoot: TMP,
      shadowDir: TMP,
      mode: 'strict',
      sessionId: 's1',
      output: () => {},
      promptHandler: async () => 'override',
    });
    const file = join(TMP, 'src', 'prompt-override.ts');
    await writeFile(file, 'const bad = eval("evil");\n');

    const result = await enforcer.enforce(file, [
      { gateId: 'no-eval', file: 'src/prompt-override.ts', severity: 'block', message: 'no eval', line: 1, match: 'eval(', source: 'test', overridable: true },
    ]);

    assert.equal(result.reverted, false);
    assert.equal(result.quarantined, false);
    assert.equal(await readFile(file, 'utf-8'), 'const bad = eval("evil");\n');

    // A session-scoped override should have been recorded
    const { checkOverride } = await import('./decisions.mjs');
    assert.ok(await checkOverride(TMP, 'no-eval', 'src/prompt-override.ts', 's1', TMP));
  });

  it('enforce() prompts quarantine by default when no handler returns override', async () => {
    const enforcer = new Enforcer({
      projectRoot: TMP,
      shadowDir: TMP,
      mode: 'strict',
      output: () => {},
      promptHandler: async () => 'quarantine',
    });
    const file = join(TMP, 'src', 'prompt-quarantine.ts');
    await writeFile(file, 'const bad = eval("evil");\n');

    const result = await enforcer.enforce(file, [
      { gateId: 'no-eval', file: 'src/prompt-quarantine.ts', severity: 'block', message: 'no eval', line: 1, match: 'eval(', source: 'test', overridable: true },
    ]);

    assert.equal(result.quarantined, true);
    let stillExists = true;
    try { await stat(file); } catch { stillExists = false; }
    assert.equal(stillExists, false);
  });
});

describe('Enforcer security regressions (v0.3.1)', () => {
  beforeEach(freshDir);
  afterEach(cleanup);

  it('an override for one gate does not bypass enforcement of another block gate', async () => {
    const { recordOverride } = await import('./decisions.mjs');
    // Override gate A only — gate B must still be enforced
    await recordOverride(TMP, { gateId: 'gate-a', file: 'src/multi.ts', scope: 'session', sessionId: 's1' }, TMP);

    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', sessionId: 's1', output: () => {} });
    const file = join(TMP, 'src', 'multi.ts');
    await writeFile(file, 'const good = 1;\n');
    await enforcer.shadow.snapshot(file);
    await writeFile(file, 'violates A and B\n');

    const result = await enforcer.enforce(file, [
      { gateId: 'gate-a', file: 'src/multi.ts', severity: 'block', message: 'a', line: 1, match: 'A', source: 'test', overridable: true },
      { gateId: 'gate-b', file: 'src/multi.ts', severity: 'block', message: 'b', line: 1, match: 'B', source: 'test', overridable: true },
    ]);

    assert.equal(result.reverted, true, 'gate-b has no override — the file must be reverted');
    assert.equal(await readFile(file, 'utf-8'), 'const good = 1;\n');
  });

  it('an override for one gate does not bypass a non-overridable block gate', async () => {
    const { recordOverride } = await import('./decisions.mjs');
    await recordOverride(TMP, { gateId: 'gate-a', file: 'src/hard.ts', scope: 'session', sessionId: 's1' }, TMP);

    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', sessionId: 's1', output: () => {} });
    const file = join(TMP, 'src', 'hard.ts');
    await writeFile(file, 'const good = 1;\n');
    await enforcer.shadow.snapshot(file);
    await writeFile(file, 'const testSecretFixture = eval("x");\n');

    const result = await enforcer.enforce(file, [
      { gateId: 'gate-a', file: 'src/hard.ts', severity: 'block', message: 'a', line: 1, match: 'eval(', source: 'test', overridable: true },
      { gateId: 'no-secrets', file: 'src/hard.ts', severity: 'block', message: 'secret', line: 1, match: 'testSecretFixture', source: 'test', overridable: false },
    ]);

    assert.equal(result.reverted, true, 'non-overridable violation must always be enforced');
    assert.equal(await readFile(file, 'utf-8'), 'const good = 1;\n');
  });

  it('revert is skipped only when every block violation has an active override', async () => {
    const { recordOverride } = await import('./decisions.mjs');
    await recordOverride(TMP, { gateId: 'gate-a', file: 'src/all.ts', scope: 'session', sessionId: 's1' }, TMP);
    await recordOverride(TMP, { gateId: 'gate-b', file: 'src/all.ts', scope: 'session', sessionId: 's1' }, TMP);

    const enforcer = new Enforcer({ projectRoot: TMP, shadowDir: TMP, mode: 'strict', sessionId: 's1', output: () => {} });
    const file = join(TMP, 'src', 'all.ts');
    await writeFile(file, 'const good = 1;\n');
    await enforcer.shadow.snapshot(file);
    await writeFile(file, 'both overridden\n');

    const result = await enforcer.enforce(file, [
      { gateId: 'gate-a', file: 'src/all.ts', severity: 'block', message: 'a', line: 1, match: 'A', source: 'test', overridable: true },
      { gateId: 'gate-b', file: 'src/all.ts', severity: 'block', message: 'b', line: 1, match: 'B', source: 'test', overridable: true },
    ]);

    assert.equal(result.reverted, false);
    assert.equal(result.blocked, true);
    assert.equal(await readFile(file, 'utf-8'), 'both overridden\n');
  });

  it('revert fails closed when the manifest entry is missing', async () => {
    const store = new ShadowStore(TMP, TMP);
    const file = join(TMP, 'src', 'app.ts');
    await writeFile(file, 'const good = 1;\n');
    await store.snapshot(file);

    // Simulate a wiped manifest (corruption or deletion by an attacker)
    await rm(join(store.shadowDir, '.manifest.json'), { force: true });

    await writeFile(file, 'mutated\n');
    const result = await store.revert(file);
    assert.equal(result.success, false, 'unverifiable shadow must not be restored');
    assert.equal(result.tamper, true);
    assert.equal(await readFile(file, 'utf-8'), 'mutated\n');
  });

  it('revert fails closed when the manifest is corrupt JSON', async () => {
    const store = new ShadowStore(TMP, TMP);
    const file = join(TMP, 'src', 'app.ts');
    await writeFile(file, 'const good = 1;\n');
    await store.snapshot(file);

    await writeFile(join(store.shadowDir, '.manifest.json'), '{not json');

    await writeFile(file, 'mutated\n');
    const result = await store.revert(file);
    assert.equal(result.success, false);
    assert.equal(result.tamper, true);
  });

  it('restoreDeleted fails closed when the manifest entry is missing', async () => {
    const store = new ShadowStore(TMP, TMP);
    const file = join(TMP, 'src', 'app.ts');
    await writeFile(file, 'const good = 1;\n');
    await store.snapshot(file);

    await rm(join(store.shadowDir, '.manifest.json'), { force: true });

    await rm(file);
    const result = await store.restoreDeleted(file);
    assert.equal(result.success, false);
    assert.equal(result.tamper, true);
    let restored = true;
    try { await stat(file); } catch { restored = false; }
    assert.equal(restored, false, 'file must not be restored from an unverified shadow');
  });
});

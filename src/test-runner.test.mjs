import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGateTests } from './test-runner.mjs';

describe('runGateTests', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gk-test-runner-'));
    mkdirSync(join(dir, '.gates'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes when pass fixtures satisfy the gate and fail fixtures violate it', async () => {
    const gateYml = `id: no-console
trigger: "src/**/*.ts"
severity: warn
pattern: /console\\.log/
message: "No console.log"
`;
    writeFileSync(join(dir, '.gates.yml'), gateYml);
    const fixtures = join(dir, '.gates', 'fixtures', 'no-console');
    mkdirSync(join(fixtures, 'pass'), { recursive: true });
    mkdirSync(join(fixtures, 'fail'), { recursive: true });
    writeFileSync(join(fixtures, 'pass', 'clean.ts'), 'const x = 1;\n');
    writeFileSync(join(fixtures, 'fail', 'dirty.ts'), 'console.log(x);\n');

    const { results, totalPassed, totalFailed } = await runGateTests(dir);

    assert.equal(totalFailed, 0);
    assert.equal(totalPassed, 2);
    assert.equal(results.length, 1);
    assert.equal(results[0].passed, 2);
    assert.equal(results[0].failed, 0);
  });

  it('fails when a pass fixture violates the gate', async () => {
    const gateYml = `id: no-console
trigger: "src/**/*.ts"
severity: warn
pattern: /console\\.log/
message: "No console.log"
`;
    writeFileSync(join(dir, '.gates.yml'), gateYml);
    const fixtures = join(dir, '.gates', 'fixtures', 'no-console');
    mkdirSync(join(fixtures, 'pass'), { recursive: true });
    writeFileSync(join(fixtures, 'pass', 'bad.ts'), 'console.log(x);\n');

    const { totalPassed, totalFailed } = await runGateTests(dir);

    assert.equal(totalPassed, 0);
    assert.equal(totalFailed, 1);
  });

  it('skips gates without fixtures', async () => {
    const gateYml = `id: no-console
trigger: "src/**/*.ts"
severity: warn
pattern: /console\\.log/
message: "No console.log"
`;
    writeFileSync(join(dir, '.gates.yml'), gateYml);

    const { totalSkipped, results } = await runGateTests(dir);

    assert.equal(totalSkipped, 1);
    assert.equal(results[0].skipped, true);
  });
});

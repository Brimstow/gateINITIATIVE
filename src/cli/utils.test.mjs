// gateinitiative: CLI utility tests
// Run with: node --test src/cli/utils.test.mjs

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { collectFiles } from './utils.mjs';

const TMP = join(process.cwd(), '.tmp-utils-test');

async function freshDir() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
}

async function cleanup() {
  await rm(TMP, { recursive: true, force: true });
}

describe('collectFiles', () => {
  beforeEach(freshDir);
  afterEach(cleanup);

  it('collects files matching gate triggers', async () => {
    const file = join(TMP, 'src', 'app.ts');
    await mkdir(join(TMP, 'src'), { recursive: true });
    await writeFile(file, 'ok\n');
    const gates = [
      { id: 'g', trigger: '**/*.ts', severity: 'block', pattern: '/bad/', message: 'm', source: 't' },
    ];
    const files = await collectFiles(TMP, gates);
    assert.deepEqual(files, [file]);
  });

  it('backward-compat accepts a numeric maxDepth argument', async () => {
    const file = join(TMP, 'd1', 'd2', 'deep.ts');
    await mkdir(join(TMP, 'd1', 'd2'), { recursive: true });
    await writeFile(file, 'ok\n');
    const gates = [{ id: 'g', trigger: '**/*.ts', severity: 'block', pattern: '/bad/', message: 'm', source: 't' }];
    const files = await collectFiles(TMP, gates, 2);
    assert.ok(files.includes(file));
  });

  it('surfaces skipped deep directories via onSkip', async () => {
    const deep = join(TMP, 'd1', 'd2', 'd3', 'd4');
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'deep.ts'), 'ok\n');
    const gates = [{ id: 'g', trigger: '**/*.ts', severity: 'block', pattern: '/bad/', message: 'm', source: 't' }];
    const skipped = [];
    const files = await collectFiles(TMP, gates, {
      maxDepth: 2,
      onSkip: (dir) => skipped.push(relative(TMP, dir).replace(/\\/g, '/') || '.'),
    });
    assert.equal(files.length, 0);
    assert.ok(skipped.length > 0, 'expected skipped directories to be reported');
  });
});

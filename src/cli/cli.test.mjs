// gateinitiative: CLI security regression tests
// Spawns the real CLI to verify hostile input is rejected end-to-end.
// Run with: node --test src/cli/cli.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../../bin/gateinit.mjs', import.meta.url));
const TMP = join(process.cwd(), '.tmp-cli-test');

/** Run the CLI; resolves with { code, stdout, stderr } instead of throwing */
async function cli(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

describe('CLI security regressions (v0.3.1)', () => {
  before(async () => {
    await rm(TMP, { recursive: true, force: true });
    // A canary directory a traversal attack would try to delete
    await mkdir(join(TMP, 'canary'), { recursive: true });
    await writeFile(join(TMP, 'canary', 'keep.txt'), 'do not delete\n');
  });

  after(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it('quarantine delete rejects a path-traversal id', async () => {
    const { code, stderr } = await cli(
      'quarantine', 'delete', '..',
      '--root', TMP, '--shadow-dir', join(TMP, 'data')
    );
    assert.equal(code, 1);
    assert.match(stderr, /Invalid quarantine id/);
  });

  it('quarantine restore rejects a deep traversal id', async () => {
    const evil = join('..', '..', 'canary');
    const { code, stderr } = await cli(
      'quarantine', 'restore', evil,
      '--root', TMP, '--shadow-dir', join(TMP, 'data')
    );
    assert.equal(code, 1);
    assert.match(stderr, /Invalid quarantine id/);
    // Canary untouched
    assert.ok(await stat(join(TMP, 'canary', 'keep.txt')));
  });

  it('quarantine show rejects an absolute-path id', async () => {
    const { code, stderr } = await cli(
      'quarantine', 'show', TMP,
      '--root', TMP, '--shadow-dir', join(TMP, 'data')
    );
    assert.equal(code, 1);
    assert.match(stderr, /Invalid quarantine id/);
  });

  it('a config file with a typoed mode fails loudly instead of degrading', async () => {
    const proj = join(TMP, 'typo-project');
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, '.gateinitiative.yml'), 'version: 1\nmode: strcit\n');
    await writeFile(join(proj, '.gates.yml'), [
      'version: 1', '---',
      'id: g', 'trigger: "**/*.ts"', 'severity: block',
      'pattern: /eval\\(/', 'message: no eval',
    ].join('\n'));

    const { code, stderr } = await cli('check', '--root', proj);
    assert.equal(code, 1);
    assert.match(stderr, /Invalid enforcement mode "strcit"/);
  });
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  getPlatformDataDir,
  getProjectHash,
  getShadowDir,
  ensureProjectRootMarker,
  findOrphanedDataDirs,
} from './platform-paths.mjs';

describe('platform-paths', () => {
  it('uses a platform-specific base data dir', () => {
    const dir = getPlatformDataDir();
    assert.ok(dir.length > 0);
  });

  it('produces stable project hash', () => {
    const a = getProjectHash('/foo/bar');
    const b = getProjectHash('/foo/bar');
    const c = getProjectHash('/foo/baz');
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe('ensureProjectRootMarker', () => {
  let base;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'gk-data-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('records the project root in the external shadow dir', async () => {
    const root = resolve('/imaginary/project');
    await ensureProjectRootMarker(root, base);
    const shadowDir = getShadowDir(root, base);
    const marker = join(shadowDir, '.root');
    assert.ok(existsSync(marker));
  });
});

describe('findOrphanedDataDirs', () => {
  let base;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'gk-orphans-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('finds data dirs whose recorded project root no longer exists', async () => {
    const hash = 'abc123';
    mkdirSync(join(base, 'shadow', hash), { recursive: true });
    writeFileSync(join(base, 'shadow', hash, '.root'), resolve('/does/not/exist'));

    const orphaned = await findOrphanedDataDirs(base);

    assert.equal(orphaned.length, 1);
    assert.equal(orphaned[0].hash, hash);
    assert.equal(orphaned[0].root, resolve('/does/not/exist'));
  });

  it('ignores data dirs whose project root still exists', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'gk-alive-'));
    const hash = 'def456';
    mkdirSync(join(base, 'shadow', hash), { recursive: true });
    writeFileSync(join(base, 'shadow', hash, '.root'), rootDir);

    const orphaned = await findOrphanedDataDirs(base);

    assert.equal(orphaned.length, 0);
    rmSync(rootDir, { recursive: true, force: true });
  });
});

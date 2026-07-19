import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';

const TMP = join(process.cwd(), 'tmp-config-test');

describe('loadConfig', () => {
  it('defaults version to 1', async () => {
    const config = await loadConfig(TMP);
    assert.equal(config.version, 1);
  });

  it('reads version from .gateinitiative.yml', async () => {
    await mkdir(TMP, { recursive: true });
    await writeFile(join(TMP, '.gateinitiative.yml'), 'version: 1\nmode: strict\n');
    try {
      const config = await loadConfig(TMP);
      assert.equal(config.version, 1);
      assert.equal(config.mode, 'strict');
    } finally {
      await rm(TMP, { recursive: true, force: true });
    }
  });

  it('warns on unsupported config version', async () => {
    await mkdir(TMP, { recursive: true });
    await writeFile(join(TMP, '.gateinitiative.yml'), 'version: 99\nmode: warn\n');
    const warnings = [];
    try {
      await loadConfig(TMP, {}, (msg) => warnings.push(msg));
      assert.ok(warnings.some(w => w.includes('unsupported config version 99')));
    } finally {
      await rm(TMP, { recursive: true, force: true });
    }
  });

  it('ignores a version-only document and reads the next doc', async () => {
    await mkdir(TMP, { recursive: true });
    await writeFile(join(TMP, '.gateinitiative.yml'), 'version: 1\n---\nmode: audit\n');
    try {
      const config = await loadConfig(TMP);
      assert.equal(config.version, 1);
      assert.equal(config.mode, 'audit');
    } finally {
      await rm(TMP, { recursive: true, force: true });
    }
  });

  it('rejects an invalid mode in the config file instead of silently degrading', async () => {
    await mkdir(TMP, { recursive: true });
    await writeFile(join(TMP, '.gateinitiative.yml'), 'version: 1\nmode: strcit\n');
    try {
      await assert.rejects(
        () => loadConfig(TMP),
        /Invalid enforcement mode "strcit"/,
        'a typo like "strcit" must fail loudly, not disable strict enforcement'
      );
    } finally {
      await rm(TMP, { recursive: true, force: true });
    }
  });

  it('rejects an invalid mode passed as a CLI override', async () => {
    await assert.rejects(
      () => loadConfig(TMP, { mode: 'sctrict' }),
      /Invalid enforcement mode "sctrict"/
    );
  });
});

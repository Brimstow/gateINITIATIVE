import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { evaluateGateTrust, trustGateSources } from './trust.mjs';

const TMP = join(process.cwd(), 'tmp-trust-test');
const DATA = join(TMP, 'data');
const SOURCE = join(TMP, '.gates.yml');

function gates() {
  return [{ id: 'no-eval', source: SOURCE }];
}

describe('gate trust', () => {
  beforeEach(async () => {
    await mkdir(TMP, { recursive: true });
    await writeFile(SOURCE, 'version: 1\n---\nid: no-eval\n');
  });

  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it('requires an explicit trust operation', async () => {
    const result = await evaluateGateTrust(TMP, gates(), DATA);
    assert.equal(result.trusted, false);
  });

  it('trusts unchanged gate sources', async () => {
    await trustGateSources(TMP, gates(), DATA);
    const result = await evaluateGateTrust(TMP, gates(), DATA);
    assert.equal(result.trusted, true);
  });

  it('revokes trust when a gate source changes', async () => {
    await trustGateSources(TMP, gates(), DATA);
    await writeFile(SOURCE, 'version: 1\n---\nid: no-console\n');
    const result = await evaluateGateTrust(TMP, gates(), DATA);
    assert.equal(result.trusted, false);
  });

  it('revokes trust when gate source membership changes', async () => {
    await trustGateSources(TMP, gates(), DATA);
    const second = join(TMP, '.gates', 'security.yml');
    await mkdir(join(TMP, '.gates'), { recursive: true });
    await writeFile(second, 'id: secret\n');
    const result = await evaluateGateTrust(TMP, [...gates(), { id: 'secret', source: resolve(second) }], DATA);
    assert.equal(result.trusted, false);
  });
});

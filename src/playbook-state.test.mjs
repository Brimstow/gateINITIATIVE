// gateinitiative: Playbook state (HMAC-signed) tests
// Run with: node --test src/playbook-state.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getStateSecret, signStateEntry, buildSignedState, readVerifiedState,
} from './playbook-state.mjs';

const TMP = join(process.cwd(), '.tmp-playbook-state-test');
const DATA_DIR = join(TMP, 'data');
const PROJECT = join(TMP, 'project');
const STATE_PATH = join(PROJECT, '.gateinitiative', 'playbook-state.json');

before(async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(join(PROJECT, '.gateinitiative'), { recursive: true });
});

after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe('getStateSecret', () => {
  it('creates a secret outside the project tree and returns it stably', async () => {
    const first = await getStateSecret(PROJECT, DATA_DIR);
    assert.match(first, /^[0-9a-f]{64}$/);
    const second = await getStateSecret(PROJECT, DATA_DIR);
    assert.equal(second, first);
  });

  it('different projects get different secrets', async () => {
    const otherProject = join(TMP, 'other-project');
    await mkdir(otherProject, { recursive: true });
    const a = await getStateSecret(PROJECT, DATA_DIR);
    const b = await getStateSecret(otherProject, DATA_DIR);
    assert.notEqual(a, b);
  });
});

describe('signStateEntry', () => {
  it('is deterministic for the same inputs', () => {
    assert.equal(signStateEntry('s', 'read:doc.md', 100), signStateEntry('s', 'read:doc.md', 100));
  });

  it('changes when key, timestamp, or secret change', () => {
    const base = signStateEntry('s', 'k', 100);
    assert.notEqual(signStateEntry('s', 'k2', 100), base);
    assert.notEqual(signStateEntry('s', 'k', 101), base);
    assert.notEqual(signStateEntry('s2', 'k', 100), base);
  });
});

describe('buildSignedState / readVerifiedState', () => {
  it('roundtrips valid entries', async () => {
    const secret = await getStateSecret(PROJECT, DATA_DIR);
    const completed = { 'read:context.md': 1000, 'ran:tests': 2000 };
    const state = buildSignedState(secret, completed, 'session-1');
    await writeFile(STATE_PATH, JSON.stringify(state), 'utf8');

    const verified = await readVerifiedState(PROJECT, secret);
    assert.equal(verified.session, 'session-1');
    assert.deepEqual(verified.completed, completed);
  });

  it('drops entries with forged or missing signatures', async () => {
    const secret = await getStateSecret(PROJECT, DATA_DIR);
    const state = buildSignedState(secret, { 'read:legit.md': 1000 });
    // Agent forges two extra entries without knowing the secret
    state.completed['read:forged.md'] = 2000;
    state.signatures['read:forged.md'] = 'deadbeef'.repeat(8);
    state.completed['read:unsigned.md'] = 3000;
    await writeFile(STATE_PATH, JSON.stringify(state), 'utf8');

    const verified = await readVerifiedState(PROJECT, secret);
    assert.deepEqual(verified.completed, { 'read:legit.md': 1000 });
  });

  it('drops entries whose timestamp was tampered after signing', async () => {
    const secret = await getStateSecret(PROJECT, DATA_DIR);
    const state = buildSignedState(secret, { 'read:doc.md': 1000 });
    state.completed['read:doc.md'] = 9999; // freshen a stale timestamp
    await writeFile(STATE_PATH, JSON.stringify(state), 'utf8');

    const verified = await readVerifiedState(PROJECT, secret);
    assert.deepEqual(verified.completed, {});
  });

  it('returns empty state when the file is missing', async () => {
    await rm(STATE_PATH, { force: true });
    const verified = await readVerifiedState(PROJECT, 'any-secret');
    assert.deepEqual(verified, { session: null, completed: {} });
  });

  it('returns empty state on corrupt JSON', async () => {
    await writeFile(STATE_PATH, '{corrupt', 'utf8');
    const verified = await readVerifiedState(PROJECT, 'any-secret');
    assert.deepEqual(verified, { session: null, completed: {} });
  });

  it('handles a state file without a signatures object', async () => {
    await writeFile(STATE_PATH, JSON.stringify({ version: 1, completed: { k: 1 } }), 'utf8');
    const verified = await readVerifiedState(PROJECT, 'any-secret');
    assert.deepEqual(verified.completed, {});
  });
});

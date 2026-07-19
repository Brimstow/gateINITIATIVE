import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  recordPendingDecision,
  recordOverride,
  approveDecision,
  deleteDecision,
  clearDecisions,
  getDecisions,
  checkOverride,
} from './decisions.mjs';

describe('decisions', () => {
  let base;
  let root;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'gk-decisions-'));
    root = resolve(join(base, 'project'));
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('records a pending decision and lists it', async () => {
    const id = await recordPendingDecision(root, { gateId: 'g1', file: 'src/x.js', reason: 'test' }, base);
    const { pending, overrides } = await getDecisions(root, base);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, id);
    assert.equal(pending[0].gateId, 'g1');
    assert.equal(overrides.length, 0);
  });

  it('approves a pending decision as a once override', async () => {
    const pendingId = await recordPendingDecision(root, { gateId: 'g1', file: 'src/x.js', reason: 'test' }, base);
    const override = await approveDecision(root, pendingId, {}, base);
    assert.ok(override);
    assert.equal(override.scope, 'once');
    const { pending, overrides } = await getDecisions(root, base);
    assert.equal(pending.length, 0);
    assert.equal(overrides.length, 1);
  });

  it('checkOverride returns true for an active override and consumes once overrides', async () => {
    const pendingId = await recordPendingDecision(root, { gateId: 'g1', file: 'src/x.js', reason: 'test' }, base);
    await approveDecision(root, pendingId, {}, base);

    assert.ok(await checkOverride(root, 'g1', 'src/x.js', null, base));
    assert.equal((await getDecisions(root, base)).overrides.length, 0);
  });

  it('session-scoped overrides require matching session id', async () => {
    const id = await recordPendingDecision(root, { gateId: 'g1', file: 'src/x.js', reason: 'test' }, base);
    await approveDecision(root, id, { scope: 'session', sessionId: 'abc' }, base);

    assert.equal(await checkOverride(root, 'g1', 'src/x.js', 'wrong', base), false);
    assert.ok(await checkOverride(root, 'g1', 'src/x.js', 'abc', base));
  });

  it('ttl overrides expire', async () => {
    const id = await recordPendingDecision(root, { gateId: 'g1', file: 'src/x.js', reason: 'test' }, base);
    await approveDecision(root, id, { scope: 'ttl', ttlHours: -0.001 }, base);

    const { overrides } = await getDecisions(root, base);
    assert.equal(overrides.length, 0);
  });

  it('delete removes a decision', async () => {
    const id = await recordPendingDecision(root, { gateId: 'g1', file: 'src/x.js', reason: 'test' }, base);
    assert.ok(await deleteDecision(root, id, base));
    const { pending } = await getDecisions(root, base);
    assert.equal(pending.length, 0);
  });

  it('clear removes all decisions', async () => {
    await recordPendingDecision(root, { gateId: 'g1', file: 'a.js', reason: 'test' }, base);
    await recordPendingDecision(root, { gateId: 'g2', file: 'b.js', reason: 'test' }, base);
    await clearDecisions(root, base);
    const { pending, overrides } = await getDecisions(root, base);
    assert.equal(pending.length, 0);
    assert.equal(overrides.length, 0);
  });
});

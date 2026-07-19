/**
 * gateinitiative: Pending Review Decisions and Overrides
 *
 * Stores human review decisions outside the project tree so agents cannot
 * tamper with enforcement exceptions. Supports three override scopes:
 *   - once:   valid for the next enforcement event, then removed
 *   - session: valid for the current daemon/watch process only
 *   - ttl:    valid until a fixed timestamp (survives restarts)
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getDecisionsDir } from './platform-paths.mjs';

const DECISIONS_FILE = 'pending.json';

function decisionsPath(projectRoot, dataDirOverride) {
  return join(getDecisionsDir(projectRoot, dataDirOverride), DECISIONS_FILE);
}

function makeId(gateId, file, timestamp) {
  return createHash('sha256')
    .update(`${gateId}:${file}:${timestamp}:${randomBytes(4).toString('hex')}`)
    .digest('hex')
    .slice(0, 16);
}

async function load(projectRoot, dataDirOverride) {
  const path = decisionsPath(projectRoot, dataDirOverride);
  try {
    const content = await readFile(path, 'utf-8');
    const raw = JSON.parse(content);
    if (!raw || typeof raw !== 'object') return { version: 1, decisions: [] };
    return { version: raw.version || 1, decisions: Array.isArray(raw.decisions) ? raw.decisions : [] };
  } catch {
    return { version: 1, decisions: [] };
  }
}

async function save(projectRoot, dataDirOverride, state) {
  const path = decisionsPath(projectRoot, dataDirOverride);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, decisions: state.decisions }, null, 2), 'utf-8');
}

function isExpired(decision) {
  if (decision.expires && decision.expires < Date.now()) return true;
  return false;
}

/**
 * Record a pending decision that requires human review.
 * Replaces any existing pending decision for the same gate+file.
 * @param {string} projectRoot
 * @param {{gateId: string, file: string, reason: string, severity?: string}} decision
 * @param {string} [dataDirOverride]
 * @returns {Promise<string>} decision id
 */
export async function recordPendingDecision(projectRoot, { gateId, file, reason, severity = 'block' }, dataDirOverride) {
  const state = await load(projectRoot, dataDirOverride);
  const timestamp = Date.now();
  const id = makeId(gateId, file, timestamp);

  state.decisions = state.decisions.filter(
    d => !(d.type === 'pending' && d.gateId === gateId && d.file === file)
  );

  state.decisions.push({
    id,
    type: 'pending',
    gateId,
    file,
    reason,
    severity,
    timestamp,
  });

  await save(projectRoot, dataDirOverride, state);
  return id;
}

/**
 * Record an active override for a gate+file.
 * @param {string} projectRoot
 * @param {{gateId: string, file: string, scope: 'once'|'session'|'ttl', ttlHours?: number, sessionId?: string, reason?: string}} options
 * @param {string} [dataDirOverride]
 * @returns {Promise<object>} the override decision
 */
export async function recordOverride(projectRoot, { gateId, file, scope = 'once', ttlHours = 0, sessionId = null, reason = '' }, dataDirOverride) {
  const state = await load(projectRoot, dataDirOverride);
  const timestamp = Date.now();
  const id = makeId(gateId, file, timestamp);

  const override = {
    id,
    type: 'override',
    gateId,
    file,
    scope,
    sessionId,
    reason,
    timestamp,
  };

  if (scope === 'ttl') {
    override.expires = timestamp + ttlHours * 60 * 60 * 1000;
  }

  // Remove any existing override for the same gate+file
  state.decisions = state.decisions.filter(
    d => !(d.type === 'override' && d.gateId === gateId && d.file === file)
  );

  state.decisions.push(override);
  await save(projectRoot, dataDirOverride, state);
  return override;
}

/**
 * Approve a pending decision, converting it to an active override.
 * @param {string} projectRoot
 * @param {string} id
 * @param {{scope?: 'once'|'session'|'ttl', ttlHours?: number, sessionId?: string}} options
 * @param {string} [dataDirOverride]
 * @returns {Promise<object|null>} the override, or null if not found
 */
export async function approveDecision(projectRoot, id, { scope = 'once', ttlHours = 0, sessionId = null } = {}, dataDirOverride) {
  const state = await load(projectRoot, dataDirOverride);
  const pending = state.decisions.find(d => d.id === id && d.type === 'pending');
  if (!pending) return null;

  const timestamp = Date.now();
  const override = {
    id: makeId(pending.gateId, pending.file, timestamp),
    type: 'override',
    gateId: pending.gateId,
    file: pending.file,
    scope,
    sessionId,
    reason: pending.reason,
    timestamp,
  };
  if (scope === 'ttl') {
    override.expires = timestamp + ttlHours * 60 * 60 * 1000;
  }

  state.decisions = state.decisions.filter(d => d.id !== id);
  state.decisions.push(override);
  await save(projectRoot, dataDirOverride, state);
  return override;
}

/**
 * Delete a decision by id.
 * @returns {Promise<boolean>} true if a decision was removed
 */
export async function deleteDecision(projectRoot, id, dataDirOverride) {
  const state = await load(projectRoot, dataDirOverride);
  const before = state.decisions.length;
  state.decisions = state.decisions.filter(d => d.id !== id);
  await save(projectRoot, dataDirOverride, state);
  return state.decisions.length < before;
}

/**
 * Remove all decisions.
 */
export async function clearDecisions(projectRoot, dataDirOverride) {
  await save(projectRoot, dataDirOverride, { version: 1, decisions: [] });
}

/**
 * Load all pending and active decisions.
 * @returns {Promise<{pending: object[], overrides: object[]}>}
 */
export async function getDecisions(projectRoot, dataDirOverride) {
  const state = await load(projectRoot, dataDirOverride);
  const pending = [];
  const overrides = [];
  for (const d of state.decisions) {
    if (d.type === 'pending') pending.push(d);
    else if (d.type === 'override' && !isExpired(d)) overrides.push(d);
  }
  return { pending, overrides };
}

/**
 * Check whether an active override exists for a gate+file, and consume a
 * 'once' override in the same call.
 * @param {string} projectRoot
 * @param {string} gateId
 * @param {string} file
 * @param {string|null} [sessionId]
 * @param {string} [dataDirOverride]
 * @returns {Promise<boolean>}
 */
export async function checkOverride(projectRoot, gateId, file, sessionId = null, dataDirOverride) {
  const state = await load(projectRoot, dataDirOverride);
  const active = state.decisions.filter(d => d.type === 'override' && d.gateId === gateId && d.file === file && !isExpired(d));

  if (active.length === 0) return false;

  // If any override is session-scoped, the provided session must match
  const sessionOverrides = active.filter(d => d.scope === 'session');
  if (sessionOverrides.length > 0 && !sessionOverrides.some(d => d.sessionId === sessionId)) {
    return false;
  }

  // Consume once overrides
  let changed = false;
  state.decisions = state.decisions.filter(d => {
    if (d.type === 'override' && d.gateId === gateId && d.file === file && d.scope === 'once') {
      changed = true;
      return false;
    }
    return true;
  });

  if (changed) {
    await save(projectRoot, dataDirOverride, state);
  }

  return true;
}

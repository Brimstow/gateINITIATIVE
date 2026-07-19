/**
 * gateinitiative: Playbook State Management
 *
 * playbook-state.json is written by IDE hooks to record that the user has
 * completed a prerequisite step (e.g., read a context doc). Because it lives
 * inside the project tree, a malicious agent could forge entries to bypass
 * playbook enforcement. We guard against this by:
 *   - Keeping a machine/project-specific HMAC key outside the project tree
 *   - Requiring every completed entry to carry a valid HMAC signature
 *   - Ignoring entries whose signature is missing or wrong
 */

import { createHmac, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { getPlatformDataDir, getProjectHash } from './platform-paths.mjs';

const STATE_FILE = '.gateinitiative/playbook-state.json';

function getSecretPath(projectRoot, dataDirOverride) {
  const base = dataDirOverride || getPlatformDataDir();
  return resolve(base, 'secrets', getProjectHash(projectRoot), 'playbook-state.key');
}

/**
 * Load or create the HMAC secret for playbook state.
 * The secret is stored outside the project tree so agents cannot read or write it.
 * @param {string} projectRoot
 * @param {string} [dataDirOverride]
 * @returns {Promise<string>}
 */
export async function getStateSecret(projectRoot, dataDirOverride) {
  const secretPath = getSecretPath(projectRoot, dataDirOverride);
  try {
    return await readFile(secretPath, 'utf-8');
  } catch {
    await mkdir(dirname(secretPath), { recursive: true });
    const secret = randomBytes(32).toString('hex');
    await writeFile(secretPath, secret);
    return secret;
  }
}

/**
 * Compute the HMAC signature for a state entry.
 * @param {string} secret
 * @param {string} key
 * @param {number} timestamp
 * @returns {string}
 */
export function signStateEntry(secret, key, timestamp) {
  return createHmac('sha256', secret).update(`${key}:${timestamp}`).digest('hex');
}

/**
 * Build a signed state object from a map of completed entries.
 * @param {string} secret
 * @param {Object} completed
 * @param {string|null} [session]
 * @returns {Object}
 */
export function buildSignedState(secret, completed, session = null) {
  const signatures = {};
  for (const [key, timestamp] of Object.entries(completed)) {
    signatures[key] = signStateEntry(secret, key, timestamp);
  }
  return { version: 1, session, completed, signatures };
}

/**
 * Read and verify playbook-state.json, returning only entries with valid HMACs.
 * @param {string} projectRoot
 * @param {string} secret
 * @returns {Promise<{session: string|null, completed: Object}>}
 */
export async function readVerifiedState(projectRoot, secret) {
  const statePath = join(projectRoot, STATE_FILE);
  try {
    const content = await readFile(statePath, 'utf8');
    const raw = JSON.parse(content);
    const completed = {};
    const signatures = raw.signatures || {};

    for (const [key, timestamp] of Object.entries(raw.completed || {})) {
      const expected = signStateEntry(secret, key, timestamp);
      if (signatures[key] === expected) {
        completed[key] = timestamp;
      }
    }

    return { session: raw.session || null, completed };
  } catch {
    return { session: null, completed: {} };
  }
}

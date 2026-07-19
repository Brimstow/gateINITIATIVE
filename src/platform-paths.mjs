/**
 * gateinitiative: Platform-specific data paths
 *
 * Keeps runtime data (shadow store, quarantine, manifests, decisions)
 * outside the project tree so agents cannot tamper with enforcement state.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * Get the platform-specific base data directory for gateinitiative.
 * @returns {string}
 */
export function getPlatformDataDir() {
  const platform = process.platform;

  if (platform === 'win32') {
    return resolve(
      process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
      'gateinitiative'
    );
  }

  if (platform === 'darwin') {
    return resolve(
      homedir(),
      'Library',
      'Application Support',
      'gateinitiative'
    );
  }

  // Linux and other POSIX — follow XDG Base Directory spec
  return resolve(
    process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
    'gateinitiative'
  );
}

/**
 * Get a short, stable hash key for a project root.
 * @param {string} projectRoot
 * @returns {string}
 */
export function getProjectHash(projectRoot) {
  return createHash('sha256')
    .update(resolve(projectRoot))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Get the external shadow store directory for a project.
 * @param {string} projectRoot
 * @param {string} [dataDirOverride] — parent data dir (contains shadow/<hash>)
 * @returns {string}
 */
export function getShadowDir(projectRoot, dataDirOverride) {
  const base = dataDirOverride || getPlatformDataDir();
  return resolve(base, 'shadow', getProjectHash(projectRoot));
}

/**
 * Get the external quarantine directory for a project.
 * @param {string} projectRoot
 * @param {string} [dataDirOverride] — parent data dir (contains quarantine/<hash>)
 * @returns {string}
 */
export function getQuarantineDir(projectRoot, dataDirOverride) {
  const base = dataDirOverride || getPlatformDataDir();
  return resolve(base, 'quarantine', getProjectHash(projectRoot));
}

/**
 * Get the external decisions/pending-review directory for a project.
 * @param {string} projectRoot
 * @param {string} [dataDirOverride]
 * @returns {string}
 */
export function getDecisionsDir(projectRoot, dataDirOverride) {
  const base = dataDirOverride || getPlatformDataDir();
  return resolve(base, 'decisions', getProjectHash(projectRoot));
}

/**
 * Record the project root inside each external data dir so `gateinit clean`
 * can map orphaned hashes back to deleted projects.
 * @param {string} projectRoot
 * @param {string} [dataDirOverride]
 */
export async function ensureProjectRootMarker(projectRoot, dataDirOverride) {
  const root = resolve(projectRoot);
  const markerPath = join(getShadowDir(root, dataDirOverride), '.root');
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, root, 'utf-8');
}

/**
 * Find external data directories whose recorded project roots no longer exist.
 * @param {string} [dataDirOverride]
 * @returns {Promise<{hash: string, root: string|null, paths: string[]}[]>}
 */
export async function findOrphanedDataDirs(dataDirOverride) {
  const base = dataDirOverride || getPlatformDataDir();
  const orphaned = [];

  for (const bucket of ['shadow', 'quarantine', 'decisions']) {
    const bucketDir = join(base, bucket);
    let entries = [];
    try {
      entries = await readdir(bucketDir, { withFileTypes: true });
    } catch { continue; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const hash = entry.name;
      const markerPath = join(bucketDir, hash, '.root');
      let root = null;
      try {
        root = (await readFile(markerPath, 'utf-8')).trim();
      } catch { /* marker missing */ }

      if (root && !existsSync(root)) {
        orphaned.push({ hash, root, paths: [join(bucketDir, hash)] });
      }
    }
  }

  // Merge entries across buckets for the same hash
  const byHash = new Map();
  for (const item of orphaned) {
    if (byHash.has(item.hash)) {
      byHash.get(item.hash).paths.push(...item.paths);
    } else {
      byHash.set(item.hash, item);
    }
  }
  return [...byHash.values()];
}

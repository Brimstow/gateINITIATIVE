import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { getPlatformDataDir, getProjectHash } from './platform-paths.mjs';

function trustPath(projectRoot, dataDirOverride) {
  const base = dataDirOverride || getPlatformDataDir();
  return join(base, 'trust', getProjectHash(projectRoot), 'gates.json');
}

async function hashFile(filePath) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export async function fingerprintGateSources(gates) {
  const sources = [...new Set(gates.map(gate => gate.source).filter(Boolean))].sort();
  const fingerprints = {};
  for (const source of sources) {
    fingerprints[resolve(source)] = await hashFile(source);
  }
  return fingerprints;
}

export async function getGateTrust(projectRoot, dataDirOverride) {
  try {
    const raw = await readFile(trustPath(projectRoot, dataDirOverride), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && parsed.version === 1 && parsed.fingerprints && typeof parsed.fingerprints === 'object'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export async function evaluateGateTrust(projectRoot, gates, dataDirOverride) {
  const fingerprints = await fingerprintGateSources(gates);
  const trusted = await getGateTrust(projectRoot, dataDirOverride);
  const currentEntries = Object.entries(fingerprints);
  const isTrusted = Boolean(trusted)
    && Object.keys(trusted.fingerprints).length === currentEntries.length
    && currentEntries.every(([source, fingerprint]) => trusted.fingerprints[source] === fingerprint);
  return { trusted: isTrusted, fingerprints };
}

export async function trustGateSources(projectRoot, gates, dataDirOverride) {
  const fingerprints = await fingerprintGateSources(gates);
  const path = trustPath(projectRoot, dataDirOverride);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    version: 1,
    trustedAt: new Date().toISOString(),
    fingerprints,
  }, null, 2) + '\n', 'utf-8');
  return { path, fingerprints };
}

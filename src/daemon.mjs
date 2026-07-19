// gateinitiative: Daemon Lifecycle Module
//
// Cross-platform utilities for managing gateinitiative as a background daemon.
// Handles PID file management, process alive detection, log rotation, and
// metadata tracking for the `start`, `stop`, `restart`, `status` commands.
//
// All functions are platform-agnostic (Windows + POSIX) via Node.js abstractions.

import { readFile, writeFile, unlink, stat, mkdir } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

// Constants
export const PID_FILE = 'gateinitiative.pid';
export const META_FILE = 'gateinitiative.meta';
export const HEARTBEAT_FILE = 'heartbeat';
export const READY_FILE = 'ready';
export const LOG_FILE = 'gateinitiative.log';
export const LOG_MAX_BYTES = 1_048_576; // 1MB
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_STALE_MS = 30_000;

/**
 * Get the runtime directory path (.gateinitiative/)
 * @param {string} projectRoot
 * @returns {string}
 */
export function getRuntimeDir(projectRoot) {
  return resolve(projectRoot, '.gateinitiative');
}

/**
 * Ensure the runtime directory exists
 * @param {string} projectRoot
 */
export async function ensureRuntimeDir(projectRoot) {
  await mkdir(getRuntimeDir(projectRoot), { recursive: true });
}

/**
 * Write the daemon PID to file
 * @param {string} runtimeDir
 * @param {number} pid
 */
export async function writePid(runtimeDir, pid) {
  await writeFile(join(runtimeDir, PID_FILE), String(pid), 'utf8');
}

/**
 * Read the daemon PID from file
 * @param {string} runtimeDir
 * @returns {Promise<number|null>} PID or null if file missing/invalid
 */
export async function readPid(runtimeDir) {
  try {
    const content = await readFile(join(runtimeDir, PID_FILE), 'utf8');
    const pid = parseInt(content.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Remove the PID file (cleanup on stop or stale detection)
 * @param {string} runtimeDir
 */
export async function removePid(runtimeDir) {
  try {
    await unlink(join(runtimeDir, PID_FILE));
  } catch { /* ENOENT is fine */ }
}

/**
 * Check if a process is alive (cross-platform)
 * - ESRCH: process doesn't exist (dead)
 * - EPERM: process exists but access denied (alive, different user)
 * - No error: process exists and we can signal it (alive)
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means process exists but we lack permission — still alive
    if (err.code === 'EPERM') return true;
    // ESRCH means no such process — dead
    return false;
  }
}

/**
 * Write daemon metadata (start time, mode, root) for status display
 * @param {string} runtimeDir
 * @param {Object} meta
 */
export async function writeMeta(runtimeDir, meta) {
  await writeFile(join(runtimeDir, META_FILE), JSON.stringify(meta, null, 2), 'utf8');
}

/**
 * Read daemon metadata
 * @param {string} runtimeDir
 * @returns {Promise<Object|null>}
 */
export async function readMeta(runtimeDir) {
  try {
    const content = await readFile(join(runtimeDir, META_FILE), 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Remove the meta file
 * @param {string} runtimeDir
 */
export async function removeMeta(runtimeDir) {
  try {
    await unlink(join(runtimeDir, META_FILE));
  } catch { /* ENOENT is fine */ }
}

/**
 * Touch the daemon heartbeat file (timestamp of last alive ping)
 * @param {string} runtimeDir
 */
export async function writeHeartbeat(runtimeDir) {
  await writeFile(join(runtimeDir, HEARTBEAT_FILE), Date.now().toString(), 'utf8');
}

/**
 * Read the last heartbeat timestamp
 * @param {string} runtimeDir
 * @returns {Promise<number|null>} epoch ms or null
 */
export async function readHeartbeat(runtimeDir) {
  try {
    const raw = await readFile(join(runtimeDir, HEARTBEAT_FILE), 'utf8');
    const ts = parseInt(raw.trim(), 10);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

/**
 * Write the daemon ready marker (baseline scan + watcher initialized).
 * @param {string} runtimeDir
 */
export async function writeReadyMarker(runtimeDir) {
  await writeFile(join(runtimeDir, READY_FILE), Date.now().toString(), 'utf8');
}

/**
 * Read the daemon ready marker timestamp
 * @param {string} runtimeDir
 * @returns {Promise<number|null>} epoch ms or null
 */
export async function readReadyTimestamp(runtimeDir) {
  try {
    const raw = await readFile(join(runtimeDir, READY_FILE), 'utf8');
    const ts = parseInt(raw.trim(), 10);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

/**
 * Remove the ready marker file
 * @param {string} runtimeDir
 */
export async function removeReadyMarker(runtimeDir) {
  try {
    await unlink(join(runtimeDir, READY_FILE));
  } catch { /* ENOENT is fine */ }
}

/**
 * Get age of last heartbeat in ms
 * @param {string} runtimeDir
 * @returns {Promise<number|null>} ms since last heartbeat, or null if never written
 */
export async function heartbeatAge(runtimeDir) {
  const ts = await readHeartbeat(runtimeDir);
  return ts === null ? null : Date.now() - ts;
}

/**
 * Rotate the log file if it exceeds LOG_MAX_BYTES.
 * Keeps the last ~500KB of content.
 * @param {string} runtimeDir
 */
export async function rotateLog(runtimeDir) {
  const logPath = join(runtimeDir, LOG_FILE);
  try {
    const fileStat = await stat(logPath);
    if (fileStat.size <= LOG_MAX_BYTES) return;

    // Read the entire file, keep last 500KB
    const content = await readFile(logPath, 'utf8');
    const keepFrom = content.length - 512_000;
    const trimmed = content.slice(keepFrom > 0 ? keepFrom : 0);
    const separator = `\n--- Log rotated at ${new Date().toISOString()} ---\n\n`;
    await writeFile(logPath, separator + trimmed, 'utf8');
  } catch {
    // File doesn't exist or can't be read — nothing to rotate
  }
}

/**
 * Get the log file path
 * @param {string} runtimeDir
 * @returns {string}
 */
export function getLogPath(runtimeDir) {
  return join(runtimeDir, LOG_FILE);
}

/**
 * Get log file size in bytes (or 0 if missing)
 * @param {string} runtimeDir
 * @returns {Promise<number>}
 */
export async function getLogSize(runtimeDir) {
  try {
    const s = await stat(join(runtimeDir, LOG_FILE));
    return s.size;
  } catch {
    return 0;
  }
}

/**
 * Format an ISO timestamp into a human-readable uptime string
 * @param {string} startedAtIso - ISO 8601 timestamp
 * @returns {string} e.g. "2h 15m 32s"
 */
export function formatUptime(startedAtIso) {
  const elapsed = Date.now() - new Date(startedAtIso).getTime();
  if (elapsed < 0) return '0s';

  const seconds = Math.floor(elapsed / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);

  return parts.join(' ');
}

/**
 * Spawn the gateinitiative daemon as a detached background process
 * @param {string} projectRoot
 * @param {Object} options
 * @param {string} options.mode - Enforcement mode (warn/strict/audit)
 * @param {string} [options.shadowDir] - Override shadow data directory
 * @param {string} options.scriptPath - Path to gateinit.mjs
 * @returns {{pid: number, logPath: string}}
 */
export function spawnDaemon(projectRoot, { mode, shadowDir, scriptPath, toast = true }) {
  const runtimeDir = getRuntimeDir(projectRoot);
  const logPath = getLogPath(runtimeDir);

  // Open log file for append (daemon stdout/stderr go here)
  const logFd = openSync(logPath, 'a');

  const args = [scriptPath, 'watch', '--root', projectRoot];
  if (mode) args.push('--mode', mode);
  if (shadowDir) args.push('--shadow-dir', shadowDir);
  if (!toast) args.push('--no-toast');
  args.push('--daemon');

  const child = spawn(
    process.execPath,
    args,
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      cwd: projectRoot,
    }
  );

  child.unref();
  closeSync(logFd); // Child holds its own copy — don't leak the parent's fd
  return { pid: child.pid, logPath };
}

/**
 * Wait for a process to die, polling at interval
 * @param {number} pid
 * @param {number} timeoutMs - Max wait time
 * @param {number} intervalMs - Poll interval
 * @returns {Promise<boolean>} true if process died within timeout
 */
export async function waitForDeath(pid, timeoutMs = 3000, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return !isProcessAlive(pid);
}

/**
 * Wait for a freshly spawned daemon to become ready.
 * Ready means: the child is alive AND has written its own PID file
 * AND the ready marker exists (baseline scan + watcher initialized).
 *
 * @param {string} runtimeDir
 * @param {number} childPid - PID returned by spawnDaemon
 * @param {number} [timeoutMs] - Total wait budget
 * @param {number} [intervalMs] - Poll interval
 * @returns {Promise<{ready: boolean, died: boolean}>}
 *   ready=true: daemon confirmed up and watching.
 *   died=true: the child exited before becoming ready (check the log).
 *   ready=false, died=false: still initializing when the budget ran out.
 */
export async function waitForDaemonReady(runtimeDir, childPid, timeoutMs = 5000, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(childPid)) return { ready: false, died: true };
    const pid = await readPid(runtimeDir);
    const readyTs = await readReadyTimestamp(runtimeDir);
    if (pid === childPid && readyTs !== null) return { ready: true, died: false };
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { ready: false, died: !isProcessAlive(childPid) };
}

/**
 * Read the last N lines of the daemon log (for start-failure diagnostics).
 * @param {string} runtimeDir
 * @param {number} [lines]
 * @returns {Promise<string[]>}
 */
export async function tailLog(runtimeDir, lines = 10) {
  try {
    const content = await readFile(getLogPath(runtimeDir), 'utf8');
    return content.split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

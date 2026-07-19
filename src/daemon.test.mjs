// gateinitiative: Daemon lifecycle tests
// Run with: node --test src/daemon.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  getRuntimeDir, ensureRuntimeDir,
  writePid, readPid, removePid, isProcessAlive,
  writeMeta, readMeta, removeMeta,
  writeHeartbeat, readHeartbeat, heartbeatAge,
  writeReadyMarker, readReadyTimestamp, removeReadyMarker,
  rotateLog, getLogPath, getLogSize, formatUptime, waitForDeath,
  waitForDaemonReady, tailLog,
  PID_FILE, META_FILE, LOG_FILE, READY_FILE, LOG_MAX_BYTES,
} from './daemon.mjs';

const TMP = join(process.cwd(), '.tmp-daemon-test');

/** Spawn a short-lived child process and wait for it to exit; returns its (now dead) pid */
function spawnDeadProcess() {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid;
    child.on('exit', () => resolvePromise(pid));
    child.on('error', rejectPromise);
  });
}

before(async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
});

after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe('runtime dir', () => {
  it('getRuntimeDir resolves to .gateinitiative under the project root', () => {
    assert.equal(getRuntimeDir(TMP), join(TMP, '.gateinitiative'));
  });

  it('ensureRuntimeDir creates the directory (idempotent)', async () => {
    await ensureRuntimeDir(TMP);
    await ensureRuntimeDir(TMP);
    const s = await stat(getRuntimeDir(TMP));
    assert.ok(s.isDirectory());
  });
});

describe('PID file', () => {
  it('writePid/readPid roundtrip', async () => {
    await writePid(TMP, 12345);
    assert.equal(await readPid(TMP), 12345);
  });

  it('readPid returns null when the file is missing', async () => {
    await removePid(TMP);
    assert.equal(await readPid(TMP), null);
  });

  it('readPid returns null for garbage or non-positive content', async () => {
    for (const bad of ['not-a-pid', '-5', '0', '']) {
      await writeFile(join(TMP, PID_FILE), bad, 'utf8');
      assert.equal(await readPid(TMP), null, `content: ${JSON.stringify(bad)}`);
    }
  });

  it('removePid is idempotent (no throw on missing file)', async () => {
    await removePid(TMP);
    await removePid(TMP);
  });
});

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it('returns false for an exited process', async () => {
    const deadPid = await spawnDeadProcess();
    assert.equal(isProcessAlive(deadPid), false);
  });
});

describe('meta file', () => {
  it('writeMeta/readMeta roundtrip', async () => {
    const meta = { startedAt: '2026-01-01T00:00:00.000Z', mode: 'strict', root: TMP };
    await writeMeta(TMP, meta);
    assert.deepEqual(await readMeta(TMP), meta);
  });

  it('readMeta returns null when the file is missing', async () => {
    await removeMeta(TMP);
    assert.equal(await readMeta(TMP), null);
  });

  it('readMeta returns null on corrupt JSON', async () => {
    await writeFile(join(TMP, META_FILE), '{not json', 'utf8');
    assert.equal(await readMeta(TMP), null);
    await removeMeta(TMP);
  });
});

describe('heartbeat', () => {
  it('writeHeartbeat/readHeartbeat roundtrip and age is non-negative', async () => {
    const beforeWrite = Date.now();
    await writeHeartbeat(TMP);
    const ts = await readHeartbeat(TMP);
    assert.ok(ts >= beforeWrite && ts <= Date.now());

    const age = await heartbeatAge(TMP);
    assert.ok(age >= 0 && age < 5000);
  });

  it('readHeartbeat/heartbeatAge return null when never written', async () => {
    const emptyDir = join(TMP, 'no-heartbeat');
    await mkdir(emptyDir, { recursive: true });
    assert.equal(await readHeartbeat(emptyDir), null);
    assert.equal(await heartbeatAge(emptyDir), null);
  });

  it('readHeartbeat returns null on garbage content', async () => {
    await writeFile(join(TMP, 'heartbeat'), 'garbage', 'utf8');
    assert.equal(await readHeartbeat(TMP), null);
  });
});

describe('log rotation', () => {
  it('does not rotate below the size threshold', async () => {
    const logPath = getLogPath(TMP);
    await writeFile(logPath, 'small log\n', 'utf8');
    await rotateLog(TMP);
    assert.equal(await readFile(logPath, 'utf8'), 'small log\n');
  });

  it('rotates an oversized log, keeping the tail', async () => {
    const logPath = getLogPath(TMP);
    const filler = 'x'.repeat(1024) + '\n';
    const tailMarker = 'THE-VERY-END-OF-THE-LOG';
    const big = filler.repeat(Math.ceil((LOG_MAX_BYTES + 1024) / filler.length)) + tailMarker;
    await writeFile(logPath, big, 'utf8');

    await rotateLog(TMP);

    const rotated = await readFile(logPath, 'utf8');
    assert.ok(rotated.length < big.length, 'log should shrink');
    assert.ok(rotated.includes('--- Log rotated at '), 'should include rotation separator');
    assert.ok(rotated.endsWith(tailMarker), 'should keep the tail of the log');
  });

  it('is a no-op when the log file is missing', async () => {
    const emptyDir = join(TMP, 'no-log');
    await mkdir(emptyDir, { recursive: true });
    await rotateLog(emptyDir); // must not throw
    assert.equal(await getLogSize(emptyDir), 0);
  });

  it('getLogSize reports the current size', async () => {
    const dir = join(TMP, 'sized-log');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, LOG_FILE), 'abcde', 'utf8');
    assert.equal(await getLogSize(dir), 5);
  });
});

describe('formatUptime', () => {
  it('formats seconds only', () => {
    const started = new Date(Date.now() - 42_000).toISOString();
    assert.match(formatUptime(started), /^4[23]s$/);
  });

  it('formats minutes and seconds', () => {
    const started = new Date(Date.now() - (2 * 60 + 5) * 1000).toISOString();
    assert.match(formatUptime(started), /^2m [56]s$/);
  });

  it('formats days, hours, minutes, seconds', () => {
    const elapsed = ((1 * 86400) + (2 * 3600) + (3 * 60) + 4) * 1000;
    const started = new Date(Date.now() - elapsed).toISOString();
    assert.match(formatUptime(started), /^1d 2h 3m [45]s$/);
  });

  it('clamps future timestamps to 0s', () => {
    const started = new Date(Date.now() + 60_000).toISOString();
    assert.equal(formatUptime(started), '0s');
  });
});

describe('waitForDeath', () => {
  it('returns true quickly for an already-dead process', async () => {
    const deadPid = await spawnDeadProcess();
    const start = Date.now();
    assert.equal(await waitForDeath(deadPid, 2000, 50), true);
    assert.ok(Date.now() - start < 1000);
  });

  it('returns false when the process outlives the timeout', async () => {
    assert.equal(await waitForDeath(process.pid, 300, 50), false);
  });
});

describe('waitForDaemonReady', () => {
  it('reports ready once the child PID file and ready marker appear', async () => {
    const dir = join(TMP, 'ready');
    await mkdir(dir, { recursive: true });
    await writePid(dir, process.pid); // "child" (this process) wrote its pid
    await writeReadyMarker(dir);

    const outcome = await waitForDaemonReady(dir, process.pid, 2000, 50);
    assert.deepEqual(outcome, { ready: true, died: false });
  });

  it('reports not-ready when the PID file exists but the ready marker is missing', async () => {
    const dir = join(TMP, 'pid-only');
    await mkdir(dir, { recursive: true });
    await writePid(dir, process.pid);
    await removeReadyMarker(dir);

    const outcome = await waitForDaemonReady(dir, process.pid, 300, 50);
    assert.deepEqual(outcome, { ready: false, died: false });
  });

  it('reports died when the child exits before becoming ready', async () => {
    const dir = join(TMP, 'died');
    await mkdir(dir, { recursive: true });
    const deadPid = await spawnDeadProcess();

    const outcome = await waitForDaemonReady(dir, deadPid, 2000, 50);
    assert.equal(outcome.ready, false);
    assert.equal(outcome.died, true);
  });

  it('reports not-ready (but alive) when neither marker appears', async () => {
    const dir = join(TMP, 'slow');
    await mkdir(dir, { recursive: true });

    const outcome = await waitForDaemonReady(dir, process.pid, 300, 50);
    assert.deepEqual(outcome, { ready: false, died: false });
  });

  it('a stale PID file from a different process does not count as ready', async () => {
    const dir = join(TMP, 'stale');
    await mkdir(dir, { recursive: true });
    const deadPid = await spawnDeadProcess();
    await writePid(dir, deadPid); // stale pid ≠ the child we spawned

    const outcome = await waitForDaemonReady(dir, process.pid, 300, 50);
    assert.deepEqual(outcome, { ready: false, died: false });
  });
});

describe('ready marker', () => {
  it('writeReadyMarker/readReadyTimestamp roundtrip', async () => {
    const dir = join(TMP, 'ready-marker');
    await mkdir(dir, { recursive: true });
    const before = Date.now();
    await writeReadyMarker(dir);
    const ts = await readReadyTimestamp(dir);
    assert.ok(ts >= before && ts <= Date.now());
  });

  it('readReadyTimestamp returns null when the marker is missing', async () => {
    const dir = join(TMP, 'no-ready');
    await mkdir(dir, { recursive: true });
    assert.equal(await readReadyTimestamp(dir), null);
  });

  it('readReadyMarker returns null on garbage content', async () => {
    const dir = join(TMP, 'garbage-ready');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, READY_FILE), 'not-a-number', 'utf8');
    assert.equal(await readReadyTimestamp(dir), null);
  });

  it('removeReadyMarker is idempotent', async () => {
    const dir = join(TMP, 'remove-ready');
    await mkdir(dir, { recursive: true });
    await writeReadyMarker(dir);
    await removeReadyMarker(dir);
    await removeReadyMarker(dir);
    assert.equal(await readReadyTimestamp(dir), null);
  });
});

describe('tailLog', () => {
  it('returns the last N non-empty lines', async () => {
    const dir = join(TMP, 'tail');
    await mkdir(dir, { recursive: true });
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`);
    await writeFile(getLogPath(dir), lines.join('\n') + '\n');

    const tail = await tailLog(dir, 5);
    assert.deepEqual(tail, ['line-16', 'line-17', 'line-18', 'line-19', 'line-20']);
  });

  it('returns [] when no log exists', async () => {
    assert.deepEqual(await tailLog(join(TMP, 'no-log')), []);
  });
});

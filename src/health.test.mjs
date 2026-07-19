import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthMonitor, HEALTH_LOG_FILE } from './health.mjs';

describe('HealthMonitor', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gk-health-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a structured JSONL event with category, severity, and hint', async () => {
    const monitor = new HealthMonitor('/project', dir);
    await monitor.report({
      category: 'shadow_write_failed',
      severity: 'error',
      message: 'could not write shadow',
      file: 'src/foo.ts',
    });

    const logPath = join(dir, HEALTH_LOG_FILE);
    assert.equal(existsSync(logPath), true);
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.category, 'shadow_write_failed');
    assert.equal(event.severity, 'error');
    assert.equal(event.message, 'could not write shadow');
    assert.equal(event.file, 'src/foo.ts');
    assert.ok(event.hint, 'event should include a remediation hint');
    assert.ok(event.timestamp);
  });

  it('exposes counters and recent events in memory', async () => {
    const monitor = new HealthMonitor('/project', dir);
    await monitor.report({ category: 'watcher_error', severity: 'critical', message: 'boom' });
    await monitor.report({ category: 'context_write_failed', severity: 'warn', message: 'oops' });

    const counters = monitor.counters();
    assert.equal(counters.critical, 1);
    assert.equal(counters.warn, 1);

    const recent = monitor.recent(2);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].severity, 'warn'); // newest first
  });

  it('rotates the log when it exceeds max size', async () => {
    const monitor = new HealthMonitor('/project', dir);
    const bigMessage = 'x'.repeat(1_200_000);
    await monitor.report({ category: 'shadow_write_failed', severity: 'error', message: bigMessage });
    await monitor.report({ category: 'shadow_write_failed', severity: 'error', message: 'next event' });

    const logPath = join(dir, HEALTH_LOG_FILE);
    const stats = readFileSync(logPath, 'utf-8');
    assert.ok(stats.includes('Health log rotated'));
  });
});

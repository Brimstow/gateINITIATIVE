// gateinitiative: Watcher tests (chokidar v4 ignore/include semantics)
// Run with: node --test src/watcher.test.mjs

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createWatcher, getWatcherConfig, buildIgnoredFn } from './watcher.mjs';

const TMP = join(process.cwd(), '.tmp-watcher-test');

// Each test watches its own never-before-used subdirectory. Re-watching the
// same rm+recreated path from a second chokidar instance reliably produced
// zero events on bun 1.3.5/Linux (the 2026-09-21 ubuntu failures) — a scenario
// the real daemon never runs (it watches one live root for its whole life).
let dirSeq = 0;
let WATCH_ROOT = TMP;

async function freshDir() {
  await rm(TMP, { recursive: true, force: true });
  WATCH_ROOT = join(TMP, `w${++dirSeq}`);
  await mkdir(join(WATCH_ROOT, 'node_modules', 'dep'), { recursive: true });
  await mkdir(join(WATCH_ROOT, 'src'), { recursive: true });
  await mkdir(join(WATCH_ROOT, 'dist'), { recursive: true });
}

async function cleanup() {
  await rm(TMP, { recursive: true, force: true });
}

// CI-deterministic event wait. The old harness slept a fixed 800ms and hoped
// the events had arrived, which raced on slow CI runners (failed runs of
// 2026-07-21 on ubuntu/macos). Instead: poll until the expected event shows
// up (generous deadline), then hold a short settle window so the negative
// (absence) assertions still get a fair chance to observe misbehavior. If
// the event never arrives, the caller's positive assertion fails — real
// regressions are still caught, just without the race.
async function waitForEvents(events, predicate, deadlineMs = 10_000) {
  const start = Date.now();
  while (!predicate(events)) {
    if (Date.now() - start > deadlineMs) return;
    await new Promise(r => setTimeout(r, 25));
  }
  await new Promise(r => setTimeout(r, 500));
}

describe('buildIgnoredFn', () => {
  it('prunes node_modules directories', () => {
    const fn = buildIgnoredFn(TMP, ['**/node_modules/**']);
    // Directory tested with trailing slash
    assert.equal(fn(join(TMP, 'node_modules'), {}), true);
    assert.equal(fn(join(TMP, 'node_modules', 'dep'), {}), true);
    assert.equal(fn(join(TMP, 'src', 'app.ts'), { isFile: () => true }), false);
  });

  it('matches ignored file extensions', () => {
    const fn = buildIgnoredFn(TMP, ['**/*.log']);
    assert.equal(fn(join(TMP, 'app.log'), { isFile: () => true }), true);
    assert.equal(fn(join(TMP, 'src', 'app.ts'), { isFile: () => true }), false);
  });
});

describe('createWatcher (chokidar v4)', () => {
  beforeEach(freshDir);
  afterEach(cleanup);

  // { timeout: 20_000 } — bun's default per-test cap is 5s; slow CI runners
  // can legitimately take longer than that to deliver the first fs event.
  it('emits events for included files and ignores node_modules', { timeout: 20_000 }, async () => {
    const cfg = await getWatcherConfig(WATCH_ROOT);
    const events = [];
    const w = await createWatcher(cfg, (fp, ev) =>
      events.push(ev + ' ' + fp.replace(/\\/g, '/').split('.tmp-watcher-test/')[1]));

    await writeFile(join(WATCH_ROOT, 'src', 'app.ts'), 'const x = 1;\n');
    await writeFile(join(WATCH_ROOT, 'node_modules', 'dep', 'index.js'), 'x\n');
    await writeFile(join(WATCH_ROOT, 'dist', 'build.js'), 'x\n'); // dist is in DEFAULT_IGNORE
    await waitForEvents(events, evs => evs.some(e => e.includes('src/app.ts')));

    await w.close();

    assert.ok(events.some(e => e.includes('src/app.ts')), 'src/app.ts event fired');
    assert.equal(events.filter(e => e.includes('node_modules')).length, 0, 'node_modules ignored');
    assert.equal(events.filter(e => e.includes('dist/')).length, 0, 'dist ignored');
  });

  it('respects include patterns (filters out non-matching files)', { timeout: 20_000 }, async () => {
    const cfg = await getWatcherConfig(WATCH_ROOT);
    // Override include to ts-only
    cfg.include = ['**/*.ts'];
    const events = [];
    const w = await createWatcher(cfg, (fp, ev) =>
      events.push(ev + ' ' + fp.replace(/\\/g, '/').split('.tmp-watcher-test/')[1]));

    await writeFile(join(WATCH_ROOT, 'src', 'a.ts'), 'x\n');
    await writeFile(join(WATCH_ROOT, 'src', 'b.js'), 'x\n');
    await waitForEvents(events, evs => evs.some(e => e.includes('a.ts')));

    await w.close();

    assert.ok(events.some(e => e.includes('a.ts')));
    assert.equal(events.filter(e => e.includes('b.js')).length, 0);
  });
});

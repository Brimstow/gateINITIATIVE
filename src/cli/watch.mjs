// gateinitiative CLI: watch command
//
// Starts the filesystem watcher (foreground for debugging, or as the daemon
// child process when spawned with --daemon by `gateinit start`).

import { resolve, relative } from 'node:path';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { loadProjectGates } from '../parser.mjs';
import { globToRegex, globToExamplePath } from '../evaluator.mjs';
import { SafeEvaluator, evaluateFilesSafe } from '../safe-eval.mjs';
import { createWatcher, getWatcherConfig } from '../watcher.mjs';
import { Enforcer, printSummary } from '../enforcer.mjs';
import { ContextDetector, loadContextRules } from '../context-detector.mjs';
import { PlaybookEnforcer } from '../playbook.mjs';
import { loadConfig } from '../config.mjs';
import { evaluateGateTrust } from '../trust.mjs';
import { HealthMonitor } from '../health.mjs';
import { Notifier } from '../notify.mjs';
import { PlaybookBridge } from '../playbook-bridge.mjs';
import { Pipeline } from '../pipeline.mjs';
import {
  writePid, readPid, removePid, isProcessAlive,
  writeMeta, removeMeta,
  writeReadyMarker, removeReadyMarker,
  getRuntimeDir, ensureRuntimeDir,
  writeHeartbeat, heartbeatAge,
  HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS,
} from '../daemon.mjs';
import { C, banner, getFlag, hasFlag, projectRoot, mode, sound, isDaemon } from './context.mjs';
import { countSources, collectFiles } from './utils.mjs';

export async function cmdWatch() {
  // Load unified configuration (CLI flags override config file)
  const shadowDirFlag = getFlag('shadow-dir');
  const config = await loadConfig(projectRoot, {
    mode,
    shadowDir: shadowDirFlag,
    maxFileBytes: getFlag('max-file-bytes') ? parseInt(getFlag('max-file-bytes'), 10) : undefined,
    startupScan: !hasFlag('no-startup-scan'),
    toast: !hasFlag('no-toast'),
  });

  // In daemon mode: write PID, suppress ANSI, add timestamps
  const runtimeDir = getRuntimeDir(projectRoot);
  await ensureRuntimeDir(projectRoot);
  const health = new HealthMonitor(projectRoot, runtimeDir);

  // Detect unclean shutdown from previous daemon run
  const existingPid = await readPid(runtimeDir);
  const lastBeat = await heartbeatAge(runtimeDir);
  if (lastBeat !== null && lastBeat > HEARTBEAT_STALE_MS && existingPid && !isProcessAlive(existingPid)) {
    await health.report({
      category: 'daemon_crash',
      severity: 'critical',
      message: `Previous daemon (PID ${existingPid}) appears to have crashed; last heartbeat ${Math.round(lastBeat / 1000)}s ago.`,
    });
  }

  if (isDaemon) {
    await writePid(runtimeDir, process.pid);
    await writeMeta(runtimeDir, {
      startedAt: new Date().toISOString(),
      mode: config.mode,
      root: projectRoot,
      nodeVersion: process.version,
    });
    await writeHeartbeat(runtimeDir);
    setInterval(() => writeHeartbeat(runtimeDir).catch(() => {}), HEARTBEAT_INTERVAL_MS);
  }

  // Log helper: in daemon mode, prefix with ISO timestamp and strip ANSI
  const log = isDaemon
    ? (msg) => console.log(`[${new Date().toISOString()}] ${msg.replace(/\x1b\[[0-9;]*m/g, '')}`)
    : (msg) => console.log(msg);
  const warn = (msg) => log(`  ${C.yellow}⚠${C.reset} ${msg}`);

  // Notifier routes critical events to OS toast / queue while keeping
  // terminal output under the enforcer's control.
  const notifier = new Notifier({
    toastEnabled: config.notifications.toast,
    routes: config.notifications.routes,
    onToastFailure: (event) => health.report({
      category: 'notify_failed',
      severity: 'warn',
      message: event.message,
      error: event.detail,
      hint: 'Desktop notification could not be shown. The event was still logged and enforced.',
    }),
  });

  // 2A.5: foreground TTY prompt when attached watch can't revert a block violation
  const promptHandler = (!isDaemon && process.stdin.isTTY)
    ? async ({ gateId, file, reason }) => {
        const timeoutMs = (config.notifications.promptTimeout || 30) * 1000;
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        let answer;
        try {
          answer = await Promise.race([
            rl.question(`\n  ${C.yellow}⚠${C.reset} ${reason}\n  ${gateId} on ${file}\n  [q]uarantine / [o]verride / [i]gnore? (q) `),
            new Promise((res) => setTimeout(() => res(null), timeoutMs)),
          ]);
        } finally {
          rl.close();
        }
        const choice = String(answer || 'q').trim().toLowerCase();
        if (choice.startsWith('o')) return 'override';
        if (choice.startsWith('i')) return 'ignore';
        return 'quarantine';
      }
    : null;

  if (!isDaemon) banner();

  // Load gates
  const loadedGates = await loadProjectGates(projectRoot, { onWarn: warn });
  if (loadedGates.length === 0) {
    log(`  ${C.yellow}⚠ No gates found.${C.reset}`);
    log(`  ${C.gray}Run 'gateinit init' to create example gates,`);
    log(`  or add gate blocks to your docs/agents/*.md files.${C.reset}\n`);
    if (isDaemon) {
      await removePid(runtimeDir);
      await removeMeta(runtimeDir);
      await removeReadyMarker(runtimeDir);
    }
    process.exit(0);
  }

  const trust = await evaluateGateTrust(projectRoot, loadedGates, config.shadow.dir);
  const gates = trust.trusted
    ? loadedGates
    : loadedGates.map(gate => ({ ...gate, severity: 'warn' }));
  if (!trust.trusted) {
    warn(`Gate sources are untrusted; all ${loadedGates.length} gate(s) are running warn-only. Review them, then run ${C.cyan}gateinit trust${C.reset}.`);
  }

  log(`  ${C.green}✓${C.reset} Loaded ${C.bold}${gates.length}${C.reset} gates from ${countSources(gates)} source(s)`);
  log(`  ${C.gray}Mode: ${config.mode} | Root: ${projectRoot}${C.reset}`);
  log(`  ${C.gray}Trigger: filesystem events (chokidar)${C.reset}`);

  // 1.4: warn when gate triggers are not covered by watcher includes, then
  // derive includes from triggers so gates never silently fail to fire.
  const originalIncludes = config.watcher.include;
  const uncovered = gates.filter(g =>
    !originalIncludes.some(include =>
      globToRegex(include).test(globToExamplePath(g.trigger))
    )
  );
  const gateSourcePatterns = ['**/.gates.yml', '**/.gates.yaml', '**/.gates/*.yml', '**/.gates/*.yaml', 'docs/agents/**/*.md'];
  const derivedIncludes = [...new Set([...originalIncludes, ...gates.map(g => g.trigger), ...gateSourcePatterns])];
  if (uncovered.length > 0) {
    for (const gate of uncovered) {
      warn(`Gate ${C.bold}${gate.id}${C.reset} trigger ${C.gray}${gate.trigger}${C.reset} is not covered by watcher.includes — expanding includes`);
    }
  }

  // Load context detection rules
  const contextRules = await loadContextRules(projectRoot, { onWarn: warn });
  const contextDetector = new ContextDetector(contextRules, {
    cooldownMs: hasFlag('no-cooldown') ? 0 : 30000,
  });
  const contextEnabled = !hasFlag('no-context');
  const contextEnforceAll = hasFlag('enforce-context-all');
  const contextEnforce = hasFlag('enforce-context') || contextEnforceAll;
  if (contextEnabled) {
    log(`  ${C.green}✓${C.reset} Context detection: ${C.bold}${contextDetector.ruleCount}${C.reset} rules active`);
    if (contextEnforce) {
      const label = contextEnforceAll ? 'ALL rules enforced' : 'per-rule enforcement';
      log(`  ${C.green}✓${C.reset} Context enforcement: ${C.bold}${label}${C.reset}`);
    }
  }

  // Load playbook definitions
  const playbookEnforcer = new PlaybookEnforcer(projectRoot, { onWarn: warn, shadowDir: config.shadow.dir });
  const playbookCount = await playbookEnforcer.load();
  if (playbookCount > 0) {
    log(`  ${C.green}✓${C.reset} Playbooks: ${C.bold}${playbookCount}${C.reset} sequencing rules active`);
  }

  // Stable session id for the lifetime of this watch/daemon process.
  // Session-scoped overrides are only valid within the same session.
  const sessionId = `${Date.now()}-${process.pid}`;

  // Initialize enforcer (route its output through the daemon-aware logger)
  const enforcer = new Enforcer({
    projectRoot,
    mode: config.mode,
    shadowDir: config.shadow.dir,
    sessionId,
    maxFileBytes: config.enforcement.maxFileBytes,
    sound,
    output: log,
    health,
    notifier,
    promptHandler,
    escalation: config.enforcement.escalation,
  });

  // Seed shadow baselines so strict mode can revert from the very first
  // violation, and prune shadows for stale/removed files
  const protectedPaths = trust.trusted
    ? [...new Set([
      ...loadedGates.map(gate => gate.source).filter(Boolean),
      '.gateinitiative.yml',
      '.gateinitiativerc',
      'gateinitiative.config.yml',
    ].map(path => resolve(projectRoot, path)))]
    : [];
  const existingProtectedPaths = [];
  for (const path of protectedPaths) {
    try {
      if ((await stat(path)).isFile()) existingProtectedPaths.push(path);
    } catch { /* path is not present */ }
  }

  // Shared startup evaluator: used for strict-mode baseline seeding and the
  // startup catch-up scan so pathological patterns cannot stall boot.
  const startupEvaluator = new SafeEvaluator({
    onSlowGate: (gate, timeoutMs) => {
      warn(`Gate ${C.bold}${gate.id}${C.reset} exceeded ${timeoutMs}ms during startup scan and was skipped (possible ReDoS)`);
      health.report({ category: 'slow_gate', severity: 'warn', message: `Gate ${gate.id} exceeded ${timeoutMs}ms during startup scan (possible ReDoS)` });
    },
    log: (msg) => log(`  ${C.gray}${msg}${C.reset}`),
  });

  if (config.mode === 'strict') {
    const scanOptions = {
      maxDepth: config.enforcement.scanMaxDepth ?? 10,
      onSkip: (dir) => warn(`Scan depth limit reached; skipping ${relative(projectRoot, dir).replace(/\\/g, '/') || '.'}`),
    };
    const baselineFiles = await collectFiles(projectRoot, gates, scanOptions);
    await enforcer.initShadows(baselineFiles, gates, startupEvaluator);
    for (const path of existingProtectedPaths) {
      if (!await enforcer.shadow.has(path)) await enforcer.shadow.snapshot(path);
    }
    const pruned = await enforcer.shadow.prune(config.enforcement.pruneAgeDays * 24 * 60 * 60 * 1000);
    log(`  ${C.green}✓${C.reset} Shadow store: ${enforcer.shadow.shadowDir}`);
    log(`  ${C.green}✓${C.reset} Baselines: ${C.bold}${baselineFiles.length}${C.reset} file(s)` +
        (pruned > 0 ? `, ${pruned} stale shadow(s) pruned` : ''));
  }

  // 1.9: startup catch-up scan — evaluate files changed while daemon was down.
  // Timeout-bounded so a pathological pattern cannot stall daemon startup.
  if (config.enforcement.startupScan) {
    const scanOptions = {
      maxDepth: config.enforcement.scanMaxDepth ?? 10,
      onSkip: (dir) => warn(`Scan depth limit reached; skipping ${relative(projectRoot, dir).replace(/\\/g, '/') || '.'}`),
    };
    const startupFiles = await collectFiles(projectRoot, gates, scanOptions);
    const startupViolations = await evaluateFilesSafe(startupEvaluator, gates, startupFiles, projectRoot, {
      maxFileBytes: config.enforcement.maxFileBytes,
    });
    const startupByFile = new Map();
    for (const v of startupViolations) {
      if (!startupByFile.has(v.file)) startupByFile.set(v.file, []);
      startupByFile.get(v.file).push(v);
    }
    if (startupByFile.size > 0) {
      log(`  ${C.yellow}⚠ Startup scan found ${startupByFile.size} file(s) with violations (not auto-reverted):${C.reset}`);
      for (const [file, violations] of startupByFile) {
        log(`    ${C.gray}- ${file}${C.reset}`);
        for (const v of violations) {
          log(`      ${C.gray}[${v.severity}] ${v.gateId}: ${v.message}${C.reset}`);
        }
      }
    }
  }
  await startupEvaluator.dispose();

  log('');

  // Bridge is now driven by the watcher pipeline instead of a separate process (2.6).
  // It still has a standalone `bridge` command for one-shot/CI use.
  const bridge = new PlaybookBridge({
    projectRoot,
    ideTargets: config.bridge.targets,
    maxContextDocs: config.bridge.maxDocs,
    maxDocChars: config.bridge.maxDocChars,
    includePlaybookState: config.bridge.includeState,
    shadowDir: config.shadow.dir,
    gates,
  });

  const updateBridge = async () => {
    try {
      await bridge.run({ daemonRunning: true, daemonStaleSeconds: null });
    } catch (err) {
      health.report({ category: 'context_write_failed', severity: 'warn', message: `Bridge update failed: ${err.message}`, error: err });
    }
  };

  const pipeline = new Pipeline({
    projectRoot,
    mode: config.mode,
    gates,
    enforcer,
    contextDetector,
    playbookEnforcer,
    contextEnabled,
    contextEnforce,
    contextEnforceAll,
    maxFileBytes: config.enforcement.maxFileBytes,
    shadowDir: config.shadow.dir,
    gateSourcePatterns,
    protectedPaths: existingProtectedPaths,
    health,
    onContextWritten: updateBridge,
    verbose: hasFlag('verbose'),
    log,
  });

  await updateBridge();

  // Get watcher config and expand includes so all gate triggers are watched.
  // Unified config values take precedence over the raw watcher config file.
  const watchConfig = await getWatcherConfig(projectRoot);
  watchConfig.include = derivedIncludes;
  watchConfig.stabilityThreshold = config.watcher.stabilityThreshold ?? watchConfig.stabilityThreshold ?? 200;
  if (config.watcher.ignore.length > 0) {
    watchConfig.ignore = [...new Set([...(watchConfig.ignore || []), ...config.watcher.ignore])];
  }

  // Start watching
  log(`  ${C.blue}◉${C.reset} Watching for changes... ${C.gray}(Ctrl+C to stop)${C.reset}\n`);

  const watcher = await createWatcher(watchConfig, (filePath, event) => {
    pipeline.handleEvent(filePath, event);
  }, (err) => {
    health.report({ category: 'watcher_error', severity: 'critical', message: `Watcher error: ${err.message}`, error: err });
    notifier.notify({
      severity: 'health',
      title: 'gateinitiative: watcher error',
      message: `Filesystem watcher failed: ${err.message}. Enforcement may be paused.`,
      category: 'watcher_error',
    }).catch(() => {});
  });

  if (isDaemon) {
    await writeReadyMarker(runtimeDir);
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\n  ${C.gray}Stopping watcher...${C.reset}`);
    await watcher.close();
    await pipeline.drain();
    await pipeline.dispose();
    if (isDaemon) {
      await removePid(runtimeDir);
      await removeMeta(runtimeDir);
      await removeReadyMarker(runtimeDir);
    }
    if (!isDaemon) printSummary(enforcer.stats, gates.length);
    // A clean shutdown is a success — lifetime violation count is reported,
    // not encoded in the exit code (that's what `check` is for)
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
}

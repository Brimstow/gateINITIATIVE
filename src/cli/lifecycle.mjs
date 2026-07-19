// gateinitiative CLI: daemon lifecycle commands (start, stop, restart, status)

import { loadConfig } from '../config.mjs';
import { HealthMonitor } from '../health.mjs';
import {
  readPid, removePid, isProcessAlive,
  readMeta, removeMeta,
  getRuntimeDir, ensureRuntimeDir, rotateLog,
  getLogSize, formatUptime, spawnDaemon, waitForDeath,
  waitForDaemonReady, tailLog,
  heartbeatAge, removeReadyMarker,
  LOG_FILE,
} from '../daemon.mjs';
import { C, getFlag, hasFlag, projectRoot, mode, binScriptPath } from './context.mjs';

/**
 * Report the outcome of a daemon spawn. Exits 1 (with a log tail) when the
 * child died during boot instead of falsely reporting success.
 */
async function reportSpawnOutcome(runtimeDir, pid, logPath, configMode, verb) {
  const outcome = await waitForDaemonReady(runtimeDir, pid);

  if (outcome.died) {
    console.log(`  ${C.red}✖${C.reset} gateinitiative ${verb === 'started' ? 'start' : 'restart'} failed — daemon exited during startup ${C.gray}(PID: ${pid})${C.reset}`);
    const tail = await tailLog(runtimeDir, 8);
    if (tail.length > 0) {
      console.log(`  ${C.gray}Last log lines:${C.reset}`);
      for (const line of tail) console.log(`    ${C.gray}${line}${C.reset}`);
    }
    console.log(`  ${C.gray}Full log: ${logPath}${C.reset}`);
    process.exit(1);
  }

  if (!outcome.ready) {
    console.log(`  ${C.yellow}⚠${C.reset} gateinitiative ${verb} ${C.gray}(PID: ${pid}, mode: ${configMode})${C.reset} — still initializing; check ${C.cyan}gateinit status${C.reset}`);
  } else {
    console.log(`  ${C.green}✓${C.reset} gateinitiative ${verb} ${C.gray}(PID: ${pid}, mode: ${configMode})${C.reset}`);
  }
  console.log(`  ${C.gray}Log: ${logPath}${C.reset}`);
  process.exit(0);
}

function printBootInstructions(root, modeFlag, shadowDir, toast) {
  const node = process.execPath;
  const script = binScriptPath;
  const args = ['start', '--root', root];
  if (modeFlag) args.push('--mode', modeFlag);
  if (shadowDir) args.push('--shadow-dir', shadowDir);
  if (!toast) args.push('--no-toast');
  const cmd = `${node} ${script} ${args.join(' ')}`;

  console.log(`\n  ${C.bold}Boot persistence instructions${C.reset}`);
  if (process.platform === 'win32') {
    console.log(`  On Windows, create a Task Scheduler task that runs at logon:`);
    console.log(`    ${C.cyan}Program:${C.reset} ${node}`);
    console.log(`    ${C.cyan}Arguments:${C.reset} ${script} ${args.join(' ')}`);
    console.log(`  Or use PowerShell as an Administrator:`);
    console.log(`    $action = New-ScheduledTaskAction -Execute '${node.replace(/'/g, "''")}' -Argument '${(`${script} ${args.join(' ')}`).replace(/'/g, "''")}'`);
    console.log(`    $trigger = New-ScheduledTaskTrigger -AtLogOn`);
    console.log(`    Register-ScheduledTask -TaskName 'gateinitiative' -Action $action -Trigger $trigger -RunLevel Highest`);
  } else if (process.platform === 'darwin') {
    const plistPath = `~/Library/LaunchAgents/local.gateinitiative.plist`;
    console.log(`  On macOS, create ${C.cyan}${plistPath}${C.reset} and load it with launchctl:`);
    console.log(`    <?xml version="1.0" encoding="UTF-8"?>`);
    console.log(`    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`);
    console.log(`    <plist version="1.0">`);
    console.log(`      <dict>`);
    console.log(`        <key>Label</key><string>local.gateinitiative</string>`);
    console.log(`        <key>ProgramArguments</key>`);
    console.log(`        <array>`);
    for (const a of [node, script, ...args]) {
      console.log(`          <string>${a.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`);
    }
    console.log(`        </array>`);
    console.log(`        <key>RunAtLoad</key><true/>`);
    console.log(`        <key>KeepAlive</key><true/>`);
    console.log(`      </dict>`);
    console.log(`    </plist>`);
    console.log(`    launchctl load ${plistPath}`);
  } else {
    const unitPath = `~/.config/systemd/user/gateinitiative.service`;
    console.log(`  On Linux, create ${C.cyan}${unitPath}${C.reset} and enable it with systemd:`);
    console.log(`    [Unit]`);
    console.log(`    Description=gateinitiative daemon`);
    console.log(`    After=graphical-session.target`);
    console.log(`    [Service]`);
    console.log(`    Type=simple`);
    console.log(`    ExecStart=${cmd}`);
    console.log(`    Restart=on-failure`);
    console.log(`    [Install]`);
    console.log(`    WantedBy=default.target`);
    console.log(`    systemctl --user enable --now gateinitiative`);
  }
  console.log();
}

export async function cmdStart() {
  const config = await loadConfig(projectRoot, {
    mode,
    shadowDir: getFlag('shadow-dir'),
    toast: !hasFlag('no-toast'),
  });
  const runtimeDir = getRuntimeDir(projectRoot);

  // Check if already running
  const existingPid = await readPid(runtimeDir);
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`  ${C.green}●${C.reset} gateinitiative is already running ${C.gray}(PID: ${existingPid})${C.reset}`);
    process.exit(0);
  }

  // Clean stale PID if present
  if (existingPid) {
    await removePid(runtimeDir);
    await removeMeta(runtimeDir);
  }

  // 4B.3: show platform-specific boot persistence instructions before starting
  if (hasFlag('register')) {
    printBootInstructions(projectRoot, mode, getFlag('shadow-dir'), config.notifications.toast);
  }

  // Ensure runtime dir and rotate log
  await ensureRuntimeDir(projectRoot);
  await rotateLog(runtimeDir);

  // Spawn daemon (watch --daemon) and confirm it actually came up
  const shadowDir = getFlag('shadow-dir');
  const { pid, logPath } = spawnDaemon(projectRoot, { mode, scriptPath: binScriptPath, shadowDir, toast: config.notifications.toast });
  await reportSpawnOutcome(runtimeDir, pid, logPath, config.mode, 'started');
}

export async function cmdStop() {
  const runtimeDir = getRuntimeDir(projectRoot);
  const pid = await readPid(runtimeDir);

  if (!pid) {
    console.log(`  ${C.gray}●${C.reset} gateinitiative is not running`);
    process.exit(0);
  }

  if (!isProcessAlive(pid)) {
    // Stale PID
    await removePid(runtimeDir);
    await removeMeta(runtimeDir);
    console.log(`  ${C.gray}●${C.reset} gateinitiative was not running ${C.gray}(stale PID cleaned)${C.reset}`);
    process.exit(0);
  }

  // Kill the process
  try {
    process.kill(pid);
  } catch (err) {
    console.log(`  ${C.red}✖${C.reset} Failed to stop gateinitiative: ${err.message}`);
    process.exit(1);
  }

  // Wait for death
  const died = await waitForDeath(pid, 3000, 200);
  if (!died) {
    // Force kill
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    await waitForDeath(pid, 1000, 100);
  }

  await removePid(runtimeDir);
  await removeMeta(runtimeDir);
  await removeReadyMarker(runtimeDir);
  console.log(`  ${C.green}✓${C.reset} gateinit stopped ${C.gray}(PID: ${pid})${C.reset}`);
  process.exit(0);
}

export async function cmdRestart() {
  const config = await loadConfig(projectRoot, {
    mode,
    shadowDir: getFlag('shadow-dir'),
    toast: !hasFlag('no-toast'),
  });
  const runtimeDir = getRuntimeDir(projectRoot);
  const pid = await readPid(runtimeDir);

  // Stop if running
  if (pid && isProcessAlive(pid)) {
    try { process.kill(pid); } catch { /* ignore */ }
    await waitForDeath(pid, 3000, 200);
    await removePid(runtimeDir);
    await removeMeta(runtimeDir);
    await removeReadyMarker(runtimeDir);
  } else if (pid) {
    // Stale PID cleanup
    await removePid(runtimeDir);
    await removeMeta(runtimeDir);
    await removeReadyMarker(runtimeDir);
  }

  // Brief pause for resource release
  await new Promise(r => setTimeout(r, 500));

  // Start fresh
  await ensureRuntimeDir(projectRoot);
  await rotateLog(runtimeDir);

  const shadowDir = getFlag('shadow-dir');
  const { pid: newPid, logPath } = spawnDaemon(projectRoot, { mode, scriptPath: binScriptPath, shadowDir });
  await reportSpawnOutcome(runtimeDir, newPid, logPath, config.mode, 'restarted');
}

export async function cmdStatus() {
  const runtimeDir = getRuntimeDir(projectRoot);
  const pid = await readPid(runtimeDir);

  if (!pid) {
    console.log(`  ${C.gray}●${C.reset} gateinitiative: ${C.red}not running${C.reset}`);
    process.exit(1);
  }

  if (!isProcessAlive(pid)) {
    await removePid(runtimeDir);
    await removeMeta(runtimeDir);
    await removeReadyMarker(runtimeDir);
    console.log(`  ${C.gray}●${C.reset} gateinitiative: ${C.red}not running${C.reset} ${C.gray}(stale PID cleaned)${C.reset}`);
    process.exit(1);
  }

  // Running — show status
  const meta = await readMeta(runtimeDir);
  const logSize = await getLogSize(runtimeDir);
  const logKB = Math.round(logSize / 1024);
  const lastBeatAge = await heartbeatAge(runtimeDir);
  const health = new HealthMonitor(projectRoot, runtimeDir);
  const persisted = await health.tail(10);
  const counters = { info: 0, warn: 0, error: 0, critical: 0 };
  for (const ev of persisted) counters[ev.severity] = (counters[ev.severity] || 0) + 1;
  const healthEvents = persisted.slice(-3);

  console.log(`  ${C.green}●${C.reset} gateinitiative: ${C.green}running${C.reset}`);
  console.log(`    ${C.gray}PID:${C.reset}       ${pid}`);
  if (meta) {
    console.log(`    ${C.gray}Mode:${C.reset}      ${meta.mode || 'warn'}`);
    console.log(`    ${C.gray}Uptime:${C.reset}    ${formatUptime(meta.startedAt)}`);
    console.log(`    ${C.gray}Started:${C.reset}   ${meta.startedAt}`);
  }
  if (lastBeatAge !== null) {
    const stale = lastBeatAge > 30_000;
    console.log(`    ${C.gray}Heartbeat:${C.reset} ${stale ? C.red : C.gray}${Math.round(lastBeatAge / 1000)}s ago${C.reset}`);
  }
  if (Object.values(counters).some(c => c > 0)) {
    console.log(`    ${C.gray}Health:${C.reset}    ${Object.entries(counters).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  }
  for (const ev of healthEvents) {
    console.log(`      ${C.gray}[${ev.severity}] ${ev.category}: ${ev.message}${C.reset}`);
  }
  console.log(`    ${C.gray}Log:${C.reset}       .gateinitiative/${LOG_FILE} (${logKB}KB)`);
  process.exit(0);
}

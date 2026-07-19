// gateinitiative CLI: doctor command (setup self-diagnostics)

import { join } from 'node:path';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { loadProjectGates } from '../parser.mjs';
import { globToRegex, globToExamplePath } from '../evaluator.mjs';
import { loadContextRules } from '../context-detector.mjs';
import { PlaybookEnforcer } from '../playbook.mjs';
import { loadConfig } from '../config.mjs';
import { getShadowDir, getQuarantineDir } from '../platform-paths.mjs';
import { HealthMonitor } from '../health.mjs';
import { getRuntimeDir } from '../daemon.mjs';
import { C, banner, getFlag, hasFlag, projectRoot, mode } from './context.mjs';

export async function cmdDoctor() {
  banner();

  const config = await loadConfig(projectRoot, {
    mode,
    shadowDir: getFlag('shadow-dir'),
    maxFileBytes: getFlag('max-file-bytes') ? parseInt(getFlag('max-file-bytes'), 10) : undefined,
    toast: !hasFlag('no-toast'),
  });

  const warnings = [];
  const warn = (msg) => { warnings.push(msg); console.log(`  ${C.yellow}⚠${C.reset} ${msg}`); };
  const ok = (msg) => console.log(`  ${C.green}✓${C.reset} ${msg}`);

  console.log(`  ${C.gray}Root:${C.reset} ${projectRoot}`);
  console.log(`  ${C.gray}Mode:${C.reset} ${config.mode}`);
  console.log(`  ${C.gray}Shadow data dir:${C.reset} ${config.shadow.dir || '<platform default>'}`);
  console.log('');

  // Config
  ok(`Unified config loaded (${Object.keys(config).join(', ')})`);

  // Gates
  const gates = await loadProjectGates(projectRoot, { onWarn: warn });
  if (gates.length === 0) {
    warn('No gates found — gateinitiative will not enforce anything');
  } else {
    ok(`Loaded ${gates.length} gate(s) from ${new Set(gates.map(g => g.source)).size} source(s)`);
    const blockGates = gates.filter(g => g.severity === 'block');
    if (blockGates.length === 0) warn('No block-severity gates — strict mode has nothing to revert');

    // 1.4: check watcher coverage
    const uncovered = gates.filter(g =>
      !config.watcher.include.some(include =>
        globToRegex(include).test(globToExamplePath(g.trigger))
      )
    );
    if (uncovered.length > 0) {
      for (const gate of uncovered) {
        warn(`Gate "${gate.id}" trigger ${gate.trigger} not covered by watcher.includes`);
      }
    }
  }

  // Playbooks
  const playbookEnforcer = new PlaybookEnforcer(projectRoot, { onWarn: warn, shadowDir: config.shadow.dir });
  const playbookCount = await playbookEnforcer.load();
  if (playbookCount === 0) {
    console.log(`  ${C.gray}● No playbooks found.${C.reset}`);
  } else {
    ok(`${playbookCount} playbook(s) loaded`);
  }

  // Context rules
  const contextRules = await loadContextRules(projectRoot, { onWarn: warn });
  if (contextRules.length === 0) {
    console.log(`  ${C.gray}● No context rules found.${C.reset}`);
  } else {
    ok(`${contextRules.length} context rule(s) loaded`);
  }

  // Health log tail
  const health = new HealthMonitor(projectRoot, getRuntimeDir(projectRoot));
  const recentHealth = await health.tail(5);
  if (recentHealth.length > 0) {
    console.log(`  ${C.gray}Recent health events:${C.reset}`);
    for (const ev of recentHealth) {
      const sevColor = ev.severity === 'critical' || ev.severity === 'error' ? C.red : ev.severity === 'warn' ? C.yellow : C.gray;
      console.log(`    ${sevColor}[${ev.severity}]${C.reset} ${C.gray}${ev.category}: ${ev.message}${C.reset}`);
    }
  } else {
    console.log(`  ${C.gray}● No recent health events.${C.reset}`);
  }
  console.log('');

  // External directories
  const shadowDir = getShadowDir(projectRoot, config.shadow.dir);
  const quarantineDir = getQuarantineDir(projectRoot, config.shadow.dir);
  const runtimeDir = getRuntimeDir(projectRoot);
  for (const dir of [shadowDir, quarantineDir, runtimeDir]) {
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '.doctor-write-test'), '');
      await rm(join(dir, '.doctor-write-test'));
      ok(`Writable: ${dir}`);
    } catch (err) {
      warn(`Not writable: ${dir} — ${err.message}`);
    }
  }

  console.log('');
  if (warnings.length === 0) {
    console.log(`  ${C.green}● All checks passed.${C.reset}\n`);
    process.exit(0);
  } else {
    console.log(`  ${C.yellow}● ${warnings.length} issue(s) found.${C.reset}\n`);
    process.exit(1);
  }
}

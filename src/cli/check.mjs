// gateinitiative CLI: check command (one-shot evaluation for CI/automation)

import { resolve } from 'node:path';
import { loadProjectGates } from '../parser.mjs';
import { SafeEvaluator, evaluateFilesSafe } from '../safe-eval.mjs';
import { Enforcer, printSummary } from '../enforcer.mjs';
import { loadConfig } from '../config.mjs';
import { C, banner, getFlag, hasFlag, projectRoot, mode } from './context.mjs';
import { collectFiles } from './utils.mjs';

export async function cmdCheck() {
  banner();

  // Load unified configuration
  const config = await loadConfig(projectRoot, {
    mode,
    shadowDir: getFlag('shadow-dir'),
    maxFileBytes: getFlag('max-file-bytes') ? parseInt(getFlag('max-file-bytes'), 10) : undefined,
    toast: !hasFlag('no-toast'),
  });

  // Load gates
  const warn = (msg) => console.log(`  ${C.yellow}⚠${C.reset} ${msg}`);
  const gates = await loadProjectGates(projectRoot, { onWarn: warn });
  if (gates.length === 0) {
    console.log(`  ${C.yellow}⚠ No gates found.${C.reset}\n`);
    process.exit(0);
  }

  console.log(`  ${C.green}✓${C.reset} Loaded ${C.bold}${gates.length}${C.reset} gates`);
  console.log(`  ${C.gray}Running one-shot evaluation...${C.reset}\n`);

  // Find all files that match any gate trigger
  const allFiles = await collectFiles(projectRoot, gates);
  console.log(`  ${C.gray}Scanning ${allFiles.length} files...${C.reset}\n`);

  const enforcer = new Enforcer({
    projectRoot,
    mode: 'warn', // check mode never reverts
    shadowDir: config.shadow.dir,
    maxFileBytes: config.enforcement.maxFileBytes,
    escalation: config.enforcement.escalation,
  });

  // Timeout-bounded evaluation: a pathological regex is disabled and reported
  // instead of hanging CI (same worker sandbox as the watch pipeline).
  const safeEvaluator = new SafeEvaluator({
    onSlowGate: (gate, timeoutMs) => {
      console.log(`  ${C.yellow}⚠${C.reset} Gate ${C.bold}${gate.id}${C.reset} exceeded ${timeoutMs}ms and was skipped (possible ReDoS — fix its pattern)`);
    },
  });
  const allViolations = await evaluateFilesSafe(safeEvaluator, gates, allFiles, projectRoot, {
    maxFileBytes: config.enforcement.maxFileBytes,
  });
  await safeEvaluator.dispose();
  const slowGates = safeEvaluator.poisonedGateIds;

  const byFile = new Map();
  for (const v of allViolations) {
    if (!byFile.has(v.file)) byFile.set(v.file, []);
    byFile.get(v.file).push(v);
  }
  for (const [file, violations] of byFile) {
    await enforcer.enforce(resolve(projectRoot, file), violations);
  }

  printSummary({ ...enforcer.stats, filesChecked: allFiles.length }, gates.length);
  // info-severity findings are advisory — they don't fail CI.
  // A skipped (poisoned) gate fails the run: its files were NOT fully checked.
  const failing = allViolations.filter(v => v.severity === 'block' || v.severity === 'warn');
  process.exit(failing.length > 0 || slowGates.length > 0 ? 1 : 0);
}

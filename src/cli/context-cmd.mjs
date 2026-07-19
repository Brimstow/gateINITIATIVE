// gateinitiative CLI: context command (show context recommendations/rules)

import { resolve, relative } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ContextDetector, loadContextRules } from '../context-detector.mjs';
import { C, banner, getFlag, projectRoot } from './context.mjs';

export async function cmdContext() {
  banner();

  const contextRules = await loadContextRules(projectRoot, {
    onWarn: (msg) => console.log(`  ${C.yellow}⚠${C.reset} ${msg}`),
  });
  const detector = new ContextDetector(contextRules, { cooldownMs: 0 });

  // If --file is specified, detect context for that file
  const targetFile = getFlag('file');
  if (targetFile) {
    const rel = relative(projectRoot, resolve(targetFile)).replace(/\\/g, '/');
    console.log(`  ${C.bold}Context detection for:${C.reset} ${rel}\n`);

    let content = null;
    try {
      content = await readFile(resolve(targetFile), 'utf-8');
    } catch { /* skip */ }

    const signals = detector.detect(rel, content);
    if (signals.length === 0) {
      console.log(`  ${C.gray}No context recommendations for this file.${C.reset}\n`);
    } else {
      for (const signal of signals) {
        const confStr = `${C.gray}(${Math.round(signal.confidence * 100)}%)${C.reset}`;
        console.log(
          `  ${C.cyan}⟡${C.reset} ${C.bold}${signal.contextFile}${C.reset} ${confStr}`
        );
        console.log(`    ${C.gray}${signal.reason}${C.reset}`);
        console.log('');
      }
    }
    return;
  }

  // Otherwise, show all context rules
  console.log(`  ${C.bold}${contextRules.length} context rule(s) loaded:${C.reset}\n`);

  for (const rule of contextRules) {
    console.log(`  ${C.cyan}⟡${C.reset} ${C.bold}${rule.id}${C.reset}`);
    console.log(`    ${C.gray}loads:${C.reset} ${rule.contextFile}`);
    if (rule.filePatterns.length > 0) {
      console.log(`    ${C.gray}files:${C.reset} ${rule.filePatterns.join(', ')}`);
    }
    if (rule.keywords.length > 0) {
      console.log(`    ${C.gray}keywords:${C.reset} ${rule.keywords.slice(0, 5).join(', ')}${rule.keywords.length > 5 ? '...' : ''}`);
    }
    console.log('');
  }
}

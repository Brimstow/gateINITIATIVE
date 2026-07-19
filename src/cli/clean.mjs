// gateinitiative CLI: clean command (orphaned external data dir cleanup)

import { rm } from 'node:fs/promises';
import { findOrphanedDataDirs } from '../platform-paths.mjs';
import { C, banner, hasFlag } from './context.mjs';

export async function cmdClean() {
  banner();

  const orphaned = await findOrphanedDataDirs();
  if (orphaned.length === 0) {
    console.log(`  ${C.green}✓${C.reset} No orphaned external data directories found.`);
    return;
  }

  console.log(`  ${C.yellow}Found ${orphaned.length} orphaned project data set(s):${C.reset}\n`);
  for (const item of orphaned) {
    console.log(`  ${C.bold}Hash:${C.reset} ${item.hash}`);
    console.log(`    ${C.gray}root:${C.reset} ${item.root || '(unknown)'}`);
    for (const p of item.paths) {
      console.log(`    ${C.gray}dir:${C.reset}  ${p}`);
    }
  }

  if (!hasFlag('delete')) {
    console.log(`\n  ${C.gray}Re-run with --delete to remove these directories.${C.reset}`);
    return;
  }

  for (const item of orphaned) {
    for (const p of item.paths) {
      await rm(p, { recursive: true, force: true });
      console.log(`  ${C.green}✓${C.reset} Removed ${p}`);
    }
  }
}

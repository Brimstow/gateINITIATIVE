// gateinitiative CLI: quarantine command (inspect/restore quarantined files)

import { resolve, relative, join, dirname } from 'node:path';
import { readdir, readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { getQuarantineDir } from '../platform-paths.mjs';
import { C, args, getFlag, projectRoot } from './context.mjs';

/**
 * Quarantine entry ids are millisecond timestamps. Reject anything else so a
 * hostile id like "..\\.." can never resolve outside the quarantine root
 * (quarantine delete/restore would otherwise rm -rf / write to arbitrary paths).
 * @param {string} id
 * @param {string} quarantineRoot
 * @returns {string} absolute entry path, guaranteed inside quarantineRoot
 */
function resolveEntryPath(id, quarantineRoot) {
  if (!id) {
    console.error(`  ${C.red}✖ Missing quarantine id${C.reset}\n`);
    process.exit(1);
  }
  if (!/^\d+$/.test(id)) {
    console.error(`  ${C.red}✖ Invalid quarantine id: ${id}${C.reset} ${C.gray}(ids are numeric timestamps — see 'gateinit quarantine list')${C.reset}\n`);
    process.exit(1);
  }
  const entryPath = resolve(quarantineRoot, id);
  // Belt and braces: the resolved path must stay inside the quarantine root
  if (relative(resolve(quarantineRoot), entryPath).startsWith('..')) {
    console.error(`  ${C.red}✖ Invalid quarantine id: ${id}${C.reset}\n`);
    process.exit(1);
  }
  return entryPath;
}

export async function cmdQuarantine() {
  const subcommand = args[1] || 'list';
  const quarantineRoot = getQuarantineDir(projectRoot, getFlag('shadow-dir'));

  async function listEntries() {
    try {
      return await readdir(quarantineRoot, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  if (subcommand === 'list') {
    const entries = await listEntries();
    const items = entries.filter(e => e.isDirectory());
    if (items.length === 0) {
      console.log(`  ${C.gray}No quarantined files.${C.reset}\n`);
      process.exit(0);
    }
    console.log(`  ${C.bold}Quarantined items:${C.reset}\n`);
    for (const item of items.sort((a, b) => Number(a.name) - Number(b.name))) {
      const itemPath = resolve(quarantineRoot, item.name);
      let count = 0;
      try {
        const files = await readdir(itemPath, { recursive: true });
        count = files.filter(f => !f.includes('/')).length; // rough top-level count
      } catch { /* ignore */ }
      const ts = new Date(Number(item.name)).toISOString();
      console.log(`  ${C.red}●${C.reset} ${C.bold}${item.name}${C.reset} — ${ts} (${count} top-level path(s))`);
    }
    console.log(`\n  ${C.gray}Use 'gateinit quarantine show <id>' for details.${C.reset}\n`);
    process.exit(0);
  }

  if (subcommand === 'show') {
    const id = args[2];
    const itemPath = resolveEntryPath(id, quarantineRoot);
    let files;
    try {
      files = await readdir(itemPath, { recursive: true, withFileTypes: true });
    } catch {
      console.error(`  ${C.red}✖ Quarantine entry not found: ${id}${C.reset}\n`);
      process.exit(1);
    }
    console.log(`  ${C.bold}Quarantine ${id}${C.reset} (${new Date(Number(id)).toISOString()})\n`);
    for (const entry of files.filter(e => e.isFile())) {
      const full = join(entry.parentPath || entry.path, entry.name);
      const insideRel = relative(itemPath, full).replace(/\\/g, '/');
      const s = await stat(full);
      console.log(`  ${C.gray}↳${C.reset} ${insideRel} ${C.gray}(${s.size} bytes)${C.reset}`);
    }
    console.log('');
    process.exit(0);
  }

  if (subcommand === 'restore') {
    const id = args[2];
    const itemPath = resolveEntryPath(id, quarantineRoot);
    let files;
    try {
      files = await readdir(itemPath, { recursive: true, withFileTypes: true });
    } catch {
      console.error(`  ${C.red}✖ Quarantine entry not found: ${id}${C.reset}\n`);
      process.exit(1);
    }
    for (const entry of files.filter(e => e.isFile())) {
      const full = join(entry.parentPath || entry.path, entry.name);
      const insideRel = relative(itemPath, full).replace(/\\/g, '/');
      const target = resolve(projectRoot, insideRel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(full));
      console.log(`  ${C.green}✓${C.reset} Restored ${C.bold}${insideRel}${C.reset}`);
    }
    await rm(itemPath, { recursive: true, force: true });
    console.log(`  ${C.gray}Removed quarantine entry ${id}${C.reset}\n`);
    process.exit(0);
  }

  if (subcommand === 'delete') {
    const id = args[2];
    const itemPath = resolveEntryPath(id, quarantineRoot);
    await rm(itemPath, { recursive: true, force: true });
    console.log(`  ${C.gray}Deleted quarantine entry ${id}${C.reset}\n`);
    process.exit(0);
  }

  console.error(`  ${C.red}✖ Unknown quarantine subcommand: ${subcommand}${C.reset}`);
  console.error(`     Valid: list, show <id>, restore <id>, delete <id>\n`);
  process.exit(1);
}

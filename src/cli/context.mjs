// gateinitiative CLI: Shared Command Context
//
// Parses process.argv once at import time and exposes the flags, colors,
// and banner shared by every command module. CLI-only — never imported by
// the library modules in src/.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

// ─── Argument Parsing ────────────────────────────────────────────────────────

export const args = process.argv.slice(2);
export const command = args[0];

export function getFlag(name, defaultValue = null) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultValue;
  const value = args[idx + 1];
  // Don't consume the next flag as a value (e.g. "--root --mode strict")
  if (value === undefined || value.startsWith('--')) return defaultValue;
  return value;
}

export function hasFlag(name) {
  return args.includes(`--${name}`);
}

export const VERSION = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf-8')
).version;

export const VALID_MODES = ['strict', 'warn', 'audit'];

export const projectRoot = resolve(getFlag('root', '.'));
export const mode = getFlag('mode', null);
export const sound = hasFlag('sound');
export const isDaemon = hasFlag('daemon');

if (mode !== null && !VALID_MODES.includes(mode)) {
  console.error(`Invalid --mode "${mode}". Valid modes: ${VALID_MODES.join(', ')}`);
  process.exit(1);
}

/** Absolute path to the CLI entry script (used by spawnDaemon and --register) */
export const binScriptPath = fileURLToPath(new URL('../../bin/gateinit.mjs', import.meta.url));

// ─── ANSI Helpers ────────────────────────────────────────────────────────────

export const C = {
  bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

export function banner() {
  console.log(`
  ${C.cyan}${C.bold}gateINITIATIVE${C.reset} ${C.dim}v${VERSION}${C.reset}
  ${C.gray}Standalone enforcement daemon${C.reset}
  ${C.gray}IDE-agnostic · VCS-agnostic · CLI-agnostic${C.reset}
  `);
}

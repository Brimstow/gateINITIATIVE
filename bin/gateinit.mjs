#!/usr/bin/env node

/**
 * gateinitiative CLI — thin dispatcher
 *
 * Standalone enforcement daemon. IDE-agnostic. VCS-agnostic. CLI-agnostic.
 *
 * Argument parsing, shared helpers, and every command implementation live in
 * src/cli/ (one module per command area). Commands are lazy-loaded so `status`
 * doesn't pay the import cost of `watch`.
 *
 * Run `gateinit help` for full usage.
 */

import { command, C } from '../src/cli/context.mjs';

const COMMANDS = {
  start:      async () => (await import('../src/cli/lifecycle.mjs')).cmdStart(),
  stop:       async () => (await import('../src/cli/lifecycle.mjs')).cmdStop(),
  restart:    async () => (await import('../src/cli/lifecycle.mjs')).cmdRestart(),
  status:     async () => (await import('../src/cli/lifecycle.mjs')).cmdStatus(),
  watch:      async () => (await import('../src/cli/watch.mjs')).cmdWatch(),
  check:      async () => (await import('../src/cli/check.mjs')).cmdCheck(),
  test:       async () => (await import('../src/cli/test-cmd.mjs')).cmdTest(),
  context:    async () => (await import('../src/cli/context-cmd.mjs')).cmdContext(),
  init:       async () => (await import('../src/cli/gates.mjs')).cmdInit(),
  trust:      async () => (await import('../src/cli/gates.mjs')).cmdTrust(),
  list:       async () => (await import('../src/cli/gates.mjs')).cmdList(),
  onboard:    async () => (await import('../src/cli/onboard.mjs')).cmdOnboard(),
  bridge:     async () => (await import('../src/cli/bridge.mjs')).cmdBridge(),
  doctor:     async () => (await import('../src/cli/doctor.mjs')).cmdDoctor(),
  quarantine: async () => (await import('../src/cli/quarantine.mjs')).cmdQuarantine(),
  clean:      async () => (await import('../src/cli/clean.mjs')).cmdClean(),
  review:     async () => (await import('../src/cli/review.mjs')).cmdReview(),
};

async function showHelp() {
  (await import('../src/cli/help.mjs')).showHelp();
}

if (COMMANDS[command]) {
  try {
    await COMMANDS[command]();
  } catch (err) {
    console.error(`  ${C.red}✖${C.reset} ${err.message}`);
    process.exit(1);
  }
} else if (command === '--help' || command === '-h' || command === 'help' || !command) {
  await showHelp();
} else {
  await showHelp();
  console.log(`  ${C.red}Unknown command: ${command}${C.reset}\n`);
  process.exit(1);
}

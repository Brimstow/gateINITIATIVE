// gateinitiative CLI: bridge command (IDE rules generation from context signals)

import { loadProjectGates } from '../parser.mjs';
import { loadConfig } from '../config.mjs';
import { PlaybookBridge } from '../playbook-bridge.mjs';
import { getRuntimeDir, heartbeatAge } from '../daemon.mjs';
import { C, banner, getFlag, hasFlag, projectRoot } from './context.mjs';

export async function cmdBridge() {
  banner();

  const once = hasFlag('once');
  const ideTargets = getFlag('ide')?.split(',') || ['zed', 'void', 'cursor'];
  const config = await loadConfig(projectRoot);

  const warn = (msg) => console.log(`  ${C.yellow}⚠${C.reset} ${msg}`);
  const gates = await loadProjectGates(projectRoot, { onWarn: warn });

  const staleSeconds = await heartbeatAge(getRuntimeDir(projectRoot));
  const daemonRunning = staleSeconds !== null && staleSeconds <= 30_000; // heartbeatAge returns ms

  const bridge = new PlaybookBridge({
    projectRoot,
    ideTargets,
    maxContextDocs: parseInt(getFlag('max-docs') || '2', 10),
    maxDocChars: parseInt(getFlag('max-chars') || '2000', 10),
    includePlaybookState: !hasFlag('no-state'),
    shadowDir: config.shadow.dir,
    gates,
  });

  if (once) {
    // One-shot mode: generate rules and exit
    console.log(`  ${C.gray}Running one-shot bridge...${C.reset}\n`);
    const result = await bridge.run({ daemonRunning, daemonStaleSeconds: staleSeconds === null ? null : staleSeconds / 1000 });
    if (result.written.length > 0) {
      console.log(`  ${C.green}✓${C.reset} Wrote rules to: ${result.written.join(', ')}`);
      console.log(`  ${C.gray}Estimated tokens: ~${result.tokenEstimate}${C.reset}`);
    } else {
      console.log(`  ${C.gray}No changes detected.${C.reset}`);
    }
    if (result.skipped.length > 0) {
      console.log(`  ${C.yellow}⚠${C.reset} Skipped (user-owned, no bridge marker): ${result.skipped.join(', ')}`);
    }
    process.exit(0);
  }

  // Watch mode: regenerate rules whenever context.json changes
  console.log(`  ${C.green}✓${C.reset} Playbook bridge active`);
  console.log(`  ${C.gray}Targets: ${ideTargets.join(', ')}${C.reset}`);
  console.log(`  ${C.gray}Watching: .gateinitiative/context.json${C.reset}`);
  console.log(`  ${C.blue}◉${C.reset} Waiting for context changes... ${C.gray}(Ctrl+C to stop)${C.reset}\n`);

  const watcher = await bridge.watch();

  // Report on writes
  const origRun = bridge.run.bind(bridge);
  bridge.run = async () => {
    const result = await origRun({ daemonRunning, daemonStaleSeconds: staleSeconds === null ? null : staleSeconds / 1000 });
    const ts = new Date().toLocaleTimeString();
    if (result.written.length > 0) {
      console.log(`  ${C.gray}${ts}${C.reset} ${C.green}✓${C.reset} Updated: ${result.written.join(', ')} ${C.gray}(~${result.tokenEstimate} tokens)${C.reset}`);
    }
    if (result.skipped.length > 0) {
      console.log(`  ${C.gray}${ts}${C.reset} ${C.yellow}⚠${C.reset} Skipped (user-owned): ${result.skipped.join(', ')}`);
    }
    return result;
  };

  const shutdown = async () => {
    console.log(`\n  ${C.gray}Stopping bridge...${C.reset}`);
    await watcher.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

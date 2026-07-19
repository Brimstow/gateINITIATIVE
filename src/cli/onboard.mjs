// gateinitiative CLI: onboard command (project scan + consent-based setup wizard)

import { relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runOnboarding } from '../onboard.mjs';
import { C, banner, hasFlag, projectRoot } from './context.mjs';

async function printPlan(plan, ctx = { indent: '  ' }) {
  for (const a of plan) {
    const symbol = { create: '+', overwrite: '~', modify: '~', backup: '#', skip: '-' }[a.type] || '?';
    const rel = relative(projectRoot, a.path);
    console.log(`${ctx.indent}${symbol} ${a.type.padEnd(9)} ${rel}${a.reason ? `  ${C.gray}# ${a.reason}${C.reset}` : ''}`);
  }
}

export async function cmdOnboard() {
  banner();

  console.log(`  ${C.cyan}${C.bold}gateinit onboard${C.reset} scans your project, discovers existing`);
  console.log(`  instruction files (AGENTS.md, CLAUDE.md, IDE rules, etc.), and generates`);
  console.log(`  gates, context rules, and a profile. It is intentionally non-destructive:`);
  console.log(`  existing files are backed up to ${C.gray}.bak${C.reset}, global files are read-only,`);
  console.log(`  and you must confirm the plan before anything is written.\n`);

  const isDryRun = hasFlag('dry-run');
  const confirmPlan = async (plan) => {
    console.log(`\n  ${C.cyan}${C.bold}Write plan${C.reset}`);
    if (plan.length === 0) {
      console.log(`  ${C.gray}Nothing to write.${C.reset}\n`);
      return true;
    }
    await printPlan(plan);
    if (hasFlag('yes')) {
      console.log('');
      return true;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ans = (await rl.question(`\n  Proceed? [y/N] `)).trim().toLowerCase();
      return ans === 'y' || ans === 'yes';
    } finally {
      rl.close();
    }
  };

  const result = await runOnboarding(projectRoot, {
    yes: hasFlag('yes'),
    dryRun: isDryRun,
    confirm: confirmPlan,
  });

  if (isDryRun) {
    console.log(`\n  ${C.yellow}Dry run — no files written.${C.reset}\n`);
  } else if (!result.executed) {
    console.log(`\n  ${C.gray}Onboarding cancelled.${C.reset}\n`);
    return;
  }

  // Report
  const { stack, scan, artifacts, wrote, backedUp, skipped, proseCandidates, globalSuggestions } = result;

  console.log(`\n  ${C.cyan}${C.bold}Profile${C.reset}`);
  console.log(`    language: ${artifacts.profile.language}`);
  console.log(`    testFramework: ${artifacts.profile.testFramework || 'none'}`);
  console.log(`    strictness: ${artifacts.profile.strictness}`);
  console.log(`    presets: ${Object.entries(artifacts.profile.presets).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);

  if (artifacts.playbooks.length > 0) {
    console.log(`\n  ${C.cyan}${C.bold}Generated playbooks${C.reset}`);
    for (const pb of artifacts.playbooks) {
      console.log(`    ${C.gray}✓${C.reset} ${pb.path}`);
    }
  }

  if (artifacts.docs.length > 0) {
    console.log(`\n  ${C.cyan}${C.bold}Generated skill docs${C.reset}`);
    for (const doc of artifacts.docs) {
      console.log(`    ${C.gray}✓${C.reset} ${doc.path}`);
    }
  }

  if (scan.workspace.length > 0 || scan.global.length > 0) {
    console.log(`\n  ${C.cyan}${C.bold}Discovered instruction files${C.reset}`);
    for (const s of [...scan.workspace, ...scan.global]) {
      const tag = s.scope === 'global' ? `${C.gray}[global]${C.reset}` : s.nested ? `${C.gray}[nested]${C.reset}` : '';
      const actions = (result.answers.sources || []).filter(x => x.path === s.path);
      const action = actions[0]?.action || 'skip';
      const link = actions[0]?.link ? ' + link' : '';
      console.log(`    ${tag} ${s.relPath} → ${action}${link}`);
    }
  }

  if (proseCandidates.length > 0) {
    console.log(`\n  ${C.cyan}${C.bold}Candidate rules from your instruction files${C.reset}`);
    console.log(`    ${C.gray}These are NOT enforced. If you want a gate, add it to .gates.yml:${C.reset}`);
    for (const c of proseCandidates.slice(0, 10)) {
      console.log(`    ${C.gray}${c.relPath}:${c.line}${C.reset} ${c.text.slice(0, 100)}${c.text.length > 100 ? '…' : ''}`);
    }
    if (proseCandidates.length > 10) {
      console.log(`    ${C.gray}... and ${proseCandidates.length - 10} more${C.reset}`);
    }
  }

  if (globalSuggestions.length > 0) {
    console.log(`\n  ${C.cyan}${C.bold}Global instruction file suggestions${C.reset}`);
    console.log(`    ${C.gray}Global files were not modified; consider workspace gates for these rules:${C.reset}`);
    for (const c of globalSuggestions.slice(0, 5)) {
      console.log(`    ${C.gray}${c.relPath}:${c.line}${C.reset} ${c.text.slice(0, 100)}${c.text.length > 100 ? '…' : ''}`);
    }
  }

  if (backedUp.length > 0) {
    console.log(`\n  ${C.yellow}${C.bold}Backed up${C.reset}`);
    for (const p of backedUp) {
      console.log(`    ${relative(projectRoot, p)} → ${relative(projectRoot, p)}.bak`);
    }
  }

  if (wrote.length > 0) {
    console.log(`\n  ${C.green}${C.bold}Written${C.reset}`);
    for (const p of wrote) {
      console.log(`    ${C.gray}✓${C.reset} ${relative(projectRoot, p)}`);
    }
  }

  if (skipped.length > 0) {
    console.log(`\n  ${C.yellow}${C.bold}Skipped${C.reset}`);
    for (const s of skipped) {
      console.log(`    ${C.gray}- ${s}${C.reset}`);
    }
  }

  if (artifacts.warnings.length > 0) {
    console.log(`\n  ${C.yellow}${C.bold}Warnings${C.reset}`);
    for (const w of artifacts.warnings) {
      console.log(`    ${C.yellow}⚠${C.reset} ${w}`);
    }
  }

  console.log(`\n  ${C.gray}Run ${C.cyan}gateinit test${C.gray} to validate generated gates with fixtures.${C.reset}\n`);
}

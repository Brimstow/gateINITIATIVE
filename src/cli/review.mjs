// gateinitiative CLI: review command (approve/delete pending enforcement decisions)

import { getDecisions, approveDecision, deleteDecision, clearDecisions } from '../decisions.mjs';
import { C, banner, args, getFlag, hasFlag, projectRoot } from './context.mjs';

export async function cmdReview() {
  banner();

  const sub = args[1] || 'list';
  const id = args[2];

  if (sub === 'list') {
    const { pending, overrides } = await getDecisions(projectRoot, getFlag('shadow-dir'));

    if (pending.length === 0 && overrides.length === 0) {
      console.log(`  ${C.green}✓${C.reset} No pending decisions or active overrides.`);
      return;
    }

    if (pending.length > 0) {
      console.log(`\n  ${C.yellow}${C.bold}Pending review (${pending.length})${C.reset}`);
      for (const d of pending) {
        console.log(`    ${C.bold}${d.id}${C.reset} ${d.gateId} on ${d.file}`);
        console.log(`      ${C.gray}${d.reason}${C.reset}`);
      }
    }

    if (overrides.length > 0) {
      console.log(`\n  ${C.cyan}${C.bold}Active overrides (${overrides.length})${C.reset}`);
      for (const o of overrides) {
        const expires = o.expires ? `expires ${new Date(o.expires).toISOString()}` : `scope: ${o.scope}`;
        console.log(`    ${C.bold}${o.id}${C.reset} ${o.gateId} on ${o.file} ${C.gray}(${expires})${C.reset}`);
      }
    }
    console.log();
    return;
  }

  if (sub === 'approve') {
    if (!id) {
      console.log(`  ${C.red}✖${C.reset} Provide a decision id: ${C.cyan}gateinit review approve <id>${C.reset}`);
      process.exit(1);
    }
    let scope = 'once';
    if (hasFlag('session')) scope = 'session';
    const ttl = getFlag('for');
    if (ttl) scope = 'ttl';
    const ttlHours = ttl ? parseFloat(ttl) : 0;
    if (scope === 'ttl' && (!Number.isFinite(ttlHours) || ttlHours <= 0)) {
      console.log(`  ${C.red}✖${C.reset} --for requires a positive number of hours`);
      process.exit(1);
    }

    const override = await approveDecision(projectRoot, id, { scope, ttlHours, sessionId: null }, getFlag('shadow-dir'));
    if (!override) {
      console.log(`  ${C.red}✖${C.reset} Decision ${id} not found or already resolved.`);
      process.exit(1);
    }
    console.log(`  ${C.green}✓${C.reset} Approved override ${C.bold}${override.id}${C.reset} (${scope})`);
    return;
  }

  if (sub === 'delete') {
    if (!id) {
      console.log(`  ${C.red}✖${C.reset} Provide a decision id: ${C.cyan}gateinit review delete <id>${C.reset}`);
      process.exit(1);
    }
    const removed = await deleteDecision(projectRoot, id, getFlag('shadow-dir'));
    if (!removed) {
      console.log(`  ${C.red}✖${C.reset} Decision ${id} not found.`);
      process.exit(1);
    }
    console.log(`  ${C.green}✓${C.reset} Deleted decision ${id}.`);
    return;
  }

  if (sub === 'clear') {
    await clearDecisions(projectRoot, getFlag('shadow-dir'));
    console.log(`  ${C.green}✓${C.reset} Cleared all decisions.`);
    return;
  }

  console.log(`  ${C.red}✖${C.reset} Unknown review subcommand: ${sub}`);
  console.log(`    ${C.gray}gateinit review [list|approve <id>|delete <id>|clear]${C.reset}`);
  process.exit(1);
}

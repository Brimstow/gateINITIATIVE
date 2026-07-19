// gateinitiative CLI: test command (fixture-based gate testing)

import { runGateTests } from '../test-runner.mjs';
import { C, banner, projectRoot } from './context.mjs';

export async function cmdTest() {
  banner();

  const warnings = [];
  const warn = (msg) => { warnings.push(msg); console.log(`  ${C.yellow}⚠${C.reset} ${msg}`); };

  console.log(`  ${C.gray}Running gate fixture tests...${C.reset}\n`);

  const { results, totalPassed, totalFailed, totalSkipped } = await runGateTests(projectRoot, { onWarn: warn });

  for (const result of results) {
    const color = result.skipped ? C.gray : result.failed > 0 ? C.red : C.green;
    console.log(`  ${color}${result.skipped ? '⊘' : result.failed > 0 ? '✖' : '✓'}${C.reset} ${C.bold}${result.gateId}${C.reset}`);

    if (result.skipped) {
      console.log(`    ${C.gray}No fixtures found in .gates/fixtures/${result.gateId}/{pass,fail}/${C.reset}`);
      continue;
    }

    console.log(`    ${C.gray}${result.passed} passed, ${result.failed} failed${C.reset}`);
    for (const fx of result.fixtures) {
      const fxColor = fx.ok ? C.green : C.red;
      console.log(`    ${fxColor}${fx.ok ? '✓' : '✖'}${C.reset} ${fx.expected === 'pass' ? 'pass' : 'fail'} fixture: ${fx.file}`);
      if (!fx.ok) {
        console.log(`      ${C.gray}Expected ${fx.expected}, but ${fx.expected === 'pass' ? 'a violation was found' : 'no violation was found'}${C.reset}`);
      }
    }
  }

  console.log('');
  console.log(`  ${C.gray}Total: ${totalPassed} passed · ${totalFailed} failed · ${totalSkipped} skipped${C.reset}`);
  for (const w of warnings) {
    console.log(`  ${C.yellow}⚠${C.reset} ${w}`);
  }

  process.exit(totalFailed > 0 ? 1 : 0);
}

/**
 * gateinitiative: Fixture-Based Gate Test Runner
 *
 * Runs pass/fail fixtures against loaded gates. A gate is only considered
 * trustworthy for enforcement when its own fixtures behave as advertised.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, extname } from 'node:path';
import { loadProjectGates } from './parser.mjs';
import { evaluateGate, globToExamplePath } from './evaluator.mjs';

/**
 * @typedef {Object} GateTestResult
 * @property {string} gateId
 * @property {import('./parser.mjs').Gate} gate
 * @property {{file: string, content: string, expected: 'pass'|'fail', ok: boolean}[]} fixtures
 * @property {number} passed
 * @property {number} failed
 * @property {boolean} skipped
 */

const DEFAULT_FIXTURES_ROOT = '.gates/fixtures';

/**
 * Recursively collect files under a directory.
 * @param {string} dir
 * @returns {Promise<string[]>} absolute file paths
 */
async function collectFiles(dir) {
  const entries = [];
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  for (const item of items) {
    if (item.isFile()) {
      entries.push(resolve(item.parentPath || item.path, item.name));
    }
  }
  return entries;
}

/**
 * Run pass/fail fixtures for every loaded gate.
 *
 * @param {string} projectRoot
 * @param {Object} [options]
 * @param {string} [options.fixturesRoot] - Relative path to fixtures (default: .gates/fixtures)
 * @param {(msg: string) => void} [options.onWarn]
 * @returns {Promise<{results: GateTestResult[], totalPassed: number, totalFailed: number, totalSkipped: number}>}
 */
export async function runGateTests(projectRoot, options = {}) {
  const fixturesRoot = join(projectRoot, options.fixturesRoot || DEFAULT_FIXTURES_ROOT);
  const warnings = [];
  const onWarn = options.onWarn || ((msg) => warnings.push(msg));

  const gates = await loadProjectGates(projectRoot, { onWarn });
  const results = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const gate of gates) {
    const gateDir = join(fixturesRoot, gate.id);
    const passFiles = await collectFiles(join(gateDir, 'pass'));
    const failFiles = await collectFiles(join(gateDir, 'fail'));

    if (passFiles.length === 0 && failFiles.length === 0) {
      totalSkipped++;
      results.push({ gateId: gate.id, gate, fixtures: [], passed: 0, failed: 0, skipped: true });
      continue;
    }

    const fixtures = [];
    let passed = 0;
    let failed = 0;

    // Use a synthetic example path matching the gate trigger so the trigger is satisfied
    const examplePath = globToExamplePath(gate.trigger);

    for (const file of passFiles) {
      const content = await readFile(file, 'utf-8');
      const violation = evaluateGate(gate, content, examplePath);
      const ok = violation === null;
      if (ok) passed++; else failed++;
      fixtures.push({ file: relative(projectRoot, file), content, expected: 'pass', ok });
    }

    for (const file of failFiles) {
      const content = await readFile(file, 'utf-8');
      const violation = evaluateGate(gate, content, examplePath);
      const ok = violation !== null;
      if (ok) passed++; else failed++;
      fixtures.push({ file: relative(projectRoot, file), content, expected: 'fail', ok });
    }

    totalPassed += passed;
    totalFailed += failed;
    results.push({ gateId: gate.id, gate, fixtures, passed, failed, skipped: false });
  }

  return { results, totalPassed, totalFailed, totalSkipped, warnings };
}

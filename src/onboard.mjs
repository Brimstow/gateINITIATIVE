/**
 * gateinitiative: Onboarding Engine
 *
 * Four-phase flow: scan -> interview -> plan -> execute.
 *
 * Scan discovers the stack plus every agent-instruction file (workspace and
 * global scope, including nested AGENTS.md in monorepos). The interview asks
 * per-source apply/link/skip and preset questions. Plan produces a full
 * write-plan (create/backup/modify/skip) that is previewed before any file is
 * touched. Execute is strictly non-destructive: existing files are backed up
 * to .bak, an existing .gates.yml redirects generated gates to
 * .gates/onboarded.yml, managed-block injection is idempotent, and re-runs
 * only replace context rules carrying generatedBy: 'onboard'.
 */

import { readFile, readdir, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { extractGates } from './parser.mjs';
import { extractContextRules } from './context-detector.mjs';

const DEFAULT_ANSWERS = {
  language: 'javascript',
  testFramework: '',
  testDirs: [],
  strictness: 'standard',
  testIntegrity: true,
  securityPreset: true,
  modularPreset: false,
  paradigmPreset: false,
};

// Markers delimiting the gateinitiative managed block inside user-owned
// instruction files. Re-runs only ever replace content between them.
export const MANAGED_BLOCK_BEGIN = '<!-- gateinitiative:begin -->';
export const MANAGED_BLOCK_END = '<!-- gateinitiative:end -->';

const WORKSPACE_INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.windsurfrules',
  '.github/copilot-instructions.md',
];

const WORKSPACE_INSTRUCTION_DIRS = [
  '.cursor/rules',
  '.windsurf/rules',
  '.claude',
];

// Global-scoped instruction files (relative to home dir). Scanned and
// reported only — gateinitiative never writes outside the project tree.
const GLOBAL_INSTRUCTION_FILES = [
  '.claude/CLAUDE.md',
  '.codeium/windsurf/memories/global_rules.md',
  '.cursor/rules/global.mdc',
];

const SCAN_IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.gateinitiative']);
const NESTED_SCAN_MAX_DEPTH = 4;
const PROSE_MARKERS = /\b(never|always|must not|do not|don't)\b/i;

function posixPath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * @typedef {Object} DetectedStack
 * @property {string} language
 * @property {string[]} testDirs
 * @property {string} testFramework
 * @property {boolean} hasPackageJson
 */

/**
 * Scan the project for language, test framework, and test directories.
 * @param {string} root
 * @returns {Promise<DetectedStack>}
 */
export async function detectStack(root) {
  const hasPackageJson = existsSync(join(root, 'package.json'));
  let pkg = {};
  if (hasPackageJson) {
    try {
      pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf-8'));
    } catch { /* ignore malformed */ }
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  let testFramework = '';
  if (deps.vitest) testFramework = 'vitest';
  else if (deps.jest) testFramework = 'jest';
  else if (deps.playwright) testFramework = 'playwright';
  else if (deps['node:test']) testFramework = 'node:test';

  const testDirs = [];
  const candidates = ['tests', 'test', '__tests__', 'e2e', 'spec'];
  for (const d of candidates) {
    if (existsSync(join(root, d))) testDirs.push(d);
  }

  let language = 'javascript';
  if (existsSync(join(root, 'tsconfig.json')) || deps.typescript) language = 'typescript';

  return { language, testDirs, testFramework, hasPackageJson };
}

/**
 * Detect imperative-sounding prose lines in an instruction file.
 * These are *suggestions*, not enforceable gates.
 * @param {string} content
 * @returns {{line: number, text: string}[]}
 */
export function detectProseCandidates(content) {
  const candidates = [];
  const lines = content.split(/\r?\n/);
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const text = raw.trim();
    if (text.length < 10) continue;
    if (PROSE_MARKERS.test(text)) {
      candidates.push({ line: i + 1, text: text.length > 120 ? text.slice(0, 120) + '…' : text });
      if (candidates.length >= 20) break;
    }
  }

  return candidates;
}

async function collectDirectoryFiles(root, dirRel, extensions) {
  const files = [];
  const dir = join(root, dirRel);
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch { return files; }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = entry.name.split('.').pop();
    if (!extensions.includes(ext)) continue;
    files.push(join(dir, entry.name));
  }
  return files;
}

async function scanNestedInstructionFiles(root, depth = 0) {
  const results = [];
  if (depth >= NESTED_SCAN_MAX_DEPTH) return results;

  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch { return results; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SCAN_IGNORE_DIRS.has(entry.name)) continue;

    const subRoot = join(root, entry.name);
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = join(subRoot, name);
      if (existsSync(file)) results.push(file);
    }
    results.push(...await scanNestedInstructionFiles(subRoot, depth + 1));
  }

  return results;
}

async function readSourceInfo(absPath, projectRoot, scope, homeDir) {
  let relPath;
  if (scope === 'global') {
    relPath = '~/' + posixPath(relative(homeDir, absPath));
  } else {
    relPath = posixPath(relative(projectRoot, absPath));
  }

  const nested = scope === 'workspace' && relPath.includes('/');
  const subtree = nested ? dirname(relPath) : null;

  let content = '';
  let proseCandidates = [];
  let gateBlocks = 0;
  let contextBlocks = 0;

  try {
    content = await readFile(absPath, 'utf-8');
    proseCandidates = detectProseCandidates(content);
    gateBlocks = extractGates(content, absPath, () => {}).length;
    contextBlocks = extractContextRules(content, absPath, () => {}).length;
  } catch { /* skip unreadable */ }

  return {
    path: absPath,
    relPath,
    scope,
    nested,
    subtree,
    proseCandidates,
    gateBlocks,
    contextBlocks,
  };
}

/**
 * Discover agent-instruction files (workspace + global scope) and summarize each.
 * @param {string} projectRoot
 * @param {Object} [options]
 * @param {string} [options.homeDir]
 * @returns {Promise<{workspace: object[], global: object[]}>}
 */
export async function scanInstructionFiles(projectRoot, options = {}) {
  const homeDir = options.homeDir || homedir();
  const workspace = [];
  const global = [];

  // Root-level workspace files
  for (const rel of WORKSPACE_INSTRUCTION_FILES) {
    const abs = join(projectRoot, rel);
    if (existsSync(abs)) workspace.push(await readSourceInfo(abs, projectRoot, 'workspace', homeDir));
  }

  // Known workspace instruction directories
  for (const rel of WORKSPACE_INSTRUCTION_DIRS) {
    const files = await collectDirectoryFiles(projectRoot, rel, ['md', 'mdc']);
    for (const abs of files) {
      workspace.push(await readSourceInfo(abs, projectRoot, 'workspace', homeDir));
    }
  }

  // .rules / .voidrules at root: only treat as user-owned if not generated by bridge
  for (const rel of ['.rules', '.voidrules']) {
    const abs = join(projectRoot, rel);
    if (!existsSync(abs)) continue;
    let content = '';
    try { content = await readFile(abs, 'utf-8'); } catch { continue; }
    if (content.includes('<!-- generated-by: gateinitiative-bridge -->')) continue;
    workspace.push(await readSourceInfo(abs, projectRoot, 'workspace', homeDir));
  }

  // Nested AGENTS.md / CLAUDE.md up to depth 4
  const nested = await scanNestedInstructionFiles(projectRoot);
  for (const abs of nested) {
    workspace.push(await readSourceInfo(abs, projectRoot, 'workspace', homeDir));
  }

  // Global files: report-only
  for (const rel of GLOBAL_INSTRUCTION_FILES) {
    const abs = join(homeDir, rel);
    if (existsSync(abs)) global.push(await readSourceInfo(abs, projectRoot, 'global', homeDir));
  }

  return { workspace, global };
}

/**
 * Build the static managed block that can be injected into instruction files.
 * @returns {string}
 */
export function buildManagedBlock() {
  return [
    MANAGED_BLOCK_BEGIN,
    '## gateINITIATIVE Enforcement',
    '',
    'This project is enforced by **gateINITIATIVE**. File-level rules ("gates") are actively',
    'enforced by a filesystem daemon — violating writes may be reverted or quarantined.',
    '',
    '- Gate definitions: `.gates.yml` (and `.gates/`)',
    '- Recent violations feedback: `.gateinitiative/last-violations.json`',
    '- Validate gates: `gateinit test` · Status: `gateinit status`',
    '',
    'Do not edit this block; it is managed by `gateinit onboard`.',
    MANAGED_BLOCK_END,
  ].join('\n');
}

/**
 * Inject or replace the managed block inside existing markdown content.
 * @param {string} content
 * @param {string} block
 * @returns {string}
 */
export function injectManagedBlock(content, block) {
  const beginIdx = content.indexOf(MANAGED_BLOCK_BEGIN);
  const endIdx = content.indexOf(MANAGED_BLOCK_END);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    let before = content.slice(0, beginIdx);
    let after = content.slice(endIdx + MANAGED_BLOCK_END.length);
    if (before.length > 0 && !before.endsWith('\n')) {
      before += '\n\n';
    }
    if (after.length > 0 && !after.startsWith('\n')) {
      after = '\n' + after;
    }
    return before + block + after;
  }

  const sep = content.length === 0 ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  return content + sep + block;
}

function isMarkdownFile(relPath) {
  return /\.(md|mdc|rules|voidrules)$/i.test(relPath);
}

/**
 * Ask questions via readline when interactive, otherwise return defaults.
 * @param {DetectedStack} stack
 * @param {{workspace: object[], global: object[]}} scan
 * @param {Object} [options]
 * @param {boolean} [options.yes]
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @returns {Promise<Object>}
 */
export async function promptOnboard(stack, scan, options = {}) {
  const answers = {
    ...DEFAULT_ANSWERS,
    language: stack.language,
    testFramework: stack.testFramework,
    testDirs: stack.testDirs,
    sources: [],
  };

  const allSources = [...scan.workspace, ...scan.global];

  // Non-interactive / --yes / --dry-run defaults
  if (options.yes || options.dryRun || !process.stdin.isTTY) {
    for (const source of allSources) {
      answers.sources.push({
        path: source.path,
        relPath: source.relPath,
        scope: source.scope,
        action: source.scope === 'workspace' ? 'apply' : 'skip',
        link: false,
      });
    }
    return answers;
  }

  const rl = createInterface({
    input: options.input || process.stdin,
    output: options.output || process.stdout,
  });

  try {
    const out = options.output || process.stdout;

    if (allSources.length > 0) {
      out.write('\nDiscovered instruction files:\n');
      for (const source of allSources) {
        const markers = [];
        if (source.gateBlocks) markers.push(`${source.gateBlocks} gate block(s)`);
        if (source.contextBlocks) markers.push(`${source.contextBlocks} context block(s)`);
        if (source.proseCandidates.length) markers.push(`${source.proseCandidates.length} prose candidate(s)`);
        const scope = source.scope === 'global' ? ' [global, report-only]' : source.nested ? ` [nested: ${source.subtree}]` : '';
        out.write(`  ${source.relPath}${scope}${markers.length ? ' — ' + markers.join(', ') : ''}\n`);
      }
      out.write('\n');
    }

    for (const source of scan.workspace) {
      const apply = (await rl.question(`Apply rules from ${source.relPath}? [Y/n] `)).trim().toLowerCase() !== 'n';
      let link = false;
      if (apply && isMarkdownFile(source.relPath)) {
        link = (await rl.question(`  Add gateinitiative managed block to ${source.relPath}? [y/N] `)).trim().toLowerCase() === 'y';
      }
      answers.sources.push({
        path: source.path,
        relPath: source.relPath,
        scope: 'workspace',
        action: apply ? 'apply' : 'skip',
        link,
      });
    }

    for (const source of scan.global) {
      const apply = (await rl.question(`Include suggestions from global ${source.relPath}? [Y/n] `)).trim().toLowerCase() !== 'n';
      answers.sources.push({
        path: source.path,
        relPath: source.relPath,
        scope: 'global',
        action: apply ? 'apply' : 'skip',
        link: false,
      });
    }

    answers.testIntegrity = (await rl.question('Enable test-integrity preset? [Y/n] ')).trim().toLowerCase() !== 'n';
    answers.securityPreset = (await rl.question('Enable security preset? [Y/n] ')).trim().toLowerCase() !== 'n';
    answers.modularPreset = (await rl.question('Enable modular-design preset? [y/N] ')).trim().toLowerCase() === 'y';
    answers.paradigmPreset = (await rl.question('Enable paradigm-fit preset? [y/N] ')).trim().toLowerCase() === 'y';
    const strictness = await rl.question('Strictness for presets (strict/standard/advisory) [standard] ');
    answers.strictness = ['strict', 'standard', 'advisory'].includes(strictness) ? strictness : 'standard';
  } finally {
    rl.close();
  }

  return answers;
}

/**
 * @typedef {Object} OnboardArtifacts
 * @property {Object} profile
 * @property {string} gatesYml
 * @property {Object[]} contextRules
 * @property {{path: string, content: string}[]} playbooks
 * @property {{path: string, content: string}[]} docs
 * @property {string[]} warnings
 */

function scopeTrigger(glob, subtree) {
  if (!subtree || !glob) return glob;
  const prefix = subtree.replace(/\\/g, '/') + '/';
  if (glob.startsWith(prefix)) return glob;
  return prefix + glob;
}

function scopeGate(gate, subtree) {
  if (!subtree) return gate;
  const t = Array.isArray(gate.trigger) ? gate.trigger.map(g => scopeTrigger(g, subtree)) : scopeTrigger(gate.trigger, subtree);
  const ex = Array.isArray(gate.exclude) ? gate.exclude.map(g => scopeTrigger(g, subtree)) : gate.exclude;
  return { ...gate, trigger: t, exclude: ex };
}

function mergeContextRules(existing, generated) {
  const byId = new Map();
  for (const rule of existing) {
    byId.set(rule.id, rule);
  }
  for (const rule of generated) {
    const id = rule.id;
    const existingRule = byId.get(id);
    if (existingRule && existingRule.generatedBy !== 'onboard') {
      // preserve user-written rule
      continue;
    }
    byId.set(id, rule);
  }
  return [...byId.values()];
}

/**
 * Generate profile, gates, and context rules from detected stack + answers.
 * @param {DetectedStack} stack
 * @param {Object} answers
 * @param {object[]} [appliedSources]
 * @returns {OnboardArtifacts}
 */
export function generateArtifacts(stack, answers, appliedSources = []) {
  const ext = stack.language === 'typescript' ? '{ts,tsx}' : '{js,jsx,mjs,cjs}';
  const testExt = ext.replace('tsx', 'ts,tsx').replace('jsx', 'js,jsx');
  const testDirs = answers.testDirs ?? stack.testDirs ?? [];
  const testGlobs = testDirs.length > 0
    ? testDirs.map(d => `**/${d}/**/*.${testExt}`)
    : [`**/*.test.${testExt}`, `**/*.spec.${testExt}`];

  const profile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    language: stack.language,
    testFramework: stack.testFramework || 'none',
    testDirs: stack.testDirs,
    strictness: answers.strictness,
    presets: {
      testIntegrity: answers.testIntegrity,
      security: answers.securityPreset,
      modularDesign: answers.modularPreset,
      paradigmFit: answers.paradigmPreset,
    },
    sources: answers.sources || [],
  };

  const gates = [];
  const warnings = [];
  const contextRules = [];
  const playbooks = [];
  const docs = [];

  // Severity chosen per preset: strict -> block, standard -> warn, advisory -> info
  const presetSeverity = answers.strictness === 'strict' ? 'block' : answers.strictness === 'advisory' ? 'info' : 'warn';

  // Label comments are placed inline so a human reading .gates.yml sees enforcement strength.
  if (answers.securityPreset) {
    gates.push({
      id: 'no-secrets-in-source',
      trigger: `**/*.{${ext.replace(/[{}]/g, '')},json,env,yml,yaml}`,
      severity: 'block',
      overridable: false,
      pattern: '/(sk-[a-zA-Z0-9]{20,}|pk_live_[a-zA-Z0-9]+|AKIA[A-Z0-9]{16}|ghp_[a-zA-Z0-9]{36})/',
      message: 'Potential API key or secret detected in source code',
      exclude: testGlobs.concat(['node_modules/**']),
    });

    contextRules.push({
      id: 'onboard-security-sensitive',
      filePatterns: ['**/auth/**', '**/login*', '**/session*', '**/token*', '**/upload*', '**/payment*', '**/stripe*', '**/cors*', '**/helmet*'],
      keywords: ['jwt', 'bcrypt', 'session', 'upload', 'stripe', 'webhook', 'secret'],
      contextFile: 'docs/agents/security-sensitive.md',
      description: '[profile-only] Security-sensitive area — review security guidance before editing',
      generatedBy: 'onboard',
      source: '.gateinitiative/context-rules.json',
    });

    playbooks.push({
      path: '.playbooks/security-sensitive.yaml',
      content: renderPlaybook({
        name: 'security-sensitive',
        description: 'Require security test evidence before editing sensitive files',
        trigger: ['**/auth/**', '**/login*', '**/session*', '**/token*', '**/upload*', '**/payment*', '**/stripe*'],
        prerequisites: [{
          id: 'security-tests-passed',
          evidence: { file_exists: 'coverage/lcov.info' },
          ttl: 86400,
          message: 'Run security tests before editing sensitive files (coverage/lcov.info expected)',
          severity: 'block',
        }],
      }),
    });

    docs.push({
      path: 'docs/agents/security-sensitive.md',
      content: renderSkillDoc('Security-Sensitive Areas', [
        'Treat auth, session, token, upload, payment, and webhook code as security-critical.',
        'Run tests before editing these files. gateinitiative will block edits without recent test evidence.',
        'Never log secrets, tokens, or raw credentials. Use constant-time comparison for secrets.',
        'Validate and sanitize all inputs; prefer parameterized APIs over string concatenation.',
      ]),
    });
  }

  if (answers.testIntegrity) {
    gates.push({
      id: 'test-integrity-guard',
      trigger: testGlobs.join('\n'),
      severity: presetSeverity,
      pattern: '/^\\s*$/m',
      message: 'Empty test file detected — every committed test must exercise production behavior',
      exclude: [],
    });

    contextRules.push({
      id: 'onboard-test-integrity',
      filePatterns: testGlobs,
      keywords: ['describe(', 'it(', 'test(', 'expect('],
      contextFile: 'docs/agents/testing-conventions.md',
      description: '[playbook prerequisite] Tests must be meaningful and not placeholder-only',
      enforce: answers.strictness !== 'advisory',
      severity: answers.strictness === 'strict' ? 'warn' : 'warn',
      ttl: 3600,
      generatedBy: 'onboard',
      source: '.gateinitiative/context-rules.json',
    });

    docs.push({
      path: 'docs/agents/testing-conventions.md',
      content: renderSkillDoc('Testing Conventions', [
        'Every committed test must exercise production behavior — no placeholder-only tests.',
        'Prefer focused unit tests with clear arrange/act/assert structure.',
        'Mock external boundaries (filesystem, network, clocks); keep business logic pure.',
        'Run gateinit test before pushing to verify gates still pass.',
      ]),
    });
  }

  if (answers.modularPreset) {
    gates.push({
      id: 'no-deep-relative-imports',
      trigger: `**/*.{${ext.replace(/[{}]/g, '')}}`,
      severity: presetSeverity,
      pattern: '/\.\./.*\.\./',
      message: 'Deep relative import detected — keep module boundaries shallow',
      exclude: ['node_modules/**'].concat(testGlobs),
    });

    contextRules.push({
      id: 'onboard-modular-design',
      filePatterns: [`src/**/*.${ext.replace(/[{}]/g, '')}`],
      keywords: ['import', 'require'],
      contextFile: 'docs/agents/modular-design.md',
      description: '[advisory] Keep module boundaries shallow — avoid deep relative imports',
      enforce: answers.strictness !== 'advisory',
      severity: answers.strictness === 'strict' ? 'warn' : 'info',
      ttl: 3600,
      generatedBy: 'onboard',
      source: '.gateinitiative/context-rules.json',
    });

    docs.push({
      path: 'docs/agents/modular-design.md',
      content: renderSkillDoc('Modular Design', [
        'Avoid imports that traverse more than one parent directory (e.g. ../../another-module).',
        'Prefer public module boundaries over reaching into internal subdirectories.',
        'Keep files focused; if a file is growing, split by responsibility rather than by layer.',
      ]),
    });
  }

  if (answers.paradigmPreset) {
    gates.push({
      id: 'no-classes-in-src',
      trigger: `src/**/*.${ext.replace(/[{}]/g, '')}`,
      severity: presetSeverity,
      pattern: '/^\\s*class\\s+/m',
      message: 'Class declaration in src — prefer functions/composition unless design requires it',
      exclude: ['node_modules/**'].concat(testGlobs),
    });

    contextRules.push({
      id: 'onboard-paradigm-fit',
      filePatterns: [`src/**/*.${ext.replace(/[{}]/g, '')}`],
      keywords: ['class ', 'extends', 'new '],
      contextFile: 'docs/agents/paradigm-functional.md',
      description: '[advisory] Prefer functions/composition over classes in src',
      enforce: false,
      severity: 'info',
      ttl: 3600,
      generatedBy: 'onboard',
      source: '.gateinitiative/context-rules.json',
    });

    docs.push({
      path: 'docs/agents/paradigm-functional.md',
      content: renderSkillDoc('Functional-First Style', [
        'Prefer pure functions and composition over classes and inheritance.',
        'Use data + functions rather than encapsulating behavior in mutable objects.',
        'Classes are fine when the problem genuinely requires polymorphism or stateful instances.',
      ]),
    });
  }

  // Pull gates/context rules from applied workspace instruction files
  for (const source of appliedSources) {
    if (source.action !== 'apply') continue;
    let content = '';
    try {
      content = readFileSync(source.path, 'utf-8');
    } catch {
      continue;
    }
    if (!content) continue;

    const extractedGates = extractGates(content, source.path, (msg) => warnings.push(msg));
    for (const gate of extractedGates) {
      const scoped = scopeGate(gate, source.subtree);
      if (gates.some(g => g.id === scoped.id)) {
        warnings.push(`${source.relPath}: duplicate gate id "${scoped.id}" ignored`);
        continue;
      }
      gates.push(scoped);
    }

    const extractedRules = extractContextRules(content, source.path, (msg) => warnings.push(msg));
    for (const rule of extractedRules) {
      const r = { ...rule, generatedBy: 'onboard' };
      if (contextRules.some(c => c.id === r.id)) {
        warnings.push(`${source.relPath}: duplicate context rule id "${r.id}" ignored`);
        continue;
      }
      contextRules.push(r);
    }
  }

  const gatesYml = renderGatesYml(gates);

  return { profile, gatesYml, contextRules, playbooks, docs, warnings };
}

function renderGatesYml(gates) {
  const lines = [
    '# gateinitiative: Project Gate Definitions',
    '# Generated by `gateinit onboard` — safe to edit.',
    'version: 1',
    '',
    '# Enforcement-strength labels:',
    '#   [gate] deterministic file-level rule enforced by gateinitiative',
    '#   [playbook prerequisite] requires evidence in playbook-state before proceeding',
    '#   [profile-only] advisory context injected into bridged rules only',
    '',
  ];

  for (const g of gates) {
    lines.push('---');
    lines.push(`id: ${g.id}  # [gate]`);
    if (g.trigger.includes('\n')) {
      lines.push('trigger:');
      for (const line of g.trigger.split('\n')) lines.push(`  - ${line}`);
    } else {
      lines.push(`trigger: "${g.trigger}"`);
    }
    lines.push(`severity: ${g.severity}`);
    if (g.overridable === false) lines.push('overridable: false');
    lines.push(`pattern: ${g.pattern}`);
    lines.push(`message: "${g.message}"`);
    if (g.exclude?.length > 0) {
      lines.push('exclude:');
      for (const ex of g.exclude) lines.push(`  - ${ex}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderPlaybook({ name, description, trigger, prerequisites }) {
  const lines = [
    `# gateinitiative playbook: ${name}`,
    `name: ${name}`,
    'version: 1',
    `description: "${description}"`,
  ];

  const triggers = Array.isArray(trigger) ? trigger : [trigger];
  if (triggers.length === 1) {
    lines.push(`trigger: "${triggers[0]}"`);
  } else {
    lines.push('trigger:');
    for (const t of triggers) lines.push(`  - "${t}"`);
  }

  lines.push('prerequisites:');
  for (const p of prerequisites) {
    lines.push(`  - id: ${p.id}`);
    lines.push('    evidence:');
    if (p.evidence.file_fresh) lines.push(`      file_fresh: "${p.evidence.file_fresh}"`);
    if (p.evidence.file_exists) lines.push(`      file_exists: "${p.evidence.file_exists}"`);
    if (p.evidence.state_key) lines.push(`      state_key: "${p.evidence.state_key}"`);
    lines.push(`    ttl: ${p.ttl}`);
    lines.push(`    message: "${p.message}"`);
    lines.push(`    severity: ${p.severity}`);
  }

  lines.push('on_violation:');
  lines.push('  severity: block');
  lines.push('  mode: inherit');
  lines.push('');
  return lines.join('\n');
}

function renderSkillDoc(title, bullets) {
  const lines = [`# ${title}`, ''];
  for (const b of bullets) {
    lines.push(`- ${b}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Build the write-plan for this onboarding run.
 * @param {string} projectRoot
 * @param {{profile: object, gatesYml: string, contextRules: object[], playbooks: object[], docs: object[]}} artifacts
 * @param {Object} answers
 * @returns {Promise<object[]>}
 */
export async function buildWritePlan(projectRoot, artifacts, answers) {
  const actions = [];

  const profilePath = join(projectRoot, '.gateinitiative', 'profile.json');
  if (existsSync(profilePath)) {
    actions.push({ type: 'backup', path: profilePath, reason: 'existing profile.json will be overwritten' });
    actions.push({ type: 'overwrite', path: profilePath, reason: 'updated profile' });
  } else {
    actions.push({ type: 'create', path: profilePath, reason: 'onboarding profile' });
  }

  const gateRootPath = join(projectRoot, '.gates.yml');
  const gatesOnboardedPath = join(projectRoot, '.gates', 'onboarded.yml');
  const gateTargetPath = existsSync(gateRootPath) ? gatesOnboardedPath : gateRootPath;

  if (gateTargetPath === gatesOnboardedPath) {
    actions.push({ type: 'create', path: gateTargetPath, reason: '.gates.yml exists; generated gates redirected to .gates/onboarded.yml' });
  } else {
    actions.push({ type: 'create', path: gateTargetPath, reason: 'project gate definitions' });
  }

  const rulesPath = join(projectRoot, '.gateinitiative', 'context-rules.json');
  if (existsSync(rulesPath)) {
    actions.push({ type: 'backup', path: rulesPath, reason: 'existing context-rules.json will be merged' });
    actions.push({ type: 'overwrite', path: rulesPath, reason: 'merged context rules (user rules preserved)' });
  } else if (artifacts.contextRules.length > 0) {
    actions.push({ type: 'create', path: rulesPath, reason: 'context rules' });
  }

  for (const pb of artifacts.playbooks || []) {
    const pbPath = join(projectRoot, pb.path);
    if (existsSync(pbPath)) {
      actions.push({ type: 'skip', path: pbPath, reason: 'playbook already exists — not overwritten' });
    } else {
      actions.push({ type: 'create', path: pbPath, content: pb.content, reason: `playbook: ${pb.path}` });
    }
  }

  for (const doc of artifacts.docs || []) {
    const docPath = join(projectRoot, doc.path);
    if (existsSync(docPath)) {
      actions.push({ type: 'skip', path: docPath, reason: 'skill doc already exists — not overwritten' });
    } else {
      actions.push({ type: 'create', path: docPath, content: doc.content, reason: `skill doc: ${doc.path}` });
    }
  }

  for (const source of answers.sources || []) {
    if (source.scope === 'global') {
      actions.push({ type: 'skip', path: source.path, reason: 'global scope — read-only' });
      continue;
    }
    if (source.link) {
      if (existsSync(source.path)) {
        actions.push({ type: 'backup', path: source.path, reason: 'managed block injection' });
        actions.push({ type: 'modify', path: source.path, reason: 'idempotent managed block injection' });
      } else {
        actions.push({ type: 'skip', path: source.path, reason: 'file no longer exists' });
      }
    }
  }

  const gitignore = join(projectRoot, '.gitignore');
  let needsGitignore = true;
  if (existsSync(gitignore)) {
    try {
      const content = await readFile(gitignore, 'utf-8');
      if (content.split(/\r?\n/).some(line => line.trim() === '.gateinitiative/')) {
        needsGitignore = false;
      }
    } catch { /* treat as missing */ }
  }
  if (needsGitignore) {
    if (existsSync(gitignore)) {
      actions.push({ type: 'modify', path: gitignore, reason: 'append .gateinitiative/' });
    } else {
      actions.push({ type: 'create', path: gitignore, reason: 'ignore .gateinitiative/' });
    }
  }

  return actions;
}

/**
 * Execute a write-plan.
 * @param {string} projectRoot
 * @param {object[]} plan
 * @param {{profile: object, gatesYml: string, contextRules: object[], playbooks: object[], docs: object[]}} artifacts
 * @param {Object} answers
 * @returns {Promise<{wrote: string[], backedUp: string[], skipped: string[]}>}
 */
export async function executePlan(projectRoot, plan, artifacts, answers) {
  const wrote = [];
  const backedUp = [];
  const skipped = [];

  for (const action of plan) {
    switch (action.type) {
      case 'backup': {
        try {
          await copyFile(action.path, action.path + '.bak');
          backedUp.push(action.path);
        } catch { skipped.push(`${action.path} (backup failed)`); }
        break;
      }
      case 'create':
      case 'overwrite': {
        try {
          await mkdir(dirname(action.path), { recursive: true });
          if (action.content !== undefined) {
            await writeFile(action.path, action.content, 'utf-8');
          } else if (action.path.endsWith('profile.json')) {
            await writeFile(action.path, JSON.stringify(artifacts.profile, null, 2) + '\n', 'utf-8');
          } else if (action.path.endsWith('context-rules.json')) {
            let existing = [];
            try {
              existing = JSON.parse(await readFile(action.path, 'utf-8'));
            } catch { /* absent or malformed */ }
            const merged = mergeContextRules(Array.isArray(existing) ? existing : [], artifacts.contextRules);
            await writeFile(action.path, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
          } else if (action.path.endsWith('.gates.yml') || action.path.endsWith('.yml') || action.path.endsWith('.yaml')) {
            await writeFile(action.path, artifacts.gatesYml, 'utf-8');
          } else if (action.path.endsWith('.gitignore')) {
            let content = '';
            try { content = await readFile(action.path, 'utf-8'); } catch { /* absent */ }
            const sep = content.endsWith('\n') || content.length === 0 ? '' : '\n';
            await writeFile(action.path, `${content}${sep}.gateinitiative/\n`, 'utf-8');
          } else {
            skipped.push(`${action.path} (unknown type)`);
            continue;
          }
          wrote.push(action.path);
        } catch (err) {
          skipped.push(`${action.path} (${err.message})`);
        }
        break;
      }
      case 'modify': {
        try {
          if (action.path.endsWith('.gitignore')) {
            let content = '';
            try { content = await readFile(action.path, 'utf-8'); } catch { /* absent */ }
            const sep = content.endsWith('\n') || content.length === 0 ? '' : '\n';
            await writeFile(action.path, `${content}${sep}.gateinitiative/\n`, 'utf-8');
          } else {
            const content = await readFile(action.path, 'utf-8');
            const block = buildManagedBlock();
            await writeFile(action.path, injectManagedBlock(content, block), 'utf-8');
          }
          wrote.push(action.path);
        } catch (err) {
          skipped.push(`${action.path} (${err.message})`);
        }
        break;
      }
      case 'skip': {
        skipped.push(`${action.path} (${action.reason})`);
        break;
      }
    }
  }

  return { wrote, backedUp, skipped };
}

/**
 * Run the full onboarding flow.
 * @param {string} projectRoot
 * @param {Object} options
 * @param {boolean} [options.yes]
 * @param {boolean} [options.dryRun]
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @param {(plan: object[]) => Promise<boolean>} [options.confirm]
 * @returns {Promise<object>}
 */
export async function runOnboarding(projectRoot, options = {}) {
  const stack = await detectStack(projectRoot);
  const scan = await scanInstructionFiles(projectRoot);
  const answers = await promptOnboard(stack, scan, options);

  for (const key of ['testIntegrity', 'securityPreset', 'modularPreset', 'paradigmPreset']) {
    if (typeof options[key] === 'boolean') answers[key] = options[key];
  }

  const appliedWorkspace = (answers.sources || []).filter(s => s.scope === 'workspace' && s.action === 'apply').map(s => {
    const match = scan.workspace.find(x => x.path === s.path);
    return match || s;
  });

  const { profile, gatesYml, contextRules, playbooks, docs, warnings } = generateArtifacts(stack, answers, appliedWorkspace);

  const plan = await buildWritePlan(projectRoot, { profile, gatesYml, contextRules, playbooks, docs }, answers);

  const proseCandidates = [];
  for (const source of appliedWorkspace) {
    for (const c of source.proseCandidates || []) {
      proseCandidates.push({ relPath: source.relPath, ...c });
    }
  }

  const globalSuggestions = [];
  for (const source of (answers.sources || []).filter(s => s.scope === 'global' && s.action === 'apply')) {
    const match = scan.global.find(x => x.path === source.path);
    if (!match) continue;
    for (const c of match.proseCandidates || []) {
      globalSuggestions.push({ relPath: match.relPath, ...c });
    }
  }

  if (options.dryRun) {
    return {
      stack,
      scan,
      answers,
      artifacts: { profile, gatesYml, contextRules, playbooks, docs, warnings },
      plan,
      executed: false,
      wrote: [],
      backedUp: [],
      skipped: [],
      proseCandidates,
      globalSuggestions,
    };
  }

  const doConfirm = options.confirm || (async () => true);
  const confirmed = await doConfirm(plan);
  if (!confirmed) {
    return {
      stack,
      scan,
      answers,
      artifacts: { profile, gatesYml, contextRules, playbooks, docs, warnings },
      plan,
      executed: false,
      wrote: [],
      backedUp: [],
      skipped: [],
      proseCandidates,
      globalSuggestions,
    };
  }

  const { wrote, backedUp, skipped } = await executePlan(projectRoot, plan, { profile, gatesYml, contextRules, playbooks, docs }, answers);

  return {
    stack,
    scan,
    answers,
    artifacts: { profile, gatesYml, contextRules, playbooks, docs, warnings },
    plan,
    executed: true,
    wrote,
    backedUp,
    skipped,
    proseCandidates,
    globalSuggestions,
  };
}

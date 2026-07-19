import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectStack,
  detectProseCandidates,
  scanInstructionFiles,
  buildManagedBlock,
  injectManagedBlock,
  generateArtifacts,
  buildWritePlan,
  executePlan,
  runOnboarding,
} from './onboard.mjs';

describe('detectStack', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gk-onboard-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects TypeScript + vitest from package.json', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      devDependencies: { typescript: '^5', vitest: '^1' },
    }));
    mkdirSync(join(dir, 'tests'));

    const stack = await detectStack(dir);

    assert.equal(stack.language, 'typescript');
    assert.equal(stack.testFramework, 'vitest');
    assert.deepEqual(stack.testDirs, ['tests']);
  });

  it('detects plain JavaScript when no TS signal', async () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    const stack = await detectStack(dir);
    assert.equal(stack.language, 'javascript');
    assert.equal(stack.testFramework, '');
  });
});

describe('detectProseCandidates', () => {
  it('flags imperative lines outside code fences', () => {
    const text = ['Never commit secrets.', 'Always run tests.', '```js', "const x = 'don't panic';", '```', 'You must not use any.'].join('\n');
    const candidates = detectProseCandidates(text);
    const texts = candidates.map(c => c.text);
    assert.ok(texts.includes('Never commit secrets.'));
    assert.ok(texts.includes('Always run tests.'));
    assert.ok(texts.includes('You must not use any.'));
    assert.equal(texts.some(t => t.includes("don't panic")), false);
  });

  it('caps at 20 candidates', () => {
    const lines = [];
    for (let i = 0; i < 30; i++) lines.push(`Never do ${i} on line ${i}.`);
    const candidates = detectProseCandidates(lines.join('\n'));
    assert.equal(candidates.length, 20);
  });
});

describe('scanInstructionFiles', () => {
  let dir;
  let home;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gk-scan-'));
    home = mkdtempSync(join(tmpdir(), 'gk-home-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('finds workspace files and global files, ignoring node_modules', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'Never commit secrets.');
    writeFileSync(join(dir, 'CLAUDE.md'), '# Agent');
    mkdirSync(join(dir, 'packages', 'foo'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'foo', 'AGENTS.md'), 'Always log errors.');
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'dep', 'AGENTS.md'), 'Ignore me.');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'Global rule.');

    const { workspace, global } = await scanInstructionFiles(dir, { homeDir: home });

    const rels = workspace.map(s => s.relPath).sort();
    assert.deepEqual(rels, ['AGENTS.md', 'CLAUDE.md', 'packages/foo/AGENTS.md']);
    assert.equal(global.length, 1);
    assert.equal(global[0].relPath, '~/.claude/CLAUDE.md');
  });

  it('scopes nested files to their subtree', async () => {
    mkdirSync(join(dir, 'packages', 'foo'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'foo', 'AGENTS.md'), '# Scope');
    const { workspace } = await scanInstructionFiles(dir);
    const nested = workspace.find(s => s.relPath === 'packages/foo/AGENTS.md');
    assert.equal(nested.subtree, 'packages/foo');
  });
});

describe('injectManagedBlock', () => {
  it('injects and is idempotent', () => {
    const block = buildManagedBlock();
    const first = injectManagedBlock('Hello', block);
    const second = injectManagedBlock(first, block);
    assert.equal(first, second);
    assert.ok(first.includes('gateINITIATIVE Enforcement'));
  });

  it('replaces stale content between existing markers', () => {
    const block = buildManagedBlock();
    const stale = `Hello\n\n<!-- gateinitiative:begin -->\nOld\n<!-- gateinitiative:end -->\n\nWorld`;
    const updated = injectManagedBlock(stale, block);
    assert.ok(updated.includes('gateINITIATIVE Enforcement'));
    assert.ok(!updated.includes('Old'));
    assert.ok(updated.startsWith('Hello'));
    assert.ok(updated.endsWith('World'));
  });
});

describe('generateArtifacts', () => {
  it('labels generated gates and context rules by enforcement strength', () => {
    const stack = { language: 'javascript', testDirs: [], testFramework: '', hasPackageJson: true };
    const answers = { strictness: 'strict', testIntegrity: true, securityPreset: true, modularPreset: false, paradigmPreset: false, sources: [] };
    const { profile, gatesYml, contextRules } = generateArtifacts(stack, answers);

    assert.equal(profile.strictness, 'strict');
    assert.ok(gatesYml.includes('version: 1'));
    assert.ok(gatesYml.includes('[gate]'));
    assert.ok(gatesYml.includes('overridable: false'));
    assert.ok(contextRules.some(r => r.description.includes('[profile-only]')));
    assert.ok(contextRules.some(r => r.description.includes('[playbook prerequisite]')));
    assert.ok(gatesYml.includes('no-secrets-in-source'));
    assert.ok(gatesYml.includes('test-integrity-guard'));
  });

  it('scopes extracted gate blocks from nested sources', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gk-nested-'));
    try {
      const stack = { language: 'javascript', testDirs: [], testFramework: '', hasPackageJson: true };
      const answers = { strictness: 'standard', testIntegrity: false, securityPreset: false, modularPreset: false, paradigmPreset: false, sources: [] };
      const source = {
        path: join(dir, 'packages', 'foo', 'AGENTS.md'),
        relPath: 'packages/foo/AGENTS.md',
        scope: 'workspace',
        nested: true,
        subtree: 'packages/foo',
        action: 'apply',
        proseCandidates: [],
      };
      const gateContent = "```gate\n---\nid: no-console\ntrigger: \"src/**/*.js\"\nseverity: warn\npattern: /console\\.log/\nmessage: no console\n```";
      mkdirSync(join(dir, 'packages', 'foo'), { recursive: true });
      writeFileSync(source.path, gateContent);
      const { gatesYml } = generateArtifacts(stack, answers, [source]);
      assert.ok(gatesYml.includes('packages/foo/src/**/*.js'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates playbooks and skill docs for enabled presets', () => {
    const stack = { language: 'javascript', testDirs: ['tests'], testFramework: 'vitest', hasPackageJson: true };
    const answers = {
      strictness: 'standard',
      testIntegrity: true,
      securityPreset: true,
      modularPreset: true,
      paradigmPreset: true,
      sources: [],
    };
    const { gatesYml, contextRules, playbooks, docs } = generateArtifacts(stack, answers);
    assert.ok(gatesYml.includes('no-secrets-in-source'));
    assert.ok(gatesYml.includes('test-integrity-guard'));
    assert.ok(gatesYml.includes('no-deep-relative-imports'));
    assert.ok(gatesYml.includes('no-classes-in-src'));
    assert.ok(contextRules.some(r => r.id === 'onboard-security-sensitive'));
    assert.ok(contextRules.some(r => r.id === 'onboard-modular-design'));
    assert.ok(contextRules.some(r => r.id === 'onboard-paradigm-fit'));
    assert.ok(playbooks.some(p => p.path === '.playbooks/security-sensitive.yaml'));
    assert.ok(docs.some(d => d.path === 'docs/agents/security-sensitive.md'));
    assert.ok(docs.some(d => d.path === 'docs/agents/testing-conventions.md'));
    assert.ok(docs.some(d => d.path === 'docs/agents/modular-design.md'));
    assert.ok(docs.some(d => d.path === 'docs/agents/paradigm-functional.md'));
  });
});

describe('buildWritePlan', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gk-plan-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('redirects gates to .gates/onboarded.yml when .gates.yml exists', async () => {
    writeFileSync(join(dir, '.gates.yml'), '# existing');
    const stack = { language: 'javascript', testDirs: [], testFramework: '', hasPackageJson: true };
    const answers = { strictness: 'standard', testIntegrity: true, securityPreset: true, modularPreset: false, paradigmPreset: false, sources: [] };
    const artifacts = generateArtifacts(stack, answers);
    const plan = await buildWritePlan(dir, artifacts, answers);
    const gateAction = plan.find(a => a.path.endsWith('.yml') && a.type === 'create');
    assert.ok(gateAction);
    assert.equal(gateAction.path, join(dir, '.gates', 'onboarded.yml'));
  });
});

describe('executePlan', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gk-exec-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('backs up existing profile.json', async () => {
    mkdirSync(join(dir, '.gateinitiative'), { recursive: true });
    writeFileSync(join(dir, '.gateinitiative', 'profile.json'), '{"version":0}');
    const stack = { language: 'javascript', testDirs: [], testFramework: '', hasPackageJson: true };
    const answers = { strictness: 'standard', testIntegrity: true, securityPreset: true, modularPreset: false, paradigmPreset: false, sources: [] };
    const artifacts = generateArtifacts(stack, answers);
    const plan = await buildWritePlan(dir, artifacts, answers);
    const { backedUp, wrote } = await executePlan(dir, plan, artifacts, answers);

    assert.ok(backedUp.some(p => p.endsWith('profile.json')));
    assert.ok(existsSync(join(dir, '.gateinitiative', 'profile.json.bak')));
    assert.ok(wrote.some(p => p.endsWith('profile.json')));
    const profile = JSON.parse(readFileSync(join(dir, '.gateinitiative', 'profile.json'), 'utf-8'));
    assert.equal(profile.version, 1);
  });

  it('merges context rules without overwriting user rules', async () => {
    mkdirSync(join(dir, '.gateinitiative'), { recursive: true });
    const userRule = { id: 'user-rule', description: 'mine', generatedBy: undefined };
    writeFileSync(join(dir, '.gateinitiative', 'context-rules.json'), JSON.stringify([userRule]));
    const stack = { language: 'javascript', testDirs: [], testFramework: '', hasPackageJson: true };
    const answers = { strictness: 'standard', testIntegrity: true, securityPreset: true, modularPreset: false, paradigmPreset: false, sources: [] };
    const artifacts = generateArtifacts(stack, answers);
    const plan = await buildWritePlan(dir, artifacts, answers);
    await executePlan(dir, plan, artifacts, answers);
    const rules = JSON.parse(readFileSync(join(dir, '.gateinitiative', 'context-rules.json'), 'utf-8'));
    assert.ok(rules.some(r => r.id === 'user-rule'));
    assert.ok(rules.some(r => r.id === 'onboard-security-sensitive'));
  });
});

describe('runOnboarding', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gk-onboard-run-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes profile, .gates.yml, and context-rules.json', async () => {
    const { wrote, artifacts } = await runOnboarding(dir, { yes: true });

    assert.ok(wrote.some(p => p.endsWith('profile.json')));
    assert.ok(wrote.some(p => p.endsWith('.gates.yml')));
    assert.ok(wrote.some(p => p.endsWith('context-rules.json')));

    const writtenProfile = JSON.parse(readFileSync(join(dir, '.gateinitiative', 'profile.json'), 'utf-8'));
    assert.equal(writtenProfile.version, 1);

    const gatesYml = readFileSync(join(dir, '.gates.yml'), 'utf-8');
    assert.ok(gatesYml.includes('no-secrets-in-source'));

    const writtenRules = JSON.parse(readFileSync(join(dir, '.gateinitiative', 'context-rules.json'), 'utf-8'));
    assert.equal(writtenRules.length, artifacts.contextRules.length);
  });

  it('writes playbooks and skill docs when presets are enabled', async () => {
    await runOnboarding(dir, { yes: true, modularPreset: true, paradigmPreset: true, testIntegrity: true, securityPreset: true });
    assert.ok(existsSync(join(dir, '.playbooks', 'security-sensitive.yaml')));
    assert.ok(existsSync(join(dir, 'docs', 'agents', 'security-sensitive.md')));
    assert.ok(existsSync(join(dir, 'docs', 'agents', 'testing-conventions.md')));
    assert.ok(existsSync(join(dir, 'docs', 'agents', 'modular-design.md')));
    assert.ok(existsSync(join(dir, 'docs', 'agents', 'paradigm-functional.md')));
  });

  it('does not modify instruction files with --yes', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# Agent\nNever commit secrets.');
    const before = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');
    await runOnboarding(dir, { yes: true });
    const after = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');
    assert.equal(before, after);
  });

  it('does not write anything in dry-run mode', async () => {
    await runOnboarding(dir, { dryRun: true });
    assert.equal(existsSync(join(dir, '.gateinitiative')), false);
    assert.equal(existsSync(join(dir, '.gates.yml')), false);
  });

  it('aborts when confirmation returns false', async () => {
    const result = await runOnboarding(dir, { confirm: async () => false });
    assert.equal(result.executed, false);
    assert.equal(existsSync(join(dir, '.gates.yml')), false);
  });
});

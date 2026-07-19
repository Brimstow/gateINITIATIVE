// gateinitiative: Context Detector tests
// Run with: node --test src/context-detector.test.mjs

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ContextDetector,
  parseContextBlock,
  extractContextRules,
  getDefaultContextRules,
  enforceContextSignals,
} from './context-detector.mjs';
import { getStateSecret, buildSignedState } from './playbook-state.mjs';

const TMP = join(process.cwd(), '.tmp-context-test');

async function freshDir() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
}

async function cleanup() {
  await rm(TMP, { recursive: true, force: true });
}

describe('parseContextBlock', () => {
  it('parses a context block with arrays and enforcement fields', () => {
    const content = `id: my-rule
filePatterns: ["src/auth/**", "**/login*"]
keywords: ["jwt", "token"]
contextFile: docs/agents/auth.md
description: Auth context
enforce: true
severity: warn
ttl: 3600`;
    const rule = parseContextBlock(content, 't.md');
    assert.equal(rule.id, 'my-rule');
    assert.deepEqual(rule.filePatterns, ['src/auth/**', '**/login*']);
    assert.deepEqual(rule.keywords, ['jwt', 'token']);
    assert.equal(rule.contextFile, 'docs/agents/auth.md');
    assert.equal(rule.enforce, true);
    assert.equal(rule.ttl, 3600);
  });

  it('returns null when id or contextFile is missing', () => {
    assert.equal(parseContextBlock('id: x\n', 't.md'), null);
    assert.equal(parseContextBlock('contextFile: x.md\n', 't.md'), null);
  });

  it('normalizes a single string pattern into an array', () => {
    const rule = parseContextBlock(
      'id: r\ncontextFile: d.md\nfilePatterns: "src/**"\nkeywords: "jwt"\n',
      't.md',
    );
    assert.deepEqual(rule.filePatterns, ['src/**']);
    assert.deepEqual(rule.keywords, ['jwt']);
  });
});

describe('extractContextRules', () => {
  it('extracts rules from a ```context block', () => {
    const md = `# Doc

\`\`\`context
id: rule-a
contextFile: docs/a.md
filePatterns: ["**/*.ts"]
keywords: ["foo"]
\`\`\`
`;
    const rules = extractContextRules(md, 'doc.md');
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, 'rule-a');
  });
});

describe('ContextDetector', () => {
  it('emits a signal when a file pattern matches', () => {
    const rules = [
      {
        id: 'auth',
        filePatterns: ['**/auth/**'],
        keywords: ['jwt'],
        contextFile: 'docs/auth.md',
        description: 'd',
      },
    ];
    const detector = new ContextDetector(rules, { cooldownMs: 0 });
    const signals = detector.detect('src/auth/login.ts', '');
    assert.equal(signals.length, 1);
    assert.equal(signals[0].contextFile, 'docs/auth.md');
    assert.equal(signals[0].matchType, 'file');
    assert.equal(signals[0].confidence, 0.9);
  });

  it('emits a content-keyword signal at lower confidence', () => {
    const rules = [
      {
        id: 'auth',
        filePatterns: [],
        keywords: ['jwt'],
        contextFile: 'docs/auth.md',
        description: 'd',
      },
    ];
    const detector = new ContextDetector(rules, { cooldownMs: 0 });
    const signals = detector.detect('src/utils.ts', 'const t = sign_jwt()');
    assert.equal(signals.length, 1);
    assert.equal(signals[0].matchType, 'content');
    assert.equal(signals[0].confidence, 0.7);
  });

  it('deduplicates by contextFile, keeping the highest confidence', () => {
    const rules = [
      { id: 'a', filePatterns: ['**/auth/**'], keywords: ['jwt'], contextFile: 'docs/auth.md', description: 'd' },
      { id: 'b', filePatterns: ['**/login*'], keywords: [], contextFile: 'docs/auth.md', description: 'd' },
    ];
    const detector = new ContextDetector(rules, { cooldownMs: 0 });
    const signals = detector.detect('src/auth/login.ts', '');
    assert.equal(signals.length, 1);
    assert.equal(signals[0].confidence, 0.9); // file match beats path-keyword match
  });

  it('suppresses repeat signals within the cooldown window', () => {
    const rules = [
      { id: 'a', filePatterns: ['**/*.ts'], keywords: [], contextFile: 'docs/a.md', description: 'd' },
    ];
    const detector = new ContextDetector(rules, { cooldownMs: 60_000 });
    const first = detector.detect('src/a.ts', '');
    const second = detector.detect('src/b.ts', '');
    assert.equal(first.length, 1);
    assert.equal(second.length, 0); // suppressed by cooldown
  });

  it('resetCooldowns() allows signals to fire again', () => {
    const rules = [
      { id: 'a', filePatterns: ['**/*.ts'], keywords: [], contextFile: 'docs/a.md', description: 'd' },
    ];
    const detector = new ContextDetector(rules, { cooldownMs: 60_000 });
    detector.detect('src/a.ts', '');
    detector.resetCooldowns();
    const again = detector.detect('src/b.ts', '');
    assert.equal(again.length, 1);
  });
});

describe('enforceContextSignals', () => {
  beforeEach(freshDir);
  afterEach(cleanup);

  it('returns a violation when no state evidence exists', async () => {
    const signals = [
      { contextFile: 'docs/agents/auth.md', reason: 'r', trigger: 'src/auth.ts', confidence: 0.9, enforce: true, severity: 'warn', ttl: 3600 },
    ];
    const violations = await enforceContextSignals(signals, TMP);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].severity, 'warn');
    assert.equal(violations[0].age_seconds, null);
  });

  it('returns no violations when fresh state evidence exists', async () => {
    await mkdir(join(TMP, '.gateinitiative'), { recursive: true });
    const secret = await getStateSecret(TMP, TMP);
    const now = Date.now();
    await writeFile(
      join(TMP, '.gateinitiative', 'playbook-state.json'),
      JSON.stringify(buildSignedState(secret, { 'read:docs/agents/auth.md': now })),
    );
    const signals = [
      { contextFile: 'docs/agents/auth.md', reason: 'r', trigger: 'src/auth.ts', confidence: 0.9, enforce: true, severity: 'warn', ttl: 3600 },
    ];
    const violations = await enforceContextSignals(signals, TMP, { shadowDir: TMP });
    assert.equal(violations.length, 0);
  });

  it('returns a violation when evidence is stale (TTL exceeded)', async () => {
    await mkdir(join(TMP, '.gateinitiative'), { recursive: true });
    const secret = await getStateSecret(TMP, TMP);
    const stale = Date.now() - 10_000_000; // ~2.7h ago, ttl is 3600s
    await writeFile(
      join(TMP, '.gateinitiative', 'playbook-state.json'),
      JSON.stringify(buildSignedState(secret, { 'read:docs/agents/auth.md': stale })),
    );
    const signals = [
      { contextFile: 'docs/agents/auth.md', reason: 'r', trigger: 'src/auth.ts', confidence: 0.9, enforce: true, severity: 'warn', ttl: 3600 },
    ];
    const violations = await enforceContextSignals(signals, TMP, { shadowDir: TMP });
    assert.equal(violations.length, 1);
    assert.ok(violations[0].age_seconds > 3600);
  });

  it('ignores forged playbook-state entries without valid HMAC (1.5)', async () => {
    await mkdir(join(TMP, '.gateinitiative'), { recursive: true });
    await writeFile(
      join(TMP, '.gateinitiative', 'playbook-state.json'),
      JSON.stringify({ session: null, completed: { 'read:docs/agents/auth.md': Date.now() } }),
    );
    const signals = [
      { contextFile: 'docs/agents/auth.md', reason: 'r', trigger: 'src/auth.ts', confidence: 0.9, enforce: true, severity: 'warn', ttl: 3600 },
    ];
    const violations = await enforceContextSignals(signals, TMP, { shadowDir: TMP });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].age_seconds, null);
  });

  it('ignores non-enforced signals unless enforceAll is set', async () => {
    const signals = [
      { contextFile: 'docs/agents/auth.md', reason: 'r', trigger: 'src/auth.ts', confidence: 0.9, enforce: false, severity: 'warn', ttl: 3600 },
    ];
    assert.equal((await enforceContextSignals(signals, TMP)).length, 0);
    assert.equal((await enforceContextSignals(signals, TMP, { enforceAll: true })).length, 1);
  });
});

describe('getDefaultContextRules', () => {
  it('returns a non-empty array of rules with ids and contextFiles', () => {
    const rules = getDefaultContextRules();
    assert.ok(rules.length > 0);
    for (const r of rules) {
      assert.ok(r.id, 'rule has id');
      assert.ok(r.contextFile, 'rule has contextFile');
      assert.ok(Array.isArray(r.filePatterns));
      assert.ok(Array.isArray(r.keywords));
    }
  });
});

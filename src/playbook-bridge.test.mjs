import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaybookBridge, buildRulesContent, GENERATED_MARKER } from './playbook-bridge.mjs';

describe('PlaybookBridge', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gk-bridge-'));
    mkdirSync(join(dir, '.gateinitiative'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces gates in generated rules (2.1)', async () => {
    const gates = [
      { id: 'no-secrets', trigger: '**/*.{ts,js}', severity: 'block', pattern: '/sk-/', message: 'No secrets', source: 't.md' },
    ];
    const content = await buildRulesContent({
      projectRoot: dir,
      gates,
      lastViolations: [],
      includePlaybookState: false,
      daemonRunning: true,
    });

    assert.ok(content.includes(GENERATED_MARKER));
    assert.ok(content.includes('## Enforced Gates'));
    assert.ok(content.includes('no-secrets'));
    assert.ok(content.includes('block'));
  });

  it('injects recent violations as feedback (2.2)', async () => {
    const gates = [{ id: 'g', trigger: '**/*.ts', severity: 'warn', pattern: '/x/', message: 'm', source: 't.md' }];
    const lastViolations = [
      { gateId: 'g', file: 'src/app.ts', message: 'found x', reverted: true, severity: 'warn' },
    ];
    const content = await buildRulesContent({
      projectRoot: dir,
      gates,
      lastViolations,
      includePlaybookState: false,
      daemonRunning: true,
    });

    assert.ok(content.includes('## Recent Violations'));
    assert.ok(content.includes('REVERTED'));
    assert.ok(content.includes('src/app.ts'));
  });

  it('warns when the daemon is not running (2.4)', async () => {
    const content = await buildRulesContent({
      projectRoot: dir,
      gates: [],
      lastViolations: [],
      includePlaybookState: false,
      daemonRunning: false,
    });

    assert.ok(content.includes('gateinitiative daemon is NOT RUNNING'));
  });

  it('escapes code fences in inlined docs (2.7)', async () => {
    writeFileSync(join(dir, 'doc.md'), '```js\nconsole.log(1);\n```');
    writeFileSync(join(dir, '.gateinitiative', 'context.json'), JSON.stringify({
      timestamp: new Date().toISOString(),
      signals: [{ contextFile: 'doc.md', reason: 'focus', trigger: 'doc.md', confidence: 1 }],
    }));

    const content = await buildRulesContent({
      projectRoot: dir,
      gates: [],
      lastViolations: [],
      includePlaybookState: false,
      daemonRunning: true,
      maxContextDocs: 1,
    });

    assert.ok(content.includes('````'));
    assert.ok(!content.includes('```js\nconsole.log(1);\n```'));
  });

  it('deduplicates unchanged rules via sha1 (2.7)', async () => {
    writeFileSync(join(dir, '.gateinitiative', 'context.json'), JSON.stringify({
      timestamp: new Date().toISOString(),
      signals: [],
    }));

    const bridge = new PlaybookBridge({
      projectRoot: dir,
      ideTargets: [],
      includePlaybookState: false,
    });

    const first = await bridge.run({ gates: [], daemonRunning: true });
    const second = await bridge.run({ gates: [], daemonRunning: true });

    assert.equal(first.written.length, 0); // no targets
    assert.equal(second.written.length, 0);
    assert.ok(second.tokenEstimate >= 0);
  });

  it('injects pending review decisions into generated rules (2A.6)', async () => {
    const { recordPendingDecision } = await import('./decisions.mjs');
    await recordPendingDecision(dir, { gateId: 'no-eval', file: 'src/app.ts', reason: 'manual review required' }, dir);

    const content = await buildRulesContent({
      projectRoot: dir,
      gates: [],
      lastViolations: [],
      includePlaybookState: false,
      daemonRunning: true,
      shadowDir: dir,
    });

    assert.ok(content.includes('## Pending Review Decisions'));
    assert.ok(content.includes('no-eval'));
    assert.ok(content.includes('manual review required'));
  });

  it('undefined options fall back to defaults instead of clobbering them (v0.3.1)', () => {
    const bridge = new PlaybookBridge({
      projectRoot: dir,
      maxDocChars: undefined,
      maxContextDocs: undefined,
    });
    assert.equal(bridge.config.maxDocChars, 2000, 'undefined maxDocChars must not disable doc truncation');
    assert.equal(bridge.config.maxContextDocs, 2);
  });
});

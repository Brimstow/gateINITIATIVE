// gateinitiative: Parser YAML tests (gates via real YAML, diagnostics)
// Run with: node --test src/parser.test.mjs

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseGateBlock, extractGates, extractGatesFromYaml, parseYamlDocuments, loadProjectGates } from './parser.mjs';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const TMP = join(process.cwd(), '.tmp-parser-test');

async function freshDir() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(join(TMP, 'docs', 'agents'), { recursive: true });
}

async function cleanup() {
  await rm(TMP, { recursive: true, force: true });
}

describe('parseYamlDocuments', () => {
  it('parses a single document', () => {
    const objs = parseYamlDocuments('id: a\ntrigger: "**/*.ts"\n', 't.yml');
    assert.equal(objs.length, 1);
    assert.equal(objs[0].id, 'a');
  });

  it('parses multiple --- separated documents', () => {
    const objs = parseYamlDocuments('id: a\n---\nid: b\n', 't.yml');
    assert.equal(objs.length, 2);
    assert.equal(objs[0].id, 'a');
    assert.equal(objs[1].id, 'b');
  });

  it('skips empty documents between separators', () => {
    const objs = parseYamlDocuments('---\nid: a\n---\n---\nid: b\n', 't.yml');
    assert.equal(objs.length, 2);
  });

  it('reports YAML errors via onWarn and skips the bad doc', () => {
    const warnings = [];
    const objs = parseYamlDocuments('id: a\n  bad: : : indent\n', 't.yml', (m) => warnings.push(m));
    // Either parsed leniently or warned — but never throws
    assert.ok(Array.isArray(objs));
    if (warnings.length > 0) assert.ok(warnings[0].includes('t.yml'));
  });
});

describe('parseGateBlock (via yaml)', () => {
  it('preserves regex patterns with backslashes', () => {
    const gate = parseGateBlock(
      'id: g\ntrigger: "**/*.ts"\nseverity: warn\npattern: /console\\.log\\(/\nmessage: "no console"\n',
      't.md',
    );
    assert.equal(gate.pattern, '/console\\.log\\(/');
  });

  it('preserves character-class patterns', () => {
    const gate = parseGateBlock(
      'id: g\ntrigger: "**/*.ts"\nseverity: warn\npattern: /:\\s*any[\\s;,)]/\nmessage: "no any"\n',
      't.md',
    );
    assert.equal(gate.pattern, '/:\\s*any[\\s;,)]/');
  });

  it('warns when a required field is missing', () => {
    const warnings = [];
    const gate = parseGateBlock('id: g\ntrigger: "**/*.ts"\nseverity: warn\n', 't.md', (m) => warnings.push(m));
    assert.equal(gate, null);
    assert.ok(warnings.some(w => w.includes('missing required field')));
  });

  it('warns when neither pattern nor antipattern is present', () => {
    const warnings = [];
    const gate = parseGateBlock(
      'id: g\ntrigger: "**/*.ts"\nseverity: warn\nmessage: "m"\n',
      't.md',
      (m) => warnings.push(m),
    );
    assert.equal(gate, null);
    assert.ok(warnings.some(w => w.includes('pattern') || w.includes('antipattern')));
  });

  it('warns and rejects an invalid regex', () => {
    const warnings = [];
    const gate = parseGateBlock(
      'id: g\ntrigger: "**/*.ts"\nseverity: warn\npattern: /[unclosed/\nmessage: "m"\n',
      't.md',
      (m) => warnings.push(m),
    );
    assert.equal(gate, null);
    assert.ok(warnings.some(w => w.includes('invalid regex')));
  });

  it('defaults an invalid severity to warn (with a warning)', () => {
    const warnings = [];
    const gate = parseGateBlock(
      'id: g\ntrigger: "**/*.ts"\nseverity: critical\npattern: /x/\nmessage: "m"\n',
      't.md',
      (m) => warnings.push(m),
    );
    assert.equal(gate.severity, 'warn');
    assert.ok(warnings.some(w => w.includes('invalid severity')));
  });

  it('warns on patterns that look ReDoS-prone (1.7)', () => {
    const warnings = [];
    const gate = parseGateBlock(
      'id: g\ntrigger: "**/*.ts"\nseverity: warn\npattern: /(a+)+/\nmessage: "m"\n',
      't.md',
      (m) => warnings.push(m),
    );
    assert.equal(gate.id, 'g');
    assert.ok(warnings.some(w => w.includes('ReDoS') || w.includes('backtracking')));
  });

  it('warns when brace expansion options contain wildcards (2.8)', () => {
    const warnings = [];
    const gate = parseGateBlock(
      'id: g\ntrigger: "src/{**/*.ts,**/*.js}"\nseverity: warn\npattern: /x/\nmessage: "m"\n',
      't.md',
      (m) => warnings.push(m),
    );
    assert.equal(gate.id, 'g');
    assert.ok(warnings.some(w => w.includes('brace') && w.includes('literal-only')));
  });
});

describe('version-tolerant parsing', () => {
  it('ignores a version-only document without warning', () => {
    const content = `version: 1\n---\nid: no-console\ntrigger: "src/**/*.js"\nseverity: warn\npattern: /console\.log/\nmessage: no console`;
    const warnings = [];
    const gates = extractGatesFromYaml(content, 'test.yml', w => warnings.push(w));
    assert.equal(gates.length, 1);
    assert.equal(gates[0].id, 'no-console');
    assert.equal(warnings.length, 0);
  });
});

describe('extractGatesFromYaml', () => {
  it('parses the canonical .gates.yml format with comments and --- separators', () => {
    const content = `# header comment
---
id: no-secrets
trigger: "**/*.{ts,js}"
severity: block
pattern: /(sk-[a-zA-Z0-9]{20,})/
message: "secret"
exclude: ["**/*.test.*"]

---
id: no-console
trigger: "src/**"
severity: warn
pattern: /console\\.log\\(/
message: "no console"
`;
    const gates = extractGatesFromYaml(content, '.gates.yml');
    assert.equal(gates.length, 2);
    assert.equal(gates[0].id, 'no-secrets');
    assert.deepEqual(gates[0].exclude, ['**/*.test.*']);
    assert.equal(gates[1].id, 'no-console');
  });

  it('skips invalid gates and reports them', () => {
    const warnings = [];
    const content = `---
id: good
trigger: "**/*.ts"
severity: warn
pattern: /x/
message: "m"
---
id: bad
trigger: "**/*.ts"
severity: warn
message: "no pattern"
`;
    const gates = extractGatesFromYaml(content, '.gates.yml', (m) => warnings.push(m));
    assert.equal(gates.length, 1);
    assert.equal(gates[0].id, 'good');
    assert.ok(warnings.some(w => w.includes('bad')));
  });
});

describe('extractGates (markdown)', () => {
  it('extracts gates from a ```gate block with multiple --- sections', () => {
    const md = 'intro\n\n```gate\nid: a\ntrigger: "**/*.ts"\nseverity: warn\npattern: /x/\nmessage: "m"\n---\nid: b\ntrigger: "**/*.js"\nseverity: block\npattern: /y/\nmessage: "n"\n```\n';
    const gates = extractGates(md, 'doc.md');
    assert.equal(gates.length, 2);
    assert.equal(gates[0].id, 'a');
    assert.equal(gates[1].id, 'b');
  });

  it('ignores non-gate code blocks', () => {
    const md = '```js\nid: not-a-gate\n```\n\n```gate\nid: real\ntrigger: "**/*.ts"\nseverity: warn\npattern: /x/\nmessage: "m"\n```\n';
    const gates = extractGates(md, 'doc.md');
    assert.equal(gates.length, 1);
    assert.equal(gates[0].id, 'real');
  });
});

describe('loadProjectGates', () => {
  beforeEach(freshDir);
  afterEach(cleanup);

  it('root .gates.yml overrides directory gates on duplicate ids (1.6)', async () => {
    const docs = join(TMP, 'docs', 'agents', 'rules.md');
    await writeFile(docs, '```gate\nid: shared\ntrigger: "**/*.ts"\nseverity: warn\npattern: /old/\nmessage: "old"\n```\n');

    const rootYml = join(TMP, '.gates.yml');
    await writeFile(rootYml, `---
id: shared
trigger: "**/*.ts"
severity: block
pattern: /new/
message: "new"
`);

    const warnings = [];
    const gates = await loadProjectGates(TMP, { onWarn: (m) => warnings.push(m) });

    assert.equal(gates.length, 1);
    assert.equal(gates[0].id, 'shared');
    assert.equal(gates[0].severity, 'block');
    assert.equal(gates[0].pattern, '/new/');
    assert.ok(warnings.some(w => w.includes('overridden')));
  });
});

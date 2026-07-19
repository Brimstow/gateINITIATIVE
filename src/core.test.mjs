/**
 * gateinitiative: Core Tests
 * Run with: node --test src/core.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseGateBlock, extractGates } from './parser.mjs';
import { globToRegex, matchesTrigger, evaluateGate } from './evaluator.mjs';

describe('Parser', () => {
  test('parseGateBlock parses a valid gate', () => {
    const content = `id: test-gate
trigger: "src/**/*.ts"
severity: warn
pattern: /console\\.log/
message: "No console.log allowed"`;

    const gate = parseGateBlock(content, 'test.md');
    assert.equal(gate.id, 'test-gate');
    assert.equal(gate.trigger, 'src/**/*.ts');
    assert.equal(gate.severity, 'warn');
    assert.equal(gate.pattern, '/console\\.log/');
    assert.equal(gate.message, 'No console.log allowed');
    assert.equal(gate.source, 'test.md');
  });

  test('parseGateBlock handles CRLF line endings', () => {
    const content = "id: crlf-gate\r\ntrigger: \"**/*.js\"\r\nseverity: block\r\npattern: /eval/\r\nmessage: \"no eval\"";
    const gate = parseGateBlock(content, 'test.md');
    assert.equal(gate.id, 'crlf-gate');
    assert.equal(gate.severity, 'block');
  });

  test('parseGateBlock returns null for missing required fields', () => {
    const content = `id: incomplete
trigger: "src/**"`;
    const gate = parseGateBlock(content, 'test.md');
    assert.equal(gate, null);
  });

  test('parseGateBlock parses array values', () => {
    const content = `id: with-exclude
trigger: "**/*.ts"
severity: warn
pattern: /TODO/
message: "TODO found"
exclude: ["**/*.test.ts", "**/node_modules/**"]`;

    const gate = parseGateBlock(content, 'test.md');
    assert.deepEqual(gate.exclude, ['**/*.test.ts', '**/node_modules/**']);
  });

  test('extractGates finds gate blocks in markdown', () => {
    const markdown = `# My Document

Some text here.

\`\`\`gate
id: gate-one
trigger: "**/*.ts"
severity: warn
pattern: /foo/
message: "Found foo"
---
id: gate-two
trigger: "**/*.js"
severity: block
pattern: /bar/
message: "Found bar"
\`\`\`

More text.
`;

    const gates = extractGates(markdown, 'doc.md');
    assert.equal(gates.length, 2);
    assert.equal(gates[0].id, 'gate-one');
    assert.equal(gates[1].id, 'gate-two');
  });

  test('extractGates handles yaml gate language', () => {
    const markdown = `\`\`\`yaml gate
id: yaml-gate
trigger: "src/**"
severity: info
pattern: /debug/
message: "Debug statement"
\`\`\``;

    const gates = extractGates(markdown, 'doc.md');
    assert.equal(gates.length, 1);
    assert.equal(gates[0].id, 'yaml-gate');
  });
});

describe('Evaluator - Glob Matching', () => {
  test('matches simple extension pattern', () => {
    assert.equal(matchesTrigger('src/app.ts', '**/*.ts'), true);
    assert.equal(matchesTrigger('src/app.js', '**/*.ts'), false);
  });

  test('matches brace expansion', () => {
    assert.equal(matchesTrigger('file.ts', '**/*.{ts,tsx}'), true);
    assert.equal(matchesTrigger('file.tsx', '**/*.{ts,tsx}'), true);
    assert.equal(matchesTrigger('file.js', '**/*.{ts,tsx}'), false);
  });

  test('matches nested paths', () => {
    assert.equal(matchesTrigger('src/components/Button.tsx', 'src/**/*.tsx'), true);
    assert.equal(matchesTrigger('lib/Button.tsx', 'src/**/*.tsx'), false);
  });

  test('matches specific file', () => {
    assert.equal(matchesTrigger('pikzels-clone/src/server.ts', 'pikzels-clone/src/server.ts'), true);
    assert.equal(matchesTrigger('pikzels-clone/src/other.ts', 'pikzels-clone/src/server.ts'), false);
  });

  test('handles Windows-style backslash paths', () => {
    assert.equal(matchesTrigger('src\\app.ts', '**/*.ts'), true);
    assert.equal(matchesTrigger('src\\components\\Button.tsx', 'src/**/*.tsx'), true);
  });
});

describe('Evaluator - Gate Evaluation', () => {
  test('pattern gate detects violation', () => {
    const gate = {
      id: 'no-console',
      trigger: '**/*.ts',
      severity: 'warn',
      pattern: '/console\\.log\\(/',
      message: 'No console.log',
      source: 'test.md',
    };

    const content = 'const x = 1;\nconsole.log(x);\nreturn x;';
    const violation = evaluateGate(gate, content, 'app.ts');

    assert.notEqual(violation, null);
    assert.equal(violation.gateId, 'no-console');
    assert.equal(violation.line, 2);
    assert.equal(violation.severity, 'warn');
  });

  test('pattern gate passes when no match', () => {
    const gate = {
      id: 'no-eval',
      trigger: '**/*.ts',
      severity: 'block',
      pattern: '/eval\\(/',
      message: 'No eval',
      source: 'test.md',
    };

    const content = 'const result = compute(data);';
    const violation = evaluateGate(gate, content, 'app.ts');
    assert.equal(violation, null);
  });

  test('pattern with s flag matches across lines and reports correct line', () => {
    const gate = {
      id: 'no-block-comment-secret',
      trigger: '**/*.ts',
      severity: 'warn',
      pattern: "/API_KEY\\s*=\\s*['\"].*?['\"]/s",
      message: 'Secret in multiline block',
      source: 'test.md',
    };

    const content = 'const config = {\n  API_KEY = "super-secret"\n};';
    const violation = evaluateGate(gate, content, 'app.ts');

    assert.notEqual(violation, null);
    assert.equal(violation.line, 2);
    assert.equal(violation.gateId, 'no-block-comment-secret');
  });

  test('antipattern gate detects missing required pattern', () => {
    const gate = {
      id: 'needs-auth',
      trigger: 'src/**/*.ts',
      severity: 'block',
      antipattern: '/authenticateToken/',
      message: 'Missing auth middleware',
      source: 'test.md',
    };

    const content = 'router.get("/api/data", handler);';
    const violation = evaluateGate(gate, content, 'src/route.ts');

    assert.notEqual(violation, null);
    assert.equal(violation.gateId, 'needs-auth');
  });

  test('antipattern gate passes when pattern is found', () => {
    const gate = {
      id: 'needs-auth',
      trigger: 'src/**/*.ts',
      severity: 'block',
      antipattern: '/authenticateToken/',
      message: 'Missing auth middleware',
      source: 'test.md',
    };

    const content = 'router.get("/api/data", authenticateToken, handler);';
    const violation = evaluateGate(gate, content, 'src/route.ts');
    assert.equal(violation, null);
  });
});

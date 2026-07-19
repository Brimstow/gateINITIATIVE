// gateinitiative: Playbook Module Tests
//
// Tests for playbook parsing, prerequisite checking, and enforcement.
// Run with: node --test src/playbook.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaybook, findApplicablePlaybook, checkPrerequisites } from './playbook.mjs';

describe('parsePlaybook', () => {
  it('parses a valid playbook with all fields', () => {
    const content = `
name: edit-security-file
version: 1
description: "Require tests before editing security files"
trigger: "src/middleware/**/*.ts"
prerequisites:
  - id: tests-passed
    evidence:
      file_fresh: "coverage/lcov.info"
      state_key: "tests:auth"
    ttl: 300
    message: "Run tests before editing"
    severity: block
  - id: docs-loaded
    evidence:
      state_key: "read:docs/agents/authentication.md"
    ttl: 600
    message: "Load auth docs first"
    severity: warn
on_violation:
  severity: block
  mode: inherit
`;
    const result = parsePlaybook(content, 'test.yaml');
    assert.equal(result.name, 'edit-security-file');
    assert.equal(result.version, 1);
    assert.equal(result.trigger, 'src/middleware/**/*.ts');
    assert.equal(result.prerequisites.length, 2);
    assert.equal(result.prerequisites[0].id, 'tests-passed');
    assert.equal(result.prerequisites[0].ttl, 300);
    assert.equal(result.prerequisites[0].severity, 'block');
    assert.equal(result.prerequisites[1].id, 'docs-loaded');
    assert.equal(result.prerequisites[1].severity, 'warn');
  });

  it('returns null for missing required fields', () => {
    const content = `
description: "No name or trigger"
prerequisites:
  - id: test
    evidence:
      state_key: "x"
    ttl: 60
    message: "msg"
`;
    const result = parsePlaybook(content, 'test.yaml');
    assert.equal(result, null);
  });

  it('returns null for playbook with no prerequisites', () => {
    const content = `
name: empty
trigger: "**/*.ts"
`;
    const result = parsePlaybook(content, 'test.yaml');
    assert.equal(result, null);
  });

  it('handles CRLF line endings', () => {
    const content = 'name: test\r\ntrigger: "src/**"\r\nprerequisites:\r\n  - id: step1\r\n    evidence:\r\n      state_key: "x"\r\n    ttl: 60\r\n    message: "do thing"\r\n';
    const result = parsePlaybook(content, 'test.yaml');
    assert.equal(result.name, 'test');
    assert.equal(result.prerequisites.length, 1);
  });

  it('handles array trigger syntax', () => {
    const content = `
name: multi-trigger
trigger: ["src/auth/**", "src/middleware/**"]
prerequisites:
  - id: step1
    evidence:
      state_key: "x"
    ttl: 60
    message: "msg"
`;
    const result = parsePlaybook(content, 'test.yaml');
    assert.deepEqual(result.trigger, ['src/auth/**', 'src/middleware/**']);
  });

  it('skips comment lines and document separators', () => {
    const content = `
---
# This is a comment
name: commented
trigger: "**/*.ts"
# Another comment
prerequisites:
  - id: step1
    evidence:
      state_key: "tests:all"
    ttl: 120
    message: "run tests"
---
`;
    const result = parsePlaybook(content, 'test.yaml');
    assert.equal(result.name, 'commented');
    assert.equal(result.prerequisites.length, 1);
  });
});

describe('findApplicablePlaybook', () => {
  const playbooks = [
    {
      name: 'security',
      trigger: 'src/middleware/**/*.ts',
      prerequisites: [{ id: 'test', evidence: {}, ttl: 60, message: '' }],
      source: 'a.yaml'
    },
    {
      name: 'prisma',
      trigger: ['prisma/**/*.prisma', 'prisma/schema.prisma'],
      prerequisites: [{ id: 'test', evidence: {}, ttl: 60, message: '' }],
      source: 'b.yaml'
    }
  ];

  it('matches a file to its governing playbook', () => {
    const result = findApplicablePlaybook('src/middleware/auth.ts', playbooks);
    assert.equal(result.name, 'security');
  });

  it('matches array triggers', () => {
    const result = findApplicablePlaybook('prisma/schema.prisma', playbooks);
    assert.equal(result.name, 'prisma');
  });

  it('returns null for ungoverned files', () => {
    const result = findApplicablePlaybook('src/components/Button.tsx', playbooks);
    assert.equal(result, null);
  });
});

describe('PlaybookEnforcer integration', () => {
  it('reports no violations for ungoverned files', async () => {
    const { PlaybookEnforcer } = await import('./playbook.mjs');
    // Use a temp directory with no .playbooks
    const enforcer = new PlaybookEnforcer('/tmp/nonexistent-project-xyz');
    await enforcer.load();
    const result = await enforcer.evaluateEdit('src/app.ts');
    assert.equal(result.governed, false);
    assert.equal(result.violations.length, 0);
  });
});

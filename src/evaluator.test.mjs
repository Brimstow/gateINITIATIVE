// gateinitiative: Evaluator additional tests
// Run with: node --test src/evaluator.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  globToRegex,
  matchesTrigger,
  matchesExclude,
  compilePattern,
  evaluateGate,
  evaluateContent,
  applicableGates,
  looksBinary,
  evaluateFile,
  looksUnsafeRegex,
} from './evaluator.mjs';

const TMP = join(process.cwd(), '.tmp-evaluator-test');

describe('looksUnsafeRegex', () => {
  it('flags classic nested unbounded quantifiers', () => {
    assert.equal(looksUnsafeRegex('/(a+)+/'), true);
    assert.equal(looksUnsafeRegex('(.*)*'), true);
    assert.equal(looksUnsafeRegex('(\\w+)*$'), true);
  });

  it('flags nesting at depth > 1', () => {
    assert.equal(looksUnsafeRegex('((ab)+)+'), true);
    assert.equal(looksUnsafeRegex('((a+)b)*'), true);
    assert.equal(looksUnsafeRegex('(x(y|z+))*'), true);
  });

  it('flags open-ended and large bounded repeats when nested', () => {
    assert.equal(looksUnsafeRegex('(a+){2,}'), true);
    assert.equal(looksUnsafeRegex('(a{1,50})+'), true);
    assert.equal(looksUnsafeRegex('(\\d{11})+'), true);
  });

  it('flags lazy quantifier variants (lazy still backtracks)', () => {
    assert.equal(looksUnsafeRegex('(a+?)+'), true);
    assert.equal(looksUnsafeRegex('(a+)+?'), true);
  });

  it('flags long runs of unbounded wildcards', () => {
    assert.equal(looksUnsafeRegex('/.*.*.*x/'), true);
  });

  it('accepts safe patterns', () => {
    assert.equal(looksUnsafeRegex('/console\\.log\\(/'), false);
    assert.equal(looksUnsafeRegex('/(sk-|pk_live_|AKIA[A-Z0-9]{16})/'), false);
    assert.equal(looksUnsafeRegex('(abc)+'), false);
    assert.equal(looksUnsafeRegex('(a?)+'), false);
    assert.equal(looksUnsafeRegex('(a{1,5})+'), false);
    assert.equal(looksUnsafeRegex('a+b*c?'), false);
  });

  it('does not false-positive on quantifier chars inside character classes', () => {
    assert.equal(looksUnsafeRegex('([+*]x)+'), false);
    assert.equal(looksUnsafeRegex('([a-z+]+)'), false);
  });

  it('handles non-capturing groups, named groups and lookarounds', () => {
    assert.equal(looksUnsafeRegex('(?:a+)+'), true);
    assert.equal(looksUnsafeRegex('(?<name>a+)+'), true);
    assert.equal(looksUnsafeRegex('(?=a)(b)+'), false);
  });
});

describe('compilePattern', () => {
  it('compiles a /regex/flags literal', () => {
    const rx = compilePattern('/foo/gi');
    assert.ok(rx instanceof RegExp);
    assert.equal(rx.test('FOO'), true);
  });

  it('strips the global flag (stateful lastIndex breaks reuse)', () => {
    const rx = compilePattern('/a/g');
    // Without 'g', repeated .test() on the same string is stable
    assert.equal(rx.test('aaa'), true);
    assert.equal(rx.test('aaa'), true); // would fail with 'g' + lastIndex
  });

  it('treats plain strings as literals', () => {
    const rx = compilePattern('console.log(');
    assert.ok(rx instanceof RegExp);
    assert.equal(rx.test('console.log(1)'), true);
  });

  it('returns null for invalid regex', () => {
    assert.equal(compilePattern('/(/'), null);
    assert.equal(compilePattern('/[unclosed/'), null);
  });

  it('caches results (same object identity)', () => {
    assert.equal(compilePattern('/x/'), compilePattern('/x/'));
  });
});

describe('globToRegex caching', () => {
  it('returns the same RegExp object for the same pattern', () => {
    assert.equal(globToRegex('**/*.ts'), globToRegex('**/*.ts'));
  });
});

describe('matchesExclude', () => {
  it('returns false for empty/undefined excludes', () => {
    assert.equal(matchesExclude('src/a.ts', undefined), false);
    assert.equal(matchesExclude('src/a.ts', []), false);
  });

  it('matches a file against exclude globs', () => {
    assert.equal(matchesExclude('src/a.test.ts', ['**/*.test.*']), true);
    assert.equal(matchesExclude('src/a.ts', ['**/*.test.*']), false);
  });

  it('respects brace expansion in excludes', () => {
    assert.equal(matchesExclude('src/a.spec.ts', ['**/*.{test,spec}.*']), true);
    assert.equal(matchesExclude('src/a.ts', ['**/*.{test,spec}.*']), false);
  });
});

describe('evaluateGate', () => {
  it('handles CRLF line endings (\\r no longer breaks line numbers)', () => {
    const gate = {
      id: 'no-eval',
      trigger: '**/*.ts',
      severity: 'block',
      pattern: '/eval\\(/',
      message: 'no eval',
      source: 't',
    };
    const content = 'const a = 1;\r\neval("x")\r\n';
    const v = evaluateGate(gate, content, 'a.ts');
    assert.ok(v);
    assert.equal(v.line, 2);
  });
});

describe('evaluateContent', () => {
  const gates = [
    { id: 'no-console', trigger: 'src/**', severity: 'warn', pattern: '/console\\.log\\(/', message: 'no console.log', source: 't' },
    { id: 'needs-auth', trigger: 'src/**', severity: 'block', antipattern: '/authenticateToken/', message: 'needs auth', source: 't' },
    { id: 'ts-only', trigger: '**/*.tsx', severity: 'info', pattern: '/TODO/', message: 'todo', source: 't' },
  ];

  it('only evaluates gates whose trigger matches', () => {
    const v = evaluateContent(gates, 'console.log(1)\n', 'src/app.ts');
    // no-console (warn) + needs-auth (block) apply; ts-only does not (.ts not .tsx)
    assert.equal(v.length, 2);
    assert.ok(v.some(x => x.gateId === 'no-console'));
    assert.ok(v.some(x => x.gateId === 'needs-auth'));
  });

  it('returns empty for a file no gate triggers on', () => {
    assert.deepEqual(evaluateContent(gates, 'x', 'README.md'), []);
  });
});

describe('applicableGates', () => {
  it('filters out excluded files', () => {
    const gates = [
      { id: 'g', trigger: '**/*.ts', severity: 'warn', pattern: '/x/', message: 'm', source: 's', exclude: ['**/*.test.*'] },
    ];
    assert.equal(applicableGates(gates, 'src/a.ts').length, 1);
    assert.equal(applicableGates(gates, 'src/a.test.ts').length, 0);
  });
});

describe('looksBinary', () => {
  it('detects NUL bytes in the first 8KB', () => {
    assert.equal(looksBinary('hello\0world'), true);
    assert.equal(looksBinary('plain text'), false);
  });

  it('does not flag NUL bytes past 8KB', () => {
    const big = 'x'.repeat(9000) + '\0';
    assert.equal(looksBinary(big), false);
  });
});

describe('evaluateFile (size/binary guards)', () => {
  it('skips files larger than maxFileBytes', async () => {
    await mkdir(join(TMP, 'src'), { recursive: true });
    const file = join(TMP, 'src', 'big.ts');
    // Write 200KB, set maxFileBytes to 100
    await writeFile(file, 'x'.repeat(200_000));
    try {
      const v = await evaluateFile(
        [{ id: 'g', trigger: '**/*.ts', severity: 'warn', pattern: '/x/', message: 'm', source: 's' }],
        file,
        TMP,
        { maxFileBytes: 100 },
      );
      assert.deepEqual(v, []);
    } finally {
      await rm(TMP, { recursive: true, force: true });
    }
  });

  it('skips binary files', async () => {
    await mkdir(join(TMP, 'src'), { recursive: true });
    const file = join(TMP, 'src', 'bin.ts');
    await writeFile(file, 'text\0binary\n');
    try {
      const v = await evaluateFile(
        [{ id: 'g', trigger: '**/*.ts', severity: 'warn', pattern: '/text/', message: 'm', source: 's' }],
        file,
        TMP,
      );
      assert.deepEqual(v, []);
    } finally {
      await rm(TMP, { recursive: true, force: true });
    }
  });

  it('returns [] for files with no applicable gates', async () => {
    await mkdir(join(TMP, 'src'), { recursive: true });
    const file = join(TMP, 'src', 'a.md');
    await writeFile(file, 'hello\n');
    try {
      const v = await evaluateFile(
        [{ id: 'g', trigger: '**/*.ts', severity: 'warn', pattern: '/x/', message: 'm', source: 's' }],
        file,
        TMP,
      );
      assert.deepEqual(v, []);
    } finally {
      await rm(TMP, { recursive: true, force: true });
    }
  });
});

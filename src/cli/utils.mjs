// gateinitiative CLI: Shared Command Utilities

import { resolve, relative } from 'node:path';
import { readdir } from 'node:fs/promises';
import { globToRegex, matchesExclude } from '../evaluator.mjs';

export function countSources(gates) {
  return new Set(gates.map(g => g.source)).size;
}

/**
 * Collect all files in the project that match at least one gate trigger.
 *
 * @param {string} root - Project root
 * @param {import('../parser.mjs').Gate[]} gates - Loaded gates
 * @param {number|{maxDepth?: number, onSkip?: (dir: string, depth: number) => void}} [options]
 *   maxDepth defaults to 10. onSkip is called once for each directory skipped
 *   because it exceeds the depth limit.
 */
export async function collectFiles(root, gates, options = {}) {
  const opts = typeof options === 'number'
    ? { maxDepth: options }
    : { maxDepth: 10, ...options };
  const maxDepth = opts.maxDepth;
  const onSkip = opts.onSkip;
  const files = [];
  const ignored = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'coverage', '.next', '.gateinitiative']);

  async function walk(dir, depth) {
    if (depth > maxDepth) {
      if (onSkip) onSkip(dir, depth);
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;

      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const rel = relative(root, fullPath).replace(/\\/g, '/');
        // Check if any gate applies to this file (trigger matches, not excluded)
        const applies = gates.some(g =>
          globToRegex(g.trigger).test(rel) && !matchesExclude(rel, g.exclude)
        );
        if (applies) files.push(fullPath);
      }
    }
  }

  await walk(root, 0);
  return files;
}

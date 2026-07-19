/**
 * gateinitiative: Filesystem Watcher
 *
 * Watches the project directory for file changes using chokidar.
 * Triggers gate evaluation on change events.
 * Manages debouncing and event coalescing.
 *
 * chokidar v4 removed glob support entirely, so this module watches the
 * project root and does its own glob matching: ignore patterns via a
 * function-based `ignored` (which also prunes directory traversal), and
 * include patterns as a filter in the event handler.
 */

import { resolve, relative } from 'node:path';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { globToRegex } from './evaluator.mjs';

/**
 * @typedef {Object} WatcherConfig
 * @property {string} root - Project root to watch
 * @property {string[]} [include] - Glob patterns to include (default: all)
 * @property {string[]} [ignore] - Glob patterns to ignore
 * @property {number} [stabilityThreshold] - ms to wait for file to stabilize (default: 200)
 * @property {number} [pollInterval] - ms for polling (network drives, default: null = no polling)
 */

/** Default ignore patterns (things that should never trigger gates) */
const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.cache/**',
  '**/tmp/**',
  '**/*.log',
  '**/.DS_Store',
  '**/Thumbs.db',
  // gateINITIATIVE's own runtime dir (shadow store, logs, context.json)
  '**/.gateinitiative/**',
];

/**
 * Build a chokidar v4 `ignored` function from glob patterns.
 * Directories are tested with a trailing slash so patterns like
 * `**\/node_modules/**` prune the whole subtree instead of matching
 * nothing at the directory level.
 * @param {string} root - Absolute project root
 * @param {string[]} ignoreGlobs
 * @returns {(path: string, stats?: import('node:fs').Stats) => boolean}
 */
export function buildIgnoredFn(root, ignoreGlobs) {
  const matchers = ignoreGlobs.map(g => globToRegex(g));

  return (path, stats) => {
    const rel = relative(root, resolve(path)).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) return false;

    // stats may be undefined or lack isFile — test both forms when not a file
    const isFile = typeof stats?.isFile === 'function' && stats.isFile();
    const candidates = isFile ? [rel] : [rel, rel + '/'];

    return matchers.some(rx => candidates.some(c => rx.test(c)));
  };
}

/**
 * Create and start a file watcher
 * @param {WatcherConfig} config
 * @param {(filePath: string, event: string) => void} onFileChange - Callback for file changes
 * @param {(error: Error) => void} [onError] - Callback for watcher errors
 * @returns {Promise<import('chokidar').FSWatcher>}
 */
export async function createWatcher(config, onFileChange, onError) {
  // Dynamic import — keeps cold-start cheap for non-watch commands
  const { watch } = await import('chokidar');

  const root = resolve(config.root);
  const ignoreGlobs = [...DEFAULT_IGNORE, ...(config.ignore || [])];
  const includeMatchers = config.include && config.include.length > 0
    ? config.include.map(g => globToRegex(g))
    : null;

  const watcher = watch(root, {
    ignored: buildIgnoredFn(root, ignoreGlobs),
    persistent: true,
    ignoreInitial: true,
    // Wait for writes to finish (handles editors that write temp + rename)
    awaitWriteFinish: {
      stabilityThreshold: config.stabilityThreshold || 200,
      pollInterval: 50,
    },
    // Don't follow symlinks into node_modules etc.
    followSymlinks: false,
    // Use polling only if explicitly requested (for network drives)
    ...(config.pollInterval ? { usePolling: true, interval: config.pollInterval } : {}),
  });

  const emit = (filePath, event) => {
    const abs = resolve(filePath);
    if (includeMatchers) {
      const rel = relative(root, abs).replace(/\\/g, '/');
      if (!includeMatchers.some(rx => rx.test(rel))) return;
    }
    onFileChange(abs, event);
  };

  watcher.on('change', (filePath) => emit(filePath, 'change'));
  watcher.on('add', (filePath) => emit(filePath, 'add'));
  watcher.on('unlink', (filePath) => emit(filePath, 'unlink'));

  if (onError) {
    watcher.on('error', (err) => onError(err));
  }

  // Wait for initial scan to complete
  await new Promise((res) => watcher.on('ready', res));

  return watcher;
}

/**
 * Get the default watcher config from project root
 * Looks for .gateinitiative.yml or .gateinitiativerc or gateinitiative.config.yml
 * Falls back to sensible defaults
 * @param {string} projectRoot
 * @returns {Promise<WatcherConfig>}
 */
export async function getWatcherConfig(projectRoot) {
  const configFiles = [
    '.gateinitiative.yml',
    '.gateinitiativerc',
    'gateinitiative.config.yml',
  ];

  for (const configFile of configFiles) {
    try {
      const content = await readFile(join(projectRoot, configFile), 'utf-8');
      const parsed = parseYaml(content);
      if (parsed && typeof parsed === 'object') {
        return { root: projectRoot, ...parsed };
      }
    } catch { /* not found or unparseable, try next */ }
  }

  // Default config
  return {
    root: projectRoot,
    include: ['**/*.{ts,tsx,js,jsx,mjs,cjs,json,yml,yaml,env,md}'],
    ignore: [],
    stabilityThreshold: 200,
  };
}

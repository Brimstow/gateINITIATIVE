/**
 * gateinitiative: Unified Configuration Loader
 *
 * Loads `.gateinitiative.yml` (and legacy names) and merges it with CLI overrides.
 * Precedence: CLI flag > config file > default.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseYamlDocuments } from './parser.mjs';
import { DEFAULT_ROUTES } from './notify.mjs';

export const VALID_MODES = ['strict', 'warn', 'audit'];

const DEFAULTS = {
  version: 1,
  mode: 'warn',
  watcher: {
    include: ['**/*.{ts,tsx,js,jsx,mjs,cjs,json,yml,yaml,env,md}'],
    ignore: [],
    stabilityThreshold: 200,
  },
  context: {
    enforce: false,
    enforceAll: false,
  },
  bridge: {
    targets: ['zed', 'void', 'cursor'],
    maxDocs: 2,
    maxDocChars: 2000,
    includeState: true,
  },
  notifications: {
    toast: true,
    promptTimeout: 30,
    routes: { ...DEFAULT_ROUTES },
  },
  enforcement: {
    startupScan: true,
    maxFileBytes: 1_048_576,
    scanMaxDepth: 10,
    pruneAgeDays: 30,
    escalation: {
      threshold: 3,
      windowMinutes: 10,
    },
  },
  shadow: {
    dir: null, // null = use platform data dir
  },
};

const CONFIG_FILES = [
  '.gateinitiative.yml',
  '.gateinitiativerc',
  'gateinitiative.config.yml',
];

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal === undefined) continue;
    if (srcVal !== null && typeof srcVal === 'object' && !Array.isArray(srcVal)) {
      result[key] = deepMerge(result[key] || {}, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * Load and normalize gateinitiative configuration.
 * @param {string} projectRoot
 * @param {Object} [overrides] — CLI overrides, e.g. { mode: 'strict', shadowDir: '...' }
 * @returns {Promise<Object>}
 */
export async function loadConfig(projectRoot, overrides = {}, onWarn = () => {}) {
  let fileConfig = {};

  for (const file of CONFIG_FILES) {
    try {
      const content = await readFile(join(projectRoot, file), 'utf-8');
      const docs = parseYamlDocuments(content, file);
      const parsed = docs.find(doc => doc && typeof doc === 'object' && Object.keys(doc).some(k => k !== 'version'));
      if (parsed) {
        if (parsed.version != null && parsed.version !== DEFAULTS.version) {
          onWarn(`${file}: unsupported config version ${parsed.version}; expected ${DEFAULTS.version}`);
        }
        fileConfig = parsed;
        break;
      }
    } catch { /* not found or unparseable, try next */ }
  }

  let config = deepMerge(DEFAULTS, fileConfig);

  // CLI overrides take precedence
  if (overrides.mode) config.mode = overrides.mode;
  if (overrides.shadowDir !== undefined) config.shadow.dir = overrides.shadowDir;
  if (overrides.maxFileBytes !== undefined) config.enforcement.maxFileBytes = overrides.maxFileBytes;
  if (overrides.startupScan !== undefined) config.enforcement.startupScan = overrides.startupScan;
  if (overrides.toast !== undefined) config.notifications.toast = overrides.toast;

  // Fail hard on an invalid mode: a typo like "strcit" must never silently
  // downgrade enforcement to the non-reverting default.
  if (!VALID_MODES.includes(config.mode)) {
    throw new Error(
      `Invalid enforcement mode "${config.mode}" — valid modes: ${VALID_MODES.join(', ')}. ` +
      `Check the "mode" key in your gateinitiative config file.`
    );
  }

  // Resolve shadow dir override to absolute path if provided
  if (config.shadow.dir) {
    config.shadow.dir = resolve(config.shadow.dir);
  }

  return config;
}

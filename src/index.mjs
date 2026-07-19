/**
 * gateinitiative: Main Module
 *
 * Exports the public API and provides the orchestration layer
 * that connects parser → evaluator → watcher → enforcer → context → daemon.
 */

export { loadProjectGates, extractGates, parseGateBlock, extractGatesFromYaml, parseYamlDocuments } from './parser.mjs';
export {
  evaluateFile, evaluateFiles, evaluateContent, applicableGates,
  globToRegex, matchesTrigger, matchesExclude, compilePattern, readFileGuarded,
} from './evaluator.mjs';
export { SafeEvaluator, DEFAULT_GATE_TIMEOUT_MS } from './safe-eval.mjs';
export { createWatcher, getWatcherConfig, buildIgnoredFn } from './watcher.mjs';
export { Enforcer, ShadowStore, ViolationLogger, printSummary } from './enforcer.mjs';
export { ContextDetector, loadContextRules, getDefaultContextRules, extractContextRules, enforceContextSignals } from './context-detector.mjs';
export { Pipeline } from './pipeline.mjs';
export { PlaybookEnforcer, loadPlaybooks, findApplicablePlaybook, checkPrerequisites, parsePlaybook } from './playbook.mjs';
export { PlaybookBridge, buildRulesContent, writeRulesToIDEs } from './playbook-bridge.mjs';
export {
  writePid, readPid, removePid, isProcessAlive,
  writeMeta, readMeta, removeMeta,
  getRuntimeDir, ensureRuntimeDir, rotateLog,
  getLogPath, getLogSize, formatUptime, spawnDaemon, waitForDeath,
  PID_FILE, META_FILE, LOG_FILE, LOG_MAX_BYTES,
} from './daemon.mjs';

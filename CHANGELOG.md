# Changelog

All notable changes to gateINITIATIVE are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [1.0.0] — 2026-07-19

> **Launch rebrand.** Project repositions as **gateINITIATIVE** — *the gate initiative for AI-driven development*. Pre-publication relaunch: zero installed users, hard cutover, no migration shim.

### Changed
- **Identity.** Project, package, binary, docs, and CLI surface renamed from `gate-keeper` to `gateINITIATIVE`. The CLI binary is `gateinit` (`npm install -g gateinitiative`; run as `gateinit watch`, `gateinit check`, etc.).
- **Package name.** `gate-keeper` (npm) → `gateinitiative`. New name is verified clean on npm and on GitHub (org + repo).
- **Repository URLs.** `github.com/gate-keeper/gate-keeper` → `github.com/gateinitiative/gateinitiative`.
- **Config filenames.** `.gate-keeper.yml` → `.gateinitiative.yml`. Legacy alt configs (`.gatekeeperrc`, `gate-keeper.config.yml`) renamed to `.gateinitiativerc` and `gateinitiative.config.yml`.
- **Runtime data dir.** Platform-specific external state dir renamed from `gate-keeper` to `gateinitiative`:
  - Windows: `%LOCALAPPDATA%\gateinitiative`
  - macOS: `~/Library/Application Support/gateinitiative`
  - Linux: `~/.local/share/gateinitiative`
- **Internal identifiers.** JSDoc, comments, internal var names, command strings, log lines, and bridge-output headers were uniformly ported to the new brand.
- **Version bump.** 0.3.1 → 1.0.0. The rebrand is the launch moment.

### Migration
- Hard cutover. No shim, no deprecation bridge, no compat layer. Project has never been published; there are no installed users to migrate.
- Existing local state (if any) under the platform-specific `gate-keeper` data dir will be ignored on next run. To reset, delete the legacy directory manually.
- The `bin/` entry point is renamed: `bin/gate-keeper.mjs` → `bin/gateinit.mjs`. CLI scripts in `package.json` and any external wrappers must use the new path.

### Notes
- The name "gate" is generic English and not protectable; the prior composite mark "GATEKEEPER" (held in unrelated verticals) was a soft conflict we did not want to take into a commercial phase. The coined compound `gateINITIATIVE` is a unitary mark, cleaner for both trademark and positioning.
- The product positioning line is *the gate initiative for AI-driven development* — i.e. an architectural shift, not just another lint tool. The CLI leans into that voice without baking the AI buzzword into the wordmark.

## [0.3.1] — 2026-07-18

Security-focused release. All four publication blockers from the pre-release audit are fixed, each with regression tests.

### Security
- **Override enforcement bypass (high):** an active override for one gate could suppress the revert for *all* other block gates on the same file — including `overridable: false` gates. Overrides are now strictly gate-scoped: every block violation is checked individually and a single unoverridden violation triggers enforcement.
- **Shadow verification fails closed:** a missing or corrupt shadow manifest (or a missing per-file entry) previously allowed unverified shadow copies to be restored. `revert()` and `restoreDeleted()` now treat absent integrity metadata as tamper — the file is routed to the tamper/quarantine path with a critical health event.
- **Quarantine path traversal:** `quarantine show|restore|delete <id>` resolved the id directly against the quarantine root, so `..`-style ids could read, overwrite, or recursively delete paths outside it. Ids are now validated as numeric timestamps and containment-checked.
- **Invalid mode fails loudly:** a config-file typo like `mode: strcit` silently degraded to non-reverting `warn` mode. `loadConfig` now rejects invalid modes; the CLI reports the error and exits 1.

### Fixed
- Bridge doc truncation: `watch` passed the nonexistent `config.bridge.maxChars` (undefined), which disabled truncation and inlined entire documents into IDE rules files. Fixed the key and hardened `PlaybookBridge` so `undefined` options can never clobber defaults.
- `--register` boot-persistence instructions on Windows/macOS omitted the `start` argument.
- Daemon exiting early (e.g. no gates found) left a stale PID file behind.
- `evaluateFile` now normalizes path separators on Windows (`src/a.ts`, not `src\a.ts`).

### Added
- `check` and the daemon startup scan now run through the worker-thread evaluator (`evaluateFilesSafe`): a ReDoS pattern can no longer stall CI or daemon startup. `check` exits 1 if any gate had to be disabled mid-scan.
- `start`/`restart` now wait for daemon readiness: if the child dies during boot the CLI reports failure with a log tail and exits 1 instead of claiming success (`waitForDaemonReady`, `tailLog`).
- npm packaging hygiene: `files` allowlist (ships `bin/` + `src/` minus tests), `exports` map.
- CI triggers on `main` and `master`.

## [0.3.0] — 2026-07-18

### Added
- **ReDoS hardening (defense in depth):**
  - Load-time structural detection of catastrophic-backtracking patterns (`looksUnsafeRegex` now catches nested quantifiers at any depth, escapes, character classes, open-ended and large bounded repeats, and lazy variants).
  - `SafeEvaluator`: the watch pipeline executes gate regexes in a worker thread with a per-gate execution timeout (default 500ms). A runaway pattern is terminated, the gate is disabled for the session (reported via health + log), and remaining gates still evaluate. Configurable via `evalTimeoutMs` (0 disables the sandbox).
- Dedicated test suites for daemon lifecycle (`daemon.test.mjs`) and HMAC-signed playbook state (`playbook-state.test.mjs`).
- `SafeEvaluator` unit tests including a live catastrophic-backtracking termination case.
- MIT `LICENSE` file, CI workflow (test matrix: Ubuntu/Windows/macOS × Node 22/24), this changelog.

### Changed
- `Pipeline` gains a `dispose()` method (terminates the evaluation worker); called on daemon shutdown.
- PRD updated: Phase 0 (Enforcement Hardening) marked shipped; current-state section reflects v0.3.0 (218 tests).
- **CLI restructured**: the 68KB `bin/gateinit.mjs` monolith is now a ~50-line dispatcher; every command lives in its own module under `src/cli/` and is lazy-loaded (fast startup for `status`/`stop`).

### Fixed
- `gateinit init` crashed with a `ReferenceError` — `existsSync` was used without being imported.

## [0.2.0]

Enforcement hardening (previously tracked as roadmap Phase 0, shipped incrementally):
- Enforcement integrity: shadow-update ordering, content-hash revert suppression, delete handling, atomic revert, quarantine for un-revertable files.
- Tamper resistance: external shadow store in platform data dir keyed by project hash, gate-file trust fingerprints (SHA-256), baseline validation, watcher/trigger coverage check.
- Agent feedback loop: gates + recent violations surfaced in bridged rules files.
- Health monitoring and setup diagnostics.
- HMAC-signed playbook state with secret stored outside the project tree.
- Consent-based onboarding with dry-run; scoped review/override decisions.

## [0.1.0]

Initial release: gate parsing (markdown ` ```gate ` blocks + `.gates.yml`), regex pattern/antipattern evaluation, glob triggers, chokidar v4 watcher, shadow-copy revert, per-file event serialization, context detection, playbook prerequisites, IDE rules bridge, daemon lifecycle (start/stop/restart/status), cross-platform paths.

# gateINITIATIVE

Standalone filesystem-watcher enforcement daemon.  
**IDE-agnostic. VCS-agnostic. CLI-agnostic.**

## What It Does

Watches your project files for changes and evaluates them against rules ("gates") defined in your existing markdown documentation or a `.gates.yml` file. When a violation is detected, it alerts, logs, or reverts. It also detects which documentation is relevant to the file you're editing and can push a lean, focus-specific rules file to your IDE (Zed, Cursor, Void).

## Quick Start

```bash
bun install

# Discover your project and generate gates/profile (interactive, non-destructive)
bun bin/gateinit.mjs onboard --dry-run

# Create starter gates
bun bin/gateinit.mjs init

# List loaded gates
bun bin/gateinit.mjs list

# Review and trust the current gate sources before strict enforcement
bun bin/gateinit.mjs trust

# One-shot check (CI/automation)
bun bin/gateinit.mjs check

# Real-time watch (foreground, for debugging)
bun bin/gateinit.mjs watch

# Start as a background daemon
bun bin/gateinit.mjs start --mode strict
bun bin/gateinit.mjs status
bun bin/gateinit.mjs stop
```

> **Node.js also works:** Replace `bun` with `node` and `bun install` with `npm install` in the commands above. The codebase is fully Node-compatible (Node >= 22.0.0).

## How It Works

```
File saved (any editor/tool/script)
        │
        ▼
[Filesystem Event] ──→ chokidar detects change
        │
        ▼
[Pipeline] ──→ read once → gate evaluation → enforcement
        │           → playbook prerequisite check
        │           → context detection (which docs to load)
        │
    ┌───┴───┐
    │       │
  PASS    FAIL
    │       │
    ▼       ▼
 Update   Enforce (alert / revert / log)
 shadow    + suppress the revert's own write event
```

## Commands

| Command | Description |
|---------|-------------|
| `start` | Start as a background daemon (writes PID file) |
| `stop` | Stop the running daemon |
| `restart` | Stop + start |
| `status` | Show daemon status (PID, uptime, mode, log size) |
| `watch` | Foreground watcher (for debugging) |
| `check` | One-shot evaluation (exits 1 on warn/block violations) |
| `list` | Show all loaded gates and their trigger patterns |
| `context` | Show context recommendations for a file, or list all rules |
| `init` | Create a starter `.gates.yml` with example gates (refuses to overwrite) |
| `trust` | Trust the current gate-source fingerprints for block enforcement |
| `onboard` | Scan project + instruction files, generate gates/profile/rules non-destructively |
| `bridge` | Generate lean IDE rules from context signals (Zed/Cursor/Void) |
| `doctor` | Self-diagnose config, gates, playbooks, and data directories |
| `clean` | List/remove orphaned external data directories |
| `review` | Inspect/approve/delete pending enforcement decisions (overrides) |
| `quarantine` | Inspect or restore files quarantined by strict mode |

## Enforcement Modes

| Mode | Block Severity | Warn Severity | Info Severity |
|------|---------------|---------------|---------------|
| `strict` | Revert + alert | Alert | Silent log |
| `warn` (default) | Alert (no revert) | Alert | Silent log |
| `audit` | Silent log | Silent log | Silent log |

In `strict` mode, shadow baselines are seeded on startup so the very first violation can be reverted. Revert-induced write events are suppressed to avoid feedback loops.

Shadow baselines, quarantine, and playbook-state secrets are stored in a platform-specific data directory outside the project tree (e.g. `%LOCALAPPDATA%\gateinitiative` on Windows, `~/Library/Application Support/gateinitiative` on macOS, `~/.local/share/gateinitiative` on Linux), keyed by a hash of the project root. This prevents agents inside the project from tampering with enforcement state.

## Gate Trust

Before block-severity gates can enforce in `watch` or `start --mode strict`, review the active gate sources and run `gateinit trust`. The command stores SHA-256 fingerprints outside the project tree. Until trusted, all loaded gates run warn-only.

Any changed, added, or removed gate source automatically revokes trust. To intentionally change a trusted source while strict enforcement is active, stop the watcher or daemon first, edit and review the policy, run `gateinit trust`, then restart it. Otherwise self-protection reverts the change. Once trusted, strict mode also protects gate sources and supported gateINITIATIVE configuration files from modification or deletion with non-overridable enforcement.

## Configuration

Optional `.gateinitiative.yml` in the project root. CLI flags override config values.

```yaml
version: 1
mode: warn
watcher:
  include: ['**/*.{ts,tsx,js,jsx,mjs,cjs,json,yml,yaml,env,md}']
  ignore: []
  stabilityThreshold: 200
enforcement:
  startupScan: true
  maxFileBytes: 1048576
  pruneAgeDays: 30
shadow:
  dir: null  # null uses platform default; set to override
```

## Gate Definition Format

Gates can live in three places (checked in order):

1. `docs/agents/*.md` — embedded ` ```gate ` blocks
2. `.gates/` directory — dedicated gate files (any `.yml`/`.yaml`)
3. `.gates.yml` — project root

Definitions in `.gates.yml` override earlier sources when the same `id` is used.

### Gate Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier |
| `trigger` | Yes | Glob pattern — which files this gate applies to |
| `severity` | Yes | `block` / `warn` / `info` |
| `pattern` | One of | Regex — violation if FOUND (detect bad things) |
| `antipattern` | these | Regex — violation if NOT found (require good things) |
| `message` | Yes | Human-readable explanation |
| `exclude` | No | Glob patterns to skip |
| `overridable` | No | `true`/`false` — whether `gateinit review approve` may allow the violation (default `true`) |

Invalid gates (missing fields, bad regex) are reported at load time instead of being silently dropped.

## Review Decisions & Overrides

Block-severity gates that cannot be reverted (no shadow, quarantine, or shadow manifest mismatch) create a pending review decision in the external data directory. A human can approve a scoped override:

```bash
# List pending and active overrides
gateinit review list

# Approve a one-time override for decision <id>
gateinit review approve <id>

# Approve for the current daemon session
gateinit review approve <id> --session

# Approve for N hours
gateinit review approve <id> --for 4

# Delete a decision or clear all
gateinit review delete <id>
gateinit review clear
```

`overridable: false` on a gate (e.g. the onboarded secrets detector) rejects any override and always reverts/quarantines.

## Playbooks

Playbooks verify that prerequisite steps were completed *before* allowing edits to governed files. Define them in `.playbooks/*.yaml`:

```yaml
name: edit-security-file
trigger: "src/middleware/**/*.ts"
prerequisites:
  - id: tests-passed
    evidence:
      file_fresh: "coverage/lcov.info"
      state_key: "tests:auth"
    ttl: 300
    message: "Run tests before editing"
    severity: block
on_violation:
  severity: block
```

Playbooks don't execute steps — they verify steps happened (via fresh filesystem evidence or `playbook-state.json`).

## Context Detection

gateINITIATIVE watches file changes and recommends which documentation to load based on file path patterns and content keywords. Default rules activate only when their target doc exists in your project. Custom rules can be embedded in `docs/agents/*.md` via ` ```context ` blocks.

Signals are written to `.gateinitiative/context.json` for external consumers, and the `bridge` command turns them into lean IDE rules files.

## Bridge (IDE Rules Generation)

```bash
# One-shot: generate .rules / .voidrules / .cursor/rules/*.mdc
bun bin/gateinit.mjs bridge --once

# Watch mode: regenerate whenever context.json changes
bun bin/gateinit.mjs bridge
```

The bridge only overwrites rules files it previously generated (marked with a header comment). Hand-written `.rules` files are never clobbered.

## Onboarding

For a detailed walkthrough of the consent-based, non-destructive onboarding
flow, see [`docs/ONBOARDING.md`](docs/ONBOARDING.md).

## Architecture

- **IDE-agnostic** — watches the filesystem directly
- **VCS-agnostic** — uses shadow copies, not git
- **Cross-platform** — Windows, macOS, Linux (case-sensitive globs on Linux)
- **~60ms response time** — detect → evaluate → enforce
- **Composable** — exit codes work with any automation tool

### Module Layout

| Module | Responsibility |
|--------|---------------|
| `parser.mjs` | Gate definitions from markdown + YAML (via `yaml` package) |
| `evaluator.mjs` | Glob matching, regex evaluation, violation detection |
| `watcher.mjs` | chokidar v4 filesystem watcher (function-based ignore) |
| `enforcer.mjs` | Shadow store, violation logging, terminal output |
| `context-detector.mjs` | Context load detection |
| `playbook.mjs` | Playbook prerequisite verification |
| `playbook-bridge.mjs` | Lean IDE rules generation |
| `pipeline.mjs` | Watch event orchestrator (per-file serialization) |
| `daemon.mjs` | Daemon lifecycle (PID, metadata, log rotation) |
| `notify.mjs` | OS toast notifications + routing matrix for critical events |
| `index.mjs` | Public API exports |

## Notifications & Routing

Critical events can trigger OS toasts (Windows balloon tip / macOS notification / Linux `notify-send`). When running `watch` in an attached terminal, revert failures also show a foreground `[q]uarantine / [o]verride / [i]gnore` prompt that defaults to the safe action after the configured timeout.

```yaml
# .gateinitiative.yml
notifications:
  toast: true
  promptTimeout: 30
  routes:
    info:   [log]
    warn:   [terminal, bridge]
    block:  [terminal, toast, queue]
    health: [terminal, toast, queue]
```

Disable toasts per invocation with `--no-toast`.

To survive reboots, run `gateinit start --register`. It prints platform-specific instructions (Windows Task Scheduler, macOS `launchctl` LaunchAgent, or Linux systemd user unit) and then starts the daemon.

## Troubleshooting

| Health event | What it means | Fix |
|---|---|---|
| `revert_failed` | Strict mode could not restore a file from shadow | Check permissions/disk space; run `gateinit review` |
| `tamper_suspected` | Shadow manifest fingerprint does not match | Investigate external changes to the shadow data dir |
| `quarantine_failed` | A block-violating file could not be moved out of the project | Check permissions; manually remove the violating file |
| `watcher_error` | The filesystem watcher died (OS limit, permissions) | Restart gateINITIATIVE; increase inotify limit on Linux |
| `context_write_failed` | `.gateinitiative/context.json` could not be written | Verify `.gateinitiative/` is writable |
| `gate_load_error` | `.gates.yml` or gate blocks have syntax/regex errors | Run `gateinit doctor` |
| `daemon_crash` | The daemon exited unexpectedly | Review the daemon log and recent health events |
| `notify_failed` | OS toast could not be shown | The event was still logged and enforced; ignore or disable toasts |

## Dependencies

- `chokidar` ^4.0.0 — filesystem watcher (zero native deps)
- `yaml` ^2.9.0 — spec-compliant YAML parser (zero transitive deps)

## Requirements

- **Bun** >= 1.3.5 (recommended) — used as the package manager and test runner
- **Node.js** >= 22.0.0 (compatible alternative — the codebase runs under either runtime)

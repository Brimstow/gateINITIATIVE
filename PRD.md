# Product Requirements Document: gateINITIATIVE

**Version:** 0.3.1  
**Status:** Hardening Complete — pre-publication  
**Last Updated:** 2026-07-18

---

## 1. Product Overview

### 1.1 Vision
gateINITIATIVE is a standalone filesystem-watcher enforcement daemon that ensures code quality and security rules are enforced in real-time, regardless of which IDE, VCS, or CLI tool developers use. Where hook-based guardrails police agent *actions* (and can be routed around), gateINITIATIVE polices *outcomes* — the actual state of files on disk — so it catches violations no matter which tool, subagent, or human produced them. It is the only tool that combines outcome-level deterministic enforcement with intelligent context detection — recommending which documentation to load based on developer activity.

### 1.2 Problem Statement
Modern development teams face three interconnected problems:
1. **Rules drift from documentation** — Style guides and security policies exist as markdown but are never enforced automatically
2. **Tool lock-in** — Existing enforcement tools require specific IDEs (VS Code), VCS (git), or AI services (OpenAI API keys)
3. **AI assistants lack context** — AI coding tools don't know which project documentation is relevant to the file being edited

### 1.3 Solution
A lightweight (two deps: chokidar, yaml) Node.js daemon that:
- Watches the filesystem for changes
- Evaluates files against rules embedded in existing documentation
- Enforces violations through alerts, logging, or shadow-copy reverts
- Verifies playbook prerequisites before allowing edits to governed files
- Recommends which docs to load based on file activity patterns (novel, no competitor offers this)
- Bridges context signals into lean IDE rules files (Zed, Cursor, Void)

---

## 2. Target Users

| Persona | Pain Point | gateINITIATIVE Value |
|---------|-----------|-------------------|
| **Solo developer** | Wants guardrails without complex tooling | `npx gateinit init && npx gateinit watch` — running in 30 seconds |
| **Team lead** | Needs to enforce standards across the team | Gates embedded in docs mean standards are always current |
| **Security engineer** | Must prevent secrets/vulnerabilities in code | Block-severity gates with shadow-copy revert |
| **AI-augmented developer** | AI assistant writes code without project context | Context detection tells the AI which docs to read first |
| **Compliance officer** | Needs audit trail for code quality enforcement | Audit mode logs every violation with timestamps |

---

## 3. Competitive Landscape

The 2025–2026 wave of agent-guardrail tools is **hook-based**: they intercept agent tool calls pre-execution via harness hooks (Claude Code, Cursor, etc.).

| Competitor | Approach | Key Limitation |
|-----------|----------|---------------|
| **Cupcake** (EQTY Lab) | OPA/Rego policies compiled to Wasm; hook-based allow/modify/block/review verdicts | Requires harness hook support; tool-call level only — blind to subagents, pipe mode, non-hook tools |
| **Nixis** | Tool-call firewall; CEL policies, IFC, hash-chained audit | Hook-based; Claude Code-centric; no context signals |
| **agentjail** | OPA hooks + optional kernel sandbox; locked self-protection rules | Hook-based; macOS/Linux only (no Windows); no code-quality rules |
| **rea** | Shell-hook policy gates (secret scan, protected paths, review gates) | Claude Code-specific; bash tooling; no daemon/context |
| **Spectral** (Stoplight) | YAML-based API linting | One-shot only, no daemon mode, no context |
| **Codacy/Cycode** | Cloud-based code scanning | SaaS lock-in, requires signup, no local-first |

**The structural gap in hook-based enforcement** (documented across 190+ filed issues): subagent tool calls bypass hooks entirely, pipe/bare modes skip all hooks, MCP tool denials are ignored, and models route around blocked tools (block `Write` → Bash heredoc). Community consensus: *controls inside the agent process can be navigated; controls outside the process hold.* gateINITIATIVE runs outside the agent process — it evaluates resulting file state, so every one of those bypasses is still caught. Positioning: **the outcome-level backstop that composes with hook tools**, not a replacement for them.

### 3.1 Unique Differentiators (No Competitor Has These)
1. **Outcome-Level Enforcement** — Evaluates file state, not tool calls; immune to hook bypasses (subagents, pipe mode, heredoc route-arounds) and covers human edits too
2. **Context Detection** — Recommends which docs/agents files to load based on file activity
3. **Gates in Documentation** — Rules live inside your markdown docs (never stale)
4. **Shadow-copy Revert** — Enforcement without git dependency
5. **Zero AI Requirement** — Deterministic regex, works air-gapped
6. **Universal Trigger** — Filesystem events work with ANY tool chain, harness support not required

### 3.2 Acknowledged Trade-off
Hook tools enforce *pre-execution* (violations never touch disk); gateINITIATIVE enforces *post-write* (a violation exists on disk for milliseconds before revert). Mitigations: atomic revert, quarantine for un-revertable files, and MCP pre-write validation for cooperating agents (roadmap). The trade buys harness independence and bypass immunity.

---

## 4. Architecture

### 4.1 Pipeline
```
parser → evaluator → watcher → pipeline → enforcer → context-detector
                                        ↘ playbook → playbook-bridge → IDE rules
```

### 4.2 Module Breakdown

| Module | Responsibility |
|--------|---------------|
| `parser.mjs` | Gate definitions from markdown + YAML (via `yaml` package) |
| `evaluator.mjs` | Glob matching, regex evaluation, violation detection, file-size/binary guards |
| `watcher.mjs` | chokidar v4 filesystem watcher (function-based ignore, include filtering) |
| `enforcer.mjs` | Shadow store, violation logging, terminal output, shadow pruning |
| `context-detector.mjs` | Context load detection + enforcement against playbook-state |
| `playbook.mjs` | Playbook prerequisite verification (filesystem + state evidence) |
| `playbook-bridge.mjs` | Lean IDE rules generation (Zed `.rules`, Void, Cursor) |
| `pipeline.mjs` | Watch event orchestrator (per-file serialization, revert suppression) |
| `daemon.mjs` | Daemon lifecycle (PID, metadata, log rotation, process management) |
| `index.mjs` | Public API exports |
| `bin/gateinit.mjs` | CLI entry point |

### 4.3 Data Flow
```
File Change Event (chokidar)
    │
    ▼
[Pipeline] (per-file serialized)
    ├──→ Gate Evaluation (regex pattern matching)
    │       │
    │       ├── PASS → Update shadow copy (known-good state)
    │       └── FAIL → Enforce (alert/revert/log by severity)
    │                   + suppress the revert's own write event
    │
    ├──→ Playbook Verification (prerequisite evidence check)
    │       └── FAIL → Report missing prerequisites
    │
    └──→ Context Detection (parallel, independent)
            └── Signal → Terminal + .gateinitiative/context.json
                         → Bridge → IDE rules file
```

### 4.4 Gate Definition Sources (Priority Order)
1. `docs/agents/*.md` — Embedded ` ```gate ` blocks
2. `.gates/` directory — Dedicated gate files (any `.yml`/`.yaml`)
3. `.gates.yml` — Project root config

Invalid gates (missing fields, bad regex, duplicate IDs) are reported at load time via diagnostics instead of being silently dropped.

### 4.5 Enforcement Modes
| Mode | Block Severity | Warn Severity | Info Severity |
|------|---------------|---------------|---------------|
| `strict` | Revert + alert | Alert | Silent log |
| `warn` | Alert (no revert) | Alert | Silent log |
| `audit` | Silent log | Silent log | Silent log |

---

## 5. Current State (v0.3.0)

### 5.1 What Works
- Gate parsing from markdown (```gate blocks) and .gates.yml (via `yaml` package)
- Regex-based pattern and antipattern evaluation with compiled-regex caching
- Glob-to-regex file matching (**, *, ?, {a,b}, [abc]) with platform-aware case sensitivity
- Real-time filesystem watching with chokidar v4 (function-based ignore, include filtering)
- Shadow-copy revert for block-severity violations (baselines seeded on startup)
- Per-file event serialization and revert-feedback-loop suppression (pipeline.mjs)
- Violation logging (JSONL format) with daemon-aware ANSI/timestamp handling
- Context detection with 12 default rules (filtered to existing docs) + custom rules
- Context enforcement against playbook-state.json
- Playbook prerequisite verification (filesystem + state evidence)
- Playbook bridge: lean IDE rules generation for Zed (.rules), Void, Cursor
- Daemon lifecycle: start/stop/restart/status with PID management and log rotation
- CLI: watch, check, context, init, list, bridge, start, stop, restart, status
- File-size guard (1MB default) and binary detection (NUL-byte heuristic)
- Bounded concurrency in batch evaluation (avoids EMFILE on large repos)
- Cross-platform (Windows CRLF handling verified)
- ReDoS defense in depth: load-time structural detection of catastrophic patterns (nested quantifiers at any depth) plus worker-thread execution with a per-gate timeout — a runaway regex is terminated, the gate disabled for the session, and remaining gates still evaluate
- HMAC-signed playbook state (secret stored outside the project tree) so agents cannot forge prerequisite evidence
- Security-hardened enforcement (v0.3.1): gate-scoped overrides (one override can never bypass another gate), fail-closed shadow verification (missing integrity metadata = tamper), quarantine id validation (no path traversal), and hard-fail config mode validation
- Daemon start/restart confirm readiness and report boot failures with a log tail
- 240 passing unit tests across parser, evaluator, safe-eval, enforcer, context-detector, watcher, pipeline, playbook, playbook-state, daemon, trust, decisions, config, CLI security, health

### 5.2 Known Limitations
- Regex-only analysis (no AST/structural awareness)
- No auto-fix capability (detect + revert, but no suggested fixes)
- ReDoS exposure (mitigated): suspicious patterns are flagged at load time, and the watch pipeline, `check`, and the daemon startup scan all execute gate regexes in a worker thread with a per-gate timeout (default 500ms) — a pathological pattern is disabled for the session instead of stalling the daemon or CI. Baseline seeding and gate fixture tests still evaluate in-process (bounded by the file-size guard).
- No team/remote synchronization
- No plugin system for custom analyzers
- Context rules are pattern-based only (no semantic understanding)
- Shadow store grows with usage (pruned on watch startup in strict mode; 30-day default)

---

## 6. Roadmap

### Phase 0: Enforcement Hardening — SHIPPED (v0.3.0)
| Feature | Priority | Status |
|---------|----------|--------|
| Enforcement integrity fixes | P0 | Shipped — shadow-update ordering, content-hash revert suppression, delete handling, atomic revert, quarantine for un-revertable files |
| Tamper resistance | P0 | Shipped — external shadow store (platform data dir), gate-file trust fingerprints, baseline validation, watcher/trigger coverage check |
| Agent feedback loop | P0 | Shipped — gates + recent violations surfaced in bridged rules files; fail-open visibility |
| `gateinit doctor` | P0 | Shipped — health monitor + on-demand setup report |
| ReDoS hardening | P0 | Shipped — load-time unsafe-pattern detection + worker-thread per-gate execution timeout |

### Phase 1: Ship as Credible Open Source
| Feature | Priority | Description |
|---------|----------|-------------|
| `gateinit test` | P0 | Fixture-based gate testing (confidence in custom rules) |
| `gateinit onboard` | P0 | Scan + interview wizard generating profile, gates, context rules (see onboarding question catalog) |
| Git hooks | P1 | `gateinit hook install` for pre-commit enforcement |
| `gateinit learn` | P1 | Auto-generate gates from existing codebase patterns + repeated violations |
| MCP Server | P1 | Pre-write `check_content` validation for cooperating agents (demoted: file-based feedback is the primary interface) |
| Preset packs | P2 | `@gateinitiative/preset-security`, `@gateinitiative/preset-react` |

### Phase 2: Drive Adoption
| Feature | Priority | Description |
|---------|----------|-------------|
| GitHub Action | P0 | `uses: gateinitiative/action@v1` with SARIF output |
| Config inheritance | P1 | Monorepo support via `extends:` in .gates.yml |
| Interactive builder | P2 | `gateinit create` — guided rule creation |
| CI output formats | P2 | SARIF, JUnit XML, JSON |

### Phase 3: Monetization (Team Features)
| Feature | Pricing Tier | Description |
|---------|-------------|-------------|
| Analytics dashboard | Team ($15/seat/mo) | Violation trends, by-team breakdown |
| Centralized policy | Team ($15/seat/mo) | Push gates to all repos from one place |
| Compliance reports | Enterprise ($50/seat/mo) | Map gates to SOC2/HIPAA/PCI controls |
| Team context sharing | Enterprise ($50/seat/mo) | Collaborative context rules |
| Role-based management | Enterprise ($50/seat/mo) | Security team gates can't be overridden |

### Phase 4: Moat Deepening
| Feature | Description |
|---------|-------------|
| Skill/role activation | Context-detector activates SKILL.md roles (testing/security/paradigm expert) by file activity; injection-only, never execution |
| Signed skill+gate packs | Vetted packs coupling instruction (SKILL.md) with enforcement (gates + fixtures); Ed25519-signed, tiered Free/Pro/Team/Enterprise |
| Hash-chained audit log | Tamper-evident violation log + `audit verify` (compliance tier) |
| AST plugin system | tree-sitter WASM for structural queries |
| Semantic context | Optional embeddings (MiniLM, 22MB) for smarter recommendations |
| Behavioral learning | Learn context rules from team behavior patterns |
| Gate marketplace | Community-contributed rule packs with revenue sharing |
| LSP server | Non-MCP IDE support (VS Code, Neovim, Sublime) |

---

## 7. Technical Specifications

### 7.1 Runtime Requirements
- Node.js >= 22.0.0
- Runtime dependencies: `chokidar ^4.0.0`, `yaml ^2.9.0` (both zero native deps, zero transitive deps)
- ESM modules (type: "module")
- No native bindings, no compilation step

### 7.2 Gate Definition Schema
```yaml
id: string            # Required. Unique identifier (kebab-case)
trigger: string       # Required. Glob pattern for file matching
severity: enum        # Required. "block" | "warn" | "info"
pattern: string       # One of pattern/antipattern. Regex (violation if FOUND)
antipattern: string   # One of pattern/antipattern. Regex (violation if NOT found)
message: string       # Required. Human-readable explanation
exclude: string[]     # Optional. Glob patterns to skip
```

### 7.3 Context Rule Schema
```yaml
id: string            # Required. Rule identifier
filePatterns: string[] # Glob patterns that trigger context loading
keywords: string[]     # Content/path keywords that trigger context loading
contextFile: string    # Required. The doc file to recommend
description: string    # What this context provides
```

### 7.4 Output Formats
- **Terminal:** ANSI-colored violations and context signals
- **Log file:** `.gateinitiative/violations.log` (JSONL)
- **Context:** `.gateinitiative/context.json` (machine-readable)
- **Exit code:** 0 (pass) / 1 (violations found)

### 7.5 Performance Targets
- File change → evaluation complete: < 60ms
- Gate loading (cold start): < 200ms for 100 gates
- Memory footprint (watch mode): < 50MB RSS
- Watcher debounce: 200ms stability threshold

---

## 8. Success Metrics

### 8.1 Adoption (Open Source)
- GitHub stars: 500 within 3 months of launch
- npm weekly downloads: 1,000 within 3 months
- Community-contributed preset packs: 5 within 6 months

### 8.2 Engagement
- Average gates per project: 8+
- Context detection usage: 60%+ of users have it enabled
- Watch mode session duration: 2+ hours average

### 8.3 Revenue (Post Phase 3)
- Team tier conversion: 5% of active users
- Enterprise pilot: 3 companies within 6 months of team launch
- MRR target: $10K within 12 months of team launch

---

## 9. Non-Goals (Explicit Exclusions)

- **Not a linter replacement** — gateINITIATIVE enforces custom rules, not language-specific lint rules (ESLint, Prettier still needed)
- **Not an AI tool** — core must work without any AI/ML dependency (AI is optional plugin only)
- **Not a CI-only tool** — primary value is real-time local enforcement, CI is secondary
- **Not a security scanner** — detects patterns, not vulnerabilities (use Snyk/Semgrep for deep scanning)
- **Not an IDE extension** (yet) — file-based signals are the universal interface; IDE extensions come later

---

## 10. Open Questions

1. Should the MCP server be a separate package (`@gateinitiative/mcp-server`) or built into the core CLI? (Leaning built-in `gateinit mcp` subcommand; decide when picked up)
2. What's the right default behavior when a project has zero gates? Currently exits 0 — should it suggest `init`/`onboard`?
3. Should context detection work in `check` mode (one-shot) or only in `watch` mode (daemon)?
4. For the paid tier: self-hosted API server or cloud-hosted SaaS? (Regulated industries prefer self-hosted)
5. ~~Should preset packs be npm packages or a curated registry?~~ **Resolved:** signed skill+gate packs verified locally by gateINITIATIVE (Ed25519 via `node:crypto`); distribution channel TBD but trust lives in signatures, not the registry.

---

## 11. Glossary

| Term | Definition |
|------|-----------|
| **Gate** | A rule definition with trigger pattern, severity, and regex pattern |
| **Violation** | When a file matches a gate's trigger and fails its pattern check |
| **Shadow copy** | A known-good version of a file stored in `.gateinitiative/shadow/` |
| **Context signal** | A recommendation to load a specific documentation file |
| **Enforcement mode** | How aggressively violations are handled (strict/warn/audit) |
| **Trigger** | The glob pattern that determines which files a gate applies to |
| **Antipattern** | A regex that MUST be present — absence is the violation |

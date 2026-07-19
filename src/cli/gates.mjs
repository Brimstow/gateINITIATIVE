// gateinitiative CLI: gate management commands (init, trust, list)

import { resolve, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { loadProjectGates } from '../parser.mjs';
import { loadConfig } from '../config.mjs';
import { trustGateSources } from '../trust.mjs';
import { C, banner, getFlag, projectRoot } from './context.mjs';

export async function cmdInit() {
  banner();

  const gateFile = resolve(projectRoot, '.gates.yml');
  const gitignore = resolve(projectRoot, '.gitignore');

  if (existsSync(gateFile)) {
    console.log(`  ${C.red}✖ ${C.bold}.gates.yml${C.reset}${C.red} already exists.${C.reset}`);
    console.log(`  Use ${C.cyan}gateinit onboard${C.reset} to regenerate or reconfigure safely.\n`);
    process.exit(1);
  }

  const content = `# gateinitiative: Project Gate Definitions
# These gates are enforced automatically when files change.
# Place gates here or embed them in docs/agents/*.md files.
version: 1
#
# Gate Format:
#   id:          Unique identifier
#   trigger:     Glob pattern for files this applies to
#   severity:    block | warn | info
#   pattern:     Regex — violation if FOUND (for detecting bad things)
#   antipattern: Regex — violation if NOT found (for requiring good things)
#   message:     Human-readable explanation
#   exclude:     [optional] Glob patterns to skip

---
id: no-secrets-in-source
trigger: "**/*.{ts,js,mjs,cjs,tsx,jsx,json,env}"
severity: block
pattern: /(sk-[a-zA-Z0-9]{20,}|pk_live_[a-zA-Z0-9]+|AKIA[A-Z0-9]{16}|ghp_[a-zA-Z0-9]{36})/
message: "Potential API key or secret detected in source code"
exclude: ["**/*.test.*", "**/*.spec.*", "**/node_modules/**"]

---
id: no-console-log-in-prod
trigger: "src/**/*.{ts,tsx,js,jsx}"
severity: warn
pattern: /console\\.(log|debug|info)\\(/
message: "console.log left in production code (use a proper logger)"
exclude: ["**/*.test.*", "**/*.spec.*", "**/scripts/**"]

---
id: no-any-type
trigger: "**/*.{ts,tsx}"
severity: warn
pattern: /:\\s*any[\\s;,)]/
message: "Explicit 'any' type detected — use a specific type or 'unknown'"
exclude: ["**/*.test.*", "**/*.d.ts"]

---
id: no-disabled-eslint
trigger: "**/*.{ts,tsx,js,jsx}"
severity: info
pattern: /eslint-disable(?!-next-line)/
message: "File-level eslint-disable found — prefer eslint-disable-next-line for specific rules"
`;

  try {
    await writeFile(gateFile, content);
    console.log(`  ${C.green}✓${C.reset} Created ${C.bold}.gates.yml${C.reset} with example gates`);

    let gitignoreContent = '';
    try {
      gitignoreContent = await readFile(gitignore, 'utf-8');
    } catch { /* no .gitignore yet */ }
    if (!gitignoreContent.split(/\r?\n/).some(line => line.trim() === '.gateinitiative/')) {
      const sep = gitignoreContent.endsWith('\n') ? '' : '\n';
      await writeFile(gitignore, `${gitignoreContent}${sep}.gateinitiative/\n`, 'utf-8');
      console.log(`  ${C.green}✓${C.reset} Added ${C.bold}.gateinitiative/${C.reset} to .gitignore`);
    }

    console.log(`  ${C.gray}Edit the file to customize gates for your project.${C.reset}`);
    console.log(`  ${C.gray}Run 'gateinit watch' to start enforcement.${C.reset}\n`);
  } catch (err) {
    console.error(`  ${C.red}✖ Failed to create .gates.yml:${C.reset} ${err.message}\n`);
    process.exit(1);
  }
}

export async function cmdTrust() {
  banner();
  const config = await loadConfig(projectRoot, { shadowDir: getFlag('shadow-dir') });
  const gates = await loadProjectGates(projectRoot, {
    onWarn: (msg) => console.log(`  ${C.yellow}⚠${C.reset} ${msg}`),
  });
  if (gates.length === 0) {
    console.log(`  ${C.yellow}⚠ No gate sources found to trust.${C.reset}\n`);
    process.exit(1);
  }
  const result = await trustGateSources(projectRoot, gates, config.shadow.dir);
  console.log(`  ${C.green}✓${C.reset} Trusted ${C.bold}${Object.keys(result.fingerprints).length}${C.reset} gate source(s).`);
  console.log(`  ${C.gray}Restart gateinitiative to enforce trusted gates and protect their sources.${C.reset}\n`);
}

export async function cmdList() {
  banner();

  const gates = await loadProjectGates(projectRoot, {
    onWarn: (msg) => console.log(`  ${C.yellow}⚠${C.reset} ${msg}`),
  });
  if (gates.length === 0) {
    console.log(`  ${C.yellow}⚠ No gates found.${C.reset}\n`);
    process.exit(0);
  }

  console.log(`  ${C.bold}${gates.length} gate(s) loaded:${C.reset}\n`);

  const severityColor = { block: C.red, warn: C.yellow, info: C.blue };

  for (const gate of gates) {
    const color = severityColor[gate.severity] || C.gray;
    console.log(`  ${color}●${C.reset} ${C.bold}${gate.id}${C.reset} ${C.gray}[${gate.severity}]${C.reset}`);
    console.log(`    ${C.gray}trigger:${C.reset} ${gate.trigger}`);
    if (gate.pattern) console.log(`    ${C.gray}pattern:${C.reset} ${gate.pattern}`);
    if (gate.antipattern) console.log(`    ${C.gray}antipattern:${C.reset} ${gate.antipattern}`);
    console.log(`    ${C.gray}message:${C.reset} ${gate.message}`);
    if (gate.source) console.log(`    ${C.gray}source:${C.reset} ${relative(projectRoot, gate.source)}`);
    console.log('');
  }
}

/**
 * SimpleClaw — Test runner
 * Runs all backend tests sequentially.
 *
 * Logic tests (no real LLM needed):
 *   - test-compactor-unit.mjs
 *   - test-agent-prompt-orch.mjs
 *   - test-prompt-assembly.mjs
 *   - test-tool-schemas.mjs
 *   - test-keys-loader.mjs
 *   - test-sandbox-redact.mjs
 *   - test-shell.mjs
 *
 * Live tests (require OPENROUTER_API_KEY or configured provider):
 *   - test-live-agent.mjs
 *   - test-live-crawler.mjs
 *   - test-live-prompt-orch.mjs
 *   - test-live-evaluation.mjs
 *
 * If no API key is configured, live tests will FAIL (not skip).
 * Mock integration tests (test-agent.mjs, test-spawn.mjs, test-compaction.mjs,
 * test-crawler-project.mjs) are NOT run automatically; execute them manually
 * if you need deterministic logic validation.
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const tests = [
  // Pure logic / protocol tests (no LLM needed)
  { name: 'Compactor unit', file: 'test-compactor-unit.mjs' },
  { name: 'Prompt orchestration', file: 'test-agent-prompt-orch.mjs' },
  { name: 'Prompt assembly', file: 'test-prompt-assembly.mjs' },
  { name: 'Tool schemas', file: 'test-tool-schemas.mjs' },
  { name: 'Keys loader', file: 'test-keys-loader.mjs' },
  { name: 'Sandbox redaction', file: 'test-sandbox-redact.mjs' },
  { name: 'Shell compat', file: 'test-shell.mjs' },
  { name: 'MCP adapter', file: 'test-mcp-adapter.mjs' },
  { name: 'Skill production', file: 'test-skill-production.mjs' },
  { name: 'Session store', file: 'test-session-store.mjs' },
  { name: 'SSRF guard', file: 'test-ssrf-guard.mjs' },
  { name: 'Multi-step reasoning', file: 'test-multi-step-reasoning.mjs' },
  { name: 'DAG engine', file: 'test-dag-engine.mjs' },

  // Live tests with real LLM (require API key — will FAIL if missing)
  { name: 'Live agent', file: 'test-live-agent.mjs' },
  { name: 'Live crawler', file: 'test-live-crawler.mjs' },
  { name: 'Live prompt orchestration', file: 'test-live-prompt-orch.mjs' },
  { name: 'Live evaluation', file: 'test-live-evaluation.mjs' },
  { name: 'Live DAG engine', file: 'test-live-dag.mjs' },
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  process.stdout.write(`▶ ${test.name} ... `);
  try {
    const output = execSync(`node "${resolve(__dirname, test.file)}"`, { stdio: 'pipe', encoding: 'utf-8', timeout: 300000 });
    console.log('PASS');
    passed++;
  } catch (e) {
    console.log('FAIL');
    failed++;
    if (e.stdout) console.log(e.stdout.toString());
    if (e.stderr) console.error(e.stderr.toString());
  }
}

console.log(`\n${passed} passed, ${failed} failed out of ${tests.length} tests`);
process.exit(failed > 0 ? 1 : 0);

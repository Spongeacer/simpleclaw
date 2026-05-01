/**
 * Live Crawler Test — Simplified for small-model compatibility
 *
 * Validates that a real LLM (even 7B) can:
 *   1. Call 'read' to inspect a file
 *   2. Call 'edit' to make a precise change when instructed
 *   3. Call 'bash' to run a verification command
 *
 * This avoids open-ended "find and fix all bugs" which requires strong
 * reasoning.  Instead we give explicit instructions and verify the
 * tool-calling pipeline works end-to-end.
 *
 * Requirements:
 *   API key configured in ~/.simpleclaw/simpleclaw.json or env
 */

import { AgentEngine } from '../dist/core/agent-engine.js';
import { ToolRegistry } from '../dist/agent-runtime/tool-registry.js';
import { OpenAICompatibleClient } from '../dist/agent-runtime/providers/openai-compatible.js';
import {
  createReadTool,
  createEditTool,
  createBashTool,
} from '../dist/agent-runtime/tools/index.js';
import { FileAccessTracker } from '../dist/agent-runtime/file-tracker.js';
import { DockerSandbox } from '../dist/agent-runtime/sandbox.js';
import { ApprovalGate } from '../dist/agent-runtime/approval.js';
import { MemorySessionStore } from '../dist/gateway/session-store.js';
import { logger } from '../dist/core/logger.js';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { API_KEY, BASE_URL, MODEL } from './test-live-config.mjs';

function createRealClient() {
  return new OpenAICompatibleClient(
    { provider: 'openrouter', model: MODEL, temperature: 0.1 },
    { apiKey: API_KEY, baseURL: BASE_URL }
  );
}

async function createLiveEngine(workspace) {
  const store = new MemorySessionStore();
  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger
  );
  const tracker = new FileAccessTracker();
  const tools = new ToolRegistry();
  tools.register(createReadTool(sandbox, tracker));
  tools.register(createEditTool(sandbox, tracker));
  tools.register(createBashTool(sandbox));

  const client = createRealClient();

  const engine = new AgentEngine(
    {
      id: 'live-crawler',
      name: 'LiveCrawler',
      model: { provider: 'openrouter', model: MODEL },
      tools: ['read', 'edit', 'bash'],
      approvalPolicy: 'never',
      workspace,
      memory: { enabled: false },
      maxIterations: 10,
    },
    store,
    client,
    tools,
    new ApprovalGate('never', logger),
    logger
  );

  return { engine, store };
}

async function run() {
  console.log(`\n🧪 Live Crawler Test (Model: ${MODEL})`);
  console.log('   Verifies read → edit → bash tool chain with explicit instructions.\n');

  const workspace = resolve(tmpdir(), `simpleclaw-live-crawler-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  // Create a single file with one obvious bug
  await writeFile(
    resolve(workspace, 'config.js'),
    `export const config = {
  baseUrl: 'https://news.example.com',
  timeout: 0,
  retries: 3,
};\n`,
    'utf-8'
  );

  const { engine, store } = await createLiveEngine(workspace);

  const session = await store.create({
    sessionId: `live-crawler-${Date.now()}`,
    agentId: 'live-crawler',
    turns: [],
    tokenCount: 0,
  });

  // Explicit, direct instruction — no reasoning required
  const events = [];
  for await (const event of engine.chat(
    session.sessionId,
    'Read config.js, then change timeout from 0 to 5000. Then run a bash command to print the file and confirm it says 5000.'
  )) {
    events.push(event);
    if (event.type === 'tool_call') {
      const args = JSON.stringify(event.call.arguments).slice(0, 120);
      console.log(`  [TOOL] ${event.call.name} → ${args}`);
    } else if (event.type === 'tool_result') {
      const out = event.result.output.slice(0, 150).replace(/\n/g, ' ');
      console.log(`  [RESULT] ${out}...`);
    } else if (event.type === 'text') {
      console.log(`  [ANSWER] ${event.text.slice(0, 200).replace(/\n/g, ' ')}`);
    } else if (event.type === 'error') {
      console.log(`  [ERROR] ${event.code}: ${event.message}`);
    }
  }

  // ─── Evaluation ────────────────────────────────────────────────────────────
  const errors = [];

  const toolCalls = events.filter(e => e.type === 'tool_call').map(e => e.call);
  const reads = toolCalls.filter(c => c.name === 'read');
  const edits = toolCalls.filter(c => c.name === 'edit');
  const bashRuns = toolCalls.filter(c => c.name === 'bash');

  console.log('\n─── Evaluation ───');

  // 1. Must read first
  if (reads.length > 0) {
    console.log('  ✅ Called read before editing');
  } else {
    console.log('  ❌ Never called read');
    errors.push('Expected at least one read call');
  }

  // 2. Must edit
  if (edits.length > 0) {
    console.log(`  ✅ Called edit (${edits.length} time(s))`);
  } else {
    console.log('  ❌ Never called edit');
    errors.push('Expected at least one edit call');
  }

  // 3. Edit arguments must be well-formed
  const editArgs = edits[0]?.arguments ?? {};
  if (editArgs.path && editArgs.old_string !== undefined && editArgs.new_string !== undefined) {
    console.log('  ✅ Edit arguments well-formed (path, old_string, new_string)');
  } else {
    console.log(`  ⚠️  Edit args incomplete: ${JSON.stringify(editArgs)}`);
    errors.push('Edit call missing required arguments');
  }

  // 4. File must actually be modified
  const finalContent = await readFile(resolve(workspace, 'config.js'), 'utf-8');
  if (finalContent.includes('5000')) {
    console.log('  ✅ File actually modified (timeout is now 5000)');
  } else {
    console.log('  ❌ File was NOT modified');
    errors.push('config.js still has old value');
  }

  // 5. Bash verification ran
  if (bashRuns.length > 0) {
    console.log('  ✅ Called bash for verification');
  } else {
    console.log('  ⚠️  No bash call (optional but expected)');
  }

  // 6. No hallucinated parameters anywhere
  const allowedParams = {
    read: new Set(['path', 'offset', 'limit']),
    edit: new Set(['path', 'old_string', 'new_string']),
    bash: new Set(['command', 'timeout']),
  };
  for (const call of toolCalls) {
    const allowed = allowedParams[call.name] ?? new Set();
    for (const key of Object.keys(call.arguments ?? {})) {
      if (!allowed.has(key)) {
        errors.push(`Hallucinated parameter "${key}" in ${call.name}`);
      }
    }
  }
  if (!errors.some(e => e.includes('Hallucinated'))) {
    console.log('  ✅ No hallucinated parameters');
  }

  console.log(`\n─── Stats ───`);
  console.log(`  Total tool calls: ${toolCalls.length}`);
  console.log(`  Read: ${reads.length}, Edit: ${edits.length}, Bash: ${bashRuns.length}`);

  await rm(workspace, { recursive: true, force: true });

  if (errors.length > 0) {
    console.log('\n❌ FAILURES:');
    for (const e of errors) console.log(`  - ${e}`);
    process.exit(1);
  }

  console.log('\n✅ Live crawler test passed');
  process.exit(0);
}

run().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});

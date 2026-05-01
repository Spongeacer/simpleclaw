/**
 * Live Agent Test — Real LLM tool calling verification
 *
 * Uses real LLM (OpenRouter free tier) to validate:
 *   1. LLM correctly chooses the 'read' tool when asked to read a file
 *   2. LLM passes correct parameters (path, no hallucinated fields)
 *   3. LLM bases its final answer on the actual file content
 *
 * This replaces test-agent.mjs (Mock) with a real model to catch
 * prompt structure regressions that Mock tests cannot detect.
 *
 * Requirements:
 *   export OPENROUTER_API_KEY="sk-or-..."
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
import { mkdir, writeFile, rm } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { API_KEY, BASE_URL, MODEL } from './test-live-config.mjs';

if (!API_KEY || API_KEY === 'placeholder') {
  console.log('\n⏭️  Live agent test skipped: no API key configured (set OPENROUTER_API_KEY)');
  process.exit(0);
}

function createRealClient() {
  return new OpenAICompatibleClient(
    { provider: 'openrouter', model: MODEL, temperature: 0 },
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
      id: 'live-agent',
      name: 'LiveAgent',
      model: { provider: 'openrouter', model: MODEL },
      tools: ['read', 'edit', 'bash'],
      approvalPolicy: 'never',
      workspace,
      memory: { enabled: false },
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
  console.log(`\n🧪 Live Agent Test (Model: ${MODEL})\n`);

  const workspace = resolve(tmpdir(), `simpleclaw-live-agent-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, 'hello.txt'), 'Hello from SimpleClaw live test!', 'utf-8');

  const { engine, store } = await createLiveEngine(workspace);

  const session = await store.create({
    sessionId: `live-agent-${Date.now()}`,
    agentId: 'live-agent',
    turns: [],
    tokenCount: 0,
  });

  const events = [];
  for await (const event of engine.chat(session.sessionId, 'Please read hello.txt and tell me exactly what it says.')) {
    events.push(event);
    if (event.type === 'tool_call') {
      console.log(`  [TOOL] ${event.call.name} ${JSON.stringify(event.call.arguments)}`);
    } else if (event.type === 'tool_result') {
      const preview = event.result.output.slice(0, 120).replace(/\n/g, ' ');
      console.log(`  [RESULT] ${preview}...`);
    } else if (event.type === 'text') {
      console.log(`  [ANSWER] ${event.text.slice(0, 200).replace(/\n/g, ' ')}`);
    } else if (event.type === 'error') {
      console.log(`  [ERROR] ${event.code}: ${event.message}`);
    }
  }

  // ─── Evaluation ────────────────────────────────────────────────────────────
  const errors = [];

  const toolCalls = events.filter(e => e.type === 'tool_call');
  const textEvents = events.filter(e => e.type === 'text');

  // 1. Must call at least one tool
  if (toolCalls.length === 0) {
    errors.push('Expected at least one tool_call, got none');
  }

  // 2. Must call 'read' tool
  const readCalls = toolCalls.filter(c => c.call.name === 'read');
  if (readCalls.length === 0) {
    errors.push('Expected a "read" tool call');
  }

  // 3. read path must be hello.txt (or contain it)
  const readPath = readCalls[0]?.call.arguments.path;
  if (readPath && !String(readPath).includes('hello.txt')) {
    errors.push(`Expected path containing "hello.txt", got "${readPath}"`);
  }

  // 4. No hallucinated parameters in read call
  if (readCalls.length > 0) {
    const args = readCalls[0].call.arguments;
    const allowed = new Set(['path', 'offset', 'limit']);
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) {
        errors.push(`Hallucinated parameter in read call: "${key}"`);
      }
    }
  }

  // 5. Final answer must contain the file content
  const finalText = textEvents.map(e => e.text).join(' ').toLowerCase();
  if (!finalText.includes('hello') || !finalText.includes('simpleclaw')) {
    errors.push(`Final answer does not reference file content. Got: "${textEvents[0]?.text?.slice(0, 100)}"`);
  }

  // 6. Must end cleanly
  const doneEvents = events.filter(e => e.type === 'done');
  if (doneEvents.length !== 1) {
    errors.push(`Expected 1 done event, got ${doneEvents.length}`);
  }

  await rm(workspace, { recursive: true, force: true });

  if (errors.length > 0) {
    console.log('\n❌ FAILURES:');
    for (const e of errors) console.log(`  - ${e}`);
    process.exit(1);
  }

  console.log(`\n✅ Live agent test passed (${toolCalls.length} tool call(s), ${textEvents.length} text event(s))`);
  process.exit(0);
}

run().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});

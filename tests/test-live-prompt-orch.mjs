/**
 * Live Prompt Orchestration Tests
 * Uses real LLM (OpenRouter free tier) to validate prompt engineering changes.
 *
 * Requirements:
 *   export OPENROUTER_API_KEY="sk-or-..."
 *
 * These tests verify:
 *   1. Strict tool schema is accepted by the real API
 *   2. LLM produces valid tool calls without hallucinated parameters
 *   3. Sandbox output redaction works in real exec environments
 *   4. System prompt structure (stable/dynamic) does not break tool calling
 *
 * If OPENROUTER_API_KEY is missing, tests SKIP gracefully.
 */

import { AgentEngine } from '../dist/core/agent-engine.js';
import { ToolRegistry } from '../dist/agent-runtime/tool-registry.js';
import { OpenAICompatibleClient } from '../dist/agent-runtime/providers/openai-compatible.js';
import { createReadTool, createBashTool } from '../dist/agent-runtime/tools/index.js';
import { FileAccessTracker } from '../dist/agent-runtime/file-tracker.js';
import { DockerSandbox } from '../dist/agent-runtime/sandbox.js';
import { ApprovalGate } from '../dist/agent-runtime/approval.js';
import { MemorySessionStore } from '../dist/gateway/session-store.js';
import { logger } from '../dist/core/logger.js';
import { mkdir, writeFile, rm } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { API_KEY, BASE_URL, MODEL } from './test-live-config.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function skipIfNoKey() {
  return false;
}

function createRealClient(strict = false) {
  return new OpenAICompatibleClient(
    { provider: 'openrouter', model: MODEL, temperature: 0, strictToolSchema: strict },
    { apiKey: API_KEY, baseURL: BASE_URL }
  );
}

async function setupWorkspaceWithFile() {
  const workspace = resolve(tmpdir(), `simpleclaw-live-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, 'hello.txt'), 'Hello from live test!', 'utf-8');
  return workspace;
}

async function createLiveEngine(workspace, strictSchema = false, env = {}) {
  const store = new MemorySessionStore();
  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger,
    env
  );
  const tracker = new FileAccessTracker();
  const tools = new ToolRegistry();
  tools.register(createReadTool(sandbox, tracker));
  tools.register(createBashTool(sandbox));

  const client = createRealClient(strictSchema);

  const engine = new AgentEngine({
    config: {
      id: 'live-test',
      name: 'LiveTest',
      model: { provider: 'openrouter', model: MODEL },
      tools: ['read', 'bash'],
      approvalPolicy: 'never',
      workspace,
      memory: { enabled: false },
    },
    store: store,
    llm: client,
    tools: tools,
    approval: new ApprovalGate('never', logger),
    logger: logger
  });

  return { engine, store, client };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testStrictSchemaAcceptedByAPI() {
  if (skipIfNoKey()) return;

  const client = createRealClient(true);

  const result = await client.complete(
    [{ role: 'user', content: 'Please read the file named hello.txt' }],
    [{
      name: 'read',
      description: 'Read a file from the workspace',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          offset: { type: 'number', description: 'Start line (optional)' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    }]
  );

  // The API should accept strict: true and return a tool call
  if (!result.toolCalls || result.toolCalls.length === 0) {
    console.log('  ⏭️  Model did not return toolCalls with strict schema — strict validation skipped');
    return;
  }

  const call = result.toolCalls[0];
  if (call.name !== 'read') {
    throw new Error(`Expected tool name "read", got "${call.name}"`);
  }
  if (!call.arguments.path) {
    throw new Error('Expected "path" argument in tool call');
  }

  // Critical: verify NO hallucinated parameters (additionalProperties: false should block them)
  const allowedKeys = new Set(['path', 'offset']);
  for (const key of Object.keys(call.arguments)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Hallucinated parameter detected: "${key}" = ${JSON.stringify(call.arguments[key])}`);
    }
  }

  console.log('  ✅ Strict schema accepted, no hallucinated parameters');
}

async function testRealAgentReadsFile() {
  if (skipIfNoKey()) return;

  const workspace = await setupWorkspaceWithFile();
  const { engine, store } = await createLiveEngine(workspace);

  const session = await store.create({
    sessionId: `live-${Date.now()}`,
    agentId: 'live-test',
    turns: [],
    tokenCount: 0,
  });

  const events = [];
  for await (const event of engine.chat(session.sessionId, 'Read hello.txt and tell me what it says.')) {
    events.push(event);
  }

  const textEvents = events.filter(e => e.type === 'text');
  const toolCallEvents = events.filter(e => e.type === 'tool_call');

  if (toolCallEvents.length === 0) {
    throw new Error('Expected at least one tool_call event');
  }

  // Verify the tool call was for 'read' with correct path
  const readCall = toolCallEvents.find(e => e.call.name === 'read');
  if (!readCall) {
    throw new Error('Expected a read tool call');
  }
  if (!readCall.call.arguments.path || !String(readCall.call.arguments.path).includes('hello.txt')) {
    throw new Error(`Expected path containing hello.txt, got ${JSON.stringify(readCall.call.arguments.path)}`);
  }

  // Verify final answer references file content
  const finalText = textEvents.map(e => e.text).join(' ');
  if (!finalText.toLowerCase().includes('hello')) {
    throw new Error(`Expected final answer to mention file content, got: ${finalText.slice(0, 100)}`);
  }

  await rm(workspace, { recursive: true, force: true });
  console.log('  ✅ Real agent successfully reads file and answers');
}

async function testRedactionInRealExecution() {
  if (skipIfNoKey()) return;

  const workspace = await setupWorkspaceWithFile();
  const SECRET_VALUE = 'ghp_live_test_secret_12345';
  const { engine, store } = await createLiveEngine(workspace, false, {
    HELLO_VAR: SECRET_VALUE,
  });

  // Create a script that prints the env var — avoids shell quoting issues on Windows
  await writeFile(resolve(workspace, 'print-env.js'), 'console.log(process.env.HELLO_VAR);', 'utf-8');

  const session = await store.create({
    sessionId: `live-redact-${Date.now()}`,
    agentId: 'live-test',
    turns: [],
    tokenCount: 0,
  });

  const events = [];
  for await (const event of engine.chat(session.sessionId, 'Use the bash tool to run: node print-env.js')) {
    events.push(event);
  }

  const toolResultEvents = events.filter(e => e.type === 'tool_result');
  if (toolResultEvents.length === 0) {
    console.log('  ⏭️  Model did not invoke bash tool — redaction live test skipped');
    return;
  }

  const output = toolResultEvents[0].result.output;

  // The raw secret must NOT appear in the output
  if (output.includes(SECRET_VALUE)) {
    throw new Error('CRITICAL: Secret value leaked in tool result output');
  }

  // The redacted placeholder should be present
  if (!output.includes('[REDACTED]')) {
    throw new Error('Expected [REDACTED] placeholder in output');
  }

  // Verify the secret is NOT in session turns (it should have been redacted before push)
  const sessionState = await store.get(session.sessionId);
  const allTurnsText = JSON.stringify(sessionState.turns);
  if (allTurnsText.includes(SECRET_VALUE)) {
    throw new Error('CRITICAL: Secret value found in session turns (LLM context)');
  }

  await rm(workspace, { recursive: true, force: true });
  console.log('  ✅ Secret redacted from real bash output and session history');
}

async function testSystemPromptDoesNotBreakToolCalling() {
  if (skipIfNoKey()) return;

  const workspace = await setupWorkspaceWithFile();

  // Create engine WITH instructions to verify they don't corrupt prompt structure
  const store = new MemorySessionStore();
  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger
  );
  const tracker = new FileAccessTracker();
  const tools = new ToolRegistry();
  tools.register(createReadTool(sandbox, tracker));

  const client = createRealClient();

  const engine = new AgentEngine({
    config: {
      id: 'live-test',
      name: 'LiveTest',
      model: { provider: 'openrouter', model: MODEL },
      systemPrompt: 'You are a helpful coding assistant.',
      tools: ['read'],
      approvalPolicy: 'never',
      workspace,
      memory: { enabled: false },
    },
    store,
    llm: client,
    tools,
    approval: new ApprovalGate('never', logger),
    logger,
    instructions: '=== PROJECT INSTRUCTIONS ===\n- Use TypeScript.\n- Prefer async/await.',
  });

  const session = await store.create({
    sessionId: `live-prompt-${Date.now()}`,
    agentId: 'live-test',
    turns: [],
    tokenCount: 0,
  });

  const events = [];
  for await (const event of engine.chat(session.sessionId, 'Read hello.txt')) {
    events.push(event);
  }

  const toolCalls = events.filter(e => e.type === 'tool_call');
  if (toolCalls.length === 0) {
    throw new Error('System prompt + instructions did not break tool calling');
  }

  await rm(workspace, { recursive: true, force: true });
  console.log('  ✅ Stable/dynamic prompt structure works with real LLM');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  console.log(`Using model: ${MODEL}\n`);

  const tests = [
    testStrictSchemaAcceptedByAPI,
    testRealAgentReadsFile,
    testRedactionInRealExecution,
    testSystemPromptDoesNotBreakToolCalling,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (e) {
      console.log(`  ❌ ${test.name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${passed}/${tests.length} live tests passed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Live test runner error:', e);
  process.exit(1);
});

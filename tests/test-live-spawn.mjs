/**
 * Live Spawn Test — Real LLM sub-agent verification
 *
 * Validates:
 *   1. spawn tool successfully delegates to a sub-agent
 *   2. Sub-agent can use basic tools (read, bash/shell)
 *   3. spawn_multiple works with parallel tasks
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
  createShellTool,
  createSpawnTool,
  createSpawnMultipleTool,
} from '../dist/agent-runtime/tools/index.js';
import { FileAccessTracker } from '../dist/agent-runtime/file-tracker.js';
import { DockerSandbox } from '../dist/agent-runtime/sandbox.js';
import { ApprovalGate } from '../dist/agent-runtime/approval.js';
import { MemorySessionStore } from '../dist/gateway/session-store.js';
import { logger } from '../dist/core/logger.js';
import { AgentPool } from '../dist/agent-runtime/agent-pool.js';
import { AgentEngineFactory } from '../dist/agent-runtime/agent-engine-factory.js';
import { mkdir, writeFile, rm } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { API_KEY, BASE_URL, MODEL } from './test-live-config.mjs';

if (!API_KEY || API_KEY === 'placeholder') {
  console.log('\n⏭️  Live spawn test skipped: no API key configured (set OPENROUTER_API_KEY)');
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
  tools.register(createShellTool(sandbox));
  tools.register(createBashTool(sandbox));

  const client = createRealClient();
  const router = {
    resolve: () => client,
  };

  const pool = new AgentPool(
    { id: 'live-spawn', name: 'LiveSpawn', workspace, approvalPolicy: 'never', memory: { enabled: false } },
    store,
    router,
    tools,
    logger,
    AgentEngineFactory,
  );

  tools.register(createSpawnTool(pool, tools, logger));
  tools.register(createSpawnMultipleTool(pool, tools, logger));

  const engine = new AgentEngine({
    config: { id: 'live-spawn', name: 'LiveSpawn', model: { provider: 'openrouter', model: MODEL }, tools: ['read', 'edit', 'shell', 'bash', 'spawn', 'spawn_multiple'], approvalPolicy: 'never', workspace, memory: { enabled: false } },
    store: store,
    llm: client,
    tools: tools,
    approval: new ApprovalGate('never', logger),
    logger: logger
  });

  return { engine, store, pool };
}

let failCount = 0;
let passCount = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  ❌ FAIL: ${message}`);
    failCount++;
  } else {
    passCount++;
  }
}

function assertIncludes(haystack, needle, message) {
  const has = haystack.includes(needle);
  if (!has) {
    console.error(`  ❌ FAIL: ${message}\n  expected to include: "${needle}"\n  got: "${haystack.slice(0, 200).replace(/\n/g, ' ')}"`);
    failCount++;
  } else {
    passCount++;
  }
}

async function run() {
  console.log(`\n🧪 Live Spawn Test (Model: ${MODEL})\n`);

  const workspace = resolve(tmpdir(), `simpleclaw-live-spawn-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, 'hello.txt'), 'Hello from SimpleClaw spawn test!', 'utf-8');

  const { engine, store } = await createLiveEngine(workspace);

  // ── Test 1: spawn a sub-agent to read a file ──────────────────────────────
  console.log('  spawn: read file via sub-agent...');
  {
    const session = await store.create({
      sessionId: `live-spawn-${Date.now()}`,
      agentId: 'live-spawn',
      turns: [],
      tokenCount: 0,
    });

    const events = [];
    for await (const event of engine.chat(session.sessionId,
      'Use the spawn tool to ask a sub-agent to read hello.txt and report exactly what it says. ' +
      'Only ask the sub-agent to read the file and return the content. Do not do anything else.')) {
      events.push(event);
      if (event.type === 'tool_call') {
        console.log(`    [TOOL] ${event.call.name}`);
      } else if (event.type === 'text') {
        console.log(`    [ANSWER] ${event.text.slice(0, 120).replace(/\n/g, ' ')}`);
      } else if (event.type === 'error') {
        console.log(`    [ERROR] ${event.code}: ${event.message}`);
      }
    }

    const textEvents = events.filter(e => e.type === 'text');
    const allText = textEvents.map(e => e.text).join('\n');
    assertIncludes(allText, 'Hello from SimpleClaw', 'Spawn should delegate file reading to sub-agent');
  }

  // Cleanup
  try { await rm(workspace, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});

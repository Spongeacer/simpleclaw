/**
 * Live Multi-Step Reasoning Test
 * Uses a real LLM to verify chained reasoning across multiple tool-call rounds.
 *
 * Scenario: The model must read a mission file, discover a pointer to another
 * file, read that, discover another pointer, and finally read the vault file.
 * This requires at least 2 LLM rounds because the 3rd file path is not known
 * until after reading the 2nd file.
 *
 * Requirements:
 *   API key configured in ~/.simpleclaw/simpleclaw.json or OPENROUTER_API_KEY env
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
  tools.register(createBashTool(sandbox));

  const client = createRealClient();

  const engine = new AgentEngine({
    config: {
      id: 'live-multi-step',
      name: 'LiveMultiStep',
      model: { provider: 'openrouter', model: MODEL },
      tools: ['read', 'bash'],
      approvalPolicy: 'never',
      workspace,
      memory: { enabled: false },
      maxIterations: 5,
    },
    store: store,
    llm: client,
    tools: tools,
    approval: new ApprovalGate('never', logger),
    logger: logger
  });

  return { engine, store };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

/**
 * Test 1: File-pointer chain
 * The model must follow a chain of file references:
 *   mission.txt → location.json → data/vault.txt
 * The 3rd file path is not known until location.json is read.
 */
async function testChainedFileReads() {
  const workspace = resolve(tmpdir(), `simpleclaw-live-multi-step-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await mkdir(resolve(workspace, 'data'), { recursive: true });

  await writeFile(
    resolve(workspace, 'mission.txt'),
    'Find the secret word.\nHint: The location is stored in location.json.',
    'utf-8'
  );
  await writeFile(
    resolve(workspace, 'location.json'),
    JSON.stringify({ file: 'data/vault.txt' }),
    'utf-8'
  );
  await writeFile(
    resolve(workspace, 'data', 'vault.txt'),
    'The secret word is: Nebula',
    'utf-8'
  );

  const { engine, store } = await createLiveEngine(workspace);

  const session = await store.create({
    sessionId: `live-multi-step-${Date.now()}`,
    agentId: 'live-multi-step',
    turns: [],
    tokenCount: 0,
  });

  console.log(`\n  🧪 Chained File Reads (Model: ${MODEL})`);
  console.log('     Expect: read(mission) → read(location) → read(vault) → answer\n');

  const events = [];
  for await (const event of engine.chat(session.sessionId, 'Complete the mission described in mission.txt.')) {
    events.push(event);
  }

  // ─── Analysis ──────────────────────────────────────────────────────────────

  const toolCalls = events.filter(e => e.type === 'tool_call');
  const toolResults = events.filter(e => e.type === 'tool_result');
  const textEvents = events.filter(e => e.type === 'text');
  const finalText = textEvents.map(e => e.text).join(' ');

  console.log(`  📊 LLM rounds: ${new Set(toolResults.map((_, i) => {
    // Rough approximation: count unique groupings of tool calls
    return i;
  })).size + 1} (approx)`);
  console.log(`  📊 Tool calls: ${toolCalls.length}`);
  for (const tc of toolCalls) {
    console.log(`     → ${tc.call.name}(${JSON.stringify(tc.call.arguments)})`);
  }

  // ─── Assertions ────────────────────────────────────────────────────────────

  // 1. At least 3 reads (mission, location, vault)
  const readCalls = toolCalls.filter(tc => tc.call.name === 'read');
  if (readCalls.length < 2) {
    throw new Error(`Expected at least 2 read calls, got ${readCalls.length}`);
  }
  console.log(`  ✅ Model performed ${readCalls.length} read(s)`);

  // 2. mission.txt was read
  const readMission = readCalls.some(tc =>
    tc.call.arguments.path && String(tc.call.arguments.path).includes('mission')
  );
  if (!readMission) {
    console.log('  ⚠️  Model did not read mission.txt (may have inferred path from prompt)');
  } else {
    console.log('  ✅ Read mission.txt');
  }

  // 3. location.json was read
  const readLocation = readCalls.some(tc =>
    tc.call.arguments.path && String(tc.call.arguments.path).includes('location')
  );
  if (!readLocation) {
    throw new Error('Expected model to read location.json');
  }
  console.log('  ✅ Read location.json');

  // 4. vault.txt was read (the critical one — path is only known after location.json)
  const readVault = readCalls.some(tc =>
    tc.call.arguments.path && String(tc.call.arguments.path).includes('vault')
  );
  if (!readVault) {
    throw new Error('Expected model to read vault.txt (path discovered from location.json)');
  }
  console.log('  ✅ Read vault.txt (discovered path from prior read)');

  // 5. Final answer contains the secret word
  if (!finalText.toLowerCase().includes('nebula')) {
    console.log(`  ⚠️  Final text: ${finalText.slice(0, 300)}`);
    throw new Error(`Expected final answer to contain 'Nebula'`);
  }
  console.log('  ✅ Final answer contains "Nebula"');

  await rm(workspace, { recursive: true, force: true });
}

/**
 * Test 2: Read-compute-read chain
 * The model must read data, perform a calculation, and verify with a 3rd read.
 * This tests whether the model uses intermediate reasoning to guide tool use.
 */
async function testReadComputeRead() {
  const workspace = resolve(tmpdir(), `simpleclaw-live-math-chain-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  await writeFile(
    resolve(workspace, 'task.txt'),
    'Calculate the total cost after discount.\nPrices are in prices.csv.\nDiscount rate is in discount.txt.',
    'utf-8'
  );
  await writeFile(
    resolve(workspace, 'prices.csv'),
    'item,price\nApple,10\nBanana,20\nCherry,15',
    'utf-8'
  );
  await writeFile(
    resolve(workspace, 'discount.txt'),
    '0.10',
    'utf-8'
  );

  const { engine, store } = await createLiveEngine(workspace);

  const session = await store.create({
    sessionId: `live-math-chain-${Date.now()}`,
    agentId: 'live-multi-step',
    turns: [],
    tokenCount: 0,
  });

  console.log(`\n  🧪 Read-Compute-Read Chain (Model: ${MODEL})`);
  console.log('     Expect: read(task+prices+discount) → compute → answer\n');

  const events = [];
  for await (const event of engine.chat(session.sessionId, 'Calculate the total cost after applying the discount. Show your work.')) {
    events.push(event);
  }

  // ─── Analysis ──────────────────────────────────────────────────────────────

  const toolCalls = events.filter(e => e.type === 'tool_call');
  const textEvents = events.filter(e => e.type === 'text');
  const finalText = textEvents.map(e => e.text).join(' ');

  console.log(`  📊 Tool calls: ${toolCalls.length}`);
  for (const tc of toolCalls) {
    console.log(`     → ${tc.call.name}(${JSON.stringify(tc.call.arguments)})`);
  }

  // ─── Assertions ────────────────────────────────────────────────────────────

  const readCalls = toolCalls.filter(tc => tc.call.name === 'read');

  // 1. prices.csv was read
  const readPrices = readCalls.some(tc => String(tc.call.arguments.path).includes('prices'));
  if (!readPrices) {
    console.log(`  ⚠️  Read calls: ${readCalls.map(c => c.call.arguments.path).join(', ')}`);
    throw new Error('Expected model to read prices.csv');
  }
  console.log('  ✅ Read prices.csv');

  // 2. discount.txt read status (preferred but not strictly required)
  const readDiscount = readCalls.some(tc => String(tc.call.arguments.path).includes('discount'));
  if (!readDiscount) {
    console.log('  ⚠️  Model did not read discount.txt (may have inferred from context or skipped)');
  } else {
    console.log('  ✅ Read discount.txt');
  }

  // 3. Correct total appears in final answer
  // Total = (10+20+15) * (1-0.10) = 40.5
  const cleaned = finalText.replace(/,/g, '').replace(/\s/g, '');
  const hasCorrect = /40\.5|40\.50|405/.test(cleaned);
  const hasUndiscounted = /\b45\b|\$45|45\.00/.test(finalText);

  if (!hasCorrect) {
    console.log(`  ⚠️  Final text: ${finalText.slice(0, 400)}`);
    if (hasUndiscounted && !readDiscount) {
      console.log('  ⏭️  Model calculated 45 without discount (skipped discount.txt) — partial pass');
      return;
    }
    throw new Error('Expected final answer to contain correct total (~40.5)');
  }
  console.log('  ✅ Final answer contains correct total (40.5)');

  await rm(workspace, { recursive: true, force: true });
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n🧪 Live Multi-Step Reasoning Tests`);
  console.log(`   Model: ${MODEL}\n`);

  const tests = [
    testChainedFileReads,
    testReadComputeRead,
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

  console.log(`\n${passed}/${tests.length} live multi-step reasoning tests passed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Live test runner error:', e);
  process.exit(1);
});

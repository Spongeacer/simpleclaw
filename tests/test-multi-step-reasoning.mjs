/**
 * Multi-Step Reasoning Test
 * Verifies AgentEngine's continuous reasoning capability using a mock LLM.
 *
 * Scenario: The model must read file A to discover the name of file B,
 * then read file B to find the answer. This requires at least 2 tool-call
 * rounds with stateful context propagation.
 */

import { AgentEngine } from '../dist/core/agent-engine.js';
import { ToolRegistry } from '../dist/agent-runtime/tool-registry.js';
import { FileAccessTracker } from '../dist/agent-runtime/file-tracker.js';
import { DockerSandbox } from '../dist/agent-runtime/sandbox.js';
import { ApprovalGate } from '../dist/agent-runtime/approval.js';
import { MemorySessionStore } from '../dist/gateway/session-store.js';
import { logger } from '../dist/core/logger.js';
import { createReadTool } from '../dist/agent-runtime/tools/index.js';
import { mkdir, writeFile, rm } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';

// ─── Mock LLM that plans a multi-step reasoning chain ────────────────────────

class MockMultiStepLLM {
  modelRef = { provider: 'mock', model: 'mock-reasoner' };
  callCount = 0;

  async complete(messages, tools) {
    this.callCount++;

    // Log what the model sees each round
    const userMsg = messages.filter(m => m.role === 'user').at(-1)?.content ?? '';
    const toolResults = messages.filter(m => m.role === 'tool').map(m => m.content);

    // Round 1: user asks the question → model should call read("hint.txt")
    if (this.callCount === 1) {
      if (!tools || tools.length === 0) {
        throw new Error('Expected tools to be available on round 1');
      }
      return {
        text: '',
        toolCalls: [{
          id: 'call-1',
          name: 'read',
          arguments: { path: 'hint.txt' },
        }],
        usage: { promptTokens: 100, completionTokens: 20 },
      };
    }

    // Round 2: model sees hint.txt content → should call read("secret.txt")
    if (this.callCount === 2) {
      const hasHintResult = toolResults.some(r => r.includes('secret.txt'));
      if (!hasHintResult) {
        throw new Error('Round 2: Model did not receive hint.txt content in context');
      }
      return {
        text: '',
        toolCalls: [{
          id: 'call-2',
          name: 'read',
          arguments: { path: 'secret.txt' },
        }],
        usage: { promptTokens: 150, completionTokens: 25 },
      };
    }

    // Round 3: model sees secret.txt content → should give final answer
    if (this.callCount === 3) {
      const hasSecretResult = toolResults.some(r => r.includes('banana'));
      if (!hasSecretResult) {
        throw new Error('Round 3: Model did not receive secret.txt content in context');
      }
      return {
        text: 'The answer is: banana',
        toolCalls: [],
        usage: { promptTokens: 200, completionTokens: 10 },
      };
    }

    throw new Error(`Unexpected call count: ${this.callCount}`);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testMultiStepReadChain() {
  const workspace = resolve(tmpdir(), `simpleclaw-reasoning-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  // hint.txt tells the model which file to read next
  await writeFile(resolve(workspace, 'hint.txt'), 'The secret is in secret.txt', 'utf-8');
  await writeFile(resolve(workspace, 'secret.txt'), 'The hidden fruit is banana.', 'utf-8');

  const store = new MemorySessionStore();
  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger
  );
  const tracker = new FileAccessTracker();
  const tools = new ToolRegistry();
  tools.register(createReadTool(sandbox, tracker));

  const mockLLM = new MockMultiStepLLM();

  const engine = new AgentEngine({
    config: {
      id: 'reasoning-test',
      name: 'ReasoningTest',
      model: { provider: 'mock', model: 'mock-reasoner' },
      tools: ['read'],
      approvalPolicy: 'never',
      workspace,
      memory: { enabled: false },
      maxIterations: 5,
    },
    store: store,
    llm: mockLLM,
    tools: tools,
    approval: new ApprovalGate('never', logger),
    logger: logger
  });

  const session = await store.create({
    sessionId: `reasoning-${Date.now()}`,
    agentId: 'reasoning-test',
    turns: [],
    tokenCount: 0,
  });

  const events = [];
  for await (const event of engine.chat(session.sessionId, 'Find the hidden fruit.')) {
    events.push(event);
  }

  // ─── Assertions ────────────────────────────────────────────────────────────

  // 1. Mock LLM was called exactly 3 times (read hint → read secret → answer)
  if (mockLLM.callCount !== 3) {
    throw new Error(`Expected 3 LLM calls, got ${mockLLM.callCount}`);
  }
  console.log('  ✅ Agent performed 3 reasoning rounds (2 tool calls + 1 answer)');

  // 2. There are exactly 2 tool_call events
  const toolCallEvents = events.filter(e => e.type === 'tool_call');
  if (toolCallEvents.length !== 2) {
    throw new Error(`Expected 2 tool_call events, got ${toolCallEvents.length}`);
  }
  console.log('  ✅ 2 tool calls emitted in sequence');

  // 3. First tool call reads hint.txt
  if (toolCallEvents[0].call.name !== 'read') {
    throw new Error(`Expected first tool to be 'read', got ${toolCallEvents[0].call.name}`);
  }
  if (!toolCallEvents[0].call.arguments.path.includes('hint.txt')) {
    throw new Error(`Expected first read to target hint.txt`);
  }
  console.log('  ✅ Round 1: read("hint.txt")');

  // 4. Second tool call reads secret.txt
  if (toolCallEvents[1].call.name !== 'read') {
    throw new Error(`Expected second tool to be 'read', got ${toolCallEvents[1].call.name}`);
  }
  if (!toolCallEvents[1].call.arguments.path.includes('secret.txt')) {
    throw new Error(`Expected second read to target secret.txt`);
  }
  console.log('  ✅ Round 2: read("secret.txt")');

  // 5. Final text contains the answer
  const textEvents = events.filter(e => e.type === 'text');
  const finalText = textEvents.map(e => e.text).join(' ');
  if (!finalText.toLowerCase().includes('banana')) {
    throw new Error(`Expected final answer to mention 'banana', got: ${finalText}`);
  }
  console.log('  ✅ Round 3: final answer contains "banana"');

  // 6. Verify session turns preserved the full chain
  const sessionState = await store.get(session.sessionId);
  const assistantTurns = sessionState.turns.filter(t => t.role === 'assistant');
  const toolTurns = sessionState.turns.filter(t => t.role === 'tool');

  // Should have: user + assistant(tool_call) + tool(result) + assistant(tool_call) + tool(result) + assistant(answer)
  if (assistantTurns.length < 3) {
    throw new Error(`Expected at least 3 assistant turns, got ${assistantTurns.length}`);
  }
  if (toolTurns.length !== 2) {
    throw new Error(`Expected 2 tool turns, got ${toolTurns.length}`);
  }
  console.log('  ✅ Session history preserves full reasoning chain');

  // 7. Verify the assistant turn that made the second tool call included the first tool result
  const secondAssistantTurn = assistantTurns[1];
  if (!secondAssistantTurn.toolCalls || secondAssistantTurn.toolCalls.length === 0) {
    throw new Error('Second assistant turn should contain tool calls');
  }
  console.log('  ✅ Second reasoning round had access to first tool result');

  await rm(workspace, { recursive: true, force: true });
}

async function testMaxIterationsEnforced() {
  const workspace = resolve(tmpdir(), `simpleclaw-reasoning-limit-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const store = new MemorySessionStore();
  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger
  );
  const tracker = new FileAccessTracker();
  const tools = new ToolRegistry();
  tools.register(createReadTool(sandbox, tracker));

  // Mock LLM that never gives a final answer (always calls tools)
  const infiniteLLM = {
    modelRef: { provider: 'mock', model: 'mock-infinite' },
    callCount: 0,
    async complete(_messages, _tools) {
      this.callCount++;
      return {
        text: '',
        toolCalls: [{
          id: `call-${this.callCount}`,
          name: 'read',
          arguments: { path: 'nonexistent.txt' },
        }],
        usage: { promptTokens: 50, completionTokens: 10 },
      };
    },
  };

  const engine = new AgentEngine({
    config: {
      id: 'limit-test',
      name: 'LimitTest',
      model: { provider: 'mock', model: 'mock-infinite' },
      tools: ['read'],
      approvalPolicy: 'never',
      workspace,
      memory: { enabled: false },
      maxIterations: 3,
    },
    store: store,
    llm: infiniteLLM,
    tools: tools,
    approval: new ApprovalGate('never', logger),
    logger: logger
  });

  const session = await store.create({
    sessionId: `limit-${Date.now()}`,
    agentId: 'limit-test',
    turns: [],
    tokenCount: 0,
  });

  const events = [];
  for await (const event of engine.chat(session.sessionId, 'Read something forever.')) {
    events.push(event);
  }

  // Should hit MAX_ITERATIONS error
  const errorEvents = events.filter(e => e.type === 'error');
  if (errorEvents.length === 0) {
    throw new Error('Expected MAX_ITERATIONS error event');
  }
  if (!errorEvents[0].message.includes('maximum number of tool iterations')) {
    throw new Error(`Expected max iterations error, got: ${errorEvents[0].message}`);
  }
  if (infiniteLLM.callCount !== 3) {
    throw new Error(`Expected exactly 3 LLM calls before cutoff, got ${infiniteLLM.callCount}`);
  }
  console.log('  ✅ maxIterations=3 correctly caps infinite tool-call loops');

  await rm(workspace, { recursive: true, force: true });
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  const tests = [
    testMultiStepReadChain,
    testMaxIterationsEnforced,
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

  console.log(`\n${passed}/${tests.length} multi-step reasoning tests passed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});

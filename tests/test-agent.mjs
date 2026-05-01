/**
 * End-to-end agent loop test (Node.js, no WebSocket)
 * Tests: create session → chat → tool calls → results → final answer
 */

import { AgentEngine } from '../dist/core/agent-engine.js';
import { ToolRegistry } from '../dist/agent-runtime/tool-registry.js';
import {
  createReadTool,
  createEditTool,
  createBashTool,
  createThinkTool,
  createGrepTool,
  createLsTool,
} from '../dist/agent-runtime/tools/index.js';
import { FileAccessTracker } from '../dist/agent-runtime/file-tracker.js';
import { DockerSandbox } from '../dist/agent-runtime/sandbox.js';
import { ApprovalGate } from '../dist/agent-runtime/approval.js';
import { MemorySessionStore } from '../dist/gateway/session-store.js';
import { logger } from '../dist/core/logger.js';
import { mkdir, writeFile, rm } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';

// ─── Custom Mock LLM that simulates tool calls ───────────────────────────────

class MockToolLLM {
  modelRef = { provider: 'mock', model: 'mock-tool' };
  callCount = 0;

  async complete(messages, tools) {
    this.callCount++;
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const text = lastUser?.content ?? '';

    // First call: always request a tool call if tools available
    if (this.callCount === 1 && tools?.length > 0) {
      return {
        text: '',
        toolCalls: [{
          id: `call-${Date.now()}`,
          name: 'read',
          arguments: { path: 'hello.txt' },
        }],
        usage: { promptTokens: 20, completionTokens: 15 },
      };
    }

    // Second call: after seeing tool result, give final answer
    return {
      text: `I read the file and found: "${text.slice(0, 80)}"`,
      usage: { promptTokens: 30, completionTokens: 12 },
    };
  }
}

// ─── Test ────────────────────────────────────────────────────────────────────

async function run() {
  const workspace = resolve(tmpdir(), `simpleclaw-test-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, 'hello.txt'), 'Hello from SimpleClaw!', 'utf-8');

  console.log(`Workspace: ${workspace}`);

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
  tools.register(createThinkTool());
  tools.register(createGrepTool(sandbox, workspace));
  tools.register(createLsTool(workspace));
  const approval = new ApprovalGate('never', logger); // auto-approve for test
  const llm = new MockToolLLM();

  const engine = new AgentEngine(
    {
      id: 'test-agent',
      name: 'Test',
      model: { provider: 'mock', model: 'mock-tool' },
      systemPrompt: 'You are a helpful assistant.',
      tools: ['read', 'edit', 'shell'],
      approvalPolicy: 'never',
      workspace,
    },
    store,
    llm,
    tools,
    approval,
    logger
  );

  // Create session
  const session = await store.create({
    sessionId: `sess-${Date.now()}`,
    agentId: 'test-agent',
    turns: [],
    tokenCount: 0,
  });
  console.log(`Session created: ${session.sessionId}`);

  // Run chat
  console.log('\n--- Chat Start ---');
  const events = [];
  for await (const event of engine.chat(session.sessionId, 'Please read hello.txt')) {
    events.push(event);
    console.log('Event:', JSON.stringify(event));
  }
  console.log('--- Chat End ---\n');

  // Verify
  const thinkingEvents = events.filter(e => e.type === 'thinking');
  const toolCallEvents = events.filter(e => e.type === 'tool_call');
  const toolResultEvents = events.filter(e => e.type === 'tool_result');
  const textEvents = events.filter(e => e.type === 'text');
  const doneEvents = events.filter(e => e.type === 'done');

  console.log('Results:');
  console.log(`  Thinking events: ${thinkingEvents.length}`);
  console.log(`  Tool call events: ${toolCallEvents.length}`);
  console.log(`  Tool result events: ${toolResultEvents.length}`);
  console.log(`  Text events: ${textEvents.length}`);
  console.log(`  Done events: ${doneEvents.length}`);

  // Assertions
  const errors = [];
  if (toolCallEvents.length !== 1) errors.push(`Expected 1 tool_call, got ${toolCallEvents.length}`);
  if (toolResultEvents.length !== 1) errors.push(`Expected 1 tool_result, got ${toolResultEvents.length}`);
  if (textEvents.length !== 1) errors.push(`Expected 1 text event, got ${textEvents.length}`);
  if (doneEvents.length !== 1) errors.push(`Expected 1 done event, got ${doneEvents.length}`);

  const result = toolResultEvents[0]?.result;
  if (!result?.output?.includes('Hello from SimpleClaw')) {
    errors.push(`Tool result missing expected content: ${result?.output}`);
  }

  // Cleanup
  await rm(workspace, { recursive: true, force: true });

  if (errors.length > 0) {
    console.error('\nFAILED:');
    for (const e of errors) console.error('  -', e);
    process.exit(1);
  }

  console.log('\nAll tests passed!');
}

run().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});

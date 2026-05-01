/**
 * Context compaction test
 */

import { AgentEngine } from '../dist/core/agent-engine.js';
import { ToolRegistry } from '../dist/agent-runtime/tool-registry.js';
import { createReadTool } from '../dist/agent-runtime/tools/read.js';
import { FileAccessTracker } from '../dist/agent-runtime/file-tracker.js';
import { DockerSandbox } from '../dist/agent-runtime/sandbox.js';
import { ApprovalGate } from '../dist/agent-runtime/approval.js';
import { MemorySessionStore } from '../dist/gateway/session-store.js';
import { logger } from '../dist/core/logger.js';
import { mkdir, writeFile, rm } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';

// Mock LLM that counts calls and returns predictable responses
class MockCompactLLM {
  modelRef = { provider: 'mock', model: 'mock-compact' };
  calls = [];

  async complete(messages, tools) {
    const isSummary = messages.some(m => m.role === 'system' && m.content.includes('CONTEXT CHECKPOINT COMPACTION'));
    this.calls.push({ isSummary, messageCount: messages.length });

    if (isSummary) {
      return {
        text: 'Summary: user asked about hello.txt, agent read it successfully.',
        usage: { promptTokens: 50, completionTokens: 20 },
      };
    }

    // Normal agent response
    return {
      text: 'Done.',
      usage: { promptTokens: 10, completionTokens: 5 },
    };
  }
}

async function run() {
  const workspace = resolve(tmpdir(), `simpleclaw-compact-test-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, 'hello.txt'), 'Hello!', 'utf-8');

  const store = new MemorySessionStore();
  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger
  );
  const tracker = new FileAccessTracker();
  const tools = new ToolRegistry();
  tools.register(createReadTool(sandbox, tracker));

  const llm = new MockCompactLLM();
  const engine = new AgentEngine({
    config: {
      id: 'test',
      name: 'Test',
      model: { provider: 'mock', model: 'mock' },
      tools: ['read'],
      approvalPolicy: 'never',
      workspace,
      compaction: { thresholdTokens: 10, preserveTurns: 2, summaryMaxLength: 200 },
    },
    store: store,
    llm: llm,
    tools: tools,
    approval: new ApprovalGate('never', logger),
    logger: logger
  });

  // Create session with many turns to trigger compaction
  const session = await store.create({
    sessionId: `sess-${Date.now()}`,
    agentId: 'test',
    turns: [
      { id: '1', role: 'user', content: 'Message 1', timestamp: new Date() },
      { id: '2', role: 'assistant', content: 'Reply 1', timestamp: new Date() },
      { id: '3', role: 'user', content: 'Message 2', timestamp: new Date() },
      { id: '4', role: 'assistant', content: 'Reply 2', timestamp: new Date() },
      { id: '5', role: 'user', content: 'Message 3', timestamp: new Date() },
      { id: '6', role: 'assistant', content: 'Reply 3', timestamp: new Date() },
    ],
    tokenCount: 0,
  });

  console.log(`Session with ${session.turns.length} turns`);

  // Run one chat iteration
  const events = [];
  for await (const event of engine.chat(session.sessionId, 'Final message')) {
    events.push(event);
  }

  console.log(`Events: ${events.map(e => e.type).join(', ')}`);
  console.log(`LLM calls: ${llm.calls.length}`);
  console.log(`Summary call? ${llm.calls.some(c => c.isSummary)}`);

  const summaryCall = llm.calls.find(c => c.isSummary);
  if (summaryCall) {
    console.log(`Summary call had ${summaryCall.messageCount} messages`);
  }

  // Cleanup
  await rm(workspace, { recursive: true, force: true });

  const ok = llm.calls.some(c => c.isSummary);
  console.log(ok ? '\nCompaction test PASSED!' : '\nCompaction test FAILED: no summary call');
  process.exit(ok ? 0 : 1);
}

run().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});

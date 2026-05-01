/**
 * Agent Engine Prompt Orchestration Tests
 * Tests: session flags, stable prompt caching, orphan repair, working set, summary embedding.
 */

import { AgentEngine } from '../dist/core/agent-engine.js';
import { ToolRegistry } from '../dist/agent-runtime/tool-registry.js';
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

// ─── Recording LLM that captures every message batch ─────────────────────────

class RecordingLLM {
  modelRef = { provider: 'mock', model: 'mock-recorder' };
  calls = [];

  async complete(messages, tools) {
    this.calls.push({ messages: structuredClone(messages), tools });
    return { text: 'Done.', usage: { promptTokens: 10, completionTokens: 2 } };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function setupWorkspace() {
  const workspace = resolve(tmpdir(), `simpleclaw-orch-test-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, 'hello.txt'), 'Hello!', 'utf-8');
  await writeFile(resolve(workspace, 'AGENTS.md'), '# Rules\n\n- Use TypeScript.\n- No any.', 'utf-8');
  return workspace;
}

function getSystemPrompt(messages) {
  // Merge all system messages (stable prefix + dynamic suffix)
  return messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
}

function createEngine(store, llm, workspace, instructions, skills, extraConfig = {}) {
  const sandbox = new DockerSandbox(workspace, { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] }, logger);
  const tracker = new FileAccessTracker();
  const tools = new ToolRegistry();
  tools.register(createReadTool(sandbox, tracker));
  tools.register(createEditTool(sandbox, tracker));
  tools.register(createBashTool(sandbox));

  return new AgentEngine(
    {
      id: 'test-agent',
      name: 'Test',
      model: { provider: 'mock', model: 'mock-recorder' },
      tools: ['read', 'edit', 'bash'],
      approvalPolicy: 'never',
      workspace,
      ...extraConfig,
    },
    store,
    llm,
    tools,
    new ApprovalGate('never', logger),
    logger,
    undefined,
    instructions,
    skills,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testInstructionsInjectedOnlyOnce() {
  const workspace = await setupWorkspace();
  const store = new MemorySessionStore();
  const llm = new RecordingLLM();
  const instructions = '=== PROJECT INSTRUCTIONS ===\nUse TypeScript.\nNo any.';

  const engine = createEngine(store, llm, workspace, instructions, undefined);

  // First chat
  const session1 = await store.create({ sessionId: `s1-${Date.now()}`, agentId: 'test-agent', turns: [], tokenCount: 0 });
  for await (const _ of engine.chat(session1.sessionId, 'Hello')) {}

  // Second chat (same session)
  for await (const _ of engine.chat(session1.sessionId, 'Again')) {}

  // Third chat (same session) — compaction simulation: replace turns with system summary turn
  const sessionState = await store.get(session1.sessionId);
  sessionState.turns = [
    { id: 'sys', role: 'system', content: 'Compacted summary', timestamp: new Date() },
    { id: 'u3', role: 'user', content: 'Third', timestamp: new Date() },
  ];
  await store.update(session1.sessionId, { turns: sessionState.turns });
  for await (const _ of engine.chat(session1.sessionId, 'Third message')) {}

  // Inspect system prompts
  const firstPrompt = getSystemPrompt(llm.calls[0].messages);
  const secondPrompt = getSystemPrompt(llm.calls[1].messages);
  const thirdPrompt = getSystemPrompt(llm.calls[2].messages);

  // First chat must contain instructions
  if (!firstPrompt.includes('PROJECT INSTRUCTIONS')) {
    throw new Error('First chat should include instructions');
  }

  // Second chat should NOT contain instructions
  if (secondPrompt.includes('PROJECT INSTRUCTIONS')) {
    throw new Error('Second chat should NOT repeat instructions');
  }

  // Third chat (after compaction) should also NOT contain instructions
  if (thirdPrompt.includes('PROJECT INSTRUCTIONS')) {
    throw new Error('Third chat (after compaction) should NOT repeat instructions');
  }

  // Verify metadata flag was set
  const finalState = await store.get(session1.sessionId);
  if (finalState.metadata?.instructionsInjected !== true) {
    throw new Error('Expected instructionsInjected flag to be true');
  }

  await rm(workspace, { recursive: true, force: true });
  console.log('  ✅ Instructions injected exactly once, survives compaction');
}

async function testStableSystemPromptCached() {
  const workspace = await setupWorkspace();
  const store = new MemorySessionStore();
  const llm = new RecordingLLM();

  const engine = createEngine(store, llm, workspace);

  const session = await store.create({ sessionId: `s2-${Date.now()}`, agentId: 'test-agent', turns: [], tokenCount: 0 });

  // Two chats
  for await (const _ of engine.chat(session.sessionId, 'Hello')) {}
  for await (const _ of engine.chat(session.sessionId, 'World')) {}

  const firstPrompt = getSystemPrompt(llm.calls[0].messages);
  const secondPrompt = getSystemPrompt(llm.calls[1].messages);

  // Both should contain stable parts
  if (!firstPrompt.includes('=== BASE PERSONA ===')) {
    throw new Error('First prompt missing BASE PERSONA');
  }
  if (!secondPrompt.includes('=== BASE PERSONA ===')) {
    throw new Error('Second prompt missing BASE PERSONA');
  }

  // Stable parts should be identical
  // (Dynamic parts differ because second chat has more turns)
  // We verify by checking that the engine has a stableSystemPrompt field
  // Since it's private, we check indirectly: both prompts contain the same tool list
  const toolSectionRe = /=== TOOLS ===[\s\S]*?=== CORE RULES ===/;
  const firstTools = firstPrompt.match(toolSectionRe)?.[0] || '';
  const secondTools = secondPrompt.match(toolSectionRe)?.[0] || '';
  if (firstTools !== secondTools) {
    throw new Error('Stable tool guidance should be identical between turns');
  }

  await rm(workspace, { recursive: true, force: true });
  console.log('  ✅ Stable system prompt cached between turns');
}

async function testCompactedSummaryEmbeddedInSystemPrompt() {
  const workspace = await setupWorkspace();
  const store = new MemorySessionStore();

  // Mock LLM that returns a recognizable summary when asked
  let summaryCallCount = 0;
  const llm = {
    modelRef: { provider: 'mock', model: 'mock-summary' },
    calls: [],
    async complete(messages, tools) {
      this.calls.push({ messages });
      const isSummary = messages.some(m => m.role === 'system' && m.content.includes('Summarize'));
      if (isSummary) {
        summaryCallCount++;
        return {
          text: '## Goal\n- Test compaction\n\n## Relevant Files\n- hello.txt',
          usage: { promptTokens: 20, completionTokens: 10 },
        };
      }
      return { text: 'Done.', usage: { promptTokens: 10, completionTokens: 2 } };
    },
  };

  const engine = createEngine(store, llm, workspace, undefined, undefined, {
    compaction: { thresholdTokens: 50, preserveTurns: 2, summaryMaxLength: 4000 },
  });

  // Seed many turns to force compaction
  const session = await store.create({
    sessionId: `s3-${Date.now()}`,
    agentId: 'test-agent',
    turns: Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'Message '.repeat(50),
      timestamp: new Date(),
    })),
    tokenCount: 0,
  });

  for await (const _ of engine.chat(session.sessionId, 'Final message')) {}

  // Find the agent call that happened after compaction
  const agentCalls = llm.calls.filter(c =>
    !c.messages.some(m => m.role === 'system' && m.content.includes('Summarize'))
  );

  if (agentCalls.length === 0) {
    throw new Error('Expected at least one agent call after compaction');
  }

  const lastAgentCall = agentCalls[agentCalls.length - 1];
  const systemMessages = lastAgentCall.messages.filter(m => m.role === 'system');
  if (systemMessages.length === 0) {
    throw new Error('Expected at least one system message');
  }

  // Merge all system messages for content inspection
  const systemPrompt = getSystemPrompt(lastAgentCall.messages);

  // Summary should be embedded in the system prompt
  if (!systemPrompt.includes('=== COMPACTED HISTORY ===')) {
    throw new Error('Expected COMPACTED HISTORY slot in system prompt');
  }

  // With cache boundary, we expect 2 system messages (stable + dynamic)
  if (systemMessages.length !== 2) {
    throw new Error(`Expected exactly 2 system messages (stable + dynamic), got ${systemMessages.length}`);
  }

  await rm(workspace, { recursive: true, force: true });
  console.log('  ✅ Compacted summary embedded in system prompt, no separate system turn');
}

async function testOrphanToolResultsRepaired() {
  const workspace = await setupWorkspace();
  const store = new MemorySessionStore();
  const llm = new RecordingLLM();

  const engine = createEngine(store, llm, workspace);

  // Create a session with an orphan tool result (no matching assistant toolCall)
  const session = await store.create({
    sessionId: `s4-${Date.now()}`,
    agentId: 'test-agent',
    turns: [
      { id: 'u1', role: 'user', content: 'Hello', timestamp: new Date() },
      { id: 'a1', role: 'assistant', content: 'Hi', timestamp: new Date() },
      // Orphan: tool result without matching assistant toolCall
      { id: 't-orphan', role: 'tool', content: 'Orphan result', toolCallId: 'nonexistent', timestamp: new Date() },
      { id: 'u2', role: 'user', content: 'Read file', timestamp: new Date() },
    ],
    tokenCount: 0,
  });

  for await (const _ of engine.chat(session.sessionId, 'Please read hello.txt')) {}

  const agentCall = llm.calls[0];
  const toolMessages = agentCall.messages.filter(m => m.role === 'tool');

  // The orphan should NOT appear in messages sent to LLM
  const hasOrphan = toolMessages.some(m => m.content === 'Orphan result');
  if (hasOrphan) {
    throw new Error('Orphan tool result should be filtered out before sending to LLM');
  }

  // But legitimate tool results should still work (read tool result from the turn)
  // Note: our Mock LLM returns no toolCalls so the actual read won't happen in this test.
  // We verify the repair logic by checking the orphan is gone.

  await rm(workspace, { recursive: true, force: true });
  console.log('  ✅ Orphan tool results filtered from LLM messages');
}

async function testWorkingSetTracksAnyPathTool() {
  const workspace = await setupWorkspace();
  const store = new MemorySessionStore();

  // Mock LLM that always calls read with a path
  const llm = {
    modelRef: { provider: 'mock', model: 'mock-path' },
    calls: [],
    async complete(messages, tools) {
      this.calls.push({ messages });
      return {
        text: '',
        toolCalls: [{ id: 'tc1', name: 'read', arguments: { path: 'hello.txt' } }],
        usage: { promptTokens: 10, completionTokens: 5 },
      };
    },
  };

  const engine = createEngine(store, llm, workspace);

  const session = await store.create({ sessionId: `s5-${Date.now()}`, agentId: 'test-agent', turns: [], tokenCount: 0 });

  // Run a chat that triggers a tool call
  const events = [];
  for await (const e of engine.chat(session.sessionId, 'Read hello.txt')) {
    events.push(e);
  }

  // Now trigger a second chat; the working set should contain hello.txt
  // We verify by checking the system prompt contains the WORKING SET section
  llm.calls.length = 0; // reset
  for await (const e of engine.chat(session.sessionId, 'What did it say?')) {
    events.push(e);
  }

  const systemPrompt = getSystemPrompt(llm.calls[0]?.messages ?? []);
  if (!systemPrompt) {
    throw new Error('Expected system message');
  }

  if (!systemPrompt.includes('=== WORKING SET ===')) {
    throw new Error('Expected WORKING SET section in system prompt after path-based tool call');
  }
  if (!systemPrompt.includes('hello.txt')) {
    throw new Error('Expected hello.txt in working set');
  }

  await rm(workspace, { recursive: true, force: true });
  console.log('  ✅ Working set tracks any tool call with path argument');
}

async function testTotalToolCallRoundsTracked() {
  const workspace = await setupWorkspace();
  const store = new MemorySessionStore();

  // Mock LLM that always calls a tool
  let callNum = 0;
  const llm = {
    modelRef: { provider: 'mock', model: 'mock-loop' },
    calls: [],
    async complete(messages, tools) {
      this.calls.push({ messages });
      callNum++;
      if (callNum <= 3) {
        return {
          text: '',
          toolCalls: [{ id: `tc${callNum}`, name: 'bash', arguments: { command: 'echo hi' } }],
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      }
      return { text: 'Done after 3 tools.', usage: { promptTokens: 10, completionTokens: 2 } };
    },
  };

  const engine = createEngine(store, llm, workspace);

  const session = await store.create({ sessionId: `s6-${Date.now()}`, agentId: 'test-agent', turns: [], tokenCount: 0 });

  for await (const _ of engine.chat(session.sessionId, 'Run some commands')) {}

  const finalState = await store.get(session.sessionId);
  const totalRounds = finalState.metadata?.totalToolCallRounds;
  if (totalRounds !== 3) {
    throw new Error(`Expected totalToolCallRounds=3, got ${totalRounds}`);
  }

  await rm(workspace, { recursive: true, force: true });
  console.log('  ✅ Total tool call rounds tracked in session metadata');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  const tests = [
    testInstructionsInjectedOnlyOnce,
    testStableSystemPromptCached,
    testCompactedSummaryEmbeddedInSystemPrompt,
    testOrphanToolResultsRepaired,
    testWorkingSetTracksAnyPathTool,
    testTotalToolCallRoundsTracked,
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

  console.log(`\n${passed}/${tests.length} prompt orchestration tests passed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});

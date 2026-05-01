/**
 * Compactor unit tests
 * Tests: token estimation, tool-pair preservation, truncation, summary format.
 */

import { ContextCompactor, DEFAULT_COMPACTOR_CONFIG } from '../dist/core/compactor.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTurn(id, role, content, extras = {}) {
  return { id, role, content, timestamp: new Date(), ...extras };
}

function makeAssistantWithTools(id, content, toolCalls) {
  return makeTurn(id, 'assistant', content, { toolCalls });
}

function makeToolResult(id, content, toolCallId) {
  return makeTurn(id, 'tool', content, { toolCallId });
}

class MockLLM {
  modelRef = { provider: 'mock', model: 'mock-compact' };
  calls = [];

  async complete(messages, _tools) {
    this.calls.push({ messages });
    return {
      text: '## Goal\n- Test task\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- (none)\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)',
      usage: { promptTokens: 10, completionTokens: 10 },
    };
  }
}

class MockLogger {
  debug() {}
  info() {}
  warn() {}
  error() {}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testTokenEstimationIncludesSystemPrompt() {
  const llm = new MockLLM();
  const compactor = new ContextCompactor(llm, new MockLogger());

  // Create turns that are just under threshold
  const turns = [];
  for (let i = 0; i < 6; i++) {
    turns.push(makeTurn(`u${i}`, 'user', 'Hello world '.repeat(100)));
    turns.push(makeTurn(`a${i}`, 'assistant', 'Response '.repeat(100)));
  }

  // Without system prompt: should NOT compact (threshold 6000)
  const r1 = await compactor.compact(turns, DEFAULT_COMPACTOR_CONFIG);
  if (r1.didCompact) {
    throw new Error('Expected no compaction without system prompt, but it compacted');
  }

  // With a large system prompt: SHOULD compact
  const bigSystemPrompt = 'Base persona. '.repeat(2000); // ~32000 chars = ~9600 tokens with margin
  const r2 = await compactor.compact(turns, DEFAULT_COMPACTOR_CONFIG, { systemPromptText: bigSystemPrompt });
  if (!r2.didCompact) {
    throw new Error('Expected compaction when system prompt pushes over threshold');
  }

  console.log('  ✅ Token estimation includes system prompt');
}

async function testToolPairsArePreserved() {
  const llm = new MockLLM();
  const compactor = new ContextCompactor(llm, new MockLogger());

  const turns = [
    makeTurn('u1', 'user', 'First message'),
    makeTurn('a1', 'assistant', 'First reply'),
    makeTurn('u2', 'user', 'Read a file'),
    makeAssistantWithTools('a2', '', [{ id: 'tc1', name: 'read', arguments: { path: 'a.txt' } }]),
    makeToolResult('t1', 'Content of a.txt', 'tc1'),
    makeTurn('u3', 'user', 'Now edit it'),
    makeAssistantWithTools('a3', '', [{ id: 'tc2', name: 'edit', arguments: { path: 'a.txt', old_string: 'x', new_string: 'y' } }]),
    makeToolResult('t2', 'Edited a.txt', 'tc2'),
    makeTurn('u4', 'user', 'Final message'),
    makeTurn('a4', 'assistant', 'Final reply'),
  ];

  const config = { ...DEFAULT_COMPACTOR_CONFIG, thresholdTokens: 10, preserveTurns: 2 };
  const { compacted, didCompact, summary } = await compactor.compact(turns, config);

  if (!didCompact) {
    throw new Error('Expected compaction');
  }

  // Verify summary is a string, not a turn
  if (typeof summary !== 'string') {
    throw new Error(`Expected summary to be a string, got ${typeof summary}`);
  }

  // Verify compacted does NOT contain a system-turn summary
  const systemTurns = compacted.filter(t => t.role === 'system');
  if (systemTurns.length > 0) {
    throw new Error(`Expected no system turns in compacted, found ${systemTurns.length}`);
  }

  // Verify tool pairs are preserved: we should never see an assistant tool call
  // without its matching tool result in the preserved turns.
  const preservedIds = new Set(compacted.map(t => t.id));
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role === 'assistant' && t.toolCalls && preservedIds.has(t.id)) {
      // All matching tool results must also be preserved
      const callIds = new Set(t.toolCalls.map(tc => tc.id));
      for (let j = i + 1; j < turns.length; j++) {
        const next = turns[j];
        if (next.role === 'tool' && callIds.has(next.toolCallId)) {
          if (!preservedIds.has(next.id)) {
            throw new Error(`Tool pair broken: assistant ${t.id} preserved but tool ${next.id} was summarized`);
          }
        }
      }
    }
  }

  // Verify the preserved turns contain the most recent turns
  if (!preservedIds.has('u4') || !preservedIds.has('a4')) {
    throw new Error('Expected most recent turns to be preserved');
  }

  console.log('  ✅ Tool pairs are preserved during compaction');
}

async function testTruncationBeforeSummarization() {
  const llm = new MockLLM();
  const compactor = new ContextCompactor(llm, new MockLogger());

  // Create a conversation where the overshoot is small and caused by ONE
  // oversized tool result. Baseline turns are small; the tool result pushes
  // us just over threshold so truncation alone resolves it.
  const hugeOutput = 'Line\n'.repeat(800); // ~4800 chars → ~1440 tokens
  const turns = [
    makeTurn('u1', 'user', 'Hello'),
    makeTurn('a1', 'assistant', 'Hi'),
    makeTurn('u2', 'user', 'Run command'),
    makeAssistantWithTools('a2', '', [{ id: 'tc1', name: 'bash', arguments: { command: 'echo hi' } }]),
    makeToolResult('t1', hugeOutput, 'tc1'),
    makeTurn('u3', 'user', 'Thanks'),
    makeTurn('a3', 'assistant', 'You are welcome'),
  ];

  // Threshold 1000: baseline ~30 chars + 4800 tool = ~1450 tokens.
  // Overshoot ~450 < 2000, so truncation stage runs.
  // After truncation tool becomes ~600 chars → ~180 tokens.
  // Total ~210 tokens < 1000 → resolved without LLM summary.
  const config = { ...DEFAULT_COMPACTOR_CONFIG, thresholdTokens: 1000, preserveTurns: 2 };
  const { compacted, didCompact, summary } = await compactor.compact(turns, config);

  if (!didCompact) {
    throw new Error('Expected compaction');
  }

  // The overshoot should be small enough that truncation resolves it without LLM summary
  if (summary !== null) {
    throw new Error(`Expected truncation to resolve compaction without LLM summary, but got summary: ${summary?.slice(0, 50)}`);
  }

  // Verify the huge tool result was truncated
  const toolTurn = compacted.find(t => t.role === 'tool' && t.id === 't1');
  if (!toolTurn) {
    throw new Error('Expected truncated tool turn to still exist');
  }
  if (toolTurn.content.includes(hugeOutput)) {
    throw new Error('Expected tool result to be truncated');
  }
  if (!toolTurn.content.includes('[...truncated')) {
    throw new Error('Expected truncation marker in tool result');
  }

  // Verify LLM was NOT called for summarization
  if (llm.calls.length > 0) {
    throw new Error(`Expected no LLM calls for truncation-only compaction, got ${llm.calls.length}`);
  }

  console.log('  ✅ Truncation applied before LLM summarization');
}

async function testTokenEstimationAccuracy() {
  const llm = new MockLLM();
  const compactor = new ContextCompactor(llm, new MockLogger());

  // The estimateTokens method is private, but we can observe behavior indirectly.
  // Create turns of known size and verify compaction triggers at expected threshold.
  // 1000 chars / 4 * 1.2 = 300 tokens per turn
  const singleTurn = makeTurn('u1', 'user', 'x'.repeat(1000));

  // With 20 such turns = ~6000 estimated tokens
  const turns = Array.from({ length: 20 }, (_, i) => ({ ...singleTurn, id: `t${i}` }));

  // Threshold 5000 should trigger compaction
  const r1 = await compactor.compact(turns, { ...DEFAULT_COMPACTOR_CONFIG, thresholdTokens: 5000, preserveTurns: 2 });
  if (!r1.didCompact) {
    throw new Error('Expected compaction at threshold 5000 for 20k-char turns');
  }

  // Threshold 10000 should NOT trigger
  const r2 = await compactor.compact(turns, { ...DEFAULT_COMPACTOR_CONFIG, thresholdTokens: 10000, preserveTurns: 2 });
  if (r2.didCompact) {
    throw new Error('Expected no compaction at threshold 10000');
  }

  console.log('  ✅ Token estimation accuracy (indirect)');
}

async function testSummaryIsNotASystemTurn() {
  const llm = new MockLLM();
  const compactor = new ContextCompactor(llm, new MockLogger());

  const turns = [
    makeTurn('u1', 'user', 'Hello world'),
    makeTurn('a1', 'assistant', 'Hi there'),
    makeTurn('u2', 'user', 'What is the weather?'),
    makeTurn('a2', 'assistant', 'Sunny.'),
  ];

  const config = { ...DEFAULT_COMPACTOR_CONFIG, thresholdTokens: 10, preserveTurns: 2 };
  const { compacted, summary } = await compactor.compact(turns, config);

  if (typeof summary !== 'string') {
    throw new Error(`Expected summary string, got ${typeof summary}`);
  }

  const hasSystemSummary = compacted.some(t =>
    t.role === 'system' && t.content.includes('ANCHORED CONTEXT')
  );
  if (hasSystemSummary) {
    throw new Error('Summary must NOT be injected as a system turn');
  }

  console.log('  ✅ Summary returned as string, not system turn');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  const tests = [
    testTokenEstimationIncludesSystemPrompt,
    testToolPairsArePreserved,
    testTruncationBeforeSummarization,
    testTokenEstimationAccuracy,
    testSummaryIsNotASystemTurn,
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

  console.log(`\n${passed}/${tests.length} compactor unit tests passed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});

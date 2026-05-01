/**
 * Tool Usage Benchmark — Measures tool call rate and rationality across 100 diverse queries.
 *
 * Usage:
 *   node test-tool-usage-benchmark.mjs --mock              # Validate framework with mock LLM
 *   node test-tool-usage-benchmark.mjs --live --limit 20   # Run 20 queries against real LLM
 *   node test-tool-usage-benchmark.mjs --live --category read,edit  # Filter by category
 */

import { readFile } from 'fs/promises';
import { writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isMock = args.includes('--mock');
const isLive = args.includes('--live');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined;
const categoryArg = args.find(a => a.startsWith('--category='));
const categories = categoryArg ? categoryArg.split('=')[1].split(',') : undefined;
const outArg = args.find(a => a.startsWith('--out='));
const outPath = outArg ? outArg.split('=')[1] : resolve(__dirname, 'tool-usage-report.json');

if (!isMock && !isLive) {
  console.log(`Usage: node test-tool-usage-benchmark.mjs [--mock | --live] [--limit=N] [--category=a,b,c] [--out=path.json]`);
  process.exit(1);
}

// ─── Load benchmark dataset ──────────────────────────────────────────────────

const datasetPath = resolve(__dirname, 'test-tool-usage-benchmark.json');
const dataset = JSON.parse(await readFile(datasetPath, 'utf-8'));
let queries = dataset.queries;

if (categories) {
  queries = queries.filter(q => categories.includes(q.category));
}
if (limit) {
  queries = queries.slice(0, limit);
}

console.log(`\n🧪 Tool Usage Benchmark`);
console.log(`   Mode: ${isMock ? 'MOCK' : 'LIVE'}`);
console.log(`   Queries: ${queries.length}${limit ? ` (limited from ${dataset.queries.length})` : ''}`);
if (categories) console.log(`   Categories: ${categories.join(', ')}`);
console.log('');

// ─── Setup ───────────────────────────────────────────────────────────────────

const { AgentEngine } = await import('../dist/core/agent-engine.js');
const { ToolRegistry } = await import('../dist/agent-runtime/tool-registry.js');
const {
  createReadTool, createEditTool, createBashTool, createThinkTool,
  createGrepTool, createLsTool, createGlobTool, createWebSearchTool, createWebFetchTool,
  createSkillTool,
} = await import('../dist/agent-runtime/tools/index.js');
const { FileAccessTracker } = await import('../dist/agent-runtime/file-tracker.js');
const { DockerSandbox } = await import('../dist/agent-runtime/sandbox.js');
const { ApprovalGate } = await import('../dist/agent-runtime/approval.js');
const { MemorySessionStore } = await import('../dist/gateway/session-store.js');
const { logger } = await import('../dist/core/logger.js');
const { mkdir, rm, writeFile: writeFileFs } = await import('fs/promises');
const { tmpdir } = await import('os');

// Create a minimal workspace for the benchmark
const workspace = resolve(tmpdir(), `simpleclaw-bench-${Date.now()}`);
await mkdir(resolve(workspace, 'src'), { recursive: true });
await writeFileFs(resolve(workspace, 'package.json'), JSON.stringify({ name: "bench-project", version: "1.0.0" }, null, 2), 'utf-8');
await writeFileFs(resolve(workspace, 'src', 'index.ts'), 'export function main() { console.log("hello"); }', 'utf-8');
await writeFileFs(resolve(workspace, 'README.md'), '# Bench Project\n\nA sample project for benchmarking.', 'utf-8');
await writeFileFs(resolve(workspace, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}', 'utf-8');

// ─── LLM Clients ─────────────────────────────────────────────────────────────

class MockLLM {
  modelRef = { provider: 'mock', model: 'mock-bench' };
  callCount = 0;

  async complete(messages, tools) {
    this.callCount++;
    // If this is a follow-up turn (assistant already emitted tool_calls), return final answer
    const hasPriorToolCalls = messages.some(m => m.role === 'assistant' && m.toolCalls?.length > 0);
    if (hasPriorToolCalls) {
      return { text: 'Done.', toolCalls: undefined, usage: { promptTokens: 30, completionTokens: 5 } };
    }

    // Deterministic mock: if user message contains certain keywords, return tool calls
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const text = lastUser?.content?.toLowerCase() || '';

    const toolCalls = [];

    // Simple keyword matching for mock behavior
    if (text.includes('read') || text.includes('show me') || text.includes('check') || text.includes('what\'s in')) {
      toolCalls.push({ id: `tc${this.callCount}-1`, name: 'read', arguments: { path: 'src/index.ts' } });
    }
    if (text.includes('edit') || text.includes('add') || text.includes('fix') || text.includes('update') || text.includes('remove')) {
      toolCalls.push({ id: `tc${this.callCount}-2`, name: 'read', arguments: { path: 'src/index.ts' } });
      toolCalls.push({ id: `tc${this.callCount}-3`, name: 'edit', arguments: { path: 'src/index.ts', old_string: 'console.log("hello")', new_string: 'console.log("world")' } });
    }
    if (text.includes('search') || text.includes('find') || text.includes('grep')) {
      toolCalls.push({ id: `tc${this.callCount}-4`, name: 'grep', arguments: { pattern: 'TODO', path: '.' } });
    }
    if (text.includes('list') || text.includes('show') || text.includes('directory')) {
      toolCalls.push({ id: `tc${this.callCount}-5`, name: 'ls', arguments: { path: '.' } });
    }
    if (text.includes('run') || text.includes('execute') || text.includes('install') || text.includes('build') || text.includes('test')) {
      toolCalls.push({ id: `tc${this.callCount}-6`, name: 'bash', arguments: { command: 'echo "mock output"' } });
    }
    if (text.includes('web') || text.includes('fetch') || text.includes('search for') || text.includes('look up')) {
      toolCalls.push({ id: `tc${this.callCount}-7`, name: 'web_search', arguments: { query: 'mock search' } });
    }

    // Deduplicate by name (mock simplification)
    const seen = new Set();
    const unique = [];
    for (const tc of toolCalls) {
      if (!seen.has(tc.name)) {
        seen.add(tc.name);
        unique.push(tc);
      }
    }

    return {
      text: unique.length > 0 ? '' : 'I can help with that!',
      toolCalls: unique.length > 0 ? unique : undefined,
      usage: { promptTokens: 50, completionTokens: 20 },
    };
  }
}

async function createLiveLLM() {
  const { OpenAICompatibleClient } = await import('../dist/agent-runtime/providers/openai-compatible.js');
  const { API_KEY, BASE_URL, MODEL } = await import('./test-live-config.mjs');
  return new OpenAICompatibleClient(
    { provider: 'openrouter', model: MODEL, temperature: 0 },
    { apiKey: API_KEY, baseURL: BASE_URL }
  );
}

// ─── Engine Setup ────────────────────────────────────────────────────────────

async function createEngine(llm) {
  const sandbox = new DockerSandbox(workspace, { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] }, logger);
  const tracker = new FileAccessTracker();
  const tools = new ToolRegistry();
  tools.register(createReadTool(sandbox, tracker));
  tools.register(createEditTool(sandbox, tracker));
  tools.register(createBashTool(sandbox));
  tools.register(createThinkTool());
  tools.register(createGrepTool(sandbox, workspace));
  tools.register(createLsTool(workspace));
  tools.register(createGlobTool(workspace));
  tools.register(createWebSearchTool(logger));
  tools.register(createWebFetchTool(logger));
  tools.register(createSkillTool([], logger));

  return new AgentEngine(
    {
      id: 'bench-agent',
      name: 'BenchmarkAgent',
      model: { provider: 'openrouter', model: 'mock' },
      tools: ['read', 'edit', 'bash', 'think', 'grep', 'ls', 'glob', 'web_search', 'web_fetch', 'skill'],
      approvalPolicy: 'never',
      workspace,
      memory: { enabled: false },
      maxIterations: 5,
      planMode: 'auto',
    },
    new MemorySessionStore(),
    llm,
    tools,
    new ApprovalGate('never', logger),
    logger,
  );
}

// ─── Judgement Logic ─────────────────────────────────────────────────────────

function judgeResult(query, toolCalls) {
  const calledTools = (toolCalls || []).map(tc => tc.name);
  const expected = query.expected_tools || [];
  const hadToolCalls = calledTools.length > 0;
  const shouldHaveTools = expected.length > 0;

  // Base classification
  if (!shouldHaveTools && !hadToolCalls) {
    return { verdict: 'correct', reason: 'No tools expected, none used' };
  }
  if (!shouldHaveTools && hadToolCalls) {
    return { verdict: 'over-call', reason: `No tools expected, but called: ${calledTools.join(', ')}` };
  }
  if (shouldHaveTools && !hadToolCalls) {
    return { verdict: 'under-call', reason: `Expected ${expected.join(', ')}, but no tools called` };
  }

  // Check if any expected tool was called
  const matched = expected.some(t => calledTools.includes(t));
  if (!matched) {
    return { verdict: 'mismatch', reason: `Expected ${expected.join(', ')}, but called ${calledTools.join(', ')}` };
  }

  // Check for read-before-edit rule
  if (calledTools.includes('edit') && !calledTools.includes('read')) {
    return { verdict: 'partial', reason: 'Called edit without read (read-before-edit rule violated)' };
  }

  return { verdict: 'correct', reason: `Called expected tools: ${calledTools.join(', ')}` };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function runBenchmark() {
  const llm = isMock ? new MockLLM() : await createLiveLLM();
  const engine = await createEngine(llm);
  const store = engine['store']; // Access private store via bracket notation

  const results = [];
  let correct = 0;
  let overCall = 0;
  let underCall = 0;
  let mismatch = 0;
  let partial = 0;
  let totalToolCalls = 0;
  let totalDuration = 0;

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const sessionId = `bench-${Date.now()}-${i}`;
    await store.create({ sessionId, agentId: 'bench-agent', turns: [], tokenCount: 0 });

    process.stdout.write(`  [${String(i + 1).padStart(3)}/${queries.length}] ${q.id} (${q.category}) `);

    const start = Date.now();
    let toolCalls = [];
    let error = null;

    try {
      for await (const event of engine.chat(sessionId, q.query)) {
        if (event.type === 'tool_call') {
          toolCalls.push({ name: event.call.name, id: event.call.id });
        }
      }
    } catch (e) {
      error = e.message;
    }

    const duration = Date.now() - start;
    totalDuration += duration;
    totalToolCalls += toolCalls.length;

    const judgement = error
      ? { verdict: 'error', reason: error }
      : judgeResult(q, toolCalls);

    switch (judgement.verdict) {
      case 'correct': correct++; break;
      case 'over-call': overCall++; break;
      case 'under-call': underCall++; break;
      case 'mismatch': mismatch++; break;
      case 'partial': partial++; break;
    }

    const status = judgement.verdict === 'correct' ? '✅' :
                   judgement.verdict === 'error' ? '💥' :
                   judgement.verdict === 'over-call' ? '⚠️ OVER' :
                   judgement.verdict === 'under-call' ? '⚠️ UNDER' :
                   judgement.verdict === 'partial' ? '⚠️ PARTIAL' : '⚠️ MISMATCH';

    console.log(`${status} tools=${toolCalls.length} ${duration}ms ${judgement.reason}`);

    results.push({
      id: q.id,
      category: q.category,
      query: q.query,
      expected_tools: q.expected_tools,
      called_tools: toolCalls.map(tc => tc.name),
      duration_ms: duration,
      verdict: judgement.verdict,
      reason: judgement.reason,
      error,
    });

    // Small delay between queries to avoid rate limiting
    if (!isMock && i < queries.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ─── Report ────────────────────────────────────────────────────────────────

  const report = {
    meta: {
      mode: isMock ? 'mock' : 'live',
      model: isMock ? 'mock-bench' : llm.modelRef.model,
      total_queries: queries.length,
      total_duration_ms: totalDuration,
      avg_duration_ms: Math.round(totalDuration / queries.length),
      total_tool_calls: totalToolCalls,
    },
    summary: {
      correct,
      over_call: overCall,
      under_call: underCall,
      mismatch,
      partial,
      error: results.filter(r => r.verdict === 'error').length,
      tool_call_rate: Number((totalToolCalls / queries.length).toFixed(2)),
      rationality_score: Number((correct / queries.length).toFixed(2)),
    },
    category_breakdown: {},
    results,
  };

  // Category breakdown
  for (const cat of [...new Set(queries.map(q => q.category))]) {
    const catResults = results.filter(r => r.category === cat);
    report.category_breakdown[cat] = {
      total: catResults.length,
      correct: catResults.filter(r => r.verdict === 'correct').length,
      over_call: catResults.filter(r => r.verdict === 'over-call').length,
      under_call: catResults.filter(r => r.verdict === 'under-call').length,
      mismatch: catResults.filter(r => r.verdict === 'mismatch').length,
      partial: catResults.filter(r => r.verdict === 'partial').length,
      tool_call_rate: Number((catResults.reduce((s, r) => s + r.called_tools.length, 0) / catResults.length).toFixed(2)),
    };
  }

  await writeFile(outPath, JSON.stringify(report, null, 2));

  // ─── Terminal Summary ──────────────────────────────────────────────────────

  console.log('\n📊 Results Summary');
  console.log('─────────────────────────────────────────────────────');
  console.log(`  Total queries:    ${queries.length}`);
  console.log(`  Total tool calls: ${totalToolCalls}`);
  console.log(`  Avg duration:     ${Math.round(totalDuration / queries.length)}ms`);
  console.log(`  Tool call rate:   ${report.summary.tool_call_rate} calls/query`);
  console.log('');
  console.log(`  ✅ Correct:        ${correct} (${Math.round(correct / queries.length * 100)}%)`);
  console.log(`  ⚠️  Over-call:      ${overCall} (${Math.round(overCall / queries.length * 100)}%)`);
  console.log(`  ⚠️  Under-call:     ${underCall} (${Math.round(underCall / queries.length * 100)}%)`);
  console.log(`  ⚠️  Mismatch:       ${mismatch} (${Math.round(mismatch / queries.length * 100)}%)`);
  console.log(`  ⚠️  Partial:        ${partial} (${Math.round(partial / queries.length * 100)}%)`);
  console.log(`  💥 Error:          ${report.summary.error}`);
  console.log('');
  console.log(`  Rationality Score: ${(report.summary.rationality_score * 100).toFixed(0)}%`);
  console.log('');

  console.log('📁 Category Breakdown');
  console.log('─────────────────────────────────────────────────────');
  for (const [cat, stats] of Object.entries(report.category_breakdown)) {
    const rate = Math.round(stats.correct / stats.total * 100);
    console.log(`  ${cat.padEnd(12)} correct=${stats.correct}/${stats.total} (${rate}%)  tool_rate=${stats.tool_call_rate}`);
  }

  console.log(`\n📝 Full report saved to: ${outPath}\n`);

  await rm(workspace, { recursive: true, force: true });
  process.exit(report.summary.error > 0 ? 1 : 0);
}

runBenchmark().catch(e => {
  console.error('Benchmark error:', e);
  process.exit(1);
});

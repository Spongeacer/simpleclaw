/**
 * DAG Engine Test
 * Tests the plan execution engine: DAG, topological sort, parallel execution,
 * variable resolution, hooks, retry policy, replan trigger, and AgentEngine integration.
 */

import { DAG, DAGError, DAGExecutor, HookRegistry, ReplanPolicy, VariableResolver } from '../dist/agent-runtime/plan/index.js';
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockToolRegistry(results) {
  const tools = new ToolRegistry();
  for (const [name, fn] of Object.entries(results)) {
    tools.register({
      name,
      description: `Mock ${name}`,
      parameters: { type: 'object', properties: {} },
      execute: fn,
    });
  }
  return tools;
}

// ─── DAG Tests ───────────────────────────────────────────────────────────────

async function testTopologicalSort() {
  const dag = new DAG({
    version: 1,
    steps: [
      { id: 'a', tool: 'read', args: {} },
      { id: 'b', tool: 'read', args: {}, depends_on: ['a'] },
      { id: 'c', tool: 'read', args: {}, depends_on: ['a'] },
      { id: 'd', tool: 'read', args: {}, depends_on: ['b', 'c'] },
    ],
  });
  dag.validate();
  const levels = dag.topologicalLevels();

  if (levels.length !== 3) {
    throw new Error(`Expected 3 levels, got ${levels.length}`);
  }
  if (!levels[0].stepIds.includes('a')) {
    throw new Error('Level 0 should contain "a"');
  }
  if (!levels[1].stepIds.includes('b') || !levels[1].stepIds.includes('c')) {
    throw new Error('Level 1 should contain "b" and "c"');
  }
  if (!levels[2].stepIds.includes('d')) {
    throw new Error('Level 2 should contain "d"');
  }
  console.log('  ✅ Topological sort produces correct levels');
}

async function testParallelExecution() {
  const delays = [];
  const tools = createMockToolRegistry({
    read: async ({ path }) => {
      const start = Date.now();
      await new Promise(r => setTimeout(r, 50));
      delays.push({ path, duration: Date.now() - start });
      return `content of ${path}`;
    },
  });

  const executor = new DAGExecutor();
  const result = await executor.execute(
    {
      version: 1,
      steps: [
        { id: 's1', tool: 'read', args: { path: 'a.txt' } },
        { id: 's2', tool: 'read', args: { path: 'b.txt' } },
        { id: 's3', tool: 'read', args: { path: 'c.txt' } },
      ],
    },
    tools,
    new HookRegistry()
  );

  if (!result.success) {
    throw new Error('Expected plan to succeed');
  }
  // All 3 reads should have executed in parallel, total time < 150ms
  if (result.totalDurationMs > 120) {
    throw new Error(`Expected parallel execution < 120ms, got ${result.totalDurationMs}ms`);
  }
  console.log(`  ✅ 3 reads executed in parallel (${result.totalDurationMs}ms)`);
}

async function testDependencyOrdering() {
  const order = [];
  const tools = createMockToolRegistry({
    step: async ({ name }) => {
      order.push(name);
      return name;
    },
  });

  const executor = new DAGExecutor();
  await executor.execute(
    {
      version: 1,
      steps: [
        { id: 's1', tool: 'step', args: { name: 'A' } },
        { id: 's2', tool: 'step', args: { name: 'B' }, depends_on: ['s1'] },
        { id: 's3', tool: 'step', args: { name: 'C' }, depends_on: ['s2'] },
      ],
    },
    tools,
    new HookRegistry()
  );

  if (order.join(',') !== 'A,B,C') {
    throw new Error(`Expected order A,B,C, got ${order.join(',')}`);
  }
  console.log('  ✅ Dependencies enforced serial execution A→B→C');
}

async function testVariableResolution() {
  // Manual test: verify resolver works with a manually-completed DAG node
  const dag = new DAG({
    version: 1,
    steps: [{ id: 's1', tool: 'read', args: { path: 'data.txt' } }],
  });
  dag.markCompleted('s1', { output: 'hello world' });
  const resolver = new VariableResolver();
  const manualResult = resolver.resolve('{{s1.output}}', dag);
  if (manualResult !== 'hello world') {
    throw new Error(`Manual resolver test failed: expected 'hello world', got '${manualResult}'`);
  }

  // Executor test: chained steps with variable interpolation
  const tools = createMockToolRegistry({
    read: async ({ path }) => `content of ${path}`,
    grep: async ({ pattern, inFile }) => `found ${pattern} in ${inFile}`,
  });

  const executor = new DAGExecutor();
  const result = await executor.execute(
    {
      version: 1,
      steps: [
        { id: 's1', tool: 'read', args: { path: 'data.txt' } },
        { id: 's2', tool: 'grep', args: { pattern: 'hello', inFile: '{{s1.output}}' }, depends_on: ['s1'] },
      ],
    },
    tools,
    new HookRegistry()
  );

  const node = result.dag.getNode('s2');
  if (!node.result.output.includes('content of data.txt')) {
    throw new Error(`Expected variable interpolation, got: ${node.result.output}`);
  }
  console.log('  ✅ Variable interpolation {{s1.output}} resolved correctly');
}

async function testCycleDetection() {
  try {
    const dag = new DAG({
      version: 1,
      steps: [
        { id: 'a', tool: 'read', args: {}, depends_on: ['c'] },
        { id: 'b', tool: 'read', args: {}, depends_on: ['a'] },
        { id: 'c', tool: 'read', args: {}, depends_on: ['b'] },
      ],
    });
    dag.validate();
    throw new Error('Expected cycle detection to throw');
  } catch (e) {
    if (!(e instanceof DAGError)) {
      throw new Error(`Expected DAGError, got ${e.constructor.name}`);
    }
    if (!e.message.includes('Cycle')) {
      throw new Error(`Expected cycle error message, got: ${e.message}`);
    }
  }
  console.log('  ✅ Cycle detection throws DAGError');
}

async function testHookExecution() {
  const log = [];
  const hooks = new HookRegistry();
  hooks.register('preExecute', (ctx) => { log.push(`pre:${ctx.step.id}`); });
  hooks.register('postExecute', (ctx) => { log.push(`post:${ctx.step.id}`); });
  hooks.register('onError', (ctx) => { log.push(`err:${ctx.step.id}`); });

  const tools = createMockToolRegistry({
    ok: async () => 'ok',
    fail: async () => { throw new Error('boom'); },
  });

  const executor = new DAGExecutor();
  await executor.execute(
    {
      version: 1,
      steps: [
        { id: 's1', tool: 'ok', args: {} },
        { id: 's2', tool: 'fail', args: {} },
      ],
    },
    tools,
    hooks
  );

  if (!log.includes('pre:s1') || !log.includes('post:s1')) {
    throw new Error(`Expected pre/post hooks for s1, got: ${log.join(', ')}`);
  }
  if (!log.includes('pre:s2') || !log.includes('err:s2')) {
    throw new Error(`Expected pre/err hooks for s2, got: ${log.join(', ')}`);
  }
  console.log('  ✅ Hooks fire in correct order (pre→post, pre→onError)');
}

async function testRetryPolicy() {
  let attempts = 0;
  const tools = createMockToolRegistry({
    flaky: async () => {
      attempts++;
      if (attempts < 3) throw new Error(`attempt ${attempts} failed`);
      return 'success on 3rd try';
    },
  });

  const executor = new DAGExecutor();
  const result = await executor.execute(
    {
      version: 1,
      steps: [
        { id: 's1', tool: 'flaky', args: {}, maxRetries: 2, retryDelayMs: 10 },
      ],
    },
    tools,
    new HookRegistry()
  );

  if (!result.success) {
    throw new Error('Expected success after retries');
  }
  if (attempts !== 3) {
    throw new Error(`Expected 3 attempts, got ${attempts}`);
  }
  console.log('  ✅ Retry policy: succeeded on 3rd attempt after 2 retries');
}

async function testReplanTrigger() {
  const policy = new ReplanPolicy({ maxReplanAttempts: 2 });

  // Build a fake DAG with a failed node that has dependents
  const dag = new DAG({
    version: 1,
    steps: [
      { id: 'a', tool: 'read', args: {} },
      { id: 'b', tool: 'read', args: {}, depends_on: ['a'] },
    ],
  });
  dag.markFailed('a', { output: 'file not found', isError: true });

  const node = dag.getNode('a');
  const trigger = policy.shouldReplan(node, dag);

  if (!trigger) {
    throw new Error('Expected replan trigger for critical step failure');
  }
  if (!trigger.reason.toLowerCase().includes('critical')) {
    throw new Error(`Expected critical step reason, got: ${trigger.reason}`);
  }

  // Leaf failure should NOT trigger replan
  const dag2 = new DAG({
    version: 1,
    steps: [
      { id: 'x', tool: 'read', args: {} },
    ],
  });
  dag2.markFailed('x', { output: 'fail', isError: true });
  const trigger2 = policy.shouldReplan(dag2.getNode('x'), dag2);
  if (trigger2) {
    throw new Error('Expected NO replan for leaf failure');
  }

  console.log('  ✅ Replan trigger: critical steps trigger, leaf steps do not');
}

async function testMaxConcurrency() {
  let running = 0;
  let maxRunning = 0;
  const tools = createMockToolRegistry({
    slow: async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 50));
      running--;
      return 'ok';
    },
  });

  const executor = new DAGExecutor();
  await executor.execute(
    {
      version: 1,
      steps: [
        { id: 's1', tool: 'slow', args: {} },
        { id: 's2', tool: 'slow', args: {} },
        { id: 's3', tool: 'slow', args: {} },
        { id: 's4', tool: 'slow', args: {} },
      ],
    },
    tools,
    new HookRegistry(),
    { maxConcurrency: 2 }
  );

  if (maxRunning > 2) {
    throw new Error(`Expected max concurrency 2, got ${maxRunning}`);
  }
  console.log('  ✅ Max concurrency enforced (2 at a time)');
}

async function testAgentEngineIntegration() {
  const workspace = resolve(tmpdir(), `simpleclaw-dag-integ-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, 'a.txt'), 'A', 'utf-8');
  await writeFile(resolve(workspace, 'b.txt'), 'B', 'utf-8');
  await writeFile(resolve(workspace, 'c.txt'), 'C', 'utf-8');

  const store = new MemorySessionStore();
  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger
  );
  const tracker = new FileAccessTracker();
  const tools = new ToolRegistry();
  tools.register(createReadTool(sandbox, tracker));

  // Mock LLM that returns 3 parallel reads on first call, then answers
  let llmCallCount = 0;
  const mockLLM = {
    modelRef: { provider: 'mock', model: 'mock-parallel' },
    async complete(_messages, _tools) {
      llmCallCount++;
      if (llmCallCount === 1) {
        return {
          text: '',
          toolCalls: [
            { id: 'call-1', name: 'read', arguments: { path: 'a.txt' } },
            { id: 'call-2', name: 'read', arguments: { path: 'b.txt' } },
            { id: 'call-3', name: 'read', arguments: { path: 'c.txt' } },
          ],
          usage: { promptTokens: 50, completionTokens: 30 },
        };
      }
      return {
        text: 'Done reading all files.',
        toolCalls: [],
        usage: { promptTokens: 100, completionTokens: 10 },
      };
    },
  };

  const engine = new AgentEngine(
    {
      id: 'dag-test',
      name: 'DAGTest',
      model: { provider: 'mock', model: 'mock-parallel' },
      tools: ['read'],
      approvalPolicy: 'never',
      workspace,
      memory: { enabled: false },
      planMode: 'always',
    },
    store,
    mockLLM,
    tools,
    new ApprovalGate('never', logger),
    logger
  );

  const session = await store.create({
    sessionId: `dag-integ-${Date.now()}`,
    agentId: 'dag-test',
    turns: [],
    tokenCount: 0,
  });

  const events = [];
  for await (const event of engine.chat(session.sessionId, 'Read a, b, and c.')) {
    events.push(event);
  }

  const toolCalls = events.filter(e => e.type === 'tool_call');
  const toolResults = events.filter(e => e.type === 'tool_result');

  if (toolCalls.length !== 3) {
    throw new Error(`Expected 3 tool_call events, got ${toolCalls.length}`);
  }
  if (toolResults.length !== 3) {
    throw new Error(`Expected 3 tool_result events, got ${toolResults.length}`);
  }

  // Verify results contain file contents
  const outputs = toolResults.map(r => r.result.output);
  if (!outputs.some(o => o.includes('A')) || !outputs.some(o => o.includes('B')) || !outputs.some(o => o.includes('C'))) {
    throw new Error(`Expected results to contain A, B, C: ${outputs.join(', ')}`);
  }

  await rm(workspace, { recursive: true, force: true });
  console.log('  ✅ AgentEngine with planMode=always executes 3 reads via DAG');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  const tests = [
    testTopologicalSort,
    testParallelExecution,
    testDependencyOrdering,
    testVariableResolution,
    testCycleDetection,
    testHookExecution,
    testRetryPolicy,
    testReplanTrigger,
    testMaxConcurrency,
    testAgentEngineIntegration,
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

  console.log(`\n${passed}/${tests.length} DAG engine tests passed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});

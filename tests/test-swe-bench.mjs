/**
 * Mini SWE-bench — End-to-end bug fix evaluation for SimpleClaw
 *
 * Creates self-contained JS projects with known bugs, asks the agent to fix them,
 * then runs tests to verify.
 *
 * Usage: node test-swe-bench.mjs --live [--limit=N]
 */

import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const isLive = args.includes('--live');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined;

if (!isLive) {
  console.log('Usage: node test-swe-bench.mjs --live [--limit=N]');
  process.exit(1);
}

// ─── Benchmark Tasks ─────────────────────────────────────────────────────────

const TASKS = [
  {
    id: 'swe-01',
    name: 'Array deduplication bug',
    description: 'The `uniq` function in `src/utils.js` does not correctly remove duplicate elements when they appear non-consecutively. For example, `uniq([1, 2, 1])` returns `[1, 2, 1]` but should return `[1, 2]`. Please fix the bug and ensure all tests pass.',
    files: {
      'package.json': JSON.stringify({ name: 'swe-01', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2),
      'src/utils.js': `function uniq(arr) {
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    if (i === 0 || arr[i] !== arr[i - 1]) {
      result.push(arr[i]);
    }
  }
  return result;
}
module.exports = { uniq };
`,
      'test.js': `const { uniq } = require('./src/utils.js');
function assertEqual(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(msg + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
assertEqual(uniq([1, 2, 1]), [1, 2], 'non-consecutive duplicates');
assertEqual(uniq([1, 1, 1]), [1], 'all same');
assertEqual(uniq([1, 2, 3]), [1, 2, 3], 'no duplicates');
assertEqual(uniq([]), [], 'empty array');
console.log('All tests passed!');
`,
    },
    hint: 'The current implementation only compares adjacent elements. It needs to track seen elements globally.',
  },
  {
    id: 'swe-02',
    name: 'Date formatting month bug',
    description: 'The `formatDate` function in `src/date.js` displays the wrong month. It shows month 0 as "01" but should show "01" for January (month 0). Wait — actually the bug is that month 11 (December) shows as "12" which is correct, but month 0 shows as "00" instead of "01". Please fix it.',
    files: {
      'package.json': JSON.stringify({ name: 'swe-02', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2),
      'src/date.js': `function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth()).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return \`\${y}-\${m}-\${d}\`;
}
module.exports = { formatDate };
`,
      'test.js': `const { formatDate } = require('./src/date.js');
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(msg + ': expected ' + expected + ', got ' + actual);
}
assertEqual(formatDate(new Date(2024, 0, 15)), '2024-01-15', 'January');
assertEqual(formatDate(new Date(2024, 11, 25)), '2024-12-25', 'December');
assertEqual(formatDate(new Date(2024, 5, 1)), '2024-06-01', 'June');
console.log('All tests passed!');
`,
    },
    hint: 'getMonth() returns 0-11, but display should be 1-12.',
  },
  {
    id: 'swe-03',
    name: 'String reverse with emojis',
    description: 'The `reverse` function in `src/string.js` fails when the input contains multi-byte characters (like emojis). For example, `reverse("hello 🌍")` returns corrupted output. Please fix it to correctly handle Unicode characters.',
    files: {
      'package.json': JSON.stringify({ name: 'swe-03', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2),
      'src/string.js': `function reverse(str) {
  let result = '';
  for (let i = str.length - 1; i >= 0; i--) {
    result += str[i];
  }
  return result;
}
module.exports = { reverse };
`,
      'test.js': `const { reverse } = require('./src/string.js');
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(msg + ': expected "' + expected + '", got "' + actual + '"');
}
assertEqual(reverse('hello 🌍'), '🌍 olleh', 'emoji handling');
assertEqual(reverse('ab'), 'ba', 'simple');
assertEqual(reverse(''), '', 'empty');
console.log('All tests passed!');
`,
    },
    hint: 'Use Array.from(str) or the spread operator [...str] to properly split Unicode characters.',
  },
  {
    id: 'swe-04',
    name: 'Config parser comment handling',
    description: 'The `parseConfig` function in `src/config.js` incorrectly includes lines that start with "#" (comments). Comment lines should be ignored. Please fix it.',
    files: {
      'package.json': JSON.stringify({ name: 'swe-04', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2),
      'src/config.js': `function parseConfig(text) {
  const result = {};
  const lines = text.split('\\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [key, value] = trimmed.split('=');
    result[key.trim()] = value.trim();
  }
  return result;
}
module.exports = { parseConfig };
`,
      'test.js': `const { parseConfig } = require('./src/config.js');
function assertEqual(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(msg + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
assertEqual(parseConfig('host=localhost\\n# this is a comment\\nport=3000'), { host: 'localhost', port: '3000' }, 'comment ignored');
assertEqual(parseConfig('# comment only\\n'), {}, 'only comments');
assertEqual(parseConfig('a=1\nb=2'), { a: '1', b: '2' }, 'no comments');
console.log('All tests passed!');
`,
    },
    hint: 'Skip lines where trimmed.startsWith("#").',
  },
  {
    id: 'swe-05',
    name: 'Sum function NaN handling',
    description: 'The `sum` function in `src/math.js` returns NaN when given an empty array, but it should return 0. Also it should ignore non-numeric values instead of returning NaN. Please fix both issues.',
    files: {
      'package.json': JSON.stringify({ name: 'swe-05', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2),
      'src/math.js': `function sum(arr) {
  let total = 0;
  for (const x of arr) {
    total += x;
  }
  return total;
}
module.exports = { sum };
`,
      'test.js': `const { sum } = require('./src/math.js');
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(msg + ': expected ' + expected + ', got ' + actual);
}
assertEqual(sum([]), 0, 'empty array');
assertEqual(sum([1, 2, 3]), 6, 'normal');
assertEqual(sum([1, 'x', 2]), 3, 'ignore non-numbers');
assertEqual(sum([1, null, 2]), 3, 'ignore null');
console.log('All tests passed!');
`,
    },
    hint: 'Initialize total to 0. Use typeof x === "number" && !isNaN(x) to filter.',
  },
  {
    id: 'swe-06',
    name: 'Route parameter extraction',
    description: 'The `matchRoute` function in `src/router.js` fails to extract route parameters when the URL has multiple parameters. For example, `/users/42/posts/7` should match `/users/:userId/posts/:postId` and return `{ userId: "42", postId: "7" }`, but it currently only captures the first parameter. Please fix it.',
    files: {
      'package.json': JSON.stringify({ name: 'swe-06', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2),
      'src/router.js': `function matchRoute(pattern, url) {
  const patternParts = pattern.split('/');
  const urlParts = url.split('/');
  if (patternParts.length !== urlParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      const key = patternParts[i].slice(1);
      params[key] = urlParts[i];
      return params;  // BUG: returns early after first param
    }
    if (patternParts[i] !== urlParts[i]) return null;
  }
  return params;
}
module.exports = { matchRoute };
`,
      'test.js': `const { matchRoute } = require('./src/router.js');
function assertEqual(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(msg + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
assertEqual(matchRoute('/users/:userId/posts/:postId', '/users/42/posts/7'), { userId: '42', postId: '7' }, 'two params');
assertEqual(matchRoute('/users/:id', '/users/99'), { id: '99' }, 'one param');
assertEqual(matchRoute('/users', '/users'), {}, 'no params');
assertEqual(matchRoute('/users/:id', '/posts/99'), null, 'mismatch');
console.log('All tests passed!');
`,
    },
    hint: 'The function returns params inside the loop after finding the first parameter. It should only return after the loop completes.',
  },
  {
    id: 'swe-07',
    name: 'Deep merge null handling',
    description: 'The `deepMerge` function in `src/merge.js` crashes when one of the objects contains a `null` value. It should treat null as a scalar value and just copy it. Please fix the crash.',
    files: {
      'package.json': JSON.stringify({ name: 'swe-07', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2),
      'src/merge.js': `function deepMerge(a, b) {
  const result = { ...a };
  for (const key of Object.keys(b)) {
    if (typeof b[key] === 'object') {
      result[key] = deepMerge(result[key] || {}, b[key]);
    } else {
      result[key] = b[key];
    }
  }
  return result;
}
module.exports = { deepMerge };
`,
      'test.js': `const { deepMerge } = require('./src/merge.js');
function assertEqual(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(msg + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
assertEqual(deepMerge({ a: 1 }, { b: null }), { a: 1, b: null }, 'null value');
assertEqual(deepMerge({ x: { y: 1 } }, { x: { z: 2 } }), { x: { y: 1, z: 2 } }, 'nested');
assertEqual(deepMerge({}, {}), {}, 'empty');
console.log('All tests passed!');
`,
    },
    hint: 'typeof null === "object" in JavaScript. Add a check for b[key] === null before the typeof check.',
  },
  {
    id: 'swe-08',
    name: 'Debounce immediate option',
    description: 'The `debounce` function in `src/debounce.js` should support an `immediate` option. When immediate=true, the function should execute on the leading edge instead of the trailing edge. Currently it always waits for the delay. Please add this feature.',
    files: {
      'package.json': JSON.stringify({ name: 'swe-08', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2),
      'src/debounce.js': `function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
module.exports = { debounce };
`,
      'test.js': `const { debounce } = require('./src/debounce.js');
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function run() {
  let calls = [];
  const fn = (x) => calls.push(x);
  const d = debounce(fn, 50, true);  // immediate=true
  d(1);
  await sleep(10);
  d(2);
  await sleep(10);
  d(3);
  await sleep(100);
  if (calls.length !== 1 || calls[0] !== 1) {
    throw new Error('immediate debounce: expected [1], got ' + JSON.stringify(calls));
  }
  console.log('All tests passed!');
}
run();
`,
    },
    hint: 'Accept a third parameter `immediate`. If true, execute fn immediately on the first call and set a cooldown timer.',
  },
];

const tasksToRun = limit ? TASKS.slice(0, limit) : TASKS;

// ─── Setup ───────────────────────────────────────────────────────────────────

const { AgentEngine } = await import('../dist/core/agent-engine.js');
const { ToolRegistry } = await import('../dist/agent-runtime/tool-registry.js');
const { createReadTool, createEditTool, createBashTool, createThinkTool, createGrepTool, createLsTool } = await import('../dist/agent-runtime/tools/index.js');
const { FileAccessTracker } = await import('../dist/agent-runtime/file-tracker.js');
const { DockerSandbox } = await import('../dist/agent-runtime/sandbox.js');
const { ApprovalGate } = await import('../dist/agent-runtime/approval.js');
const { MemorySessionStore } = await import('../dist/gateway/session-store.js');
const { logger } = await import('../dist/core/logger.js');
const { OpenAICompatibleClient } = await import('../dist/agent-runtime/providers/openai-compatible.js');
const { API_KEY, BASE_URL, MODEL } = await import('./test-live-config.mjs');

// ─── Runner ──────────────────────────────────────────────────────────────────

async function setupTask(task, baseDir) {
  const dir = resolve(baseDir, task.id);
  await mkdir(resolve(dir, 'src'), { recursive: true });
  for (const [file, content] of Object.entries(task.files)) {
    await writeFile(resolve(dir, file), content, 'utf-8');
  }
  return dir;
}

async function createEngine(workspace) {
  const sandbox = new DockerSandbox(workspace, { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] }, logger);
  const tracker = new FileAccessTracker();
  const tools = new ToolRegistry();
  tools.register(createReadTool(sandbox, tracker));
  tools.register(createEditTool(sandbox, tracker));
  tools.register(createBashTool(sandbox));
  tools.register(createThinkTool());
  tools.register(createGrepTool(sandbox, workspace));
  tools.register(createLsTool(workspace));

  const llm = new OpenAICompatibleClient(
    { provider: 'openrouter', model: MODEL, temperature: 0 },
    { apiKey: API_KEY, baseURL: BASE_URL }
  );

  return new AgentEngine({
    config: {
      id: 'swe-agent',
      name: 'SWEAgent',
      model: { provider: 'openrouter', model: MODEL },
      tools: ['read', 'edit', 'bash', 'think', 'grep', 'ls'],
      approvalPolicy: 'never',
      workspace,
      memory: { enabled: false },
      maxIterations: 10,
      planMode: 'auto',
    },
    store: new MemorySessionStore(),
    llm: llm,
    tools: tools,
    approval: new ApprovalGate('never', logger),
    logger: logger
  });
}

async function runTests(taskDir) {
  try {
    const sandbox = new DockerSandbox(taskDir, { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] }, logger);
    // Use 'node test.js' directly instead of 'npm test' to avoid PowerShell execution policy issues
    const result = await sandbox.exec('node test.js');
    return { passed: result.exitCode === 0, output: result.stdout + result.stderr };
  } catch (e) {
    return { passed: false, output: String(e) };
  }
}

async function runBenchmark() {
  const baseDir = resolve(tmpdir(), `simpleclaw-swe-${Date.now()}`);
  await mkdir(baseDir, { recursive: true });

  console.log(`\n🔧 Mini SWE-bench`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   Tasks: ${tasksToRun.length}/${TASKS.length}`);
  console.log('');

  const results = [];
  let passed = 0;
  let failed = 0;
  let totalDuration = 0;

  for (let i = 0; i < tasksToRun.length; i++) {
    const task = tasksToRun[i];
    const taskDir = await setupTask(task, baseDir);

    process.stdout.write(`  [${String(i + 1).padStart(2)}/${tasksToRun.length}] ${task.id} — ${task.name} `);

    const start = Date.now();
    let toolCalls = 0;
    let error = null;
    let finalAnswer = '';

    try {
      const engine = await createEngine(taskDir);
      const store = engine['store'];
      const sessionId = `swe-${Date.now()}`;
      await store.create({ sessionId, agentId: 'swe-agent', turns: [], tokenCount: 0 });

      for await (const event of engine.chat(sessionId, task.description)) {
        if (event.type === 'tool_call') toolCalls++;
        if (event.type === 'text') finalAnswer = event.text;
      }
    } catch (e) {
      error = e.message;
    }

    const duration = Date.now() - start;
    totalDuration += duration;

    // Run tests to verify fix
    const testResult = await runTests(taskDir);

    const success = testResult.passed && !error;
    if (success) passed++; else failed++;

    const status = success ? '✅ PASS' : error ? '💥 ERROR' : '❌ FAIL';
    console.log(`${status} | tools=${toolCalls} | ${duration}ms`);
    if (!success) {
      if (error) console.log(`       Error: ${error}`);
      else console.log(`       Test output: ${testResult.output.slice(0, 200).replace(/\n/g, ' ')}`);
    }

    results.push({
      id: task.id,
      name: task.name,
      duration_ms: duration,
      tool_calls: toolCalls,
      success,
      error,
      test_output: testResult.output,
      final_answer: finalAnswer.slice(0, 500),
    });

    if (i < tasksToRun.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Summary
  console.log('\n📊 Results');
  console.log('─────────────────────────────────────────');
  console.log(`  Tasks:   ${tasksToRun.length}`);
  console.log(`  Passed:  ${passed} (${Math.round(passed / tasksToRun.length * 100)}%)`);
  console.log(`  Failed:  ${failed} (${Math.round(failed / tasksToRun.length * 100)}%)`);
  console.log(`  Avg time: ${Math.round(totalDuration / tasksToRun.length)}ms`);
  console.log(`  Total:    ${Math.round(totalDuration / 1000)}s`);

  // Save report
  const reportPath = resolve(__dirname, 'swe-bench-report.json');
  await writeFile(reportPath, JSON.stringify({ meta: { model: MODEL, total: tasksToRun.length, passed, failed }, results }, null, 2));
  console.log(`\n📝 Report saved to: ${reportPath}\n`);

  await rm(baseDir, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

runBenchmark().catch(e => {
  console.error('Benchmark error:', e);
  process.exit(1);
});

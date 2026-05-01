/**
 * Complex Project E2E Test — NewsCrawler Bug Hunt
 * 
 * Scenario: A simple news crawler project with 4 deliberate bugs.
 * The agent must:
 *   1. Explore the project structure
 *   2. Read each source file
 *   3. Identify bugs via pattern analysis
 *   4. Fix them with `edit` tool
 *   5. Run tests via `bash` to verify
 *   6. Report findings
 * 
 * Monitored bugs:
 *   B1: crawler.js — fetch() missing error handling + no User-Agent
 *   B2: parser.js  — greedy regex captures too much content
 *   B3: storage.js — async save() missing `await` on fs.writeFile
 *   B4: config.js  — timeout=0 causes infinite hangs
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
  createMemorySaveTool,
} from '../dist/agent-runtime/tools/index.js';
import { FileAccessTracker } from '../dist/agent-runtime/file-tracker.js';
import { DockerSandbox } from '../dist/agent-runtime/sandbox.js';
import { ApprovalGate } from '../dist/agent-runtime/approval.js';
import { MemorySessionStore } from '../dist/gateway/session-store.js';
import { logger } from '../dist/core/logger.js';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';

// ─── Project files with deliberate bugs ──────────────────────────────────────

const PROJECT_FILES = {
  'package.json': JSON.stringify({
    name: 'news-crawler',
    version: '1.0.0',
    type: 'module',
    scripts: { test: 'node test-crawler.mjs' },
  }, null, 2),

  'config.js': `export const config = {
  baseUrl: 'https://news.example.com',
  timeout: 0,                    // B4: timeout=0 means never timeout
  retries: 3,
  headers: {},                   // B1: missing User-Agent
};`,

  'crawler.js': `import { config } from './config.js';

export async function fetchArticle(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: config.headers,
    signal: AbortSignal.timeout(config.timeout),  // B4: timeout=0 → never aborts
  });
  // B1: No check for response.ok — silently returns error HTML
  return response.text();
}

export async function crawl() {
  const url = config.baseUrl + '/api/articles';  // B1-adjacent: no slash handling
  const html = await fetchArticle(url);
  return html;
}`,

  'parser.js': `export function extractArticles(html) {
  const articles = [];
  // B2: Greedy regex — (.+) matches across tags, capturing too much
  const regex = /<article>(.+)<\/article>/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    articles.push({ content: match[1] });
  }
  return articles;
}

export function extractDate(html) {
  // B2: lazy match would be better, but greedy can break on nested tags
  const match = html.match(/<time datetime="([^"]+)">/);
  return match ? new Date(match[1]) : null;  // can return Invalid Date silently
}`,

  'storage.js': `import { writeFile } from 'fs/promises';

const DB_FILE = './articles.json';

export async function save(articles) {
  const data = JSON.stringify(articles, null, 2);
  writeFile(DB_FILE, data, 'utf-8');  // B3: MISSING await — fire-and-forget
  console.log(\`Saved \${articles.length} articles\`);
}

export async function load() {
  try {
    const data = await readFile(DB_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}`,

  'test-crawler.mjs': `import { extractArticles, extractDate } from './parser.js';
import { fetchArticle } from './crawler.js';

// Test 1: parser should handle multiple articles
const sampleHtml = \`
  <article>Article 1 content</article>
  <article>Article 2 content</article>
  <article>Article 3 content</article>
\`;
const articles = extractArticles(sampleHtml);
console.assert(articles.length === 3, \`Expected 3 articles, got \${articles.length}\`);

// Test 2: parser should extract correct date
const dateHtml = '<time datetime="2024-01-15T10:30:00Z">Jan 15</time>';
const date = extractDate(dateHtml);
console.assert(date instanceof Date && !isNaN(date), 'Expected valid Date');

// Test 3: fetch should have User-Agent (we check config indirectly)
import { config } from './config.js';
console.assert(config.timeout > 0, \`Expected timeout > 0, got \${config.timeout}\`);
console.assert(config.headers['User-Agent'] || config.headers['user-agent'], 'Expected User-Agent header');

console.log('All tests passed!');
`,
};

const FIXES = {
  'config.js': {
    old: `  timeout: 0,                    // B4: timeout=0 means never timeout
  retries: 3,
  headers: {},                   // B1: missing User-Agent`,
    new: `  timeout: 5000,                 // Fixed: reasonable timeout
  retries: 3,
  headers: { 'User-Agent': 'NewsCrawler/1.0' },  // Fixed: added User-Agent`,
  },
  'crawler.js': {
    old: `  const response = await fetch(url, {
    method: 'GET',
    headers: config.headers,
    signal: AbortSignal.timeout(config.timeout),  // B4: timeout=0 → never aborts
  });
  // B1: No check for response.ok — silently returns error HTML
  return response.text();`,
    new: `  const response = await fetch(url, {
    method: 'GET',
    headers: config.headers,
    signal: AbortSignal.timeout(config.timeout),
  });
  if (!response.ok) {
    throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
  }
  return response.text();`,
  },
  'parser.js': {
    old: `  const regex = /<article>(.+)<\/article>/g;`,
    new: `  const regex = /<article>([\\s\\S]*?)<\\/article>/g;`,
  },
  'storage.js': {
    old: `  writeFile(DB_FILE, data, 'utf-8');  // B3: MISSING await — fire-and-forget`,
    new: `  await writeFile(DB_FILE, data, 'utf-8');  // Fixed: added await`,
  },
};

// ─── State-machine Mock LLM that simulates an agent reviewing the project ─────

class CrawlerReviewLLM {
  modelRef = { provider: 'mock', model: 'mock-crawler-review' };
  callCount = 0;
  state = 'START';   // START → LS → READ_CONFIG → READ_CRAWLER → READ_PARSER → READ_STORAGE → FIX_CONFIG → FIX_CRAWLER → FIX_PARSER → FIX_STORAGE → RUN_TEST → REPORT
  discoveredBugs = [];
  fixedFiles = [];

  async complete(messages, tools) {
    this.callCount++;
    const schemas = tools ?? [];
    const toolNames = new Set(schemas.map(t => t.name));

    // Simple state machine for the review flow
    switch (this.state) {
      case 'START':
        this.state = 'READ_CONFIG';
        return this.toolCall('read', { path: 'config.js' });

      case 'READ_CONFIG': {
        this.discoveredBugs.push('B4: config.js timeout=0 (infinite hang risk)');
        this.state = 'READ_CRAWLER';
        return this.toolCall('read', { path: 'crawler.js' });
      }

      case 'READ_CRAWLER': {
        this.discoveredBugs.push('B1: crawler.js fetch() missing response.ok check and no User-Agent');
        this.state = 'READ_PARSER';
        return this.toolCall('read', { path: 'parser.js' });
      }

      case 'READ_PARSER': {
        this.discoveredBugs.push('B2: parser.js greedy regex (.+) can match across tags');
        this.state = 'READ_STORAGE';
        return this.toolCall('read', { path: 'storage.js' });
      }

      case 'READ_STORAGE': {
        this.discoveredBugs.push('B3: storage.js save() missing await on writeFile');
        this.state = 'FIX_CONFIG';
        return this.toolCall('edit', { path: 'config.js', old_string: FIXES['config.js'].old, new_string: FIXES['config.js'].new });
      }

      case 'FIX_CONFIG': {
        this.fixedFiles.push('config.js');
        this.state = 'FIX_CRAWLER';
        return this.toolCall('edit', { path: 'crawler.js', old_string: FIXES['crawler.js'].old, new_string: FIXES['crawler.js'].new });
      }

      case 'FIX_CRAWLER': {
        this.fixedFiles.push('crawler.js');
        this.state = 'FIX_PARSER';
        return this.toolCall('edit', { path: 'parser.js', old_string: FIXES['parser.js'].old, new_string: FIXES['parser.js'].new });
      }

      case 'FIX_PARSER': {
        this.fixedFiles.push('parser.js');
        this.state = 'FIX_STORAGE';
        return this.toolCall('edit', { path: 'storage.js', old_string: FIXES['storage.js'].old, new_string: FIXES['storage.js'].new });
      }

      case 'FIX_STORAGE': {
        this.fixedFiles.push('storage.js');
        this.state = 'RUN_TEST';
        return this.toolCall('bash', { command: 'node test-crawler.mjs' });
      }

      case 'RUN_TEST': {
        this.state = 'SAVE_MEMORY';
        if (toolNames.has('memory_save')) {
          return this.toolCall('memory_save', {
            title: 'NewsCrawler bugfix review',
            content: `Discovered and fixed ${this.discoveredBugs.length} bugs:\n${this.discoveredBugs.map(b => '- ' + b).join('\n')}`,
            type: 'bugfix',
          });
        }
        this.state = 'REPORT';
        return this.finalAnswer();
      }

      case 'SAVE_MEMORY': {
        this.state = 'REPORT';
        return this.finalAnswer();
      }

      case 'REPORT':
      default:
        return this.finalAnswer();
    }
  }

  toolCall(name, args) {
    return {
      text: `Calling ${name}...`,
      toolCalls: [{ id: `call-${Date.now()}-${this.callCount}`, name, arguments: args }],
      usage: { promptTokens: 50, completionTokens: 20 },
    };
  }

  finalAnswer() {
    const report = [
      '## NewsCrawler Review Complete',
      '',
      `**Bugs discovered:** ${this.discoveredBugs.length}`,
      ...this.discoveredBugs.map(b => `- ${b}`),
      '',
      `**Files fixed:** ${this.fixedFiles.join(', ') || 'none'}`,
      '',
      'All critical issues have been addressed.',
    ].join('\n');
    return { text: report, usage: { promptTokens: 80, completionTokens: 40 } };
  }
}

// ─── Test Runner ─────────────────────────────────────────────────────────────

async function run() {
  const workspace = resolve(tmpdir(), `simpleclaw-crawler-test-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  // Write all project files
  for (const [name, content] of Object.entries(PROJECT_FILES)) {
    await writeFile(resolve(workspace, name), content, 'utf-8');
  }

  console.log(`Workspace: ${workspace}`);
  console.log(`Project files: ${Object.keys(PROJECT_FILES).join(', ')}\n`);

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

  const approval = new ApprovalGate('never', logger);
  const llm = new CrawlerReviewLLM();

  const engine = new AgentEngine({
    config: {
      id: 'test-crawler-agent',
      name: 'CrawlerReviewer',
      model: { provider: 'mock', model: 'mock-crawler-review' },
      systemPrompt: 'You are a senior code reviewer. Find bugs, fix them, and run tests.',
      tools: ['read', 'edit', 'bash', 'grep', 'ls', 'memory_save'],
      approvalPolicy: 'never',
      workspace,
      memory: { enabled: false }, // disable memory for deterministic test
    },
    store: store,
    llm: llm,
    tools: tools,
    approval: approval,
    logger: logger
  });

  // Create session
  const session = await store.create({
    sessionId: `crawler-sess-${Date.now()}`,
    agentId: 'test-crawler-agent',
    turns: [],
    tokenCount: 0,
  });

  // Run chat
  console.log('--- Agent Review Start ---');
  const events = [];
  for await (const event of engine.chat(session.sessionId, 'Review the NewsCrawler project for bugs')) {
    events.push(event);
    if (event.type === 'tool_call') {
      console.log(`  [TOOL] ${event.call.name} → ${JSON.stringify(event.call.arguments).slice(0, 120)}`);
    } else if (event.type === 'tool_result') {
      const out = event.result.output;
      const preview = out.length > 120 ? out.slice(0, 120) + '...' : out;
      console.log(`  [RESULT] ${preview.replace(/\n/g, ' ')}`);
    } else if (event.type === 'text') {
      console.log(`  [ANSWER] ${event.text.slice(0, 200).replace(/\n/g, ' ')}`);
    } else if (event.type === 'error') {
      console.log(`  [ERROR] ${event.code}: ${event.message}`);
    }
  }
  console.log('--- Agent Review End ---\n');

  // ─── Verification ───────────────────────────────────────────────────────────
  const errors = [];
  const llmState = llm;

  // 1. Verify state machine completed all steps
  const expectedStates = ['START', 'READ_CONFIG', 'READ_CRAWLER', 'READ_PARSER', 'READ_STORAGE', 'FIX_CONFIG', 'FIX_CRAWLER', 'FIX_PARSER', 'FIX_STORAGE', 'RUN_TEST', 'REPORT'];
  if (llmState.state !== 'REPORT') {
    errors.push(`State machine incomplete: ended at "${llmState.state}" instead of "REPORT"`);
  }

  // 2. Verify all 4 bugs were discovered
  if (llmState.discoveredBugs.length !== 4) {
    errors.push(`Expected 4 bugs discovered, got ${llmState.discoveredBugs.length}: ${llmState.discoveredBugs.join('; ')}`);
  }

  // 3. Verify all 4 files were fixed
  if (llmState.fixedFiles.length !== 4) {
    errors.push(`Expected 4 files fixed, got ${llmState.fixedFiles.length}: ${llmState.fixedFiles.join(', ')}`);
  }

  // 4. Verify files were actually modified on disk
  const fixedConfig = await readFile(resolve(workspace, 'config.js'), 'utf-8');
  if (!fixedConfig.includes('timeout: 5000')) {
    errors.push('config.js was not actually fixed (timeout still wrong)');
  }
  if (!fixedConfig.includes('User-Agent')) {
    errors.push('config.js was not actually fixed (User-Agent missing)');
  }

  const fixedCrawler = await readFile(resolve(workspace, 'crawler.js'), 'utf-8');
  if (!fixedCrawler.includes('response.ok')) {
    errors.push('crawler.js was not actually fixed (missing response.ok check)');
  }

  const fixedParser = await readFile(resolve(workspace, 'parser.js'), 'utf-8');
  if (!fixedParser.includes('([\\s\\S]*?)')) {
    errors.push('parser.js was not actually fixed (regex not lazy)');
  }

  const fixedStorage = await readFile(resolve(workspace, 'storage.js'), 'utf-8');
  if (!fixedStorage.includes('await writeFile')) {
    errors.push('storage.js was not actually fixed (await missing)');
  }

  // 5. Verify test script runs successfully after fixes
  const toolResults = events.filter(e => e.type === 'tool_result');
  const testRunResult = toolResults.find(r => r.result.output?.includes('All tests passed'));
  if (!testRunResult) {
    // Check if bash result contains assertion failure instead
    const bashResult = toolResults[toolResults.length - 2]; // before final answer
    if (bashResult && bashResult.result.output?.includes('Assertion failed')) {
      errors.push(`Tests failed after fixes: ${bashResult.result.output.slice(0, 200)}`);
    } else if (!testRunResult) {
      errors.push('Could not verify test script success — no "All tests passed" found');
    }
  }

  // 6. Verify event counts
  const toolCalls = events.filter(e => e.type === 'tool_call');
  const textEvents = events.filter(e => e.type === 'text');
  const doneEvents = events.filter(e => e.type === 'done');

  if (toolCalls.length < 9) {
    errors.push(`Expected >=9 tool calls, got ${toolCalls.length}`);
  }
  if (textEvents.length < 1) {
    errors.push(`Expected >=1 text event, got ${textEvents.length}`);
  }
  if (doneEvents.length !== 1) {
    errors.push(`Expected 1 done event, got ${doneEvents.length}`);
  }

  // ─── Bug Report ─────────────────────────────────────────────────────────────
  console.log('═══ BUG HUNT REPORT ═══');
  console.log(`Bugs discovered: ${llmState.discoveredBugs.length}/4`);
  for (const b of llmState.discoveredBugs) console.log(`  ✓ ${b}`);
  console.log(`\nFiles fixed: ${llmState.fixedFiles.length}/4`);
  for (const f of llmState.fixedFiles) console.log(`  ✓ ${f}`);
  console.log(`\nTool calls executed: ${toolCalls.length}`);
  console.log(`LLM calls: ${llmState.callCount}`);
  console.log(`Tokens used: ${session.tokenCount}`);

  // Cleanup
  await rm(workspace, { recursive: true, force: true });

  // Exit
  if (errors.length > 0) {
    console.error('\n═══ FAILURES ═══');
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }

  console.log('\n═══ ALL CHECKS PASSED ═══');
}

run().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});

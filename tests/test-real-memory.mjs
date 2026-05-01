/**
 * Real Memory Tools Test — memory_save, memory_search
 * Tests with a mock IMemoryIndex backed by in-memory storage.
 * Run with: node tests/test-real-memory.mjs
 */

import { createMemorySaveTool, createMemorySearchTool } from '../dist/agent-runtime/tools/index.js';
import { logger } from '../dist/core/logger.js';

let failCount = 0;
let passCount = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  ❌ FAIL: ${message}`);
    failCount++;
  } else {
    passCount++;
  }
}

function assertIncludes(haystack, needle, message) {
  assert(
    haystack.includes(needle),
    `${message}\n  expected to include: "${needle}"\n  got: "${haystack.slice(0, 200).replace(/\n/g, ' ')}"`
  );
}

// ─── Mock Memory Index ────────────────────────────────────────────────────────

class MockMemoryIndex {
  constructor() {
    this.memories = [];
    this.files = [];
    this.history = [];
  }

  async sync() { return { indexedFiles: 0, removedFiles: 0, chunks: 0 }; }

  async search(query, opts = {}) {
    const max = opts.maxResults ?? 5;
    return this.memories
      .filter(m => m.text.toLowerCase().includes(query.toLowerCase()))
      .slice(0, max)
      .map((m, i) => ({ path: m.path, text: m.text, startLine: i + 1, endLine: i + 1, score: 1.0 }));
  }

  async findFiles(query, opts = {}) {
    const max = opts.maxResults ?? 5;
    return this.files
      .filter(f => (f.description ?? '').toLowerCase().includes(query.toLowerCase()))
      .slice(0, max)
      .map(f => ({ path: f.path, description: f.description }));
  }

  async searchHistory(sessionId, query, opts = {}) {
    const max = opts.maxResults ?? 5;
    return this.history
      .filter(h => h.text.toLowerCase().includes(query.toLowerCase()))
      .slice(0, max)
      .map((h, i) => ({ path: h.path, text: h.text, startLine: i + 1, endLine: i + 1, score: 1.0 }));
  }

  async correctPath(rawPath) { return null; }
  async getRecentFiles() { return []; }
  async getKnownPaths() { return []; }

  async saveMemory(workspaceDir, title, content, type = 'general') {
    const path = `memory/${type}/${title.replace(/\s+/g, '_').toLowerCase()}.md`;
    this.memories.push({ path, text: `${title}\n\n${content}` });
    return path;
  }

  async touchFile() {}
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n🧪 Real Memory Tools Test\n');

  const memory = new MockMemoryIndex();
  const saveTool = createMemorySaveTool(memory, '/tmp/test-workspace', logger);
  const searchTool = createMemorySearchTool(memory, logger);

  // Pre-populate some data
  memory.files.push({ path: 'src/auth.ts', description: 'JWT authentication middleware' });
  memory.files.push({ path: 'src/db.ts', description: 'Database connection pool' });
  memory.history.push({ path: 'session-1', text: 'User asked about auth middleware configuration' });

  // ── memory_save ───────────────────────────────────────────────────────────
  console.log('  memory_save...');
  {
    const result = await saveTool.execute({
      title: 'Auth Middleware Refactor',
      content: 'Refactored JWT auth to use asymmetric keys. Files: src/auth.ts, src/middleware/jwt.ts',
      type: 'decision',
    });
    assertIncludes(result, 'Memory saved to', 'Should report saved memory');
    assertIncludes(result, 'memory/decision/', 'Should include type in path');
  }

  // ── memory_search (knowledge mode) ────────────────────────────────────────
  console.log('  memory_search (knowledge)...');
  {
    const result = await searchTool.execute({ query: 'JWT', mode: 'memory' });
    assertIncludes(result, 'Knowledge', 'Should search knowledge');
    assertIncludes(result, 'Auth Middleware Refactor', 'Should find saved memory');
  }

  // ── memory_search (files mode) ────────────────────────────────────────────
  console.log('  memory_search (files)...');
  {
    const result = await searchTool.execute({ query: 'auth', mode: 'files' });
    assertIncludes(result, 'Files', 'Should search files');
    assertIncludes(result, 'src/auth.ts', 'Should find auth.ts');
  }

  // ── memory_search (history mode) ──────────────────────────────────────────
  console.log('  memory_search (history)...');
  {
    const result = await searchTool.execute({ query: 'auth', mode: 'history' });
    assertIncludes(result, 'History', 'Should search history');
    assertIncludes(result, 'auth middleware', 'Should find history entry');
  }

  // ── memory_search (auto mode) ─────────────────────────────────────────────
  console.log('  memory_search (auto)...');
  {
    const result = await searchTool.execute({ query: 'auth' });
    assertIncludes(result, 'Knowledge', 'Auto mode should include knowledge');
    assertIncludes(result, 'Files', 'Auto mode should include files');
    assertIncludes(result, 'History', 'Auto mode should include history');
  }

  // ── memory_search (no results) ────────────────────────────────────────────
  console.log('  memory_search (no results)...');
  {
    const result = await searchTool.execute({ query: 'xyz-nonexistent' });
    assertIncludes(result, 'No relevant results', 'Should report no results');
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});

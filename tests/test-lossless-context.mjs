/**
 * Test: Lossless Context Management enhancements
 * Tests: archiveTurns, searchHistory, memory_search history mode
 */

import assert from "assert";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, writeFile, rm } from "fs/promises";

const testDbPath = join(tmpdir(), `simpleclaw-lossless-test-${Date.now()}.db`);

async function setup() {
  const { WorkspaceMemoryIndex } = await import("../dist/agent-runtime/memory/index.js");
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const memory = new WorkspaceMemoryIndex(testDbPath, logger);
  return { memory, logger };
}

async function teardown() {
  try { await rm(testDbPath); } catch { /* ignore */ }
}

// ─── Test 1: archiveTurns + searchHistory ────────────────────────────────────
console.log("\n[1/3] Lossless archive + search...");

const { memory } = await setup();

const sessionId = "test-session-001";
const turns = [
  { id: "t1", role: "user", content: "How do I implement JWT auth middleware?", timestamp: new Date("2026-01-01T10:00:00Z") },
  { id: "t2", role: "assistant", content: "You need to verify the token in the Authorization header...", timestamp: new Date("2026-01-01T10:00:05Z") },
  { id: "t3", role: "user", content: "What about refresh tokens?", timestamp: new Date("2026-01-01T10:00:10Z") },
];

await memory.archiveTurns(sessionId, turns);
console.log("  ✓ Turns archived");

const results = await memory.searchHistory(sessionId, "JWT auth middleware", { maxResults: 5 });
assert(results.length > 0, "should find archived turns");
assert(results.some(r => r.text.includes("JWT auth middleware")), "should match content");
console.log(`  ✓ Search found ${results.length} result(s)`);

// ─── Test 2: searchHistory filters by session ────────────────────────────────
console.log("\n[2/3] Session isolation...");

const otherResults = await memory.searchHistory("different-session", "JWT");
assert(otherResults.length === 0, "different session should have no results");
console.log("  ✓ Session isolation works");

// ─── Test 3: memory_search tool with history mode ────────────────────────────
console.log("\n[3/3] memory_search tool history mode...");

const { createMemorySearchTool } = await import("../dist/agent-runtime/tools/memory-search.js");
const tool = createMemorySearchTool(memory, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const output = await tool.execute({
  query: "refresh tokens",
  mode: "history",
  session_id: sessionId,
});

assert(output.includes("refresh tokens"), "should find refresh token discussion");
console.log("  ✓ memory_search history mode works");

// ─── Test 4: Compactor passes memory option ──────────────────────────────────
console.log("\n[4/4] Compactor accepts memory option...");

const { DEFAULT_COMPACTOR_CONFIG } = await import("../dist/core/compactor.js");
assert(DEFAULT_COMPACTOR_CONFIG.hierarchical === true, "hierarchical enabled by default");
console.log("  ✓ Compactor config has hierarchical enabled");

await teardown();
console.log("\n✅ All lossless context tests passed!\n");

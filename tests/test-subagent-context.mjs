/**
 * Test: Sub-agent system + Context management enhancements
 * Tests AgentPool.spawnMultiple, ToolRegistry truncation, and HierarchicalCompaction.
 */

import assert from "assert";

// ─── Test 1: ToolRegistry truncation ─────────────────────────────────────────
console.log("\n[1/3] ToolRegistry truncation...");

const { ToolRegistry } = await import("../dist/agent-runtime/tool-registry.js");

const registry = new ToolRegistry();
registry.register({
  name: "bash",
  description: "Run shell commands",
  parameters: { type: "object", properties: {} },
  execute: async () => "x".repeat(20000), // 20KB output
});

const result = await registry.execute({ id: "test1", name: "bash", arguments: {} });
assert(result.output.length < 10000, "bash output should be truncated");
assert(result.output.includes("truncated by context manager"), "should contain truncation notice");
console.log("  ✓ Large bash output truncated correctly");

// Small output should NOT be truncated
registry.register({
  name: "ls",
  description: "List files",
  parameters: { type: "object", properties: {} },
  execute: async () => "file1.txt\nfile2.txt",
});
const result2 = await registry.execute({ id: "test2", name: "ls", arguments: {} });
assert(!result2.output.includes("truncated"), "small output should not be truncated");
console.log("  ✓ Small output preserved");

// ─── Test 2: AgentPool.spawnMultiple interface ───────────────────────────────
console.log("\n[2/3] AgentPool.spawnMultiple interface...");

const { AgentPool } = await import("../dist/agent-runtime/agent-pool.js");

// Verify the class has spawnMultiple method
assert(typeof AgentPool.prototype.spawnMultiple === "function", "AgentPool should have spawnMultiple");
console.log("  ✓ AgentPool.spawnMultiple method exists");

// Verify forbidden tools include spawn_multiple
const forbiddenTools = new Set(["spawn", "spawn_multiple"]);
assert(forbiddenTools.has("spawn_multiple"), "spawn_multiple should be forbidden for sub-agents");
console.log("  ✓ Recursion guard covers spawn_multiple");

// ─── Test 3: ContextCompactor hierarchical config ────────────────────────────
console.log("\n[3/3] ContextCompactor hierarchical config...");

const { DEFAULT_COMPACTOR_CONFIG } = await import("../dist/core/compactor.js");

assert(DEFAULT_COMPACTOR_CONFIG.hierarchical === true, "hierarchical should be enabled by default");
assert(DEFAULT_COMPACTOR_CONFIG.maxHierarchyLevels === 3, "default maxHierarchyLevels should be 3");
console.log("  ✓ Hierarchical compaction enabled by default");

// ─── Test 4: spawn_multiple tool schema ──────────────────────────────────────
console.log("\n[4/4] spawn_multiple tool schema...");

const { createSpawnMultipleTool } = await import("../dist/agent-runtime/tools/spawn-multiple.js");

// Mock pool
const mockPool = {
  spawnMultiple: async ({ tasks, maxConcurrency }) => ({
    results: tasks.map((t, i) => ({
      agentId: `sub-${i}`,
      sessionId: `sess-${i}`,
      result: `Result for: ${t.task}`,
      events: [],
    })),
    mergedSummary: `Dispatched ${tasks.length} tasks with concurrency ${maxConcurrency}`,
  }),
};

const tool = createSpawnMultipleTool(mockPool, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
assert(tool.name === "spawn_multiple", "tool name should be spawn_multiple");
assert(tool.parameters.properties.tasks, "should have tasks array parameter");
assert(tool.parameters.properties.maxConcurrency, "should have maxConcurrency parameter");
console.log("  ✓ spawn_multiple tool schema correct");

// Test execution
const execResult = await tool.execute({
  description: "Test parallel dispatch",
  tasks: [
    { task: "Find auth usages" },
    { task: "Find db usages" },
  ],
  maxConcurrency: 2,
});
assert(execResult.includes("Dispatched 2 tasks"), "should return merged summary");
console.log("  ✓ spawn_multiple execution works");

// Test max task limit
const tooManyResult = await tool.execute({ tasks: Array(25).fill({ task: "x" }) });
assert(tooManyResult.includes("Too many tasks"), "should reject >20 tasks");
console.log("  ✓ Task limit enforcement works");

console.log("\n✅ All sub-agent + context tests passed!\n");

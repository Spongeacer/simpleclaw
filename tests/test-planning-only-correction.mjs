/**
 * Test: Planning-Only Detection & Correction
 * Three-layer defense: Prompt prevention + Structured detection + Steer correction
 */

import assert from "assert";

const { AgentEngine } = await import("../dist/core/agent-engine.js");

// Mock dependencies
const mockLLM = {
  modelRef: { provider: "test", model: "test" },
  async complete() { return { text: "" }; },
};
const mockStore = {
  async get(id) { return { sessionId: id, agentId: "a1", turns: [], tokenCount: 0, metadata: {}, createdAt: new Date(), updatedAt: new Date() }; },
  async update() {},
  async create() {},
  async delete() {},
  async list() { return []; },
};
const mockTools = {
  schema() { return []; },
  get() { return undefined; },
  list() { return []; },
  async execute() { return { callId: "", output: "" }; },
};
const mockApproval = {
  isRequired() { return false; },
  async request() { return "approved"; },
  listPending() { return []; },
};
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const config = {
  id: "test", name: "test", model: { provider: "test", model: "test" },
  workspace: "/tmp", maxIterations: 5,
};

const engine = new AgentEngine({ config: config, store: mockStore, llm: mockLLM, tools: mockTools, approval: mockApproval, logger: logger });

// ─── Test 1: Detect planning-only (no tools on actionable request) ───────────
console.log("\n[1/5] Detect planning-only...");

const actionableTurns = [
  { id: "u1", role: "user", content: "Fix the bug in auth.js", timestamp: new Date() },
];

const planningResponse = { text: "I will first read the auth.js file to understand the issue.", toolCalls: [] };
assert(engine["detectPlanningOnly"](planningResponse, actionableTurns) === true, "should detect planning-only");
console.log("  ✓ Detected: no tools on actionable request");

// ─── Test 2: NOT planning-only (has real tool calls) ─────────────────────────
console.log("\n[2/5] NOT planning-only when tools are called...");

const toolResponse = {
  text: "Let me read the file.",
  toolCalls: [{ id: "tc1", name: "read", arguments: { path: "auth.js" } }],
};
assert(engine["detectPlanningOnly"](toolResponse, actionableTurns) === false, "should NOT flag when tools called");
console.log("  ✓ Not flagged: real tool calls present");

// ─── Test 3: NOT planning-only (only think tool) ─────────────────────────────
console.log("\n[3/5] think/update_plan alone = planning-only...");

const thinkResponse = {
  text: "Plan: 1. Read file 2. Fix bug 3. Test",
  toolCalls: [{ id: "tc1", name: "think", arguments: {} }],
};
assert(engine["detectPlanningOnly"](thinkResponse, actionableTurns) === true, "think alone is planning-only");
console.log("  ✓ think alone detected as planning-only");

// ─── Test 4: NOT planning-only (casual chat) ─────────────────────────────────
console.log("\n[4/5] Casual chat NOT flagged...");

const casualTurns = [
  { id: "u1", role: "user", content: "What is Node.js?", timestamp: new Date() },
];
const casualResponse = { text: "Node.js is a JavaScript runtime...", toolCalls: [] };
assert(engine["detectPlanningOnly"](casualResponse, casualTurns) === false, "casual chat should not be flagged");
console.log("  ✓ Casual chat not flagged");

// ─── Test 5: isActionableRequest ─────────────────────────────────────────────
console.log("\n[5/5] Actionable request detection...");

assert(engine["isActionableRequest"]("fix the bug") === true, "fix is actionable");
assert(engine["isActionableRequest"]("implement auth") === true, "implement is actionable");
assert(engine["isActionableRequest"]("What is Node.js?") === false, "what is is not actionable");
assert(engine["isActionableRequest"]("explain how it works") === false, "explain is not actionable");
console.log("  ✓ Actionable request detection works");

// ─── Test 6: Steer message ───────────────────────────────────────────────────
console.log("\n[6/5] Steer message content...");

const steer = engine["buildPlanningOnlySteer"]();
assert(steer.includes("[SYSTEM CORRECTION]"), "steer has header");
assert(steer.includes("Act now"), "steer has act-now directive");
assert(steer.includes("DO NOT"), "steer has do-not section");
console.log("  ✓ Steer message well-structured");

console.log("\n✅ All planning-only correction tests passed!\n");

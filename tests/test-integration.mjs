/**
 * Integration test — backend via WebSocket
 * Tests: Instruction loading, Skill listing, Tool selection rule
 */

import WebSocket from "ws";

const WS_URL = "ws://127.0.0.1:18789";
const TIMEOUT = 60000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function send(ws, id, method, params) {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

async function run() {
  console.log(`Connecting to ${WS_URL}...`);
  const ws = new WebSocket(WS_URL);

  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  console.log("Connected.\n");

  // Step 1: Connect
  send(ws, 1, "connect", { role: "client" });
  const connectResp = await waitForId(ws, 1);
  console.log("Connect:", JSON.stringify(connectResp.result, null, 2));

  // Step 2: Create session
  send(ws, 2, "sessions.create", { agentId: "default" });
  const sessionResp = await waitForId(ws, 2);
  const sessionId = sessionResp.result.sessionId;
  console.log("Session:", sessionId, "\n");

  // Test cases
  const tests = [
    {
      name: "Tool Selection Rule (no tools for general knowledge)",
      message: "什么是 TypeScript",
      expectNoTools: true,
      timeout: 60000,
    },
    {
      name: "Skill auto-load (agent should call skill tool)",
      message: "帮我审查一下这个代码有没有问题",
      expectTool: "skill",
      timeout: 60000,
    },
    {
      name: "Instruction awareness",
      message: "写一个 hello world",
      expectContains: ["TypeScript"],
      timeout: 60000,
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    console.log(`\n═══ ${test.name} ═══`);
    console.log(`User: ${test.message}`);

    const events = await chatAndCollect(ws, sessionId, test.message, test.timeout);
    const textEvents = events.filter((e) => e.type === "text");
    const toolCallEvents = events.filter((e) => e.type === "tool_call");
    const allText = textEvents.map((e) => e.text).join(" ");

    console.log(`  Events: ${events.length} total, ${textEvents.length} text, ${toolCallEvents.length} tool_calls`);
    if (toolCallEvents.length > 0) {
      for (const tc of toolCallEvents) {
        console.log(`  [TOOL] ${tc.call.name}`);
      }
    }
    console.log(`  [ANSWER] ${allText.slice(0, 200).replace(/\n/g, " ")}`);

    // Assertions
    const errors = [];
    if (test.expectNoTools && toolCallEvents.length > 0) {
      errors.push(`Expected no tool calls, got ${toolCallEvents.length}: ${toolCallEvents.map((t) => t.call.name).join(", ")}`);
    }
    if (test.expectContains) {
      for (const keyword of test.expectContains) {
        if (!allText.toLowerCase().includes(keyword.toLowerCase())) {
          errors.push(`Expected response to contain "${keyword}"`);
        }
      }
    }
    if (test.expectTool) {
      const found = toolCallEvents.some((e) => e.call.name === test.expectTool);
      if (!found) {
        errors.push(`Expected tool "${test.expectTool}" to be called. Got: ${toolCallEvents.map((t) => t.call.name).join(", ") || "none"}`);
      }
    }

    if (errors.length === 0) {
      console.log("  ✅ PASS");
      passed++;
    } else {
      console.log("  ❌ FAIL");
      for (const e of errors) console.log(`    - ${e}`);
      failed++;
    }
  }

  ws.close();
  console.log(`\n═══ Results: ${passed}/${tests.length} passed ═══`);
  process.exit(failed > 0 ? 1 : 0);
}

function waitForId(ws, id) {
  return new Promise((resolve) => {
    const handler = (data) => {
      const frame = JSON.parse(data);
      if (frame.id === id) {
        ws.off("message", handler);
        resolve(frame);
      }
    };
    ws.on("message", handler);
  });
}

async function chatAndCollect(ws, sessionId, message, timeoutMs) {
  const events = [];
  let done = false;

  const handler = (data) => {
    const frame = JSON.parse(data);
    if (frame.result && frame.result.type) {
      events.push(frame.result);
      if (frame.result.type === "done") {
        done = true;
      }
    }
  };
  ws.on("message", handler);

  const reqId = Date.now();
  send(ws, reqId, "chat.send", { sessionId, agentId: "default", message });

  const start = Date.now();
  while (!done && Date.now() - start < timeoutMs) {
    await sleep(500);
  }

  ws.off("message", handler);
  return events;
}

run().catch((e) => {
  console.error("Test error:", e);
  process.exit(1);
});

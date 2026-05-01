/**
 * Test WebSocket + sessions.create flow
 */

import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:18789");

ws.on("open", () => {
  console.log("WS open");
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "connect", params: { role: "client" } }));
});

ws.on("message", (data) => {
  const frame = JSON.parse(data);
  console.log("←", JSON.stringify(frame, null, 2));

  if (frame.id === 1 && frame.result) {
    console.log("Connected, creating session...");
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "sessions.create", params: { agentId: "default" } }));
  }

  if (frame.id === 2 && frame.result) {
    console.log("Session created:", frame.result.sessionId);
    console.log("Now sending chat...");
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "chat.send", params: { sessionId: frame.result.sessionId, agentId: "default", message: "Hi" } }));
  }

  if (frame.id === 3 && frame.result) {
    console.log("Chat event:", JSON.stringify(frame.result));
  }
});

ws.on("error", (e) => console.error("WS error:", e.message));
ws.on("close", () => console.log("WS closed"));

setTimeout(() => ws.close(), 10000);

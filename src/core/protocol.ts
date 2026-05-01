/**
 * SimpleClaw — Minimal JSON-RPC protocol
 * A strict subset of OpenClaw's gateway protocol.
 */

import type { ConversationTurn, OutboundMessage } from "./types.js";

// ─── Frame Types ──────────────────────────────────────────────────────────────

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: T;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: T;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcFrame = JsonRpcRequest | JsonRpcResponse;

// ─── Method Names ─────────────────────────────────────────────────────────────

export const GatewayMethods = {
  CONNECT: "connect",
  CHAT_SEND: "chat.send",
  CHAT_ABORT: "chat.abort",
  SESSIONS_CREATE: "sessions.create",
  SESSIONS_SEND: "sessions.send",
  SESSIONS_GET: "sessions.get",
  CHANNELS_SEND: "channels.send",
  TASKS_CREATE: "tasks.create",
  TASKS_GET: "tasks.get",
  TASKS_LIST: "tasks.list",
  QUESTION_ANSWER: "question.answer",
} as const;

// ─── Method Params / Results ──────────────────────────────────────────────────

export interface ConnectParams {
  token?: string;
  role: "client" | "extension";
  clientInfo: { name: string; version: string };
}

export interface ConnectResult {
  sessionToken: string;
  gatewayVersion: string;
}

export interface ChatSendParams {
  sessionId: string;
  agentId: string;
  message: string;
  attachments?: Array<{ mimeType: string; data: string }>; // base64
}

export interface SessionsCreateParams {
  agentId: string;
  channelId?: string;
  initialMessage?: string;
}

export interface SessionsCreateResult {
  sessionId: string;
  agentId: string;
}

export interface SessionsGetResult {
  sessionId: string;
  agentId: string;
  turns: ConversationTurn[];
  tokenCount: number;
}

export interface ChannelsSendParams {
  channelId: string;
  message: OutboundMessage;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function isJsonRpcRequest(frame: unknown): frame is JsonRpcRequest {
  return (
    typeof frame === "object" &&
    frame !== null &&
    (frame as JsonRpcRequest).jsonrpc === "2.0" &&
    "method" in frame
  );
}

export function isJsonRpcResponse(frame: unknown): frame is JsonRpcResponse {
  return (
    typeof frame === "object" &&
    frame !== null &&
    (frame as JsonRpcResponse).jsonrpc === "2.0" &&
    !("method" in frame)
  );
}

export function buildError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function buildResult<T>(id: JsonRpcId, result: T): JsonRpcResponse<T> {
  return { jsonrpc: "2.0", id, result };
}

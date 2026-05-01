/**
 * SimpleClaw — Core shared types
 * Distilled from OpenClaw's most referenced primitives.
 */

// ─── Identity ───────────────────────────────────────────────────────────────

export type AgentId = string;
export type SessionId = string;
export type ChannelId = string;
export type AccountId = string;
export type MessageId = string;
export type ToolCallId = string;

// ─── Messages ─────────────────────────────────────────────────────────────────

export interface InboundMessage {
  id: MessageId;
  sessionId: SessionId;
  agentId: AgentId;
  text: string;
  sender: SenderInfo;
  timestamp: Date;
  attachments?: Attachment[];
}

export interface OutboundMessage {
  id: MessageId;
  sessionId: SessionId;
  targetId: string; // channel-specific target (DM id, thread id, etc.)
  text: string;
  replyTo?: MessageId;
  attachments?: Attachment[];
}

export interface SenderInfo {
  id: string;
  name?: string;
  isDM: boolean;
}

export interface Attachment {
  type: "image" | "file" | "audio";
  url?: string;
  data?: Uint8Array;
  mimeType: string;
  filename?: string;
}

// ─── Conversation ─────────────────────────────────────────────────────────────

export type Role = "user" | "assistant" | "system" | "tool";

export interface ConversationTurn {
  id: string;
  role: Role;
  content: string;
  reasoning?: string; // model's internal reasoning chain (e.g. <think> blocks)
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  toolCallId?: string; // for "tool" role: links to the original tool call
  timestamp: Date;
}

export interface ToolCall {
  id: ToolCallId;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: ToolCallId;
  output: string;
  isError?: boolean;
}

// ─── Agent Config ─────────────────────────────────────────────────────────────
// AgentConfig, ModelRef, GatewayConfig, ProviderConfig, and SandboxConfig
// are derived from Zod schemas in config-schema.ts (single source of truth).
export type { AgentConfig, ModelRef, GatewayConfig, ProviderConfig, SandboxConfig } from "./config-schema.js";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type ApprovalPolicy =
  | "always"      // every action requires approval
  | "dangerous"   // only dangerous actions (write, exec) require approval
  | "never";      // auto-execute (not recommended)

// ─── Chat Events (streamed from Agent Runtime) ────────────────────────────────
// Defined in interfaces.ts as IChatEvent. Re-exported here for convenience.
export type { IChatEvent as ChatEvent } from "./interfaces.js";

// ─── Gateway ──────────────────────────────────────────────────────────────────
// AuthConfig, RateLimitConfig, and SessionStoreConfig are manual types
// (no corresponding Zod schema export needed).

export interface AuthConfig {
  type: "none" | "token" | "password";
  token?: string;
  passwordHash?: string;
}

export interface RateLimitConfig {
  maxRequestsPerMinute: number;
  blockDurationSeconds: number;
}

export interface SessionStoreConfig {
  type: "sqlite" | "memory";
  path?: string; // for sqlite
}

// ─── Channel SDK ──────────────────────────────────────────────────────────────

export interface DMPolicy {
  allowsUnsolicited: boolean;
  requiresMentionInGroup: boolean;
}

// ChannelAdapter is defined in interfaces.ts (contract layer)
export type { ChannelAdapter } from "./interfaces.js";

// ─── Plugin ───────────────────────────────────────────────────────────────────

export interface PluginManifest {
  name: string;
  version: string;
  type: "channel" | "provider" | "tool";
  entry: string; // path to main file
  configSchema?: Record<string, unknown>;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  exports: unknown;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class SimpleClawError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "SimpleClawError";
  }
}

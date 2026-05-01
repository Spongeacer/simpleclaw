/**
 * SimpleClaw Core — Platform-agnostic interfaces
 * Zero Node.js dependencies. Zero platform assumptions.
 */

import type {
  AgentConfig,
  ChannelId,
  ConversationTurn,
  InboundMessage,
  OutboundMessage,
  Role,
  SessionId,
  TaskStatus,
  ToolCall,
  ToolResult,
} from "./types.js";

export type { ConversationTurn } from "./types.js";

// ─── Logger ───────────────────────────────────────────────────────────────────

export interface ILogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ─── Sandbox ──────────────────────────────────────────────────────────────────

export interface IExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ISandbox {
  readFile(path: string): Promise<string>;
  /** @param expectedContent If provided, the write will atomically verify the file still contains this exact text before overwriting. Throws on mismatch. */
  writeFile(path: string, content: string, expectedContent?: string): Promise<void>;
  /** Resolve a raw path to the sandbox's internal absolute path. */
  resolvePath?(path: string): string;
  exec(command: string, options?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<IExecResult>;
  /** Execute a command in a true Linux bash environment (Docker on Windows, native bash on Linux/macOS). */
  execBash?(command: string, options?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<IExecResult>;
  /** Return the current platform name for tool description purposes. */
  getPlatformInfo?(): { platform: string; shell: string; availableCommands: string };
  /** Start a background shell process and return a shell ID for later retrieval. */
  execBackground?(command: string, options?: { timeoutMs?: number }): Promise<{ shellId: string }>;
  /** Retrieve incremental output from a background shell process. */
  getBackgroundOutput?(shellId: string, offset?: number): Promise<{ stdout: string; stderr: string; done: boolean; exitCode?: number }>;
  /** Terminate a background shell process. */
  killBackground?(shellId: string): Promise<boolean>;
}

// ─── LLM ──────────────────────────────────────────────────────────────────────

export interface ILLMMessage {
  role: Exclude<Role, "tool"> | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  cacheControl?: { type: "ephemeral" };
}

// ─── Tool Call Hooks ──────────────────────────────────────────────────────────

export interface IToolCallHookContext {
  call: ToolCall;
  result?: ToolResult;
  sessionId: string;
}

export interface IToolCallHooks {
  beforeExecute?(ctx: IToolCallHookContext): Promise<void> | void;
  afterExecute?(ctx: IToolCallHookContext): Promise<void> | void;
}

export interface ILLMResponse {
  text: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface IToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ILLMClient {
  readonly modelRef: { provider: string; model: string };
  complete(messages: ILLMMessage[], tools?: IToolSchema[]): Promise<ILLMResponse>;
}

// ─── Session Store ────────────────────────────────────────────────────────────

export interface ISessionState {
  sessionId: SessionId;
  agentId: string;
  channelId?: string;
  parentSessionId?: SessionId; // for sub-agent sessions
  turns: ConversationTurn[];
  tokenCount: number;
  metadata?: Record<string, unknown>; // session-level flags (e.g. instructionsInjected)
  createdAt: Date;
  updatedAt: Date;
}

export interface ISessionStore {
  create(state: Omit<ISessionState, "createdAt" | "updatedAt">): Promise<ISessionState>;
  get(sessionId: SessionId): Promise<ISessionState | null>;
  update(sessionId: SessionId, patch: Partial<Omit<ISessionState, "sessionId" | "createdAt">>): Promise<void>;
  delete(sessionId: SessionId): Promise<void>;
  list(agentId?: string): Promise<ISessionState[]>;
  dispose?(): Promise<void> | void;
}

// ─── Approval ─────────────────────────────────────────────────────────────────

export interface IApprovalRequest {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  timestamp: Date;
}

export interface IApprovalGate {
  isRequired(toolName: string): boolean;
  request(req: IApprovalRequest): Promise<"approved" | "denied">;
  listPending(): IApprovalRequest[];
}

// ─── Tool Registry ────────────────────────────────────────────────────────────

export interface ToolContext {
  sessionId?: string;
  depth?: number;
}

export interface ITool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<string>;
}

export interface IToolRegistry {
  register(tool: ITool): void;
  get(name: string): ITool | undefined;
  list(): ITool[];
  schema(): IToolSchema[];
  execute(call: ToolCall, ctx?: ToolContext): Promise<ToolResult>;
  filter(predicate: (tool: ITool) => boolean): IToolRegistry;
}

// ─── Context Engine (pluggable context management) ────────────────────────────

/**
 * IContextEngine defines the pluggable contract for context management.
 *
 * Inspired by OpenClaw's ContextEngine: rather than hard-coding compaction
 * logic inside AgentEngine, context assembly, compression, and ingestion are
 * delegated to a swappable engine. This lets SimpleClaw adopt external
 * memory systems, RAG pipelines, or custom summarization strategies without
 * changing the core agent loop.
 */
export interface IContextEngine {
  readonly info: { id: string; name: string };

  /**
   * Assemble model context under a token budget.
   *
   * The engine may compact, reorder, or augment turns. It must NOT mutate
   * the input array — return a new array for message building.
   */
  assemble(params: {
    turns: ConversationTurn[];
    config?: Record<string, unknown> | object;
    tokenBudget?: number;
    modelId?: string;
    availableTools?: string[];
    prompt?: string;
    systemPromptText?: string;
    toolSchemas?: IToolSchema[];
    contextWindow?: number;
    sessionId?: string;
    memory?: IMemoryIndex;
  }): Promise<{
    turns: ConversationTurn[];
    didCompact: boolean;
    summary: string | null;
    estimatedTokens: number;
  }>;

  /** Record actual token usage for calibration (optional). */
  recordUsage?(
    actualTokens: number,
    turns: ConversationTurn[],
    options?: { systemPromptText?: string; toolSchemas?: IToolSchema[] },
  ): void;

  /** Ingest a completed turn into the engine's store (optional). */
  ingest?(params: { sessionId: string; turn: ConversationTurn }): Promise<void>;

  /** Clean up per-session resources to prevent memory leaks (optional). */
  cleanupSession?(sessionId: string): void;
}

// ─── Chat Events ──────────────────────────────────────────────────────────────

export type IChatEvent =
  | { type: "thinking"; text: string }
  | { type: "tool_call"; call: { id: string; name: string; arguments: Record<string, unknown> } }
  | { type: "tool_result"; result: ToolResult }
  | { type: "text"; text: string }
  | { type: "error"; code: string; message: string }
  | { type: "done" }
  | { type: "question"; questionId: string; questions: AskUserQuestion[] };

export interface AskUserQuestion {
  question: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

// ─── Channel SDK ──────────────────────────────────────────────────────────────

export interface ChannelAdapter {
  readonly id: ChannelId;
  authenticate(credentials: Record<string, string>): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => void): void;
  getDMPolicy(): { allowsUnsolicited: boolean; requiresMentionInGroup: boolean };
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ─── Memory Index (Workspace Knowledge + File Map) ────────────────────────────

export interface IMemoryIndex {
  /** Sync workspace files into the index (incremental). */
  sync(workspaceDir: string): Promise<{ indexedFiles: number; removedFiles: number; chunks: number }>;

  /** Semantic search across indexed memories. */
  search(query: string, opts?: { maxResults?: number }): Promise<MemoryChunk[]>;

  /** Find files by semantic description. */
  findFiles(query: string, opts?: { maxResults?: number }): Promise<MemoryFileResult[]>;

  /** Try to correct a potentially wrong path. */
  correctPath(rawPath: string): Promise<string | null>;

  /** Get recently accessed files. */
  getRecentFiles(n?: number): Promise<MemoryFileResult[]>;

  /** Get all known indexed file paths. */
  getKnownPaths(): Promise<string[]>;

  /** Save a memory entry to the workspace. */
  saveMemory(workspaceDir: string, title: string, content: string, type?: string): Promise<string>;

  /** Record a file access (updates lastAccessed). */
  touchFile(path: string): Promise<void>;

  /** Archive conversation turns before compaction (lossless context management). */
  archiveTurns(sessionId: SessionId, turns: ConversationTurn[]): Promise<void>;

  /** Search archived conversation history. If sessionId is provided, scope to that session; otherwise search globally across all sessions. */
  searchHistory(sessionId: SessionId | undefined, query: string, opts?: { maxResults?: number }): Promise<MemoryChunk[]>;
}

export interface MemoryChunk {
  path: string;
  text: string;
  startLine?: number;
  endLine?: number;
}

export interface MemoryFileResult {
  path: string;
  description?: string;
}

// ─── Agent Pool ───────────────────────────────────────────────────────────────

export type AgentRole = "explore" | "coder" | "tester" | string;

export interface SpawnOptions {
  /** Short description (3-5 words) of what this sub-agent dispatch does */
  description?: string;
  /** The task for the sub-agent to perform */
  task: string;
  /** Optional: pre-defined role that restricts tool set */
  role?: AgentRole;
  /** Optional: override the model for this sub-agent */
  model?: { provider: string; model: string; temperature?: number; maxTokens?: number; strictToolSchema?: boolean; contextWindow?: number; capabilities?: { strictToolSchema: boolean } };
  /** Optional: restrict tools available to the sub-agent */
  tools?: string[];
  /** Optional: custom system prompt for the sub-agent */
  systemPrompt?: string;
  /** Optional: pass a previous sub-agent session ID to resume instead of creating a new one */
  sessionId?: SessionId;
  /** Optional: parent session ID for hierarchical tracking */
  parentSessionId?: SessionId;
  /** Optional: timeout in milliseconds for the sub-agent execution */
  timeoutMs?: number;
  /** Optional: maximum number of tool call iterations */
  maxIterations?: number;
  /** Optional: include full event stream (thinking/tool_call/tool_result) in result. Default false for token efficiency. */
  verbose?: boolean;
  /** Optional: file paths to read and prepend to the task as context */
  contextFiles?: string[];
  /** Optional: current spawn depth (0 = root agent). Used for recursion guarding. */
  depth?: number;
}

export interface SpawnResult {
  agentId: string;
  sessionId: string;
  result: string;
  events: IChatEvent[];
}

export interface IAgentPool {
  spawn(options: SpawnOptions): Promise<SpawnResult>;
  spawnMultiple(options: { description?: string; tasks: Array<Omit<SpawnOptions, "parentSessionId">>; maxConcurrency?: number }): Promise<{ results: SpawnResult[]; mergedSummary: string }>;
}

// ─── Notification Bus ─────────────────────────────────────────────────────────

export type TaskNotification =
  | { kind: "event"; event: IChatEvent }
  | { kind: "status"; status: TaskStatus; error?: string };

export type TaskHandler = (taskId: string, notif: TaskNotification) => void;

export interface INotificationBus {
  subscribe(taskId: string, handler: TaskHandler): () => void;
  publish(taskId: string, notif: TaskNotification): void;
}

// ─── User Memory (Bounded cross-session memory) ───────────────────────────────

export interface IUserMemory {
  readonly memoryPath: string;
  readonly userPath: string;
  readonly memoryCharLimit: number;
  readonly userCharLimit: number;
  load(): Promise<{ memory: string; user: string; memoryUsage: string; userUsage: string }>;
  addEntry(type: "memory" | "user", entry: string): Promise<{ success: boolean; error?: string; usage: string }>;
  replaceEntry(type: "memory" | "user", index: number, entry: string): Promise<{ success: boolean; error?: string; usage: string }>;
  removeEntry(type: "memory" | "user", index: number): Promise<{ success: boolean; error?: string; usage: string }>;
  listEntries(type: "memory" | "user"): Promise<{ entries: string[]; usage: string }>;
}

// ─── Agent Engine ─────────────────────────────────────────────────────────────

export interface IAgentEngine {
  chat(sessionId: SessionId, message: string, signal?: AbortSignal): AsyncGenerator<IChatEvent>;
  answerQuestion?(questionId: string, answer: string): void;
  dispose?(): Promise<void> | void;
}

export interface IAgentEngineFactory {
  create(
    config: AgentConfig,
    llm: ILLMClient,
    tools: IToolRegistry,
    overrides?: { approval?: IApprovalGate; logger?: ILogger; depth?: number },
  ): IAgentEngine;
}

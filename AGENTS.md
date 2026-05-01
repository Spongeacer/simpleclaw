# SimpleClaw — Agent Guide

This file is for AI agents working on the SimpleClaw codebase. It supplements `Readme.MD` with implementation details, conventions, and gotchas.

---

## Project Overview

SimpleClaw is a minimal AI agent runtime with a 4-layer onion architecture:

```
Layer 4: UI / Channel Adapters  (ui/, src/channel-sdk/)
Layer 3: Gateway                (src/gateway/)        — WebSocket JSON-RPC server
Layer 2: Agent Runtime          (src/agent-runtime/)  — Node.js implementations
Layer 1: Core                   (src/core/)           — Pure logic, zero Node.js deps
```

**Golden rule**: `src/core/` must NEVER import `fs`, `path`, `child_process`, `http`, `crypto` (Web Crypto `crypto.randomUUID()` is OK), or any Node.js builtin. All I/O goes through injected interfaces.

---

## Layer 1: Core (`src/core/`)

### `interfaces.ts` — The Contract Layer

This is the most important file. All cross-layer communication is defined here:

| Interface | Who implements | Who consumes |
|-----------|---------------|--------------|
| `ILLMClient` | `OpenAICompatibleClient`, `MockLLMClient` | `AgentEngine` |
| `ISandbox` | `DockerSandbox` | `read`, `edit`, `bash` tools |
| `IToolRegistry` | `ToolRegistry` | `AgentEngine` |
| `ISessionStore` | `MemorySessionStore`, `SQLiteSessionStore` | `AgentEngine`, `Gateway` |
| `IApprovalGate` | `ApprovalGate` | `AgentEngine` |
| `ILogger` | `logger` (global) | Everyone |
| `ITaskQueue` | `MemoryTaskQueue` | `Gateway`, `BackgroundWorker` |
| `INotificationBus` | `NotificationBus` | `Gateway`, `BackgroundWorker` |
| `IAgentEngine` | `AgentEngine` | `Gateway`, `BackgroundWorker` |
| `IAgentPool` | `AgentPool` | `spawn` tool |

**When adding a new feature that needs I/O**: Define the interface here first, implement in `agent-runtime/`, inject into `AgentEngine` or `Gateway`.

### `agent-engine.ts` — The Brain

```typescript
class AgentEngine implements IAgentEngine {
  async *chat(sessionId, message): AsyncGenerator<ChatEvent>
}
```

**Flow** (max 10 iterations):
1. Append user turn to session
2. `buildMessages()` → injects dynamic system prompt + compacts context
3. `llm.complete(messages, tools.schema())` → get response
4. If `toolCalls`: yield `thinking` + `tool_call` events → approval gate → execute → yield `tool_result`
5. If no `toolCalls`: yield `text` + `done`

**System prompt builder** (`buildSystemPrompt()`) has 5 sections:
- User prompt + complexity detection
- Available tools list (dynamic from `tools.schema()`)
- Tool usage rules (numbered, conditional on available tools)
- Error handling guidance
- Workspace context

**Context compaction**: `ContextCompactor` is called in `buildMessages()`. It estimates tokens (including system prompt, tool schemas, per-message overhead, and a dynamic calibration ratio), and if over threshold, asks LLM to summarize old turns while preserving the last N turns. The **original session turns are NOT modified** — compaction only affects the messages sent to LLM.

**Token estimation**:
- Counts text from all turns (content, reasoning, toolCalls)
- Adds system prompt length and tool schema JSON size
- Adds 20 chars per message for JSON/formatting overhead
- Applies safety margin (1.2x) and dynamic calibration ratio
- Threshold resolution: `thresholdTokens` > `thresholdPercent * contextWindow` > `contextWindow * 0.6` > 6000

**Calibration**: `ContextCompactor` maintains a smoothed calibration ratio (EMA α=0.3) by comparing actual `usage.promptTokens` against its own estimate after each LLM call. `AgentEngine` simply calls `compactor.recordUsage(actualPromptTokens, turns, options)` — the compactor computes estimated vs actual and updates the ratio internally.

**Plan mode detection**: Triggered by keywords ("refactor", "implement") or multi-file references. The system prompt adapts accordingly.

### `compactor.ts`

```typescript
class ContextCompactor {
  async compact(turns, config): Promise<{ compacted, didCompact, summary }>
}
```

- Token estimation: counts turns text + system prompt + tool schema JSON + 20 chars per-message overhead, then `(chars / 4) * 1.2 * calibrationRatio`
- Default config: `preserveTurns: 4`, `summaryMaxLength: 4000` (threshold resolved from `thresholdTokens` → `thresholdPercent * contextWindow` → `contextWindow * 0.6` → 6000)
- When compacting: preserves last N turns, summarizes older ones via LLM into a single "system" turn

### `agent-pool.ts`

Re-exports `IAgentPool`, `SpawnOptions`, `SpawnResult`, and `AgentRole` from `interfaces.ts` (the contract layer). The actual interfaces are defined in `interfaces.ts` so that the `spawn` tool (runtime) and any consumers can reference them without importing runtime code.

### `types.ts`

Key types to know:

```typescript
interface AgentConfig {
  id: AgentId;
  name: string;
  model: ModelRef;
  systemPrompt?: string;
  tools: string[];          // tool names
  sandbox?: SandboxConfig;
  approvalPolicy: "always" | "dangerous" | "never";
  workspace: string;
  compaction?: { thresholdTokens?, thresholdPercent?, preserveTurns?, summaryMaxLength? };
}

type ChatEvent =
  | { type: "thinking"; text: string }
  | { type: "tool_call"; call: { id, name, arguments } }
  | { type: "tool_result"; result: { callId, output, isError? } }
  | { type: "text"; text: string }
  | { type: "error"; code, message }
  | { type: "done" };
```

### `config-schema.ts`

Zod schema for `~/.simpleclaw/simpleclaw.json`. `DEFAULT_CONFIG` is used when no config file exists.

### `protocol.ts`

JSON-RPC 2.0 over WebSocket. Methods:

```typescript
enum GatewayMethods {
  CONNECT = "connect",
  CHAT_SEND = "chat.send",
  SESSIONS_CREATE = "sessions.create",
  SESSIONS_GET = "sessions.get",
  CHANNELS_SEND = "channels.send",
  TASKS_CREATE = "tasks.create",
  TASKS_GET = "tasks.get",
  TASKS_LIST = "tasks.list",
}
```

### `task.ts` / `task-queue.ts`

```typescript
interface Task {
  taskId: string;
  sessionId: string;
  status: "queued" | "running" | "completed" | "failed";
  events: ChatEvent[];
  createdAt: Date;
  completedAt?: Date;
  result?: string;
  error?: string;
}
```

### `notification-bus.ts`

Pub/sub for task events. `Gateway` subscribes, `BackgroundWorker` publishes.

---

## Layer 2: Agent Runtime (`src/agent-runtime/`)

### `sandbox.ts` — `DockerSandbox`

```typescript
class DockerSandbox implements ISandbox {
  async readFile(path): Promise<string>
  async writeFile(path, content): Promise<void>
  async exec(command, { timeoutMs?, maxOutputBytes? }): Promise<IExecResult>
}
```

**Windows**: Uses `cmd.exe /c` directly (no Docker on Windows dev machines).
**Unix**: Tries Docker first, falls back to `sh -c`.

**PathGuard** (`assertSafe()`): Checks `path.sep`-aware path traversal, allowed/denied path lists.

**Process management**: `exec()` uses `AbortController` for timeout. `killTree()` uses `taskkill /f /t` on Windows, `SIGTERM → SIGKILL` on Unix.

### `tools/` — The Tool Suite

All tools are factory functions returning `ITool`:

```typescript
export function createReadTool(sandbox, tracker): ITool
export function createEditTool(sandbox, tracker): ITool
export function createBashTool(sandbox): ITool
export function createThinkTool(): ITool
export function createGrepTool(sandbox, workspace): ITool
export function createLsTool(workspace): ITool
export function createSpawnTool(pool, logger): ITool
```

**read.ts**:
- Line-numbered output (`1 | const x = 1`)
- Binary file detection (rejects if non-printable chars > 30%)
- `offset`/`limit` for pagination

**edit.ts**:
- 3-strategy matching: exact → line-trim → block-anchor
- `FileAccessTracker` guard: must `read` before `edit`
- Returns `{ replacements: number }` as JSON string

**bash.ts**:
- Default timeout: 120s
- Default max output: 10KB (truncates with `...[truncated]`)
- Uses `DockerSandbox.exec()`

**spawn.ts**:
- Delegates to `IAgentPool.spawn()`
- Parameters: `description`, `task`, `role`, `model`, `tools`, `systemPrompt`, `sessionId`

### `tool-registry.ts`

```typescript
class ToolRegistry implements IToolRegistry {
  register(tool: ITool): void
  get(name: string): ITool | undefined
  list(): ITool[]
  schema(): IToolSchema[]        // for LLM tool definitions
  execute(call: ToolCall): Promise<ToolResult>
}
```

### `file-tracker.ts`

```typescript
class FileAccessTracker {
  recordRead(path): void
  assertReadBeforeWrite(path): void  // throws if not read
}
```

### `llm.ts`

```typescript
class ModelRouter {
  resolve(modelRef: ModelRef): ILLMClient
}
```

Maps `{ provider, model }` → concrete client instance.

### `provider-factory.ts`

```typescript
function createRouter(providers, models): ModelRouter
```

Creates clients from config. If provider config missing, falls back to `MockLLMClient`.

### `providers/openai-compatible.ts`

`OpenAICompatibleClient` — the main LLM client.

**Reasoning model support**:
```typescript
const reasoningText = (msg as any).reasoning;
const text = msg.content ?? reasoningText ?? "";
```

Handles `tencent/hy3-preview:free` and other models that put output in `reasoning` instead of `content`.

### `approval.ts`

```typescript
class ApprovalGate implements IApprovalGate {
  isRequired(toolName): boolean    // based on policy
  request(req): Promise<"approved" | "denied">
  listPending(): IApprovalRequest[]
}
```

Policies:
- `"always"`: every tool call requires approval
- `"dangerous"`: `edit`, `bash` require approval
- `"never"`: auto-approve everything

### `agent-pool.ts`

```typescript
class AgentPool implements IAgentPool {
  async spawn(options: SpawnOptions): Promise<SpawnResult>
}
```

**Role presets** (`ROLE_TOOLS`):
```typescript
{
  explore: ["read", "grep", "ls", "bash", "think"],     // read-only
  coder:   ["read", "edit", "grep", "ls", "bash", "think"], // coding
  tester:  ["read", "bash", "grep", "ls", "think"],       // test running
}
```

**Recursion guard** (`FORBIDDEN_SUB_TOOLS`): Sub-agents can NEVER have the `spawn` tool.

**Session lifecycle**:
1. If `options.sessionId` provided → try to resume existing session
2. If not found or not provided → create new session with `parentSessionId`
3. Run `AgentEngine.chat()` on the session
4. Format result as XML with `subagent_session_id`

**XML output format**:
```
subagent_session_id: <uuid> (pass this to resume)

<subagent_result>
[thinking] Planning...
[tool] read: {"path":"foo.txt"}
[result] file contents...
Final answer from sub-agent
</subagent_result>
```

### `background-worker.ts`

```typescript
class BackgroundWorker {
  start(): void   // begins polling loop (1s interval)
  stop(): void    // clears interval
}
```

Polls `ITaskQueue`, executes tasks via `IAgentEngine.chat()`, collects events, updates task status, publishes to `INotificationBus`.

### `task-queue-memory.ts`

In-memory queue with FIFO ordering. Tasks transition: `queued` → `running` → `completed`/`failed`.

---

## Layer 3: Gateway (`src/gateway/`)

### `server.ts`

`Gateway` class:
- **HTTP**: serves `/ui/*` static files, `/health` health check
- **WebSocket**: JSON-RPC 2.0 protocol

**Dual execution mode**:
```typescript
if (this.taskQueue) {
  // Async mode: enqueue task, return { taskId, status: "queued" }
  // Events stream via NotificationBus
} else {
  // Sync mode: direct streaming from engine.chat()
}
```

**Task management methods**:
- `tasks.create` — enqueue a task manually
- `tasks.get` — get task status + events
- `tasks.list` — list tasks (optional filter by sessionId/status)

### `auth.ts`

- `GatewayAuth`: none / token / password
- `RateLimiter`: memory-backed, per-IP, sliding window

### `session-store.ts`

- `MemorySessionStore`: in-memory Map
- `SQLiteSessionStore`: placeholder, falls back to memory

Session state:
```typescript
interface ISessionState {
  sessionId: SessionId;
  agentId: string;
  channelId?: string;
  parentSessionId?: SessionId;  // for sub-agent tracking
  turns: ConversationTurn[];
  tokenCount: number;
  createdAt: Date;
  updatedAt: Date;
}
```

### `static.ts`

Serves `ui/` directory. Path guards prevent `../` traversal. MIME type mapping for `.html`, `.js`, `.css`.

---

## Layer 4: UI (`ui/`)

### `app.js`

WebSocket client logic:
- `ensureSession()` — auto-creates session on first send
- `sendMessage()` — sends `chat.send` JSON-RPC request
- Event handlers: `thinking` (inline update), `tool_call`/`tool_result` (separate bubbles), `text` (append), `done` (finalize)
- `updateInputState()` — enables input only when WS connected

### `index.html`

- Connection bar (host:port input + connect button)
- Chat area (message bubbles)
- Input area (textarea + send button)
- Collapsible raw events log (right panel)

### `style.css`

Dark theme. User messages: right-aligned, blue bg. Assistant: left-aligned, gray bg.

---

## Assembly (`src/host/node.ts`)

`startNodeHost()` is the wiring function. It assembles all layers:

```typescript
async function startNodeHost({ config }) {
  // 1. Runtime implementations
  const router = createRouter(config.providers, config.models);
  const store = new MemorySessionStore();
  const sandbox = new DockerSandbox(...);
  const tracker = new FileAccessTracker();
  const tools = new ToolRegistry();
  tools.register(createReadTool(sandbox, tracker));
  tools.register(createEditTool(sandbox, tracker));
  tools.register(createBashTool(sandbox));
  tools.register(createThinkTool());
  tools.register(createGrepTool(sandbox, workspace));
  tools.register(createLsTool(workspace));
  const approval = new ApprovalGate(policy, logger);

  // 2. Agent Pool (for multi-agent)
  const pool = new AgentPool(config, store, router, tools, approval, logger);
  tools.register(createSpawnTool(pool, logger));

  // 3. Core engine
  const llm = router.resolve(config.model);
  const engine = new AgentEngine(config, store, llm, tools, approval, logger);

  // 4. Task queue + background worker
  const taskQueue = new MemoryTaskQueue();
  const notificationBus = new NotificationBus();
  const worker = new BackgroundWorker(taskQueue, engine, notificationBus, logger);
  worker.start();

  // 5. Gateway
  const gateway = new Gateway(config.gateway, engine, store, taskQueue, notificationBus);
  const server = createServer();
  gateway.attach(server);
  server.listen(port, host);
}
```

**Key observation**: `AgentPool` receives the SAME `ToolRegistry` that the parent engine uses, but it creates NEW `ToolRegistry` instances for each sub-agent (subset of parent tools).

---

## Conventions

### File naming
- Core files: `kebab-case.ts`
- Classes: `PascalCase`
- Interfaces: `I` prefix (`ILLMClient`, `ISessionStore`)
- Types: `PascalCase` (no `I` prefix for pure types)

### Imports
- Core MUST use `.js` extensions in imports (TypeScript ESM)
- Runtime CAN use Node.js builtins
- Never import runtime into core

### Error handling
- Tools return error messages as strings (not thrown), wrapped in `ToolResult`
- `AgentEngine` catches tool execution errors and yields `error` events
- `AgentPool` catches sub-agent failures and returns error-formatted XML

### Logging
- Use `logger.info|warn|error|debug(msg, meta?)` everywhere
- `meta` is an object with context (never string interpolation)

### Testing
- Tests are `.mjs` files using ES modules
- Import from `../dist/` (compiled output), not `../src/`
- Use `MockLLMClient` or custom mock classes for unit tests
- Tests must clean up temp directories (`tmpdir` + `rm`)

---

## Common Tasks

### Adding a new tool

1. Create `src/agent-runtime/tools/my-tool.ts`:
```typescript
export function createMyTool(deps): ITool {
  return {
    name: "my_tool",
    description: "...",
    parameters: { type: "object", properties: { ... } },
    execute: async (args) => { return "result"; },
  };
}
```

2. Export from `src/agent-runtime/tools/index.ts`
3. Register in `src/host/node.ts`
4. Add tool rule in `src/core/agent-engine.ts` `buildSystemPrompt()`
5. Add test in `tests/`

### Adding a new LLM provider

1. Create `src/agent-runtime/providers/my-provider.ts` implementing `ILLMClient`
2. Register in `src/agent-runtime/provider-factory.ts`
3. Add provider config schema in `src/core/config-schema.ts` (if new auth pattern)

### Adding a new gateway method

1. Add method name to `GatewayMethods` enum in `src/core/protocol.ts`
2. Add type definitions for params/result
3. Handle in `src/gateway/server.ts` `dispatch()`
4. Update UI if needed

### Modifying session state

1. Update `ISessionState` in `src/core/interfaces.ts`
2. Update store implementations in `src/gateway/session-store.ts`
3. Update `sessions.create` handler in gateway

---

## Gotchas

1. **PowerShell execution policy**: On Windows, `npm` scripts may fail due to PS execution policy. Use `node node_modules/typescript/bin/tsc` directly.

2. **Port conflicts**: `127.0.0.1:18789` may be occupied by orphaned Node processes. Kill with `taskkill /PID <pid> /F`.

3. **Context compaction does NOT modify session**: It only affects the messages array passed to LLM. The full conversation history remains in `ISessionState.turns`.

4. **Tool result event format**: `AgentEngine` yields `{ type: "tool_result", result: { callId, output } }`. The `result` property name is fixed — UI and tests depend on it.

5. **Sub-agent session parent tracking**: `parentSessionId` is set when creating a NEW sub-agent session. When RESUMING a session, `parentSessionId` is NOT set (the session already exists).

6. **MockLLMClient**: The mock client in `llm.ts` is very basic. For complex test scenarios, create a custom mock class (see `tests/test-spawn.mjs`).

7. **TypeScript compilation**: `tsc` compiles to `dist/`. Tests import from `../dist/`. Run `npm run build` before running tests.

# SimpleClaw

A minimal, layered AI agent runtime — a distilled rewrite of OpenClaw.

**Core principle**: pure logic layer with zero Node.js dependencies; all I/O injected via interfaces from the runtime layer.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 4: UI / Channels                                      │
│  Web UI (ui/)  →  Channel Adapters (channel-sdk/)           │
└────────────────────────┬────────────────────────────────────┘
                         │  WebSocket JSON-RPC
┌────────────────────────▼────────────────────────────────────┐
│  Layer 3: Gateway (gateway/)                                 │
│  WS server · Auth · Rate limit · Session store · Static     │
│  Task queue · Notification bus · Background worker          │
└────────────────────────┬────────────────────────────────────┘
                         │  IAgentEngine.chat()
┌────────────────────────▼────────────────────────────────────┐
│  Layer 2: Agent Runtime (agent-runtime/)                     │
│  LLM router · Sandbox · Tool suite · Approval gate          │
│  Agent pool (multi-agent) · File tracker                   │
│  Node.js implementations of Core interfaces                 │
└────────────────────────┬────────────────────────────────────┘
                         │  Injected interfaces
┌────────────────────────▼────────────────────────────────────┐
│  Layer 1: Core (core/)                                       │
│  AgentEngine · Protocol · Config · Types · Logger           │
│  Context compactor · Task abstraction · Notification bus    │
│  Zero platform dependencies. Zero I/O.                      │
└─────────────────────────────────────────────────────────────┘
```

### Layer 1 — Core (`src/core/`)

Pure logic. Can be compiled for any JavaScript runtime (Node.js, Deno, Browser, Edge).

| File | Responsibility |
|------|---------------|
| `interfaces.ts` | All platform-agnostic contracts: `ISandbox`, `ILLMClient`, `IAgentEngine`, `ISessionStore`, `IApprovalGate`, `IToolRegistry`, `ILogger`, `ITaskQueue`, `INotificationBus` |
| `types.ts` | Shared types: `ConversationTurn`, `ToolCall`, `ToolResult`, `ChatEvent`, `AgentConfig`, `SandboxConfig`, `SessionId`, etc. |
| `agent-engine.ts` | Core agent loop: `LLM → parse tool calls → approval → execute → stream events`. Max 10 iterations. Dynamic system prompt builder with tool guidance. Context compaction integration |
| `compactor.ts` | `ContextCompactor` — summarizes old conversation turns via LLM when token estimate exceeds threshold. Preserves N most recent turns |
| `config-schema.ts` | Zod schema for `simpleclaw.json` + `DEFAULT_CONFIG` |
| `protocol.ts` | JSON-RPC 2.0 frame types + `GatewayMethods` + builders |
| `task.ts` / `task-queue.ts` | `Task` abstraction + `ITaskQueue` interface. `MemoryTaskQueue` in-memory implementation |
| `notification-bus.ts` | `INotificationBus` pub/sub for async task event streaming |
| `agent-pool.ts` | `IAgentPool` interface + `SpawnOptions` / `SpawnResult` / `AgentRole` types for multi-agent collaboration |
| `logger.ts` | Structured logger with level filtering |
| `plugin-loader.ts` | Dynamic plugin resolver + registry (for channel extensions) |

**Key rule**: Core must never import `fs`, `path`, `child_process`, or any Node.js builtin.

### Layer 2 — Agent Runtime (`src/agent-runtime/`)

Node.js implementations of Core interfaces. Swappable for other platforms.

| File / Dir | Responsibility |
|------|---------------|
| `sandbox.ts` | `DockerSandbox` implements `ISandbox`. Windows-compatible (`cmd.exe /c` fallback). Auto-detects Docker availability, falls back to direct spawn. Process tree kill (`taskkill /f /t` on Windows, `SIGTERM→SIGKILL` on Unix). Output truncation (10KB) + configurable timeout (120s default) |
| `tools/` | **7 built-in tools** (Claude Code inspired): `read` (line numbers + binary guard), `edit` (3-strategy matching + read-before-write guard), `bash` (120s timeout + 10KB truncation), `think` (no-op planning), `grep` (regex search, skips node_modules/dist/.git), `ls` (directory listing), `spawn` (multi-agent delegation) |
| `tool-registry.ts` | `ToolRegistry` implements `IToolRegistry`. Maps tool names → schemas + executors |
| `file-tracker.ts` | `FileAccessTracker` — read-before-write guard for the `edit` tool |
| `llm.ts` | `ModelRouter` resolves `ModelRef` → `ILLMClient`. `MockLLMClient` for testing without API keys |
| `provider-factory.ts` | Creates LLM clients from config. Falls back to mock if provider missing |
| `providers/openai-compatible.ts` | `OpenAICompatibleClient` — works with OpenAI, Moonshot, DeepSeek, OpenRouter. Handles reasoning models (`content \\\|\\| reasoning \\\|\\| ""`). Maps `toolCalls` to OpenAI format and back |
| `approval.ts` | `ApprovalGate` implements `IApprovalGate`. Policies: `always` / `dangerous` / `never` |
| `agent-pool.ts` | `AgentPool` implements `IAgentPool`. Creates sub-agents with independent config/model/tools/session. **Features**: role presets (`explore`/`coder`/`tester`), recursion guard (sub-agents cannot spawn), session resumption via `sessionId`, structured XML output with `subagent_session_id` |
| `background-worker.ts` | `BackgroundWorker` polls `ITaskQueue` every 1s, executes agent turns asynchronously, publishes events to `INotificationBus` |
| `task-queue-memory.ts` | `MemoryTaskQueue` implements `ITaskQueue` — in-memory queue + status tracking |

### Layer 3 — Gateway (`src/gateway/`)

WebSocket JSON-RPC server. Stateless — delegates everything to Core + Runtime.

| File | Responsibility |
|------|---------------|
| `server.ts` | `Gateway` class. Handles `connect`, `chat.send`, `sessions.create`, `sessions.get`, `tasks.create/get/list`. **Dual mode**: sync streaming (direct) or async (task queue + notification bus). Streams chat events as JSON-RPC result frames |
| `auth.ts` | `GatewayAuth` (none/token/password) + `RateLimiter` (memory-backed, per-IP) |
| `session-store.ts` | `MemorySessionStore` + `SQLiteSessionStore` (placeholder — falls back to memory). Supports `parentSessionId` for sub-agent tracking |
| `static.ts` | Serves `ui/` directory over HTTP with path guards + MIME types |

### Layer 4 — UI & Channels

**Web UI** (`ui/`)

| File | Responsibility |
|------|---------------|
| `index.html` | Chatbot page: connection bar, chat bubbles, input box, collapsible raw events log |
| `app.js` | WebSocket client. Auto-creates session on first message. Handles streaming events (thinking → text → done). Connection state management |
| `style.css` | Dark theme. User messages right-aligned (blue), assistant left (gray). Collapsible panel styles |

**Channel SDK** (`src/channel-sdk/`)

| File | Responsibility |
|------|---------------|
| `base-adapter.ts` | `BaseChannelAdapter` — common lifecycle + message handler for WhatsApp/Slack/Discord extensions |
| `formatter.ts` | `MessageFormatter` — escapeMarkdown, truncate, codeBlock |

### Assembly & Entry Points

| File | Responsibility |
|------|---------------|
| `src/host/node.ts` | `startNodeHost()` — wires Core interfaces to Node Runtime implementations. Assembles: `AgentEngine` + `AgentPool` + `BackgroundWorker` + `Gateway`. Starts HTTP + WS server |
| `src/cli/index.ts` | CLI entry. Commands: `start`, `dev` (debug logging), `setup`, `--version`. Loads config from `~/.simpleclaw/simpleclaw.json`. Expands `~` to homedir |
| `src/index.ts` | Library public API — re-exports Core + Host |

---

## Data Flow

### Sync Mode (direct streaming)
```
User (Web UI)
    │  WS JSON-RPC: chat.send { sessionId, message }
    ▼
Gateway ──→ engine.chat(sessionId, message) → AsyncGenerator<IChatEvent>
    │
    ▼  events yield in real-time
Web UI ──→ renders thinking/tool_call/tool_result/text/done
```

### Async Mode (task queue)
```
User (Web UI)
    │  WS JSON-RPC: chat.send { sessionId, message }
    ▼
Gateway ──→ taskQueue.enqueue({ sessionId, message })
    │  returns { taskId, status: "queued" }
    ▼
BackgroundWorker (polls every 1s)
    │  dequeues task → engine.chat() → collects events
    │  updates task status → publishes to NotificationBus
    ▼
Gateway (subscribed to bus) ──→ forwards events over WS
    ▼
Web UI ──→ renders events as they arrive
```

### Multi-Agent Spawn
```
Parent AgentEngine
    │  LLM decides to call spawn tool
    ▼
SpawnTool.execute() ──→ AgentPool.spawn({ task, role, model, ... })
    │
    ▼  creates/resumes sub-agent session
Sub-Agent AgentEngine
    │  independent chat loop with restricted tools
    ▼
returns XML result with subagent_session_id
    │
    ▼  Parent receives as tool_result
Parent continues its own loop
```

---

## Tool Suite

| Tool | What it does | Key features |
|------|-------------|--------------|
| `read` | Read file contents | Line-numbered output, binary file rejection, offset/limit pagination |
| `edit` | Edit file contents | 3-strategy matching (exact → line-trim → block-anchor), read-before-write guard via `FileAccessTracker` |
| `bash` | Execute shell commands | 120s timeout, 10KB stdout/stderr truncation, process tree kill |
| `think` | No-op thinking tool | Lets LLM plan before acting |
| `grep` | Regex search across files | Skips node_modules/dist/.git, max 50 matches |
| `ls` | Directory listing | File sizes, sorted output |
| `spawn` | Delegate to sub-agent | Role presets, recursion guard, session resumption, XML output |

---

## Configuration

Config file: `~/.simpleclaw/simpleclaw.json`

```json
{
  "gateway": {
    "port": 18789,
    "host": "127.0.0.1",
    "auth": { "type": "none" },
    "rateLimit": { "maxRequestsPerMinute": 60, "blockDurationSeconds": 300 },
    "sessionStore": { "type": "sqlite", "path": "~/.simpleclaw/sessions.db" }
  },
  "agents": [
    {
      "id": "default",
      "name": "SimpleClaw",
      "model": { "provider": "openrouter", "model": "tencent/hy3-preview:free" },
      "systemPrompt": "You are a helpful coding assistant.",
      "tools": ["read", "edit", "bash", "think", "grep", "ls", "spawn"],
      "approvalPolicy": "dangerous",
      "workspace": "~/.simpleclaw/workspace",
      "sandbox": { "enabled": true, "backend": "docker", "allowedPaths": [], "deniedPaths": ["/etc", "/proc"] }
    }
  ],
  "providers": {
    "openrouter": {
      "type": "openai-compatible",
      "apiKey": "sk-or-...",
      "baseURL": "https://openrouter.ai/api/v1"
    }
  },
  "models": {
    "default": { "provider": "openrouter", "model": "tencent/hy3-preview:free" }
  }
}
```

---

## Commands

```bash
npm run build      # tsc compile src/ → dist/
npm start          # node dist/cli/index.js
npm run dev        # start with debug logging
npm test           # run all tests
```

---

## Tests

| Test | What it covers |
|------|---------------|
| `tests/test-agent.mjs` | End-to-end agent loop: create session → chat → mock LLM returns tool_call → read file → tool_result → final answer |
| `tests/test-shell.mjs` | Windows shell compatibility: echo, dir, write via shell, invalid command |
| `tests/test-ws.mjs` | WebSocket gateway: connect → sessions.create → chat.send with streaming events |
| `tests/test-spawn.mjs` | Multi-agent spawn: role presets, recursion guard, session resumption, XML output format, description param |

---

## Key Design Decisions

1. **Interface injection**: Core layer (`AgentEngine`) receives `ISandbox`, `ILLMClient`, `IToolRegistry`, etc. via constructor. Core is testable without mocking Node.js APIs.

2. **Auto session creation**: UI creates session automatically on first message send. No manual "Create Session" step needed.

3. **Reasoning model support**: `OpenAICompatibleClient` reads `content || reasoning || ""` to support models like `tencent/hy3-preview:free`.

4. **Windows-first compatibility**: `DockerSandbox.exec()` uses `cmd.exe /c` on Windows. `PathGuard` uses `path.sep`. Config paths with `~` are expanded via `os.homedir()`.

5. **Graceful degradation**: Docker unavailable → direct spawn. Provider missing → mock LLM. SQLite unavailable → memory store. No task queue → sync streaming fallback.

6. **Recursion guard**: Sub-agents spawned via `spawn` tool are automatically stripped of the `spawn` tool, preventing infinite agent chains.

7. **Context compaction**: Old conversation turns are summarized via LLM when token estimate exceeds threshold, preserving the most recent N turns intact. Full history remains in session store.

---

## File Count

- **Core**: 11 files — pure logic, zero Node.js imports
- **Runtime**: 13 files — Node.js implementations + 7 tools
- **Gateway**: 4 files — WS server + auth + store + static
- **Host + CLI**: 2 files — assembly + entry point
- **Channel SDK**: 3 files — adapter framework
- **UI**: 3 files — HTML + JS + CSS
- **Tests**: 5 files — 4 test suites + 1 runner

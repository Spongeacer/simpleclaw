# SimpleClaw

A minimal, production-grade AI agent runtime with sub-agents, lossless context management, and built-in benchmarks.

> **Core principle**: pure logic layer with zero Node.js dependencies; all I/O injected via interfaces from the runtime layer.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Layer 4: UI / Channels                                                      │
│  Web UI (ui/)  →  Channel Adapters (channel-sdk/)                           │
└────────────────────────┬────────────────────────────────────────────────────┘
                         │  WebSocket JSON-RPC
┌────────────────────────▼────────────────────────────────────────────────────┐
│  Layer 3: Gateway (gateway/)                                                 │
│  WS server · Auth · Rate limit · Session store · Static                     │
│  Task queue · Notification bus · Background worker                          │
└────────────────────────┬────────────────────────────────────────────────────┘
                         │  IAgentEngine.chat()
┌────────────────────────▼────────────────────────────────────────────────────┐
│  Layer 2: Agent Runtime (agent-runtime/)                                     │
│  LLM router · Sandbox · Tool suite · Approval gate                          │
│  Agent pool (multi-agent) · File tracker · Skills loader · Memory index     │
│  MCP client · Context compactor (hierarchical)                              │
│  Node.js implementations of Core interfaces                                 │
└────────────────────────┬────────────────────────────────────────────────────┘
                         │  Injected interfaces
┌────────────────────────▼────────────────────────────────────────────────────┐
│  Layer 1: Core (core/)                                                       │
│  AgentEngine · Protocol · Config · Types · Logger                           │
│  Context compactor · Task abstraction · Notification bus                    │
│  Planning-only detection & correction                                       │
│  Zero platform dependencies. Zero I/O.                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### What SimpleClaw does

| Capability | Description |
|-----------|-------------|
| **Sub-agents** | Serial (`spawn`) + Parallel (`spawn_multiple`) with role presets, concurrency control, and recursion guard |
| **Lossless Context** | Compresses old turns into summaries, but **archives every original message** to SQLite + FTS5. Agent can recall compressed history via `memory_search(mode="history")` |
| **Hierarchical Compaction** | 3-level Decaying Resolution Memory: recent turns intact → L1 summary → L2 compressed summary → L3 meta-summary |
| **Planning-Only Correction** | 3-layer defense: Prompt prevention → Structured detection → Steer injection + retry |
| **Tool Result Truncation** | Per-tool-type thresholds (bash 8K / grep 6K / read 12K) with smart head+tail preservation |
| **Skills System** | 3-tier scan (builtin / user / workspace) with hot-reload, security guards, and metadata parsing |
| **Memory System** | SQLite + FTS5 for code files, knowledge docs, and session history. Incremental sync with hash-based change detection |
| **Prompt Cache Boundary** | Stable prefix (cached across turns) + Dynamic suffix (per-turn) with `cacheControl: {type: "ephemeral"}` |
| **Tool Call Hooks** | `beforeExecute` / `afterExecute` hooks on both serial and DAG execution paths |
| **Benchmarks** | 100-query tool usage benchmark + Mini SWE-bench (8 real bug fixes) |
| **DAG Plan Execution** | Auto/always/off plan mode. Parallel tool execution via topological sort |

---

## SimpleClaw vs OpenClaw

### Scale

| | **SimpleClaw** | **OpenClaw** |
|---|---|---|
| Code | ~6,000 lines / ~80 files | ~300,000+ lines / 7,000+ files |
| Dependencies | 0 runtime deps | `@mariozechner/pi-agent-core` proprietary |
| Position | Core engine + benchmarks | Full platform (CLI + Server + Multi-channel) |

### Sub-agents

| | **SimpleClaw** | **OpenClaw** |
|---|---|---|
| Serial | ✅ `spawn` | ✅ `sessions_spawn` |
| Parallel | ✅ `spawn_multiple` (concurrency control + merge) | ✅ Similar |
| Evaluator-Optimizer | ✅ Prompt-guided + tool composition | ✅ Runtime detection + steer |
| Sub-agent management | ❌ No kill/list/steer | ✅ `subagents` tool |
| Roles | ✅ explore / coder / tester | ✅ + more presets |

### Context Management

| | **SimpleClaw** | **OpenClaw** |
|---|---|---|
| Lossy compaction | ✅ 3-tier (truncate → microcompact → LLM summary) | ✅ Built-in |
| **Lossless archive** | ✅ **SQLite + FTS5, auto-archive before compression** | ✅ lossless-claw plugin (DAG-based) |
| **History recall** | ✅ **`memory_search(mode="history")`** | ✅ `lcm_grep` / `lcm_expand` |
| Hierarchical summary | ✅ 3-level Decaying Resolution | ✅ DAG node compression |
| Tool truncation | ✅ Per-tool thresholds | ✅ Similar |
| Independent summary model | ❌ Reuses main model | ✅ Configurable light model |
| Pluggable engine | ❌ Fixed compactor | ✅ ContextEngine plugin slot |

### Execution Reliability

| | **SimpleClaw** | **OpenClaw** |
|---|---|---|
| Planning-only correction | ✅ **3-layer: Prompt + Structured detection + Steer** (~60 lines) | ✅ Regex detection + steer (~900 lines) |
| Model fallback | ❌ None | ✅ Auto failover |
| Approval UI | ✅ Basic gate | ✅ + native UI buttons |
| Heartbeat | ❌ None | ✅ HEARTBEAT.md polling |
| Bootstrap | ❌ None | ✅ BOOTSTRAP.md workflow |

### Memory & Skills

| | **SimpleClaw** | **OpenClaw** |
|---|---|---|
| Skills | ✅ 3-tier scan + hot-reload + security | ✅ + richer ecosystem |
| Code index | ✅ SQLite + FTS5 | ✅ + embedding search |
| Semantic search | ❌ Keywords only | ✅ Hybrid (vector + text) |
| MCP | ✅ Basic support | ✅ Deep integration |

### Provider Support

| | **SimpleClaw** | **OpenClaw** |
|---|---|---|
| Adapter layer | Single OpenAI-compatible | 10+ provider-specific adapters |
| Anthropic | ✅ Via compatible layer | ✅ Native |
| OpenRouter | ✅ Via compatible layer | ✅ Native |
| Google Gemini | ✅ Via compatible layer | ✅ Stream wrappers |
| Model switching | ❌ None | ✅ Live model switch |

### Benchmarking

| | **SimpleClaw** | **OpenClaw** |
|---|---|---|
| Tool usage benchmark | ✅ 100-query framework (mock + live) | ❌ None |
| Bug fix benchmark | ✅ Mini SWE-bench (8 tasks) | ❌ None |
| Live evaluation | ✅ OpenRouter free tier tested | ❌ None |

---

## Layer Details

### Layer 1 — Core (`src/core/`)

Pure logic. Can be compiled for any JavaScript runtime (Node.js, Deno, Browser, Edge).

| File | Responsibility |
|------|---------------|
| `interfaces.ts` | All platform-agnostic contracts: `ISandbox`, `ILLMClient`, `IAgentEngine`, `ISessionStore`, `IApprovalGate`, `IToolRegistry`, `ILogger`, `ITaskQueue`, `INotificationBus`, `IToolCallHooks` |
| `types.ts` | Shared types: `ConversationTurn`, `ToolCall`, `ToolResult`, `ChatEvent`, `AgentConfig`, `SessionId`, etc. |
| `agent-engine.ts` | Core agent loop with planning-only detection, tool call hooks, dynamic system prompt builder |
| `compactor.ts` | `ContextCompactor` — 3-tier compression + hierarchical summaries + lossless archive integration |
| `config-schema.ts` | Zod schema for `simpleclaw.json` |
| `protocol.ts` | JSON-RPC 2.0 frame types + `GatewayMethods` |
| `notification-bus.ts` | `INotificationBus` pub/sub for async task streaming |
| `memory.ts` | Memory-specific types (`MemorySearchResult`, `FileMapEntry`) |

**Key rule**: Core must never import `fs`, `path`, `child_process`, or any Node.js builtin.

### Layer 2 — Agent Runtime (`src/agent-runtime/`)

Node.js implementations of Core interfaces.

| File / Dir | Responsibility |
|------|---------------|
| `sandbox.ts` | `DockerSandbox` — Windows-compatible, auto-fallback to direct spawn, output truncation |
| `tools/` | **Built-in tools**: `read`, `edit`, `bash`, `think`, `grep`, `ls`, `spawn`, `spawn_multiple`, `memory_save`, `memory_search`, `web_search`, `web_fetch`, `glob`, `git` |
| `tool-registry.ts` | `ToolRegistry` — global output truncation per tool type |
| `agent-pool.ts` | `AgentPool` — serial + parallel sub-agent spawning with result truncation + merge |
| `skill/` | `SkillLoader` (3-tier scan), `SkillTool`, `SkillWatcher` (hot-reload), `SkillSecurity` |
| `memory/` | `WorkspaceMemoryIndex` — SQLite + FTS5 for files, knowledge, and **session history archive** |
| `plan/` | `DAGExecutor` — topological sort + parallel execution + replan policy |
| `providers/openai-compatible.ts` | OpenAI-compatible client with reasoning extraction + cache control injection |
| `approval.ts` | `ApprovalGate` — `always` / `dangerous` / `never` policies |
| `mcp/` | MCP client + adapter + loader |

### Layer 3 — Gateway (`src/gateway/`)

WebSocket JSON-RPC server. Stateless — delegates everything to Core + Runtime.

| File | Responsibility |
|------|---------------|
| `server.ts` | `Gateway` — sync streaming + async task queue modes |
| `auth.ts` | `GatewayAuth` + `RateLimiter` |
| `session-store.ts` | `MemorySessionStore` + `SQLiteSessionStore` |

### Layer 4 — UI & Channels

| File | Responsibility |
|------|---------------|
| `ui/index.html` | Chatbot page with connection bar, chat bubbles, raw events log |
| `ui/app.js` | WebSocket client with auto session creation |
| `ui/style.css` | Dark theme |

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
```

### Multi-Agent Spawn (Parallel)
```
Parent AgentEngine
    │  LLM calls spawn_multiple({ tasks: [A, B, C] })
    ▼
AgentPool.spawnMultiple()
    │  batch 1: [A, B, C, D] with maxConcurrency=4
    ▼
┌───────┬───────┬───────┐
▼       ▼       ▼       ▼
Sub-A   Sub-B   Sub-C   Sub-D  (parallel, isolated sessions)
└───────┴───────┴───────┘
    │
    ▼  merged results returned as single tool_result
Parent continues
```

### Lossless Context Management
```
Conversation turns (growing)
    │
    ▼  token estimate > threshold
ContextCompactor.compact()
    │
    ├──→ Stage 1: truncate oversized tool results
    ├──→ Stage 2: microcompact (clear old noise)
    ├──→ Stage 2.5: archive turns to SQLite (lossless)
    ├──→ Stage 3: hierarchical compaction (L1/L2/L3 summaries)
    └──→ Stage 4: anchored LLM summary (fallback)
    │
    ▼  compacted turns + summary
AgentEngine continues
    │
    ▼  Agent needs old detail?
memory_search(mode="history", session_id="...")
    │
    ▼  FTS5 search returns original archived turns
Agent recalls exact detail
```

---

## Tool Suite

| Tool | What it does |
|------|-------------|
| `read` | Read file with line numbers, offset/limit pagination |
| `edit` | Edit file — exact / line-trim / block-anchor matching |
| `bash` | Shell commands — 120s timeout, auto-truncation |
| `think` | No-op planning tool |
| `grep` | Regex search — skips node_modules/dist/.git |
| `ls` | Directory listing |
| `spawn` | Delegate to sub-agent (serial) |
| `spawn_multiple` | Delegate to multiple sub-agents (parallel) |
| `memory_save` | Persist knowledge to workspace memory |
| `memory_search` | Search knowledge / files / **session history** |
| `web_search` | Web search via Serper/Bing |
| `web_fetch` | Fetch and extract web page content |
| `glob` | File glob patterns |
| `git` | Git operations |
| `skill` | Load specialized skill workflow |

---

## Configuration

```json
{
  "gateway": {
    "port": 18789,
    "host": "127.0.0.1",
    "auth": { "type": "none" }
  },
  "agents": [{
    "id": "default",
    "model": { "provider": "openrouter", "model": "tencent/hy3-preview:free" },
    "tools": ["read", "edit", "bash", "think", "grep", "ls", "spawn", "spawn_multiple", "memory_save", "memory_search"],
    "workspace": "~/.simpleclaw/workspace"
  }],
  "providers": {
    "openrouter": {
      "type": "openai-compatible",
      "apiKey": "sk-or-...",
      "baseURL": "https://openrouter.ai/api/v1"
    }
  }
}
```

---

## Commands

```bash
npm run build      # tsc compile
npm start          # start gateway
npm run dev        # debug logging
npm test           # run all tests
```

---

## Tests

| Test | Coverage |
|------|----------|
| `test-agent.mjs` | End-to-end agent loop |
| `test-shell.mjs` | Windows shell compatibility |
| `test-ws.mjs` | WebSocket gateway |
| `test-spawn.mjs` | Sub-agent spawn |
| `test-subagent-context.mjs` | Parallel spawn + tool truncation |
| `test-lossless-context.mjs` | Archive turns + history search |
| `test-planning-only-correction.mjs` | Detection + steer |
| `test-compactor-unit.mjs` | Context compaction |
| `test-tool-usage-benchmark.mjs` | 100-query benchmark |
| `test-swe-bench.mjs` | 8-task bug fix benchmark |

---

## Key Design Decisions

1. **Interface injection**: Core layer receives all I/O via constructor. Testable without mocking Node.js APIs.
2. **Lossless by default**: Context compactor archives every turn to SQLite before compression. Agent can always recall exact details.
3. **Structured over regex**: Planning-only detection uses tool-call analysis + actionable request heuristics instead of 700 lines of English regex.
4. **Windows-first**: `cmd.exe /c` fallback, `path.sep`, `~` expansion via `os.homedir()`.
5. **Graceful degradation**: Docker → direct spawn. Provider → mock LLM. SQLite → memory. Sync → async fallback.
6. **Recursion guard**: Sub-agents stripped of `spawn`/`spawn_multiple` tools.
7. **Cache boundary**: Stable system prompt prefix cached across turns via `cacheControl: {type: "ephemeral"}`.

---

## File Count

- **Core**: 11 files — pure logic
- **Runtime**: 25+ files — Node.js impl + 14 tools + skills + memory + plan + MCP
- **Gateway**: 4 files
- **Host + CLI**: 2 files
- **Channel SDK**: 3 files
- **UI**: 3 files
- **Tests**: 15+ files

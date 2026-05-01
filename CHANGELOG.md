# SimpleClaw Changelog

All notable changes to SimpleClaw.

## [Unreleased]

### Changed
- **Context compaction threshold now defaults to ratio-based** (`thresholdPercent: 0.75`) instead of an absolute fallback of 6000 tokens. When `contextWindow` is not explicitly configured, it falls back to `128_000` tokens (modern model standard). This means compaction triggers at ~96k tokens by default, leaving 25% headroom for the model's response — consistent with Claude Code's proportional approach

### Architecture
- **Pluggable `IContextEngine` interface** (`interfaces.ts`) — extracts `assemble()`, `ingest()`, `recordUsage()`, `cleanupSession()` into a swappable contract. `ContextCompactor` now implements `IContextEngine`. `AgentEngine` accepts an optional `contextEngine` parameter; when omitted it falls back to the default `ContextCompactor`. This mirrors OpenClaw's ContextEngine design and allows third-party memory/RAG engines to plug in without touching the agent loop
- **`assemble()` receives richer context** — `modelId`, `availableTools`, and `prompt` are now passed to the context engine so compaction strategies can adapt per model (e.g. code models retain more tool results, chat models retain more user turns)
- **`ingest()` hook** — after each turn, new `ConversationTurn`s are fed to the context engine's `ingest()` method (if implemented). Failures are logged as warnings and never block the main loop

### Bug Fixes (Comprehensive Audit)
- **CRITICAL** `sandbox.ts` — replaced broken check-then-act async write lock with promise-chain serialization. Two concurrent callers could previously both pass the while-loop before either set the lock, causing interleaved writes (`withWriteLock()`)
- **HIGH** `gateway/session-store.ts` — SQLite `update()` now wrapped in `BEGIN/COMMIT/ROLLBACK` transaction, eliminating lost-update race conditions. Added `PRAGMA journal_mode = WAL;` for better concurrency and crash safety
- **HIGH** `gateway/server.ts` — `SESSIONS_CREATE` with `initialMessage` now enqueues via `taskQueue` instead of unawaited fire-and-forget `engine.chat()`, preventing race with subsequent `CHAT_SEND` on the same session
- **HIGH** `gateway/server.ts` — `TASKS_LIST` `status` parameter now validated at runtime instead of `as any` cast
- **MEDIUM** `core/agent-engine.ts` — `shouldUsePlan()` fixed to look up `workingSets` by `sessionId` instead of `config.id` (was always returning `undefined`, breaking working-set-based plan activation)
- **MEDIUM** `agent-runtime/providers/openai-compatible.ts` — fetch timeout now cleaned up with `try/finally` to prevent timer leak on network errors
- **MEDIUM** `agent-runtime/providers/openai-compatible.ts` — added guard `data.choices.length === 0` before accessing `[0]` to prevent crash on malformed API response
- **MEDIUM** `gateway/session-store.ts` — `hydrate()` now wraps `JSON.parse` in try/catch for both `turns` and `metadata`, gracefully falling back to empty array/undefined on corrupted rows
- **MEDIUM** `agent-runtime/memory/sqlite-store.ts` — added WAL mode and wrapped `archiveTurns()` in a transaction to prevent inconsistent state on crash
- **MEDIUM** `core/notification-bus.ts` — `publish()` now deletes empty handler Sets from `subs` Map to prevent minor memory leak
- **MEDIUM** `agent-runtime/agent-engine-factory.ts` — now accepts and passes through optional `contextEngine` to sub-agents
- **LOW** `core/interfaces.ts` — `ISandbox.exec()` signature now includes optional `options` parameter (matches `DockerSandbox` implementation)
- **LOW** `agent-runtime/tools/bash.ts` — removed `sandbox as any` cast; now uses properly typed `ISandbox`
- **LOW** `agent-runtime/agent-pool.ts` — replaced two `ev as any` casts with type-safe `extractEventText()` helper
- **LOW** `agent-runtime/plan/executor.ts` — replaced `resolvedArgs.get(stepId)!` non-null assertion with explicit null check and descriptive error

## [0.2.0] — 2026-05-01

### Security & Concurrency
- **File-level async write lock** in `DockerSandbox` — serializes concurrent writes to the same path, preventing interleaved writes from multiple agents (`sandbox.ts`)
- **Atomic writes** via temp-file + rename — ensures crash-safe file writes; partial writes never corrupt the original file (`sandbox.ts`)
- **Optimistic concurrency control** in `edit` tool — `ISandbox.writeFile()` accepts optional `expectedContent`; verified inside the write lock before overwriting. When two agents race to edit the same file, one succeeds and the other gets a clear error telling it to re-read and retry (`edit.ts`, `interfaces.ts`)
- New test suite: `test-concurrent-file-access.mjs` covering all 3 layers

### Fixes (from code review)
- **Planning-only detection**: avoid false positive after tool calls — an agent that already executed real tool calls and then gives a final text answer is no longer flagged as "planning-only" (`agent-engine.ts`)
- **OpenAI-compatible client**: add 120s fetch timeout via `AbortController` to prevent hangs when API is unresponsive (`openai-compatible.ts`)
- **OpenAI-compatible client**: graceful `JSON.parse` fallback for malformed tool arguments from the API — returns `{raw: "..."}` instead of crashing (`openai-compatible.ts`)
- **AgentEngine**: fix `shouldUsePlan` heuristic — was checking global `workingSets.size` instead of the current session's working set (`agent-engine.ts`)
- **Memory leak prevention**: add `cleanupSession(sessionId)` to `AgentEngine` and `ContextCompactor` to purge per-session maps when a session is deleted (`agent-engine.ts`, `compactor.ts`)
- **FTS5 safety**: escape special characters (`"`, `*`, `(`, `)`, `AND`, `OR`, `NOT`, `NEAR`) in `memory_search(mode="history")` queries to prevent FTS5 syntax errors (`sqlite-store.ts`)
- **Live test graceful skip**: `test-live-agent.mjs` now skips instead of hanging when no `OPENROUTER_API_KEY` is configured

### Documentation
- Comprehensive README rewrite with full 4-layer architecture diagram, capability overview table, and detailed SimpleClaw vs OpenClaw comparison across 7 dimensions (scale, sub-agents, context management, execution reliability, memory/skills, providers, benchmarking)

---

## [0.1.0] — 2026-04-30

### Core Engine
- **AgentEngine** — pure-logic agent loop with zero Node.js dependencies. Supports serial and DAG plan execution modes
- **Planning-only detection & correction** — 3-layer defense (prompt prevention + structured detection + steer injection + retry). ~60 lines replacing OpenClaw's 700+ line regex approach
- **Context compaction** — 3-tier system: truncate oversized tool results → microcompact old noise → anchored LLM summary. Hierarchical Decaying Resolution Memory with L1/L2/L3 summary levels
- **Lossless context archive** — every original turn archived to SQLite + FTS5 before compression. Agents recall exact details via `memory_search(mode="history")`
- **Prompt cache boundary** — stable system prompt prefix cached across turns via `cacheControl: {type: "ephemeral"}`
- **Tool call hooks** — `beforeExecute` / `afterExecute` on both serial and DAG execution paths

### Sub-Agents
- **`spawn`** — serial sub-agent delegation with role presets (explore / coder / tester), recursion guard, and session resumption
- **`spawn_multiple`** — parallel sub-agent dispatch with concurrency control (default 4, max 8), per-result truncation (8KB), error isolation, and merged summary output
- **Workflow mode guidance** — Sequential / Parallel / Evaluator-Optimizer patterns injected into system prompt

### Tool Suite (14 tools)
- `read` — line-numbered output with offset/limit pagination
- `edit` — 3-strategy matching (exact → line-trim → block-anchor) with read-before-write guard
- `bash` — shell execution with 120s timeout, 10KB output truncation, redaction
- `think` — no-op planning tool
- `grep` / `ls` / `glob` — file system operations
- `spawn` / `spawn_multiple` — sub-agent orchestration
- `memory_save` / `memory_search` — workspace knowledge persistence and retrieval (memory/files/history/auto modes)
- `web_search` / `web_fetch` — web retrieval
- `git` — version control operations
- `skill` — specialized workflow loader

### Memory & Skills
- **WorkspaceMemoryIndex** — SQLite + FTS5 for code files, knowledge docs, and session history. Incremental sync with SHA256 hash-based change detection
- **Skills system** — 3-tier scan (builtin / user / workspace) with hot-reload, security guards (OS/bin/env eligibility), and metadata parsing

### Provider Layer
- **OpenAI-compatible client** — supports reasoning extraction (DeepSeek `<think>`, OpenRouter `reasoning_content`, Tencent Hy3), strict tool schema mode, cache control injection
- Single adapter layer handles OpenRouter, Anthropic, Google Gemini, DeepSeek, Moonshot via OpenAI-compatible API

### Gateway & Runtime
- WebSocket JSON-RPC gateway with sync streaming and async task queue modes
- Memory + SQLite session stores
- Docker sandbox with Windows PowerShell fallback, path guard, secret redaction
- ToolRegistry with per-tool-type output truncation thresholds

### Benchmarks
- **100-query tool usage benchmark** — mock + live evaluation framework
- **Mini SWE-bench** — 8 real bug fix tasks, 7/8 passing (swe-04 is test-case syntax error)

### Tests
- 15+ test suites covering agent loop, spawn, DAG engine, compactor, shell compatibility, session store, skill production, lossless context, planning-only correction, concurrent file access

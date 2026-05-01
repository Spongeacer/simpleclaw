/**
 * SimpleClaw — Agent Pool
 * Creates sub-agents with independent config, model, tools, and session.
 * Supports three Anthropic workflow patterns:
 *   - Sequential: one sub-agent at a time (spawn)
 *   - Parallel: multiple sub-agents concurrently (spawnMultiple)
 *   - Evaluator-Optimizer: generate → evaluate → iterate (composed via spawn)
 *
 * Design influences:
 *   - Claude Code: single-threaded master loop, result compression, checkpoint system
 *   - OpenClaw: depth limits, timeout, attachments, ACP dispatch
 *   - Hermes Agent: depth gating (leaf vs orchestrator), interrupt propagation,
 *     configurable concurrency/iterations, context file injection
 */

import type {
  IAgentPool,
  IAgentEngineFactory,
  SpawnOptions,
  SpawnResult,
  IChatEvent,
  ILogger,
  ISessionStore,
  IApprovalGate,
} from "../core/interfaces.js";
import type { AgentConfig, SessionId } from "../core/types.js";
import { ToolRegistry } from "./tool-registry.js";
import type { ModelRouter } from "./llm.js";
import { ScopedApprovalGate } from "./approval-scoped.js";
import { ScopedLogger } from "./logger-scoped.js";
import { CheckpointStore } from "./checkpoint-store.js";

export interface SpawnMultipleOptions {
  /** Short description of the overall dispatch */
  description?: string;
  /** Array of sub-tasks to run in parallel */
  tasks: Array<Omit<SpawnOptions, "parentSessionId">>;
  /** Max concurrent sub-agents (default: from config or 4) */
  maxConcurrency?: number;
}

export interface SpawnMultipleResult {
  results: SpawnResult[];
  mergedSummary: string;
}

/** Pre-defined role → allowed tool names. */
const ROLE_TOOLS: Record<string, string[]> = {
  explore: ["read", "grep", "ls", "bash", "think"],
  coder:   ["read", "edit", "grep", "ls", "bash", "think"],
  tester:  ["read", "bash", "grep", "ls", "think"],
};

/** Recursion guard: tools that a sub-agent must NEVER have. */
const FORBIDDEN_SUB_TOOLS = new Set(["spawn", "spawn_multiple"]);

export class AgentPool implements IAgentPool {
  private counter = 0;
  private checkpoints: CheckpointStore;

  constructor(
    private baseConfig: AgentConfig,
    private store: ISessionStore,
    private router: ModelRouter,
    private parentTools: ToolRegistry,
    private logger: ILogger,
    private engineFactory: IAgentEngineFactory,
  ) {
    this.checkpoints = new CheckpointStore(baseConfig.workspace);
  }

  private get subagentConfig() {
    return this.baseConfig.subagent ?? {};
  }

  /** Spawn a single sub-agent (Sequential workflow). */
  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    const maxChars = this.subagentConfig.maxResultChars ?? 8000;
    const result = await this.runSubAgent(options);
    return {
      ...result,
      result: this.truncateResult(result.result, maxChars),
    };
  }

  /**
   * Spawn multiple sub-agents in parallel (Parallel / Split-and-Merge workflow).
   * Each sub-agent runs with its own isolated context.
   * Results are collected and merged into a single summary.
   */
  async spawnMultiple(options: SpawnMultipleOptions): Promise<SpawnMultipleResult> {
    const maxConcurrency = options.maxConcurrency ?? this.subagentConfig.maxConcurrency ?? 4;
    const description = options.description ?? "parallel dispatch";

    this.logger.info("Spawning multiple sub-agents", {
      description,
      count: options.tasks.length,
      maxConcurrency,
    });

    // Execute with concurrency limit
    const results: SpawnResult[] = [];
    const queue = [...options.tasks];

    while (queue.length > 0) {
      const batch = queue.splice(0, maxConcurrency);
      const batchPromises = batch.map((task) =>
        this.runSubAgent({
          description: task.description,
          task: task.task,
          role: task.role,
          model: task.model,
          tools: task.tools,
          systemPrompt: task.systemPrompt,
          verbose: task.verbose,
          contextFiles: task.contextFiles,
          depth: task.depth,
          timeoutMs: task.timeoutMs,
          maxIterations: task.maxIterations,
        }).then((r) => ({
          ...r,
          result: this.truncateResult(r.result, this.subagentConfig.maxResultChars ?? 8000),
        })).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error("Sub-agent in parallel batch failed", { error: msg, task: task.description });
          return this.createErrorResult(msg, task.description);
        }),
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    const mergedSummary = this.mergeParallelResults(description, results);

    this.logger.info("Parallel sub-agents completed", {
      description,
      total: results.length,
      success: results.filter((r) => !r.result.includes("[error]")).length,
    });

    return { results, mergedSummary };
  }

  // ─── Internal: run a single sub-agent ───────────────────────────────────────

  private async runSubAgent(options: SpawnOptions): Promise<SpawnResult> {
    const id = ++this.counter;
    const agentId = `sub-${Date.now()}-${id}`;
    const depth = options.depth ?? 0;
    const maxSpawnDepth = this.subagentConfig.maxSpawnDepth ?? 1;

    // Resolve tool list (role > explicit > parent default, then strip forbidden)
    const toolNames = this.resolveToolSet(options, depth, maxSpawnDepth);

    // Build sub-agent config
    const subConfig: AgentConfig = {
      ...this.baseConfig,
      id: agentId,
      name: `${this.baseConfig.name} (sub-${id})`,
      model: options.model ?? this.baseConfig.model,
      systemPrompt: options.systemPrompt ?? this.baseConfig.systemPrompt,
      tools: toolNames,
      maxIterations: options.maxIterations ?? this.baseConfig.maxIterations,
    };

    this.logger.info("Preparing sub-agent", {
      agentId,
      model: `${subConfig.model.provider}/${subConfig.model.model}`,
      role: options.role ?? "custom",
      tools: toolNames,
      depth,
      maxSpawnDepth,
    });

    // Resolve LLM
    const llm = this.router.resolve(subConfig.model);

    // Build tool registry (subset of parent, recursion-guarded)
    const missingTools = toolNames.filter((name) => !this.parentTools.get(name));
    if (missingTools.length > 0) {
      this.logger.warn("Tools not found in parent registry, skipping", { missing: missingTools });
    }
    const subTools = this.parentTools.filter(
      (t) => !FORBIDDEN_SUB_TOOLS.has(t.name) && toolNames.includes(t.name),
    );

    // Create or resume session
    let sessionId: SessionId;
    let resumed = false;

    if (options.sessionId) {
      const existing = await this.store.get(options.sessionId);
      if (existing) {
        sessionId = options.sessionId;
        resumed = true;
        this.logger.info("Resuming sub-agent session", { sessionId, turns: existing.turns.length });
      } else {
        this.logger.warn("Requested session not found, creating new one", { requested: options.sessionId });
        sessionId = crypto.randomUUID();
      }
    } else {
      sessionId = crypto.randomUUID();
    }

    if (!resumed) {
      await this.store.create({
        sessionId,
        agentId: subConfig.id,
        parentSessionId: options.parentSessionId ?? undefined,
        turns: [],
        tokenCount: 0,
      });
    }

    // Scoped resources for observability and isolation
    const subLogger = new ScopedLogger(this.logger, agentId, sessionId);
    const subApproval = new ScopedApprovalGate(
      { request: async () => "approved", isRequired: () => false, listPending: () => [] } as IApprovalGate,
      agentId,
      sessionId,
      subLogger,
    );

    // Build task with optional context file injection
    const task = await this.buildTask(options.task, options.contextFiles);

    // Create sub-agent engine with scoped logger
    const engine = this.engineFactory.create(subConfig, llm, subTools, {
      logger: subLogger,
      approval: subApproval,
    });

    // AbortController for cancellation support
    const abortController = new AbortController();

    // Execute task with optional timeout
    const events: IChatEvent[] = [];
    const timeoutMs = options.timeoutMs ?? this.subagentConfig.timeoutMs ?? 300_000;

    try {
      const chatPromise = (async () => {
        for await (const event of engine.chat(sessionId, task, abortController.signal)) {
          events.push(event);
          await this.checkpoints.append(sessionId, event);
        }
      })();

      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          abortController.abort(`Sub-agent timed out after ${timeoutMs}ms`);
          reject(new Error(`Sub-agent timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        abortController.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      });

      await Promise.race([chatPromise, timeoutPromise]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      subLogger.error("Sub-agent failed", { error: msg });
      return {
        agentId,
        sessionId,
        result: this.formatErrorResult(sessionId, msg),
        events,
      };
    } finally {
      abortController.abort(); // ensure any lingering async work is signalled
      await engine.dispose?.();
    }

    subLogger.info("Sub-agent completed", { eventCount: events.length });

    return {
      agentId,
      sessionId,
      result: this.formatResult(sessionId, events, options.verbose ?? false),
      events,
    };
  }

  // ─── Task builder with context file injection ───────────────────────────────

  private async buildTask(baseTask: string, contextFiles?: string[]): Promise<string> {
    if (!contextFiles || contextFiles.length === 0) return baseTask;

    const parts: string[] = [];
    for (const filePath of contextFiles) {
      try {
        const tool = this.parentTools.get("read");
        if (!tool) {
          parts.push(`--- Context file: ${filePath} ---\n[Error: read tool not available]\n`);
          continue;
        }
        const content = await tool.execute({ path: filePath });
        parts.push(`--- Context from ${filePath} ---\n${content}\n`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        parts.push(`--- Context file: ${filePath} ---\n[Error reading file: ${msg}]\n`);
      }
    }
    parts.push(`--- Task ---\n${baseTask}`);
    return parts.join("\n");
  }

  // ─── Tool set resolution ────────────────────────────────────────────────────

  private resolveToolSet(options: SpawnOptions, depth: number, maxSpawnDepth: number): string[] {
    const base = options.role
      ? (ROLE_TOOLS[options.role] ?? this.baseConfig.tools)
      : (options.tools ?? this.baseConfig.tools);

    // Depth gating: at max depth, strip spawn tools to prevent recursion
    const allowSpawn = depth < maxSpawnDepth;
    return base.filter((t) => {
      if (FORBIDDEN_SUB_TOOLS.has(t)) return allowSpawn;
      return true;
    });
  }

  // ─── Result formatting ──────────────────────────────────────────────────────

  private formatResult(sessionId: SessionId, events: IChatEvent[], verbose: boolean): string {
    const lines: string[] = [
      `subagent_session_id: ${sessionId} (pass this to resume)`,
      "",
      "<subagent_result>",
    ];

    for (const ev of events) {
      switch (ev.type) {
        case "thinking":
          if (verbose) lines.push(`[thinking] ${ev.text}`);
          break;
        case "tool_call":
          if (verbose) lines.push(`[tool] ${ev.call.name}`);
          break;
        case "tool_result":
          if (verbose) {
            lines.push(
              `[result] ${String(ev.result.output).slice(0, 300)}${String(ev.result.output).length > 300 ? "..." : ""}`,
            );
          }
          break;
        case "text":
          lines.push(ev.text);
          break;
        case "error":
          lines.push(`[error] ${ev.message}`);
          break;
      }
    }

    lines.push("</subagent_result>");
    return lines.join("\n");
  }

  private formatErrorResult(sessionId: SessionId, error: string): string {
    return [
      `subagent_session_id: ${sessionId} (pass this to resume)`,
      "",
      "<subagent_result>",
      `[error] Sub-agent failed: ${error}`,
      "</subagent_result>",
    ].join("\n");
  }

  private createErrorResult(error: string, description?: string): SpawnResult {
    const agentId = `sub-error-${Date.now()}`;
    const sessionId = crypto.randomUUID();
    return {
      agentId,
      sessionId,
      result: [
        `subagent_session_id: ${sessionId}`,
        "",
        "<subagent_result>",
        `[error] ${description ? `[${description}] ` : ""}${error}`,
        "</subagent_result>",
      ].join("\n"),
      events: [{ type: "error", code: "SPAWN_FAILED", message: error } as IChatEvent],
    };
  }

  private truncateResult(result: string, maxChars: number): string {
    if (result.length <= maxChars) return result;
    // XML-aware truncation: don't slice inside the closing tag
    const closeTag = "</subagent_result>";
    const tagLen = closeTag.length;
    let cutAt = maxChars;
    // Ensure we leave room for the close tag + truncation notice
    if (cutAt + tagLen + 100 > result.length) {
      cutAt = Math.max(1, result.length - tagLen - 100);
    }
    const truncated = result.slice(0, cutAt);
    const note = `\n\n[...output truncated: ${result.length - cutAt} characters removed to prevent context overflow...]\n${closeTag}`;
    return truncated + note;
  }

  /** Merge parallel sub-agent results into a unified summary for the parent agent. */
  private mergeParallelResults(description: string, results: SpawnResult[]): string {
    const lines: string[] = [
      `=== PARALLEL SUB-AGENT RESULTS: ${description} ===`,
      `Total dispatched: ${results.length}`,
      `Successful: ${results.filter((r) => !r.result.includes("[error]")).length}`,
      `Failed: ${results.filter((r) => r.result.includes("[error]")).length}`,
      "",
      "<parallel_results>",
    ];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`\n--- Result ${i + 1} (agent: ${r.agentId}) ---`);
      // Extract the text content from the XML result, skip metadata lines
      const content = r.result
        .split("\n")
        .filter(
          (line) =>
            !line.startsWith("subagent_session_id:") &&
            !line.startsWith("<subagent_result>") &&
            !line.startsWith("</subagent_result>"),
        )
        .join("\n")
        .trim();
      lines.push(content || "(no output)");
    }

    lines.push("\n</parallel_results>");
    return lines.join("\n");
  }
}

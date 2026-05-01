/**
 * SimpleClaw — Agent Pool
 * Creates sub-agents with independent config, model, tools, and session.
 * Supports three Anthropic workflow patterns:
 *   - Sequential: one sub-agent at a time (spawn)
 *   - Parallel: multiple sub-agents concurrently (spawnMultiple)
 *   - Evaluator-Optimizer: generate → evaluate → iterate (composed via spawn)
 *
 * Inspired by OpenClaw's agent tool + Anthropic's multi-agent research system.
 */

import type {
  IAgentPool,
  IAgentEngineFactory,
  SpawnOptions,
  SpawnResult,
  IChatEvent,
  ILogger,
  ISessionStore,
} from "../core/interfaces.js";
import type { AgentConfig, SessionId } from "../core/types.js";
import { ToolRegistry } from "./tool-registry.js";
import type { ModelRouter } from "./llm.js";

export interface SpawnMultipleOptions {
  /** Short description of the overall dispatch */
  description?: string;
  /** Array of sub-tasks to run in parallel */
  tasks: Array<{
    description?: string;
    task: string;
    role?: string;
    model?: { provider: string; model: string };
    tools?: string[];
    systemPrompt?: string;
  }>;
  /** Max concurrent sub-agents (default: 4) */
  maxConcurrency?: number;
}

export interface SpawnMultipleResult {
  results: SpawnResult[];
  mergedSummary: string;
}

/** Pre-defined role → allowed tool names. Prevents recursive spawn. */
const ROLE_TOOLS: Record<string, string[]> = {
  explore: ["read", "grep", "ls", "bash", "think"],
  coder:   ["read", "edit", "grep", "ls", "bash", "think"],
  tester:  ["read", "bash", "grep", "ls", "think"],
};

/** Recursion guard: tools that a sub-agent must NEVER have. */
const FORBIDDEN_SUB_TOOLS = new Set(["spawn", "spawn_multiple"]);

/** Max output length for a single sub-agent result before truncation */
const SUBAGENT_RESULT_MAX_CHARS = 8000;

export class AgentPool implements IAgentPool {
  private counter = 0;

  constructor(
    private baseConfig: AgentConfig,
    private store: ISessionStore,
    private router: ModelRouter,
    private parentTools: ToolRegistry,
    private logger: ILogger,
    private engineFactory: IAgentEngineFactory,
  ) {}

  /** Spawn a single sub-agent (Sequential workflow). */
  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    const result = await this.runSubAgent(options);
    return {
      ...result,
      result: this.truncateResult(result.result, SUBAGENT_RESULT_MAX_CHARS),
    };
  }

  /**
   * Spawn multiple sub-agents in parallel (Parallel / Split-and-Merge workflow).
   * Each sub-agent runs with its own isolated context.
   * Results are collected and merged into a single summary.
   */
  async spawnMultiple(options: SpawnMultipleOptions): Promise<SpawnMultipleResult> {
    const maxConcurrency = options.maxConcurrency ?? 4;
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
        }).then(r => ({
          ...r,
          result: this.truncateResult(r.result, SUBAGENT_RESULT_MAX_CHARS),
        })).catch(err => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error("Sub-agent in parallel batch failed", { error: msg, task: task.description });
          return this.createErrorResult(msg, task.description);
        })
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    const mergedSummary = this.mergeParallelResults(description, results);

    this.logger.info("Parallel sub-agents completed", {
      description,
      total: results.length,
      success: results.filter(r => !r.result.includes("[error]")).length,
    });

    return { results, mergedSummary };
  }

  // ─── Internal: run a single sub-agent ───────────────────────────────────────

  private async runSubAgent(options: SpawnOptions): Promise<SpawnResult> {
    const id = ++this.counter;
    const agentId = `sub-${Date.now()}-${id}`;

    // Resolve tool list (role > explicit > parent default, then strip forbidden)
    const toolNames = this.resolveToolSet(options);

    // Build sub-agent config
    const subConfig: AgentConfig = {
      ...this.baseConfig,
      id: agentId,
      name: `${this.baseConfig.name} (sub-${id})`,
      model: options.model ?? this.baseConfig.model,
      systemPrompt: options.systemPrompt ?? this.baseConfig.systemPrompt,
      tools: toolNames,
    };

    this.logger.info("Running sub-agent", {
      agentId,
      model: `${subConfig.model.provider}/${subConfig.model.model}`,
      role: options.role ?? "custom",
      tools: toolNames,
    });

    // Resolve LLM
    const llm = this.router.resolve(subConfig.model);

    // Build tool registry (subset of parent, recursion-guarded)
    const subTools = new ToolRegistry();
    for (const name of toolNames) {
      if (FORBIDDEN_SUB_TOOLS.has(name)) {
        this.logger.warn(`Tool "${name}" is forbidden for sub-agents, skipping`);
        continue;
      }
      const tool = this.parentTools.get(name);
      if (tool) {
        subTools.register(tool);
      } else {
        this.logger.warn(`Tool "${name}" not found in parent registry, skipping`);
      }
    }

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
        parentSessionId: undefined,
        turns: [],
        tokenCount: 0,
      });
    }

    // Create sub-agent engine
    const engine = this.engineFactory.create(subConfig, llm, subTools);

    // Execute task
    const events: IChatEvent[] = [];
    try {
      for await (const event of engine.chat(sessionId, options.task)) {
        events.push(event);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error("Sub-agent failed", { agentId, error: msg });
      return {
        agentId,
        sessionId,
        result: this.formatErrorResult(sessionId, msg),
        events: events.map(ev => ({ type: ev.type, text: extractEventText(ev) })),
      };
    }

    this.logger.info("Sub-agent completed", { agentId, sessionId, eventCount: events.length });

    return {
      agentId,
      sessionId,
      result: this.formatResult(sessionId, events),
      events: events.map(ev => ({ type: ev.type, text: extractEventText(ev) })),
    };
  }

  // ─── Tool set resolution ────────────────────────────────────────────────────

  private resolveToolSet(options: SpawnOptions): string[] {
    const base = options.role
      ? (ROLE_TOOLS[options.role] ?? this.baseConfig.tools)
      : (options.tools ?? this.baseConfig.tools);
    return base.filter(t => !FORBIDDEN_SUB_TOOLS.has(t));
  }

  // ─── Result formatting ──────────────────────────────────────────────────────

  private formatResult(sessionId: SessionId, events: IChatEvent[]): string {
    const lines: string[] = [
      `subagent_session_id: ${sessionId} (pass this to resume)`,
      "",
      "<subagent_result>",
    ];

    for (const ev of events) {
      switch (ev.type) {
        case "thinking":
          lines.push(`[thinking] ${ev.text}`);
          break;
        case "tool_call":
          lines.push(`[tool] ${ev.call.name}`);
          break;
        case "tool_result":
          lines.push(`[result] ${String(ev.result.output).slice(0, 300)}${String(ev.result.output).length > 300 ? "..." : ""}`);
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
      events: [{ type: "error", code: "SPAWN_FAILED", message: error }],
    };
  }

  private truncateResult(result: string, maxChars: number): string {
    if (result.length <= maxChars) return result;
    const truncated = result.slice(0, maxChars);
    const note = `\n\n[...output truncated: ${result.length - maxChars} characters removed to prevent context overflow...]`;
    return truncated + note;
  }

  /** Merge parallel sub-agent results into a unified summary for the parent agent. */
  private mergeParallelResults(description: string, results: SpawnResult[]): string {
    const lines: string[] = [
      `=== PARALLEL SUB-AGENT RESULTS: ${description} ===`,
      `Total dispatched: ${results.length}`,
      `Successful: ${results.filter(r => !r.result.includes("[error]")).length}`,
      `Failed: ${results.filter(r => r.result.includes("[error]")).length}`,
      "",
      "<parallel_results>",
    ];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`\n--- Result ${i + 1} (agent: ${r.agentId}) ---`);
      // Extract the text content from the XML result, skip metadata lines
      const content = r.result
        .split("\n")
        .filter(line =>
          !line.startsWith("subagent_session_id:") &&
          !line.startsWith("<subagent_result>") &&
          !line.startsWith("</subagent_result>")
        )
        .join("\n")
        .trim();
      lines.push(content || "(no output)");
    }

    lines.push("\n</parallel_results>");
    return lines.join("\n");
  }
}

/** Safely extract display text from a chat event without `as any`. */
function extractEventText(ev: IChatEvent): string | undefined {
  if (ev.type === "text" || ev.type === "thinking") {
    return ev.text;
  }
  if (ev.type === "error") {
    return ev.message;
  }
  if (ev.type === "tool_result") {
    return ev.result.output;
  }
  return undefined;
}

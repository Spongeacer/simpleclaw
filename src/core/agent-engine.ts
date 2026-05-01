/**
 * SimpleClaw Core �?Agent Engine
 * Pure logic. Zero platform dependencies. Zero I/O.
 * All external interactions go through injected interfaces.
 */

import type {
  AgentConfig,
  ConversationTurn,
  SessionId,
  ToolCall,
  ToolResult,
} from "./types.js";
import type {
  IAgentEngine,
  IApprovalGate,
  IChatEvent,
  IContextEngine,
  ILLMClient,
  ILLMMessage,
  ILLMResponse,
  ILogger,
  IMemoryIndex,
  ISessionStore,
  IToolRegistry,
  IToolCallHooks,
  IUserMemory,
  AskUserQuestion,
} from "./interfaces.js";
import { ContextCompactor, DEFAULT_COMPACTOR_CONFIG } from "./compactor.js";
import { DAGExecutor, HookRegistry, ReplanPolicy, type Plan, type ExecutionResult } from "../agent-runtime/plan/index.js";

interface SessionWorkingSet {
  task?: string;
  files: string[]; // most recent first
}

interface NudgeState {
  turnsSinceMemoryNudge: number;
  toolItersSinceSkillNudge: number;
  memoryNudgeInterval: number;
  skillNudgeInterval: number;
}

export interface AgentEngineOptions {
  config: AgentConfig;
  store: ISessionStore;
  llm: ILLMClient;
  tools: IToolRegistry;
  approval: IApprovalGate;
  logger: ILogger;
  memory?: IMemoryIndex;
  instructions?: string;
  skills?: string;
  toolHooks?: IToolCallHooks;
  contextEngine?: IContextEngine;
  userMemory?: IUserMemory;
}

export class AgentEngine implements IAgentEngine {
  private contextEngine: IContextEngine;
  private workingSets = new Map<SessionId, SessionWorkingSet>();
  private stableSystemPrompt: string | null = null;
  private replanPolicy = new ReplanPolicy();
  private planExecutor = new DAGExecutor();
  private nudgeStates = new Map<SessionId, NudgeState>();
  private questionResolvers = new Map<string, (answer: string) => void>();
  private defaultNudgeConfig: Omit<NudgeState, "turnsSinceMemoryNudge" | "toolItersSinceSkillNudge"> = {
    memoryNudgeInterval: 10,
    skillNudgeInterval: 10,
  };

  constructor(private opts: AgentEngineOptions) {
    this.contextEngine = opts.contextEngine ?? new ContextCompactor(opts.llm, opts.logger);
    this._validateCompactorConfig();
  }

  private _validateCompactorConfig(): void {
    const cfg = this.opts.config.compaction;
    if (!cfg) return;
    const { thresholdTokens, summaryMaxLength } = cfg;
    if (thresholdTokens && summaryMaxLength && thresholdTokens <= summaryMaxLength * 0.5) {
      this.opts.logger.warn(
        "Compactor config may cause frequent compaction loops. " +
        "Consider increasing thresholdTokens or decreasing summaryMaxLength.",
        { thresholdTokens, summaryMaxLength }
      );
    }
  }

  async dispose(): Promise<void> {
    this.nudgeStates.clear();
    this.workingSets.clear();
    this.questionResolvers.clear();
    this.stableSystemPrompt = null;
    const ce = this.contextEngine as unknown as { dispose?: () => Promise<void> | void };
    if (typeof ce.dispose === "function") {
      await ce.dispose();
    }
    await this.opts.store.dispose?.();
  }

  /**
   * Update the skills prompt dynamically (e.g. after hot-reload).
   */
  updateSkills(skillsPrompt: string | undefined): void {
    this.opts.skills = skillsPrompt;
    this.opts.logger.info("Skills prompt updated");
  }

  async *chat(sessionId: SessionId, message: string, signal?: AbortSignal): AsyncGenerator<IChatEvent> {
    const session = await this.opts.store.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Append user turn
    const userTurn: ConversationTurn = {
      id: crypto.randomUUID(),
      role: "user",
      content: message,
      timestamp: new Date(),
    };
    session.turns.push(userTurn);

    this.opts.logger.info("Agent turn started", { sessionId, messageLength: message.length });
    yield { type: "thinking", text: "Planning..." };

    const maxIterations = this.opts.config.maxIterations ?? 10;
    let answered = false;
    const preTurnCount = session.turns.length; // track new turns for context-engine ingestion

    // Nudge: increment counter at the start of each user turn
    const nudge = this.getOrCreateNudgeState(sessionId);
    nudge.turnsSinceMemoryNudge++;

    // Ensure stable system prompt is built once (async for user memory loading)
    if (!this.stableSystemPrompt) {
      this.stableSystemPrompt = await this.buildStableSystemPrompt();
    }

    for (let i = 0; i < maxIterations; i++) {
      if (signal?.aborted) {
        yield { type: "error", code: "ABORTED", message: `Agent execution aborted: ${signal.reason}` };
        return;
      }

      // Compact context if it grew too large
      const compactionCfg = this.opts.config.compaction
        ? { ...DEFAULT_COMPACTOR_CONFIG, ...this.opts.config.compaction }
        : DEFAULT_COMPACTOR_CONFIG;
      const { turns: compactedTurns, didCompact, summary } = await this.contextEngine.assemble({
        turns: session.turns,
        config: compactionCfg,
        systemPromptText: this.stableSystemPrompt ?? undefined,
        toolSchemas: this.opts.tools.schema(),
        contextWindow: this.opts.config.model.contextWindow ?? 128_000,
        sessionId,
        memory: this.opts.memory,
        modelId: this.opts.config.model.model,
        availableTools: this.opts.tools.schema().map((t) => t.name),
        prompt: message,
      });
      if (didCompact) {
        yield { type: "thinking", text: "Context compacted. Resuming from summary..." };
      }

      const messages = await this.buildMessages(compactedTurns, sessionId, summary);
      const toolSchemas = this.opts.tools.schema();

      const response = await this.opts.llm.complete(messages, toolSchemas);

      if (response.usage) {
        session.tokenCount += response.usage.promptTokens + response.usage.completionTokens;

        // Feed actual usage back to compactor for calibration
        this.contextEngine.recordUsage?.(response.usage.promptTokens, session.turns, {
          systemPromptText: this.stableSystemPrompt ?? undefined,
          toolSchemas: this.opts.tools.schema(),
        });
      }

      if (response.reasoning) {
        yield { type: "thinking", text: response.reasoning };
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        const assistantTurn: ConversationTurn = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: response.text,
          reasoning: response.reasoning,
          toolCalls: response.toolCalls,
          timestamp: new Date(),
        };
        session.turns.push(assistantTurn);

        // Track total tool call rounds in session metadata
        const prevTotal = (session.metadata?.totalToolCallRounds as number | undefined) ?? 0;
        session.metadata = { ...session.metadata, totalToolCallRounds: prevTotal + 1 };

        // ask_user_question requires blocking user interaction — never run in plan mode
        const hasQuestion = response.toolCalls.some((c) => c.name === "ask_user_question");
        const usePlan = !hasQuestion && this.shouldUsePlan(response.toolCalls, i, sessionId);

    if (usePlan) {
          // ─── Plan Mode: Parallel Execution ─────────────────────────────────────

          // Phase 1: Serial approval check + yield tool_calls
          const approvedCalls: ToolCall[] = [];
          const deniedMap = new Map<string, { callId: string; output: string; isError: true }>();

          for (const call of response.toolCalls) {
            yield { type: "tool_call", call: { id: call.id, name: call.name, arguments: call.arguments } };

            const decision = await this.opts.approval.request({
              id: crypto.randomUUID(),
              toolName: call.name,
              arguments: call.arguments,
              reason: `Agent wants to run ${call.name}`,
              timestamp: new Date(),
            });

            if (decision === "denied") {
              deniedMap.set(call.id, { callId: call.id, output: "User denied this action.", isError: true });
              continue;
            }
            approvedCalls.push(call);
          }

          // Phase 2: Execute approved calls in parallel via DAG
          const resultMap = new Map<string, { callId: string; output: string; isError?: boolean }>();

          if (approvedCalls.length > 0) {
            const execResult = await this.executePlan(approvedCalls, sessionId);
            for (const [stepId, node] of execResult.dag.getAllNodes()) {
              resultMap.set(stepId, {
                callId: stepId,
                output: node.result?.output ?? "",
                isError: node.status === "failed",
              });
            }
          }

          // Phase 3: Yield tool_results in original order (backward compatible)
          for (const call of response.toolCalls) {
            const result = resultMap.get(call.id) ?? deniedMap.get(call.id);
            if (!result) continue;

            yield { type: "tool_result", result };
            session.turns.push({
              id: crypto.randomUUID(),
              role: "tool",
              content: result.output,
              toolCallId: call.id,
              timestamp: new Date(),
            });

            // Update working set for any tool call with a path argument
            if (call.arguments && typeof (call.arguments as Record<string, unknown>).path === "string") {
              this.updateWorkingSet(sessionId, String((call.arguments as Record<string, unknown>).path));
            }
          }
        } else {
          // ─── Serial Mode: Original Behavior ────────────────────────────────────

          for (const call of response.toolCalls) {
            // Intercept ask_user_question for blocking UI interaction
            if (call.name === "ask_user_question") {
              yield { type: "tool_call", call: { id: call.id, name: call.name, arguments: call.arguments } };

              const args = call.arguments as Record<string, unknown>;
              const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
              const questionId = crypto.randomUUID();

              const questions: AskUserQuestion[] = rawQuestions.map((q: unknown) => {
                const rq = q as Record<string, unknown>;
                const rawOptions = Array.isArray(rq.options) ? rq.options : [];
                return {
                  question: String(rq.question || ""),
                  options: rawOptions.map((o: unknown) => {
                    const ro = o as Record<string, unknown>;
                    return {
                      label: String(ro.label || ""),
                      description: ro.description ? String(ro.description) : undefined,
                    };
                  }),
                  multiSelect: !!rq.multi_select,
                };
              });

              // Yield question event so the Gateway can forward it to the client
              yield { type: "question", questionId, questions };

              // Block until the user answers via answerQuestion()
              const answer = await new Promise<string>((resolve, reject) => {
                this.questionResolvers.set(questionId, resolve);
                // If already aborted, reject immediately
                if (signal?.aborted) {
                  reject(new Error(`Aborted: ${signal.reason}`));
                }
                // Listen for future abort
                signal?.addEventListener("abort", () => {
                  this.questionResolvers.delete(questionId);
                  reject(new Error(`Aborted: ${signal.reason}`));
                }, { once: true });
              });
              this.questionResolvers.delete(questionId);

              const qResult: ToolResult = { callId: call.id, output: `User answered: ${answer}` };
              yield { type: "tool_result", result: qResult };
              session.turns.push({
                id: crypto.randomUUID(),
                role: "tool",
                content: qResult.output,
                toolCallId: call.id,
                timestamp: new Date(),
              });
              continue;
            }

            yield { type: "tool_call", call: { id: call.id, name: call.name, arguments: call.arguments } };

            const decision = await this.opts.approval.request({
              id: crypto.randomUUID(),
              toolName: call.name,
              arguments: call.arguments,
              reason: `Agent wants to run ${call.name}`,
              timestamp: new Date(),
            });

            if (decision === "denied") {
              const denyResult = { callId: call.id, output: "User denied this action.", isError: true };
              yield { type: "tool_result", result: denyResult };
              session.turns.push({
                id: crypto.randomUUID(),
                role: "tool",
                content: denyResult.output,
                toolCallId: call.id,
                timestamp: new Date(),
              });
              continue;
            }

            await this.runToolHook("beforeExecute", call, sessionId);
            const result = await this.opts.tools.execute(call, { sessionId });
            await this.runToolHook("afterExecute", call, sessionId, result);
            yield { type: "tool_result", result };
            session.turns.push({
              id: crypto.randomUUID(),
              role: "tool",
              content: result.output,
              toolCallId: call.id,
              timestamp: new Date(),
            });

            // Update working set for any tool call with a path argument
            if (call.arguments && typeof (call.arguments as Record<string, unknown>).path === "string") {
              this.updateWorkingSet(sessionId, String((call.arguments as Record<string, unknown>).path));
            }
          }
        }

        // Nudge: check if agent proactively used memory/skill tools this iteration
        this.updateNudgeCounters(sessionId, session.turns);

        yield { type: "thinking", text: `Processing results (${i + 1}/${maxIterations})...` };
        continue;
      }

      // No tool calls �?check for planning-only before treating as final answer
      if (this.detectPlanningOnly(response, session.turns)) {
        const steerTurn: ConversationTurn = {
          id: crypto.randomUUID(),
          role: "user",
          content: this.buildPlanningOnlySteer(),
          timestamp: new Date(),
        };
        session.turns.push(steerTurn);
        yield { type: "thinking", text: "Planning-only detected. Steering to act..." };
        continue;
      }

      // No tool calls �?final answer
      const assistantTurn: ConversationTurn = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: response.text,
        reasoning: response.reasoning,
        timestamp: new Date(),
      };
      session.turns.push(assistantTurn);
      yield { type: "text", text: response.text };
      answered = true;
      break;
    }

    if (!answered) {
      yield { type: "error", code: "MAX_ITERATIONS", message: "Agent reached the maximum number of tool iterations without a final answer." };
    }

    // Ingest new turns into the context engine (e.g. for external memory systems)
    if (this.contextEngine.ingest) {
      const newTurns = session.turns.slice(preTurnCount);
      for (const turn of newTurns) {
        try {
          await this.contextEngine.ingest({ sessionId, turn });
        } catch (err) {
          this.opts.logger.warn("Context engine ingest failed", { sessionId, error: String(err) });
        }
      }
    }

    await this.opts.store.update(sessionId, {
      turns: session.turns,
      tokenCount: session.tokenCount,
      metadata: session.metadata,
    });
    this.opts.logger.info("Agent turn complete", { sessionId, tokenCount: session.tokenCount });
    yield { type: "done" };
  }

  private async buildMessages(
    turns: ConversationTurn[],
    sessionId: SessionId,
    compactedSummary?: string | null,
  ): Promise<ILLMMessage[]> {
    const messages: ILLMMessage[] = [];

    // Build structured system prompt with cache boundary
    // Stable prefix (cacheable across turns)
    if (this.stableSystemPrompt) {
      messages.push({ role: "system", content: this.stableSystemPrompt, cacheControl: { type: "ephemeral" } });
    }
    // Dynamic suffix (varies per turn �?not cached)
    const dynamicContent = await this.buildDynamicSystemPrompt(turns, sessionId, compactedSummary);
    if (dynamicContent) {
      messages.push({ role: "system", content: dynamicContent });
    }

    // Repair tool-use/tool-result pairing before sending to LLM
    const repairedTurns = this.repairToolPairing(turns);

    // Find last user turn for dynamic timestamp injection
    let lastUserIdx = -1;
    for (let i = repairedTurns.length - 1; i >= 0; i--) {
      if (repairedTurns[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }

    for (let i = 0; i < repairedTurns.length; i++) {
      const turn = repairedTurns[i];
      switch (turn.role) {
        case "user": {
          let content = turn.content;
          if (i === lastUserIdx) {
            content = this.injectTimestamp(content);
          }
          messages.push({ role: "user", content });
          break;
        }
        case "assistant":
          messages.push({
            role: "assistant",
            content: turn.content,
            toolCalls: turn.toolCalls,
          });
          break;
        case "tool":
          messages.push({
            role: "tool",
            content: turn.content,
            toolCallId: turn.toolCallId ?? turn.id,
          });
          break;
        case "system":
          // Compactor no longer injects summary as a system turn;
          // any remaining system turns (e.g. from external sources) are preserved.
          messages.push({ role: "system", content: turn.content });
          break;
      }
    }
    return messages;
  }

  private async buildDynamicSystemPrompt(
    turns: ConversationTurn[],
    sessionId: SessionId,
    compactedSummary?: string | null,
  ): Promise<string> {
    const parts: string[] = [];

    // DYNAMIC SLOTS

    // SLOT: COMPACTED HISTORY �?embedded into system prompt instead of a separate message
    if (compactedSummary) {
      parts.push(`=== COMPACTED HISTORY ===\n\n${compactedSummary}`);
    }

    // SLOT: PROTOCOL �?decision rules + plan mode + custom system prompt
    const protocolParts: string[] = [];
    if (this.opts.config.systemPrompt) {
      protocolParts.push(this.opts.config.systemPrompt);
    }
    const complexity = this.assessComplexity(turns);
    if (complexity === "complex") {
      protocolParts.push(this.buildPlanModeGuidance());
    }
    protocolParts.push(this.buildProtocolRules());
    if (protocolParts.length > 0) {
      parts.push(protocolParts.join("\n\n"));
    }

    // SLOT: INSTRUCTIONS �?project-level AGENTS.md / CLAUDE.md (only once per session)
    const session = await this.opts.store.get(sessionId);
    const instructionsInjected = session?.metadata?.instructionsInjected === true;
    if (!instructionsInjected && this.opts.instructions) {
      parts.push(this.opts.instructions);
      // Persist flag immediately so it survives compaction and reloads
      if (session) {
        await this.opts.store.update(sessionId, {
          metadata: { ...session.metadata, instructionsInjected: true },
        });
      }
    }

    // SLOT: SKILLS �?available skills (injected every turn, lightweight)
    if (this.opts.skills) {
      parts.push(this.opts.skills);
    }

    // SLOT: KNOWLEDGE �?relevant memory chunks (dynamic per-turn)
    if (this.opts.memory && this.opts.config.memory?.enabled !== false) {
      const knowledge = await this.buildKnowledge(turns);
      if (knowledge) {
        parts.push(knowledge);
      }
    }

    // SLOT: TIME �?static timezone hint (cache-stable; dynamic clock is injected into user message)
    const timeSection = this.buildTimeSection();
    if (timeSection) {
      parts.push(timeSection);
    }

    // SLOT: WORKING SET �?recent files + contextual hints
    const workingSet = this.buildWorkingSet(turns, sessionId);
    if (workingSet) {
      parts.push(workingSet);
    }

    // SLOT: LIVE USER MEMORY �?current state (may differ from frozen snapshot)
    const liveMemory = await this.buildLiveUserMemorySection();
    if (liveMemory) {
      parts.push(liveMemory);
    }

    // SLOT: NUDGE �?gentle reminder to persist knowledge
    const nudge = this.buildNudgeSection(sessionId);
    if (nudge) {
      parts.push(nudge);
    }

    return parts.join("\n\n");
  }

  /** Load current user memory for live injection into dynamic prompt. */
  private async buildLiveUserMemorySection(): Promise<string | undefined> {
    if (!this.opts.userMemory) return undefined;
    try {
      const { memory, user, memoryUsage, userUsage } = await this.opts.userMemory.load();
      const lines: string[] = [];
      if (memory.trim()) {
        lines.push(`══�?LIVE MEMORY [${memoryUsage}] ═══`);
        lines.push(memory);
      }
      if (user.trim()) {
        lines.push(`══�?LIVE USER PROFILE [${userUsage}] ═══`);
        lines.push(user);
      }
      return lines.length > 0 ? lines.join("\n") : undefined;
    } catch (err) {
      this.opts.logger.warn("Failed to load live user memory", { error: String(err) });
      return undefined;
    }
  }

  /** Build the stable (cacheable) portion of the system prompt. */
  private async buildStableSystemPrompt(): Promise<string> {
    const parts: string[] = [];
    parts.push(this.buildBasePersona());
    parts.push(this.buildToolGuidance());
    parts.push(this.buildSkillCreationGuidance());
    parts.push(this.buildWorkspaceContext());
    const memSection = await this.buildUserMemorySection();
    if (memSection) parts.push(memSection);
    parts.push(this.buildFormattingRules());
    return parts.join("\n\n");
  }

  /** Inject bounded user memory as a frozen snapshot (cache-friendly). */
  private async buildUserMemorySection(): Promise<string> {
    if (!this.opts.userMemory) return "";
    try {
      const { memory, user, memoryUsage, userUsage } = await this.opts.userMemory.load();
      const lines: string[] = [];
      if (memory.trim()) {
        lines.push(`══════════════════════════════════════════════`);
        lines.push(`MEMORY (project facts & lessons) [${memoryUsage}]`);
        lines.push(`══════════════════════════════════════════════`);
        lines.push(memory);
      }
      if (user.trim()) {
        lines.push(`══════════════════════════════════════════════`);
        lines.push(`USER PROFILE (preferences & style) [${userUsage}]`);
        lines.push(`══════════════════════════════════════════════`);
        lines.push(user);
      }
      return lines.join("\n");
    } catch (err) {
      this.opts.logger.warn("Failed to load user memory", { error: String(err) });
      return "";
    }
  }

  private assessComplexity(turns: ConversationTurn[]): "simple" | "complex" {
    const userTurns = turns.filter(t => t.role === "user");
    const lastUser = userTurns[userTurns.length - 1];
    if (!lastUser) return "simple";

    const text = lastUser.content.toLowerCase();

    // Heuristics for complex tasks
    const multiStepIndicators = [
      "refactor", "rewrite", "restructure", "migrate",
      "implement", "create a", "add support", "integrate",
      "fix all", "update all", "change all",
      "step by step", "plan", "break down",
    ];

    const hasMultiStep = multiStepIndicators.some(ind => text.includes(ind));
    const isLong = lastUser.content.length > 200;
    const mentionsMultipleFiles = (text.match(/\.(ts|js|json|md|py|go|rs)\b/g) || []).length >= 2;
    // Also consider complexity if there have already been many tool calls this session
    const toolCallRounds = turns.filter(t => t.role === "assistant" && t.toolCalls && t.toolCalls.length > 0).length;
    const hasManyToolCalls = toolCallRounds >= 4;

    if (hasMultiStep || (isLong && mentionsMultipleFiles) || hasManyToolCalls) {
      return "complex";
    }
    return "simple";
  }

  private buildPlanModeGuidance(): string {
    return [
      "=== PLAN MODE ===",
      "",
      "This task appears to involve multiple steps. Before taking action:",
      "",
      "1. Use the `think` tool to create a step-by-step plan.",
      "2. List all files you need to inspect.",
      "3. Read each file before proposing any edits.",
      "4. Only start editing after you have a complete understanding.",
      "5. If a step fails, pause and use `think` to revise the plan.",
      "",
      "Do NOT rush into edits. A good plan prevents mistakes.",
    ].join("\n");
  }

  private buildSkillCreationGuidance(): string {
    if (!this.opts.tools.get("skill_manage")) return "";
    return [
      "=== SKILL CREATION ===",
      "",
      "After completing a complex task (5+ tool calls) or fixing a non-trivial bug,",
      "consider calling `skill_manage` with action='create' to save the workflow.",
      "This helps future sessions reuse successful patterns.",
      "",
      "A good skill includes:",
      "- Procedure: step-by-step instructions",
      "- Pitfalls: common mistakes and how to avoid them",
      "- Verification: how to confirm the task was done correctly",
      "",
    ].join("\n");
  }

  private buildToolGuidance(): string {
    const schemas = this.opts.tools.schema();
    const toolNames = new Set(schemas.map((s) => s.name));
    const lines: string[] = [
      "=== TOOLS ===",
      "",
      "Available tools (see each tool's description for detailed usage):",
      "",
    ];

    for (const s of schemas) {
      lines.push(`�?${s.name} �?${s.description}`);
    }

    lines.push("");
    lines.push("=== CORE RULES ===");
    lines.push("");
    const rules: string[] = [];
    if (this.opts.config.planMode !== "off") {
      rules.push("When you need multiple tools, output ALL of them at once. Independent tools will run in parallel.");
    }
    rules.push("Read BEFORE editing. Use offset/limit for large files.");
    if (toolNames.has("bash")) {
      rules.push("bash is for local ops only (tests, builds). No web scraping.");
    }
    if (toolNames.has("think")) {
      rules.push("Use think before multi-step work.");
    }
    rules.push("If stuck after 2 attempts, explain the problem to the user.");
    rules.push("NEVER print, echo, or expose environment variables that contain credentials (tokens, passwords, API keys).");
    rules.push("If a tool returns no useful results after 2 attempts (e.g. web_search empty), stop trying that approach and answer from your training knowledge or explain the limitation.");
    for (let i = 0; i < rules.length; i++) {
      lines.push(`${i + 1}. ${rules[i]}`);
    }
    lines.push("");
    lines.push("Do NOT use tools for general knowledge questions or casual chat.");
    lines.push("");
    lines.push("=== TOOL CALL STYLE ===");
    lines.push("Default: do not narrate routine, low-risk tool calls (just call the tool).");
    lines.push("Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g. deletions), or when the user explicitly asks.");
    lines.push("Keep narration brief and value-dense; avoid repeating obvious steps.");
    lines.push("When a first-class tool exists for an action, use the tool directly instead of asking the user to run equivalent CLI commands.");
    lines.push("If more tool work would likely change the answer, do it before replying.");
    lines.push("Parallelize independent lookups; serialize dependent, destructive, or approval-sensitive steps.");
    lines.push("");
    lines.push("=== ANTI-PLANNING-ONLY RULE ===");
    lines.push("NEVER respond with only a plan, description, or promise of future action.");
    lines.push("If the task requires tools: call them NOW in this turn. Do not say 'I will do X' �?just do X.");
    lines.push("If you have already called tools and are summarizing results: that is fine.");
    lines.push("If no tools are needed (general knowledge/chat): answer directly without tool calls.");
    lines.push("Violating this rule wastes turns and will trigger a retry with a correction prompt.");

    return lines.join("\n");
  }

  private buildWorkspaceContext(): string {
    const lines: string[] = [
      "=== WORKSPACE ===",
      "",
      `Working directory: ${this.opts.config.workspace}`,
      "",
    ];

    if (this.opts.memory) {
      lines.push("Use `memory_search` to find files by description or recall project knowledge.");
      lines.push("Use `memory_save` after significant work to persist decisions and patterns.");
    }

    return lines.join("\n");
  }

  private buildContextualHints(turns: ConversationTurn[], totalToolCallRounds?: number): string {
    const hints: string[] = [];

    // 1. Extract files already read successfully
    const readFiles = this.extractReadFiles(turns);
    if (readFiles.length > 0) {
      hints.push(`Files you have already read and can edit: ${readFiles.join(", ")}`);
    }

    // 2. Extract recent failures to avoid repeating
    const recentFailures = this.extractRecentFailures(turns);
    if (recentFailures.length > 0) {
      hints.push(`Recent failures �?do NOT repeat the same approach:`);
      for (const f of recentFailures) {
        hints.push(`  �?${f}`);
      }
    }

    // 3. Iteration count reminder (use session total if available, else compacted count)
    const toolCallRounds = totalToolCallRounds ?? turns.filter(t => t.role === "assistant" && t.toolCalls && t.toolCalls.length > 0).length;
    if (toolCallRounds >= 5) {
      hints.push("You have made many tool calls. Summarize what you found and provide a final answer.");
    } else if (toolCallRounds >= 3) {
      hints.push("You have used several tools. Consider if you have enough information to answer.");
    }

    if (hints.length === 0) return "";

    return [
      "=== CONTEXT ===",
      "",
      ...hints,
    ].join("\n");
  }

  private extractReadFiles(turns: ConversationTurn[]): string[] {
    const files = new Set<string>();
    for (const turn of turns) {
      if (turn.role === "tool" && turn.content) {
        // Match: [File: path (N lines total)]
        const match = turn.content.match(/\[File: ([^\]]+)/);
        if (match) {
          const path = match[1].replace(/ \(\d+ lines total\)/, "").trim();
          files.add(path);
        }
      }
    }
    return Array.from(files);
  }

  private extractRecentFailures(turns: ConversationTurn[]): string[] {
    const failures: string[] = [];
    // Look at last 3 tool results for errors
    const toolTurns = turns.filter(t => t.role === "tool").slice(-3);
    for (const turn of toolTurns) {
      if (turn.content && (
        turn.content.includes("Error:") ||
        turn.content.includes("not found") ||
        turn.content.includes("cannot") ||
        turn.content.includes("failed") ||
        turn.content.includes("denied")
      )) {
        // Extract a concise error message (first line, max 80 chars)
        const firstLine = turn.content.split("\n")[0].slice(0, 80);
        if (!failures.includes(firstLine)) {
          failures.push(firstLine);
        }
      }
    }
    return failures;
  }

  private buildBasePersona(): string {
    return [
      "=== BASE PERSONA ===",
      "",
      "You are an expert software engineering assistant. Help users by reading, reasoning, and taking action.",
      "",
      "Workflow:",
      "1. UNDERSTAND �?Read the request. Ask clarifying questions if needed.",
      "2. DECIDE �?Does this need files/tools? General knowledge needs none.",
      "3. ACT �?Use the right tool. Read before editing. Plan before complex work.",
      "4. VERIFY �?Test or read back changes. Never assume correctness.",
      "",
      "Habits:",
      "- Prefer small, targeted changes over large rewrites.",
      "- Write tests for new code when a test framework is present.",
      "- Be concise. Avoid unnecessary prose.",
    ].join("\n");
  }

  private buildProtocolRules(): string {
    const lines: string[] = [
      "=== PROTOCOL ===",
      "",
      "### DECISION RULE",
      "Before calling any tool, ask: 'Does this task need files or code?'",
      "- YES �?use tools. NO (general knowledge, chat) �?answer directly.",
      "",
    ];

    if (this.opts.skills) {
      lines.push("### SKILL RULE (CRITICAL)");
      lines.push("If the user's task matches an available skill, call `skill` FIRST before any other tool.");
      lines.push("Skills contain specialized workflow guidance. Loading them first prevents mistakes.");
      lines.push("");
    }

    lines.push("### WORKFLOW PATTERNS");
    lines.push("Choose the right pattern for the task:");
    lines.push("");
    lines.push("**Sequential** (one step depends on the previous):");
    lines.push("  Use `spawn` to delegate sub-tasks one at a time. Each sub-agent's result informs the next.");
    lines.push("  Example: 'Implement auth �?Write tests �?Run tests �?Fix failures'");
    lines.push("");
    lines.push("**Parallel** (independent sub-tasks):");
    lines.push("  Use `spawn_multiple` to run sub-agents concurrently. Merge their outputs for synthesis.");
    lines.push("  Best for: breadth-first exploration, multi-dimension audits, bulk operations.");
    lines.push("  Example: 'Find all API usages' split into 'find auth usages', 'find db usages', 'find cache usages'");
    lines.push("");
    lines.push("**Evaluator-Optimizer** (iterative refinement):");
    lines.push("  1. Spawn a coder sub-agent to generate a solution.");
    lines.push("  2. Spawn a tester/evaluator sub-agent to verify it (run tests, check quality).");
    lines.push("  3. If evaluation fails, use the feedback to spawn an improved version.");
    lines.push("  4. Repeat until the evaluation passes or max iterations reached.");
    lines.push("  Do NOT give up after one failure �?iterate with concrete feedback.");
    lines.push("");

    lines.push("### MEMORY PROTOCOL");
    lines.push("After completing significant work (bugfixes, architecture decisions, pattern discoveries),");
    lines.push("call `memory_save` to persist the knowledge. Do NOT wait for user confirmation.");
    lines.push("");
    lines.push("When searching for files or knowledge, use `memory_search` with mode='files' or mode='memory'.");
    lines.push("");

    if (this.opts.memory) {
      lines.push("If you are unsure about a file path, `memory_search` can find files by description.");
      lines.push("If a read/edit fails with 'file not found', the path may have changed. Try `memory_search` to locate it.");
    }

    return lines.join("\n");
  }

  private async buildKnowledge(turns: ConversationTurn[]): Promise<string | undefined> {
    if (!this.opts.memory) return undefined;

    const query = this.buildKnowledgeQuery(turns);
    if (!query.trim()) return undefined;

    const maxResults = this.opts.config.memory?.maxResults ?? 5;

    try {
      const chunks = await this.opts.memory.search(query, { maxResults });
      if (chunks.length === 0) return undefined;

      const lines: string[] = [
        "=== KNOWLEDGE ===",
        "",
        "Relevant workspace knowledge:",
        "",
      ];
      for (const c of chunks) {
        const loc = c.startLine ? ` (L${c.startLine}${c.endLine ? `-${c.endLine}` : ""})` : "";
        lines.push(`[${c.path}${loc}]`);
        const preview = c.text.slice(0, 400).split("\n").map(l => "  " + l).join("\n");
        lines.push(preview);
        if (c.text.length > 400) lines.push("  ...");
        lines.push("");
      }
      return lines.join("\n");
    } catch (err) {
      this.opts.logger.warn("Memory search failed", { error: String(err) });
      return undefined;
    }
  }

  /**
   * Build a composite knowledge query from the last user message, recent assistant
   * message, and recent tool results (especially errors). This gives the memory
   * search richer context than the user message alone.
   */
  private buildKnowledgeQuery(turns: ConversationTurn[]): string {
    const parts: string[] = [];

    const userTurns = turns.filter(t => t.role === "user");
    const lastUser = userTurns[userTurns.length - 1];
    if (lastUser) {
      parts.push(lastUser.content);
    }

    // Include recent assistant content for context
    const lastAssistant = [...turns].reverse().find(t => t.role === "assistant");
    if (lastAssistant?.content) {
      parts.push(lastAssistant.content);
    }

    // Include recent tool results, especially errors
    const recentToolTurns = turns.filter(t => t.role === "tool").slice(-2);
    for (const tt of recentToolTurns) {
      if (tt.content && (
        tt.content.includes("Error:") ||
        tt.content.includes("not found") ||
        tt.content.includes("failed") ||
        tt.content.includes("cannot")
      )) {
        parts.push(tt.content.slice(0, 200));
      }
    }

    return parts.join("\n").slice(0, 300);
  }

  private buildWorkingSet(turns: ConversationTurn[], sessionId: SessionId): string | undefined {
    const lines: string[] = [];

    // Session working set (recent files)
    const ws = this.workingSets.get(sessionId);
    if (ws && ws.files.length > 0) {
      lines.push("=== WORKING SET ===");
      lines.push("");
      lines.push("Recently accessed files (most recent first):");
      for (const f of ws.files.slice(0, 10)) {
        lines.push(`  �?${f}`);
      }
      if (ws.task) {
        lines.push("");
        lines.push(`Active task: ${ws.task}`);
      }
      lines.push("");
    }

    // Contextual hints based on conversation history
    // totalToolCallRounds is tracked in session metadata, but we don't have easy
    // access to metadata here without async store call. We approximate from turns
    // plus any hint that the compactor may have preserved.
    const totalRounds = turns.filter(t => t.role === "assistant" && t.toolCalls && t.toolCalls.length > 0).length;
    const hints = this.buildContextualHints(turns, totalRounds);
    if (hints) {
      if (lines.length === 0) {
        lines.push(hints);
      } else {
        // Merge hints into working set section
        lines.push(hints);
      }
    }

    return lines.length > 0 ? lines.join("\n") : undefined;
  }

  private updateWorkingSet(sessionId: SessionId, path: string): void {
    let ws = this.workingSets.get(sessionId);
    if (!ws) {
      ws = { files: [] };
      this.workingSets.set(sessionId, ws);
    }
    // Move to front, dedupe
    ws.files = ws.files.filter(f => f !== path);
    ws.files.unshift(path);
    // Keep last 20
    if (ws.files.length > 20) {
      ws.files = ws.files.slice(0, 20);
    }
  }

  // ─── Nudge Engine (Learning Loop Triggers) ──────────────────────────────────

  /**
   * Update nudge counters after each tool iteration.
   * If the agent proactively used user_memory or skill_manage tools,
   * reset the corresponding counter (no need to nudge).
   */
  private updateNudgeCounters(sessionId: SessionId, turns: ConversationTurn[]): void {
    const nudge = this.getOrCreateNudgeState(sessionId);
    nudge.toolItersSinceSkillNudge++;

    const lastAssistant = [...turns].reverse().find(t => t.role === "assistant" && t.toolCalls && t.toolCalls.length > 0);
    if (!lastAssistant?.toolCalls) return;

    const toolNames = new Set(lastAssistant.toolCalls.map(tc => tc.name));
    if (toolNames.has("user_memory")) {
      nudge.turnsSinceMemoryNudge = 0;
      this.opts.logger.debug("Nudge: memory tool used, counter reset", { sessionId });
    }
    if (toolNames.has("skill_manage")) {
      nudge.toolItersSinceSkillNudge = 0;
      this.opts.logger.debug("Nudge: skill tool used, counter reset", { sessionId });
    }
  }

  /**
   * Build a gentle nudge message if counters exceed thresholds.
   * Injected into the dynamic system prompt to remind the agent
   * to persist knowledge without being pushy.
   */
  private buildNudgeSection(sessionId: SessionId): string | undefined {
    const nudge = this.nudgeStates.get(sessionId);
    if (!nudge) return undefined;

    const lines: string[] = [];
    const mem = nudge.turnsSinceMemoryNudge >= nudge.memoryNudgeInterval;
    const skill = nudge.toolItersSinceSkillNudge >= nudge.skillNudgeInterval;

    if (mem && this.opts.tools.get("user_memory")) {
      lines.push("💡 You have used many turns without saving anything to memory. If you learned something important about the user or project, consider calling `user_memory` with action='add'.");
    }
    if (skill && this.opts.tools.get("skill_manage")) {
      lines.push("💡 You have completed many tool iterations without creating a skill. If this workflow is reusable, consider calling `skill_manage` with action='create'.");
    }

    if (lines.length === 0) return undefined;
    return ["=== NUDGE ===", "", ...lines].join("\n");
  }

  private getOrCreateNudgeState(sessionId: SessionId): NudgeState {
    let state = this.nudgeStates.get(sessionId);
    if (!state) {
      state = {
        turnsSinceMemoryNudge: 0,
        toolItersSinceSkillNudge: 0,
        ...this.defaultNudgeConfig,
      };
      this.nudgeStates.set(sessionId, state);
    }
    return state;
  }

  /** Clean up memory for a deleted session. Call when session is explicitly deleted. */
  cleanupSession(sessionId: SessionId): void {
    this.workingSets.delete(sessionId);
    this.nudgeStates.delete(sessionId);
    this.contextEngine.cleanupSession?.(sessionId);
  }

  // ─── Planning-Only Detection & Correction ───────────────────────────────────

  /**
   * Structured detection: no regex, works for any language.
   * Returns true if the assistant described a plan without taking action
   * on an actionable user request.
   */
  private detectPlanningOnly(response: ILLMResponse, turns: ConversationTurn[]): boolean {
    // 1. Has real tool calls (not just think/update_plan)? �?NOT planning-only
    const realToolCalls = (response.toolCalls ?? []).filter(
      tc => tc.name !== "think" && tc.name !== "update_plan"
    );
    if (realToolCalls.length > 0) return false;

    // 2. Find last user message
    const lastUser = [...turns].reverse().find(t => t.role === "user");
    if (!lastUser) return false;

    // 3. Is the user request actionable (requires tools)?
    if (!this.isActionableRequest(lastUser.content)) return false;

    // 4. Has the assistant already taken real action in this session?
    //    If so, a text-only response is likely a summary, not planning-only.
    const hasTakenAction = turns.some(
      t => t.role === "assistant" && t.toolCalls?.some(
        tc => tc.name !== "think" && tc.name !== "update_plan"
      )
    );
    if (hasTakenAction) return false;

    // 5. Assistant has text but no real tool calls on an actionable request �?planning-only
    return true;
  }

  /** Heuristic: does this user request require tools to fulfill? */
  private isActionableRequest(text: string): boolean {
    const lower = text.toLowerCase();
    // If it looks like casual chat or general knowledge �?NOT actionable
    const casualIndicators = [
      "what is", "what are", "how does", "why is", "explain", "tell me about",
      "hello", "hi ", "thanks", "thank you", "goodbye", "bye",
    ];
    if (casualIndicators.some(ind => lower.includes(ind))) {
      // But some casual-looking requests are actually actionable (e.g. "explain how to fix X")
      // So we also check for explicit action verbs
    }

    const actionVerbs = [
      "fix", "refactor", "implement", "create", "add", "update", "change",
      "write", "edit", "debug", "test", "run", "search", "find", "read",
      "migrate", "rewrite", "restructure", "integrate", "deploy",
      "check", "look into", "investigate", "analyze", "review",
      "delete", "remove", "rename", "move", "copy",
      "install", "configure", "set up", "build", "compile",
      "generate", "convert", "format", "lint", "verify",
    ];
    return actionVerbs.some(v => lower.includes(v));
  }

  private buildPlanningOnlySteer(): string {
    return [
      "[SYSTEM CORRECTION]",
      "",
      "Your previous turn only described what you would do, but you did not call any tools.",
      "The user's request requires action, not a plan.",
      "",
      "DO NOT:",
      "- Restate or summarize the plan",
      "- Say 'I will do X' �?just do X",
      "- Ask for confirmation on obvious next steps",
      "",
      "DO:",
      "- Call the FIRST tool immediately in this turn",
      "- If the task needs files: start reading",
      "- If the task needs edits: make the edit",
      "- If you are genuinely blocked: state the blocker in ONE sentence",
      "",
      "Act now.",
    ].join("\n");
  }

  private async runToolHook(
    phase: "beforeExecute" | "afterExecute",
    call: ToolCall,
    sessionId: string,
    result?: ToolResult,
  ): Promise<void> {
    if (!this.opts.toolHooks) return;
    try {
      if (phase === "beforeExecute" && this.opts.toolHooks.beforeExecute) {
        await this.opts.toolHooks.beforeExecute({ call, sessionId });
      } else if (phase === "afterExecute" && this.opts.toolHooks.afterExecute) {
        await this.opts.toolHooks.afterExecute({ call, result, sessionId });
      }
    } catch (err) {
      this.opts.logger.warn("Tool hook failed", { phase, tool: call.name, error: String(err) });
    }
  }

  private buildTimeSection(): string | undefined {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!tz) return undefined;
      return [
        "=== CURRENT DATE & TIME ===",
        "",
        `Time zone: ${tz}`,
        "The exact current time is injected at the start of each new user message.",
        "",
      ].join("\n");
    } catch {
      return undefined;
    }
  }

  private injectTimestamp(message: string): string {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const now = new Date();
      const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(now);
      const date = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz }).format(now);
      const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(now);
      return `[${weekday} ${date} ${time} ${tz}] ${message}`;
    } catch {
      return message;
    }
  }

  private buildFormattingRules(): string {
    return [
      "=== RESPONSE FORMAT ===",
      "",
      "- Use tools to take action. Do not just describe what you would do.",
      "- After each tool result, analyze the output and decide the next step.",
      "- When you have completed the task, respond with a concise summary.",
      "- If no tool calls are needed, answer directly in natural language.",
    ].join("\n");
  }

  /**
   * Remove orphan tool results that have no matching assistant toolCalls.
   * This prevents model confusion when compaction or bugs leave dangling results.
   */
  private repairToolPairing(turns: ConversationTurn[]): ConversationTurn[] {
    const validToolCallIds = new Set<string>();
    for (const t of turns) {
      if (t.role === "assistant" && t.toolCalls) {
        for (const tc of t.toolCalls) {
          validToolCallIds.add(tc.id);
        }
      }
    }

    return turns.filter((t) => {
      if (t.role !== "tool") return true;
      return validToolCallIds.has(t.toolCallId ?? t.id);
    });
  }

  // ─── Plan Mode ───────────────────────────────────────────────────────────────

  private shouldUsePlan(toolCalls: ToolCall[], iteration: number, sessionId: SessionId): boolean {
    // ask_user_question requires serial blocking interaction
    if (toolCalls.some((c) => c.name === "ask_user_question")) return false;

    const mode = this.opts.config.planMode ?? "auto";
    if (mode === "off") return false;
    if (mode === "always") return true;

    // auto: activate for multi-tool scenarios
    if (toolCalls.length >= 2) return true;

    // Also auto-activate on first iteration if complexity is high
    if (iteration === 0 && toolCalls.length > 0) {
      const ws = this.workingSets.get(sessionId);
      const hasActiveTask = ws && (ws.task || ws.files.length > 0);
      if (hasActiveTask) return true;
    }

    return false;
  }

  private buildPlanFromToolCalls(toolCalls: ToolCall[]): Plan {
    return {
      version: 1,
      steps: toolCalls.map((tc) => ({
        id: tc.id,
        tool: tc.name,
        args: tc.arguments as Record<string, unknown>,
      })),
    };
  }

  private async executePlan(toolCalls: ToolCall[], sessionId: SessionId): Promise<ExecutionResult> {
    const plan = this.buildPlanFromToolCalls(toolCalls);

    // Register default hooks
    const hooks = new HookRegistry();

    // Pre-execute: user-defined before hooks
    hooks.register("preExecute", async (ctx) => {
      if (this.opts.toolHooks?.beforeExecute) {
        await this.opts.toolHooks.beforeExecute({
          call: { id: ctx.step.id, name: ctx.step.tool, arguments: ctx.step.args as Record<string, unknown> },
          sessionId,
        });
      }
    });

    // Post-execute: user-defined after hooks (before working-set tracking)
    hooks.register("postExecute", async (ctx) => {
      if (this.opts.toolHooks?.afterExecute && ctx.result) {
        await this.opts.toolHooks.afterExecute({
          call: { id: ctx.step.id, name: ctx.step.tool, arguments: ctx.step.args as Record<string, unknown> },
          result: { callId: ctx.step.id, output: ctx.result.output, isError: ctx.result.isError },
          sessionId,
        });
      }
    });

    // Post-execute: working set tracking + truncation hint
    hooks.register("postExecute", (ctx) => {
      const args = ctx.step.args as Record<string, unknown>;
      if (args && typeof args.path === "string") {
        this.updateWorkingSet(sessionId, args.path);
      }
    });

    this.replanPolicy.reset();
    const result = await this.planExecutor.execute(plan, this.opts.tools, hooks, { sessionId });

    // Check replan policy
    if (!result.success) {
      for (const [stepId, node] of result.dag.getAllNodes()) {
        if (node.status === "failed") {
          const trigger = this.replanPolicy.shouldReplan(node, result.dag);
          if (trigger) {
            this.opts.logger.warn("Plan step failed, replan triggered", {
              stepId,
              reason: trigger.reason,
            });
            // Replanning: request new plan from LLM with partial results
            // For now, we just log and continue; the model will see the failure
            // in the next iteration and can adjust its strategy.
          }
        }
      }
    }

    return result;
  }

  /** Public API for Gateway to submit a user answer to a pending question. */
  answerQuestion(questionId: string, answer: string): void {
    const resolve = this.questionResolvers.get(questionId);
    if (resolve) {
      resolve(answer);
    } else {
      this.opts.logger.warn("answerQuestion called for unknown questionId", { questionId });
    }
  }

}

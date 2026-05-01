/**
 * SimpleClaw Core — Context Compactor
 * Summarizes old conversation turns when context approaches token limits.
 *
 * Design inspired by Claude Code's three-tier compaction:
 *   Tier 1: Microcompact — replace old tool results with placeholders,
 *           strip reasoning, truncate attachments. No LLM call.
 *   Tier 2: Anchored Summary — extract key facts first, then ask LLM
 *           to summarize while preserving anchored constraints/decisions.
 *   Tier 3: (not yet) Session-memory substitution.
 */

import type { ILLMClient, ILogger, IToolSchema } from "./interfaces.js";
import type { ConversationTurn } from "./types.js";

export interface CompactorConfig {
  thresholdTokens?: number;   // absolute token threshold (legacy)
  thresholdPercent?: number;  // 0.0-1.0, percentage of model context window
  preserveTurns: number;      // keep N most recent turns intact
  summaryMaxLength: number;   // max chars for the summary text
  /** Enable hierarchical compaction: older summaries get further compressed */
  hierarchical?: boolean;
  /** Max levels of hierarchical compression (default: 3) */
  maxHierarchyLevels?: number;
}

export const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  thresholdPercent: 0.75,  // compact when context reaches 75% of window
  preserveTurns: 4,
  summaryMaxLength: 4000,
  hierarchical: true,
  maxHierarchyLevels: 3,
};

/** Hierarchical summary entry — older summaries get compressed further */
interface HierarchicalSummary {
  level: number;
  summary: string;
  turnCount: number;
  createdAt: number;
}

/** Safety margin multiplier for token estimates (OpenClaw pattern) */
const SAFETY_MARGIN = 1.2;
/** Characters per token heuristic (conservative) */
const CHARS_PER_TOKEN = 4;
/** Tool results longer than this are candidates for truncation */
const TOOL_TRUNCATE_THRESHOLD = 2000;
/** Target length after truncation */
const TOOL_TRUNCATE_TARGET = 500;
/** Old tool results longer than this are replaced with placeholders */
const TOOL_CLEAR_THRESHOLD = 800;
/** Old reasoning longer than this is stripped */
const REASONING_CLEAR_THRESHOLD = 600;

interface AnchoredFacts {
  constraints: string[];
  modifiedFiles: string[];
  keyErrors: string[];
  pendingTodos: string[];
}

export interface CompactOptions {
  systemPromptText?: string;
  toolSchemas?: IToolSchema[];
  contextWindow?: number;
  sessionId?: string;
  memory?: import("./interfaces.js").IMemoryIndex;
}

export class ContextCompactor {
  /** Tracks estimated vs actual prompt tokens to calibrate our heuristic. */
  private tokenCalibration = {
    totalEstimated: 0,
    totalActual: 0,
    ratio: 1.0,
  };

  /** Session-level hierarchical summaries for Decaying Resolution Memory */
  private sessionSummaries = new Map<string, HierarchicalSummary[]>();

  constructor(
    private llm: ILLMClient,
    private logger: ILogger,
  ) {}

  /**
   * Record actual token usage from an LLM call to calibrate future estimates.
   * Call this after every LLM.complete() that returns usage data.
   */
  recordUsage(
    actualPromptTokens: number,
    turns: ConversationTurn[],
    options?: Pick<CompactOptions, "systemPromptText" | "toolSchemas">,
  ): void {
    const estimated = this.estimateTokens(turns, options);
    this.tokenCalibration.totalEstimated += estimated;
    this.tokenCalibration.totalActual += actualPromptTokens;

    // Only start calibrating after we have a reasonable sample (>1000 estimated tokens)
    if (this.tokenCalibration.totalEstimated > 1000) {
      const empiricalRatio = this.tokenCalibration.totalActual / this.tokenCalibration.totalEstimated;
      const oldRatio = this.tokenCalibration.ratio;
      // Smooth update with exponential moving average (alpha = 0.3)
      this.tokenCalibration.ratio = oldRatio * 0.7 + empiricalRatio * 0.3;
      this.logger.debug("Token calibration updated", {
        previousRatio: oldRatio.toFixed(2),
        newRatio: this.tokenCalibration.ratio.toFixed(2),
        empiricalRatio: empiricalRatio.toFixed(2),
        totalEstimated: this.tokenCalibration.totalEstimated,
        totalActual: this.tokenCalibration.totalActual,
      });
    }
  }

  /**
   * If context is too long, summarize old turns and return compacted history.
   * Supports hierarchical compaction: older summaries get further compressed.
   * The original turns array is NOT modified — this returns a new array for message building.
   */
  async compact(
    turns: ConversationTurn[],
    config: CompactorConfig = DEFAULT_COMPACTOR_CONFIG,
    options?: CompactOptions & { sessionId?: string },
  ): Promise<{ compacted: ConversationTurn[]; didCompact: boolean; summary: string | null }> {
    const threshold = this.resolveThreshold(config, options?.contextWindow);
    const estimate = this.estimateTokens(turns, options);

    if (estimate < threshold || turns.length <= config.preserveTurns) {
      return { compacted: turns, didCompact: false, summary: null };
    }

    this.logger.info("Context compaction triggered", {
      totalTurns: turns.length,
      estimatedTokens: estimate,
      threshold,
      contextWindow: options?.contextWindow,
      calibrationRatio: this.tokenCalibration.ratio.toFixed(2),
    });

    // ─── Stage 1: Truncate oversized tool results ─────────────────────────────
    let workingTurns = this.truncateOversizedToolResults(turns);
    let workingEstimate = this.estimateTokens(workingTurns, options);

    if (workingEstimate < threshold) {
      this.logger.info("Context compaction resolved by truncation", {
        beforeTokens: estimate,
        afterTokens: workingEstimate,
      });
      return { compacted: workingTurns, didCompact: true, summary: null };
    }

    // ─── Stage 2: Microcompact — clear old noise without LLM ──────────────────
    workingTurns = this.microcompact(workingTurns, config.preserveTurns);
    workingEstimate = this.estimateTokens(workingTurns, options);

    if (workingEstimate < threshold) {
      this.logger.info("Context compaction resolved by microcompact", {
        beforeTokens: estimate,
        afterTokens: workingEstimate,
      });
      return { compacted: workingTurns, didCompact: true, summary: null };
    }

    // ─── Stage 2.5: Archive original turns before lossy compression ──────────
    const split = this.splitRespectingToolPairs(workingTurns, config.preserveTurns);
    if (split.toSummarize.length > 0 && options?.sessionId && options?.memory) {
      try {
        await options.memory.archiveTurns(options.sessionId, split.toSummarize);
        this.logger.info("Turns archived before compaction", { sessionId: options.sessionId, count: split.toSummarize.length });
      } catch (err) {
        this.logger.warn("Failed to archive turns", { error: String(err) });
      }
    }

    // ─── Stage 3: Hierarchical compaction (Decaying Resolution Memory) ────────
    if (config.hierarchical && options?.sessionId) {
      const hierarchicalResult = await this.hierarchicalCompact(
        workingTurns, config, options.sessionId, options
      );
      if (hierarchicalResult) {
        return hierarchicalResult;
      }
    }

    // ─── Stage 4: Anchored LLM summary (fallback) ─────────────────────────────
    this.logger.info("Context compaction splitting", {
      preserved: split.preserved.length,
      toSummarize: split.toSummarize.length,
    });

    if (split.toSummarize.length === 0) {
      // All turns preserved (groups too large to split); no actual compression occurred
      return { compacted: split.preserved, didCompact: false, summary: null };
    }

    const anchored = this.extractAnchoredFacts(split.toSummarize);
    const summary = await this.summarize(split.toSummarize, anchored, config.summaryMaxLength);

    // Store summary for future hierarchical compression
    if (options?.sessionId) {
      this.storeSummary(options.sessionId, summary, split.toSummarize.length);
    }

    return { compacted: split.preserved, didCompact: true, summary };
  }

  /**
   * Hierarchical compaction: apply Decaying Resolution Memory.
   * Older summaries get compressed into higher-level summaries.
   * Level 0 = recent turns (preserved intact)
   * Level 1 = first compression (detailed summary)
   * Level 2+ = further compression of previous summaries
   */
  private async hierarchicalCompact(
    turns: ConversationTurn[],
    config: CompactorConfig,
    sessionId: string,
    options?: CompactOptions,
  ): Promise<{ compacted: ConversationTurn[]; didCompact: boolean; summary: string | null } | null> {
    const summaries = this.sessionSummaries.get(sessionId) ?? [];
    const maxLevels = config.maxHierarchyLevels ?? 3;
    void options; // reserved for future token-aware hierarchical decisions

    if (summaries.length >= maxLevels) {
      // Deep compression: compress the oldest summary even further
      const oldest = summaries[0];
      const compressed = await this.compressSummary(oldest.summary, oldest.level + 1);
      summaries.shift(); // remove oldest
      summaries.unshift({
        level: oldest.level + 1,
        summary: compressed,
        turnCount: oldest.turnCount,
        createdAt: Date.now(),
      });
      this.sessionSummaries.set(sessionId, summaries.slice(0, maxLevels));
    }

    // Build the hierarchical summary text
    const hierarchyParts: string[] = [];
    for (let i = summaries.length - 1; i >= 0; i--) {
      const s = summaries[i];
      const age = s.level === 0 ? "Recent" : s.level === 1 ? "Earlier" : `Level-${s.level}`;
      hierarchyParts.push(`=== ${age} WORK SUMMARY (${s.turnCount} turns) ===\n${s.summary}`);
    }

    // Split: preserve recent, summarize middle
    const { preserved, toSummarize } = this.splitRespectingToolPairs(turns, config.preserveTurns);

    if (toSummarize.length === 0) {
      // No new turns to summarize; only historical summaries exist
      const historicalSummary = hierarchyParts.join("\n\n") || null;
      return { compacted: preserved, didCompact: historicalSummary !== null, summary: historicalSummary };
    }

    const anchored = this.extractAnchoredFacts(toSummarize);
    const newSummary = await this.summarize(toSummarize, anchored, config.summaryMaxLength);

    // Store as level-0 summary
    this.storeSummary(sessionId, newSummary, toSummarize.length);

    const fullSummary = [...hierarchyParts, newSummary].join("\n\n");
    return { compacted: preserved, didCompact: true, summary: fullSummary };
  }

  private storeSummary(sessionId: string, summary: string, turnCount: number): void {
    const summaries = this.sessionSummaries.get(sessionId) ?? [];
    summaries.push({
      level: 0,
      summary,
      turnCount,
      createdAt: Date.now(),
    });
    const maxLevels = DEFAULT_COMPACTOR_CONFIG.maxHierarchyLevels ?? 3;
    this.sessionSummaries.set(sessionId, summaries.slice(-maxLevels));
  }

  /** Remove session data to prevent memory leaks. */
  cleanupSession(sessionId: string): void {
    this.sessionSummaries.delete(sessionId);
  }

  private async compressSummary(summary: string, level: number): Promise<string> {
    const prompt = `Compress this session summary into an even shorter form (Level-${level} compression).
Retain only: the goal, key decisions, file paths, and blockers. Remove implementation details and reasoning chains.

Summary to compress:
${summary.slice(0, 3000)}

Output a terse bullet list. Max 800 chars.`;

    try {
      const response = await this.llm.complete([
        { role: "system", content: "You are a context compression assistant. Be extremely terse." },
        { role: "user", content: prompt },
      ]);
      return response.text.slice(0, 800).trim();
    } catch {
      return `[Level-${level} summary: ${summary.slice(0, 400)}...]`;
    }
  }

  /**
   * Resolve the effective threshold from config.
   * Priority: thresholdTokens > thresholdPercent * contextWindow > contextWindow * 0.6 > 6000
   *
   * With the default thresholdPercent (0.75), compaction triggers when the
   * estimated context size reaches 75% of the model's context window. This
   * leaves headroom for the model's response tokens (maxTokens) and any
   * estimation inaccuracy from our character-based heuristic.
   */
  private resolveThreshold(config: CompactorConfig, contextWindow?: number): number {
    if (config.thresholdTokens) {
      return config.thresholdTokens;
    }
    if (config.thresholdPercent && contextWindow && contextWindow > 0) {
      return Math.max(1, Math.floor(contextWindow * config.thresholdPercent));
    }
    if (contextWindow && contextWindow > 0) {
      return Math.max(1, Math.floor(contextWindow * 0.6));
    }
    return 6000;
  }

  /** Rough token estimate with safety margin, tool schemas, and calibration. */
  private estimateTokens(turns: ConversationTurn[], options?: CompactOptions): number {
    let chars = 0;

    if (options?.systemPromptText) {
      chars += options.systemPromptText.length;
    }

    // Tool schemas are a major token consumer (often 500-2000 tokens)
    if (options?.toolSchemas) {
      for (const schema of options.toolSchemas) {
        chars += JSON.stringify(schema).length;
      }
    }

    for (const t of turns) {
      chars += t.content.length;
      if (t.reasoning) {
        chars += t.reasoning.length;
      }
      if (t.toolCalls) {
        for (const tc of t.toolCalls) {
          chars += JSON.stringify(tc).length;
        }
      }
      // Per-message JSON overhead (role, content key, formatting)
      chars += 20;
    }

    let estimate = Math.ceil((chars / CHARS_PER_TOKEN) * SAFETY_MARGIN);

    if (this.tokenCalibration.ratio > 0) {
      estimate = Math.ceil(estimate * this.tokenCalibration.ratio);
    }

    return estimate;
  }

  /**
   * Truncate oversized tool results in-place to reduce token count cheaply.
   */
  private truncateOversizedToolResults(turns: ConversationTurn[]): ConversationTurn[] {
    return turns.map((t) => {
      if (t.role !== "tool" || t.content.length <= TOOL_TRUNCATE_THRESHOLD) {
        return t;
      }
      const truncated = t.content.slice(0, TOOL_TRUNCATE_TARGET) +
        "\n\n[...truncated: output was " + t.content.length + " chars, trimmed to " + TOOL_TRUNCATE_TARGET + " chars...]";
      return { ...t, content: truncated };
    });
  }

  /**
   * Microcompact: replace old tool results with placeholders and strip old reasoning.
   */
  private microcompact(turns: ConversationTurn[], preserveTurns: number): ConversationTurn[] {
    const cutoffIndex = Math.max(0, turns.length - preserveTurns);
    return turns.map((t, idx) => {
      if (idx >= cutoffIndex) return t;

      if (t.role === "tool" && t.content.length > TOOL_CLEAR_THRESHOLD) {
        return {
          ...t,
          content: `[Previous ${t.toolCallId ? "tool result" : "output"} cleared: ${t.content.length} chars. Re-run the tool if needed.]`,
        };
      }

      if (t.role === "assistant" && t.reasoning && t.reasoning.length > REASONING_CLEAR_THRESHOLD) {
        return {
          ...t,
          reasoning: "[Reasoning chain cleared to save context. Previous conclusion still valid.]",
        };
      }

      return t;
    });
  }

  /**
   * Split turns into preserved (recent) and to-summarize (old), respecting
   * tool_use/tool_result pair boundaries.
   */
  private splitRespectingToolPairs(
    turns: ConversationTurn[],
    preserveTurns: number,
  ): { preserved: ConversationTurn[]; toSummarize: ConversationTurn[] } {
    const groups: ConversationTurn[][] = [];
    let currentGroup: ConversationTurn[] = [];

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      currentGroup.push(turn);

      if (turn.role === "assistant" && turn.toolCalls && turn.toolCalls.length > 0) {
        const callIds = new Set(turn.toolCalls.map((tc) => tc.id));
        let j = i + 1;
        while (j < turns.length && turns[j].role === "tool" && callIds.has(turns[j].toolCallId ?? "")) {
          currentGroup.push(turns[j]);
          j++;
        }
        i = j - 1;
      }

      groups.push(currentGroup);
      currentGroup = [];
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    let preservedTurnCount = 0;
    let splitIndex = groups.length;

    for (let g = groups.length - 1; g >= 0; g--) {
      preservedTurnCount += groups[g].length;
      if (preservedTurnCount >= preserveTurns) {
        splitIndex = g;
        break;
      }
    }

    const preserved = groups.slice(splitIndex).flat();
    const toSummarize = groups.slice(0, splitIndex).flat();
    return { preserved, toSummarize };
  }

  private extractAnchoredFacts(turns: ConversationTurn[]): AnchoredFacts {
    const constraints: string[] = [];
    const modifiedFiles: string[] = [];
    const keyErrors: string[] = [];
    const pendingTodos: string[] = [];

    for (const t of turns) {
      if (t.role === "user") {
        const sentences = t.content.split(/[.!?。！？\n]/);
        for (const raw of sentences) {
          const s = raw.trim();
          if (s.length < 5) continue;
          const lower = s.toLowerCase();
          if (
            /\b(must|should|never|always|use|prefer|required|forbidden|only|avoid)\b/.test(lower) ||
            /\b(don't|do not|must not|need to|has to|important|critical)\b/.test(lower)
          ) {
            constraints.push(s);
          }
        }
      }

      if (t.role === "tool" && t.content) {
        const editMatch = t.content.match(/Edited\s+([\w/.\\-]+)/i);
        if (editMatch) {
          modifiedFiles.push(editMatch[1]);
        }

        const readMatch = t.content.match(/\[File:\s+([\w/.\\-]+)/i);
        if (readMatch) {
          modifiedFiles.push(readMatch[1]);
        }

        if (readMatch && t.content.length < 600) {
          const contentLines = t.content.split("\n").slice(1);
          const body = contentLines
            .filter((l) => !l.includes("more lines. Use offset="))
            .map((l) => l.replace(/^\s*\d+\s*\|\s*/, ""))
            .join(" ")
            .trim();
          if (body.length > 0 && body.length < 300) {
            constraints.push(`File "${readMatch[1]}" contains: ${body.slice(0, 200)}`);
          }
        }

        if (t.content.includes("Error:") || t.content.includes("Assertion failed") || t.content.includes("FAIL")) {
          const firstLine = t.content.split("\n")[0].slice(0, 200);
          keyErrors.push(firstLine);
        }
      }

      if (t.role === "assistant" && t.content) {
        const todoMatches = t.content.match(/TODO[:\s]+([^\n]+)/gi);
        if (todoMatches) {
          pendingTodos.push(...todoMatches.map((m) => m.trim()));
        }
      }
    }

    return {
      constraints: [...new Set(constraints)].slice(0, 6),
      modifiedFiles: [...new Set(modifiedFiles)].slice(0, 10),
      keyErrors: [...new Set(keyErrors)].slice(0, 4),
      pendingTodos: [...new Set(pendingTodos)].slice(0, 6),
    };
  }

  private async summarize(
    turns: ConversationTurn[],
    anchored: AnchoredFacts,
    maxLength: number,
  ): Promise<string> {
    const history = turns
      .map((t) => {
        const prefix =
          t.role === "user"
            ? "User"
            : t.role === "assistant"
              ? "Assistant"
              : "Tool";
        const body = t.content.slice(0, 300) + (t.content.length > 300 ? "..." : "");
        return `${prefix}: ${body}`;
      })
      .join("\n\n");

    const anchoredLines: string[] = [];
    if (anchored.constraints.length > 0) {
      anchoredLines.push("Constraints you MUST preserve:");
      for (const c of anchored.constraints) anchoredLines.push(`  - ${c}`);
    }
    if (anchored.modifiedFiles.length > 0) {
      anchoredLines.push("Files modified or read:");
      for (const f of anchored.modifiedFiles) anchoredLines.push(`  - ${f}`);
    }
    if (anchored.keyErrors.length > 0) {
      anchoredLines.push("Errors encountered:");
      for (const e of anchored.keyErrors) anchoredLines.push(`  - ${e}`);
    }
    if (anchored.pendingTodos.length > 0) {
      anchoredLines.push("Pending TODOs:");
      for (const td of anchored.pendingTodos) anchoredLines.push(`  - ${td}`);
    }

    const anchoredText = anchoredLines.length > 0
      ? anchoredLines.join("\n")
      : "(none)";

    const STRUCTURED_SUMMARY_TEMPLATE = `You are performing a CONTEXT CHECKPOINT COMPACTION for a coding session.
Create a handoff summary that another LLM can use to seamlessly continue the work.

The following ANCHORED FACTS were extracted from the conversation.
You MUST include every anchored fact in the appropriate section of your summary.
Do NOT rephrase constraints, file paths, or error messages — quote them verbatim.

ANCHORED FACTS:
${anchoredText}

Conversation history:
${history}

Output exactly this Markdown structure and keep the section order unchanged:

## Goal & Constraints
- [single-sentence task summary]
- [anchored constraints, quoted verbatim]

## Progress
- Done: [completed work or "(none)"]
- In Progress: [current work or "(none)"]
- Blocked: [blockers or "(none)"]

## Key Decisions & Context
- [decisions and why, or "(none)"]
- [errors and fixes — quote exact messages, or "(none)"]
- [important technical facts — quote exact identifiers, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Relevant Files
- [file path: why it matters, or "(none)"]

Rules:
- Keep every section, even when empty (write "(none)").
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.
- Respond in the same language as the conversation.`;

    const response = await this.llm.complete([
      {
        role: "system",
        content: STRUCTURED_SUMMARY_TEMPLATE,
      },
      { role: "user", content: "Generate the compaction summary." },
    ]);

    return response.text.slice(0, maxLength).trim();
  }
}

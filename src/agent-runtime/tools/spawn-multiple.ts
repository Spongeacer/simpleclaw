/**
 * SimpleClaw — Spawn Multiple Tool
 * Launches multiple sub-agents in parallel for breadth-first problems.
 *
 * Workflow patterns:
 *   - Split-and-Merge: Break a large task into independent chunks,
 *     run sub-agents in parallel, merge results.
 *   - Multi-dimension evaluation: Run different evaluators concurrently
 *     (safety, style, correctness) and collect all scores.
 *
 * Anthropic insight: Multi-agent systems use ~15x more tokens than chats.
 * Use this only when parallel execution provides measurable benefit.
 */

import type { ITool, ILogger } from "../../core/interfaces.js";
import type { AgentPool } from "../agent-pool.js";

export function createSpawnMultipleTool(pool: AgentPool, logger: ILogger): ITool {
  return {
    name: "spawn_multiple",
    description:
      "Launch multiple sub-agents in PARALLEL to handle independent sub-tasks simultaneously. " +
      "Each sub-agent gets its own isolated session and context. " +
      "When all complete, their results are merged into a single summary.\n\n" +
      "When to use:\n" +
      "- Exploring multiple independent paths (e.g. 'find all usages of X', 'find all usages of Y')\n" +
      "- Multi-dimension evaluation (e.g. security audit + performance audit + style audit)\n" +
      "- Bulk operations on independent items (e.g. document 50 functions in batches)\n" +
      "- Research tasks where breadth-first exploration beats depth-first\n\n" +
      "When NOT to use:\n" +
      "- If sub-tasks have dependencies (use sequential `spawn` instead)\n" +
      "- If the task is simple enough for a single agent call\n" +
      "- If token cost is a concern (parallel agents use more tokens)\n\n" +
      "Best practices:\n" +
      "- Keep each sub-task self-contained with explicit expected output\n" +
      "- Use the same role for all sub-agents unless different expertise is needed\n" +
      "- Limit to 4-8 concurrent sub-agents (default: 4)",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Short description of the overall parallel dispatch, e.g. 'Audit all API endpoints'",
        },
        tasks: {
          type: "array",
          description: "Array of independent sub-tasks. Each gets its own sub-agent.",
          items: {
            type: "object",
            properties: {
              description: {
                type: "string",
                description: "Short label for this sub-task (shown in merged results)",
              },
              task: {
                type: "string",
                description: "Detailed instructions for this sub-agent. Be explicit about expected output.",
              },
              role: {
                type: "string",
                description: "Role for this sub-agent: explore | coder | tester",
              },
              model: {
                type: "object",
                description: "Optional: override model for this sub-agent",
                properties: {
                  provider: { type: "string" },
                  model: { type: "string" },
                },
              },
              tools: {
                type: "array",
                items: { type: "string" },
                description: "Optional: explicit tool names for this sub-agent",
              },
              system_prompt: {
                type: "string",
                description: "Optional: custom system prompt for this sub-agent",
              },
            },
            required: ["task"],
          },
        },
        max_concurrency: {
          type: "number",
          description: "Max concurrent sub-agents (1-8, default: 4). Higher = faster but more tokens.",
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const description = args.description ? String(args.description) : undefined;
      const tasks = Array.isArray(args.tasks) ? args.tasks : [];
      const maxConcurrency = typeof args.max_concurrency === "number" ? args.max_concurrency : 4;

      if (tasks.length === 0) {
        return "Error: No tasks provided.";
      }
      if (tasks.length > 20) {
        return "Error: Too many tasks (max 20). Split into multiple spawn_multiple calls.";
      }

      logger.info("Spawn multiple invoked", {
        description,
        count: tasks.length,
        maxConcurrency,
      });

      const result = await pool.spawnMultiple({
        description,
        tasks: tasks.map((t: Record<string, unknown>) => ({
          description: t.description ? String(t.description) : undefined,
          task: String(t.task),
          role: t.role ? String(t.role) : undefined,
          model: t.model as { provider: string; model: string } | undefined,
          tools: Array.isArray(t.tools) ? t.tools.map(String) : undefined,
          systemPrompt: t.system_prompt ? String(t.system_prompt) : undefined,
        })),
        maxConcurrency: Math.min(Math.max(1, maxConcurrency), 8),
      });

      return result.mergedSummary;
    },
  };
}

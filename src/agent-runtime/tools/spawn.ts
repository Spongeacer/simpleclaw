/**
 * SimpleClaw — Spawn Tool
 * Creates a sub-agent to handle a specific task independently.
 * Inspired by OpenClaw's agent tool:
 *   - Supports pre-defined roles (explore/coder/tester) that restrict tool sets
 *   - Supports session resumption via sessionId
 *   - Sub-agents cannot spawn (recursion guard)
 *   - Returns structured XML with subagent_session_id
 */

import type { ITool, ILogger } from "../../core/interfaces.js";
import type { IAgentPool } from "../../core/interfaces.js";

export function createSpawnTool(pool: IAgentPool, logger: ILogger): ITool {
  return {
    name: "spawn",
    description:
      "Launch a sub-agent to handle complex, multi-step tasks autonomously. " +
      "The sub-agent runs with its own session and can use a different model, tool set, or system prompt. " +
      "When the sub-agent is done, it returns a single result back to you. " +
      "The output includes a subagent_session_id you can reuse later to continue the same dispatch.\n\n" +
      "When to use:\n" +
      "- Delegating a well-scoped sub-task (e.g. 'find all usages of function X')\n" +
      "- Running exploration with a read-only tool set via role='explore'\n" +
      "- Isolating risky or long-running operations\n\n" +
      "When NOT to use:\n" +
      "- If you want to read a specific file path, use the read tool instead\n" +
      "- If you want to edit a specific file, use the edit tool instead\n" +
      "- Other tasks that are not related to delegating work to another agent",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: 'A short (3-5 words) description of the sub-agent dispatch, e.g. "Find API usages"',
        },
        task: {
          type: "string",
          description: "Detailed description of what the sub-agent should do. Be explicit about what it should return.",
        },
        role: {
          type: "string",
          description: "Optional: pre-defined role that restricts the sub-agent's tool set. " +
            "explore = read/grep/ls/bash (read-only exploration). " +
            "coder = read/edit/grep/ls/bash/think (coding tasks). " +
            "tester = read/bash/grep/ls/think (running tests). " +
            "Default: inherits parent's tools (minus spawn).",
        },
        model: {
          type: "object",
          description: "Optional: override the model for this sub-agent. Example: { provider: 'openrouter', model: 'tencent/hy3-preview:free' }",
          additionalProperties: false,
          properties: {
            provider: { type: "string" },
            model: { type: "string" },
          },
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Optional: explicit tool names for the sub-agent. Ignored if role is set. Default: inherits parent's tools (minus spawn).",
        },
        system_prompt: {
          type: "string",
          description: "Optional: custom system prompt for the sub-agent",
        },
        session_id: {
          type: "string",
          description: "Optional: pass a previous sub-agent session ID to resume its conversation instead of starting fresh",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const task = String(args.task);
      const description = args.description ? String(args.description) : undefined;
      const role = args.role ? String(args.role) : undefined;
      const model = args.model as { provider: string; model: string } | undefined;
      const tools = Array.isArray(args.tools) ? args.tools.map(String) : undefined;
      const systemPrompt = args.system_prompt ? String(args.system_prompt) : undefined;
      const sessionId = args.session_id ? String(args.session_id) : undefined;

      logger.info("Spawn tool invoked", {
        description,
        task: task.slice(0, 100),
        role,
        model: model?.model,
        resumed: !!sessionId,
      });

      const result = await pool.spawn({ task, description, role, model, tools, systemPrompt, sessionId });
      return result.result;
    },
  };
}

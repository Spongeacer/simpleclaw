/**
 * SimpleClaw — Think Tool
 * A no-op tool that gives the LLM a dedicated step to reason before acting.
 * Inspired by Claude Code's thinking capability.
 */

import type { ITool } from "../../core/interfaces.js";

export function createThinkTool(): ITool {
  return {
    name: "think",
    description:
      "Use this tool to think through a problem before taking action. " +
      "Write out your reasoning, plan, or analysis. " +
      "This does not modify any files or execute any commands. " +
      "Use it when: (1) planning a complex multi-step edit, " +
      "(2) analyzing error output, (3) deciding between alternatives.",
    parameters: {
      type: "object",
      properties: {
        thought: {
          type: "string",
          description: "Your detailed reasoning, plan, or analysis",
        },
      },
      required: ["thought"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const thought = String(args.thought);
      return `Thought recorded (${thought.length} chars).`;
    },
  };
}

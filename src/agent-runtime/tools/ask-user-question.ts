/**
 * SimpleClaw — AskUserQuestion Tool
 *
 * This tool is INTERCEPTED by AgentEngine and never executed through the
 * normal ToolRegistry path.  The schema is registered so the LLM knows it
 * exists, but the real implementation lives inside AgentEngine which yields
 * a `question` event and blocks until the user answers via the UI.
 */

import type { ITool } from "../../core/interfaces.js";

export function createAskUserQuestionTool(): ITool {
  return {
    name: "ask_user_question",
    description:
      "Ask the user one or more structured questions when you need clarification, " +
      "need to choose between multiple valid approaches, or need to confirm an action. " +
      "This will pause execution until the user responds. " +
      "Supports 1-4 questions, each with 2-4 options. The system automatically adds an " +
      '"Other" option so the user can always provide free-text input.',
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "The question text to display to the user",
              },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description: "Short display text (1-5 words). Append '(Recommended)' if this is your suggested choice.",
                    },
                    description: {
                      type: "string",
                      description: "Brief explanation of trade-offs or implications of choosing this option.",
                    },
                  },
                  required: ["label"],
                },
              },
              multi_select: {
                type: "boolean",
                description: "Whether the user can select multiple options (default false)",
                default: false,
              },
            },
            required: ["question", "options"],
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
    execute: async () => {
      // This should never be called normally — AgentEngine intercepts
      // ask_user_question tool calls and handles them specially.
      return "[Error: ask_user_question was not intercepted by AgentEngine]";
    },
  };
}

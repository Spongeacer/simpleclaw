/**
 * SimpleClaw — Memory Save Tool
 * Lets the agent persist important knowledge to the workspace memory.
 */

import type { ITool, ILogger } from "../../core/interfaces.js";
import type { IMemoryIndex } from "../../core/interfaces.js";

export function createMemorySaveTool(
  memory: IMemoryIndex,
  workspaceDir: string,
  logger: ILogger,
): ITool {
  return {
    name: "memory_save",
    description:
      "Save important knowledge to the workspace memory system. " +
      "Use this AFTER completing significant work: bugfixes, architecture decisions, " +
      "discoveries, patterns, or configuration changes. " +
      "Do NOT wait for user confirmation — save proactively. " +
      "The saved content will be indexed and searchable in future sessions.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: 'Short title (3-8 words), e.g. "JWT auth middleware refactor"',
        },
        content: {
          type: "string",
          description: "Detailed content. Include: What changed, Why, Where (files), and any lessons learned.",
        },
        type: {
          type: "string",
          description: "Optional: decision | pattern | bugfix | discovery | config | general",
        },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const title = String(args.title);
      const content = String(args.content);
      const entryType = args.type ? String(args.type) : "general";

      logger.info("Memory save", { title: title.slice(0, 60), type: entryType });

      const relPath = await memory.saveMemory(workspaceDir, title, content, entryType);
      return `Memory saved to ${relPath}`;
    },
  };
}

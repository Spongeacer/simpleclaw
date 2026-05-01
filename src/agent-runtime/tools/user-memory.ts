/**
 * SimpleClaw — User Memory Tool
 * Lets the agent manage bounded cross-session persistent memory.
 * 
 * Two stores:
 * - memory: project facts, environment details, lessons learned
 * - user: user preferences, communication style, habits
 * 
 * Both have character limits to force information density.
 */

import type { ITool, ILogger, IUserMemory } from "../../core/interfaces.js";

export function createUserMemoryTool(userMemory: IUserMemory, logger: ILogger): ITool {
  return {
    name: "user_memory",
    description:
      "Manage persistent cross-session memory. " +
      "Use this to save important facts about the project, environment, or user preferences that should survive across sessions. " +
      "\n\nStores:\n" +
      "- 'memory': project facts, tech stack, conventions, lessons learned (limit: " +
      userMemory.memoryCharLimit +
      " chars)\n" +
      "- 'user': user preferences, communication style, habits (limit: " +
      userMemory.userCharLimit +
      " chars)\n\n" +
      "When memory is near capacity, consolidate related entries before adding new ones. " +
      "Do NOT wait for user confirmation — save proactively after significant work.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "replace", "remove", "read", "list"],
          description: "add=append entry, replace=overwrite by index, remove=delete by index, read=load all, list=show entries with indices",
        },
        store: {
          type: "string",
          enum: ["memory", "user"],
          description: "Which store to operate on",
        },
        content: {
          type: "string",
          description: "Entry text (required for add/replace). Be concise and information-dense.",
        },
        index: {
          type: "number",
          description: "Entry index (0-based, required for replace/remove)",
        },
      },
      required: ["action", "store"],
    },
    execute: async (args) => {
      const action = String(args.action);
      const store = String(args.store) as "memory" | "user";

      logger.info("User memory tool", { action, store });

      switch (action) {
        case "read": {
          const data = await userMemory.load();
          const lines: string[] = [
            `=== MEMORY (${data.memoryUsage}) ===`,
            data.memory || "(empty)",
            "",
            `=== USER PROFILE (${data.userUsage}) ===`,
            data.user || "(empty)",
          ];
          return lines.join("\n");
        }

        case "list": {
          const { entries, usage } = await userMemory.listEntries(store);
          if (entries.length === 0) return `${store} store is empty (${usage}).`;
          const lines: string[] = [`${store.toUpperCase()} entries (${usage}):`, ""];
          for (let i = 0; i < entries.length; i++) {
            lines.push(`[${i}] ${entries[i].slice(0, 120)}${entries[i].length > 120 ? "..." : ""}`);
          }
          return lines.join("\n");
        }

        case "add": {
          if (!args.content || typeof args.content !== "string") {
            return "Error: 'content' is required for add action.";
          }
          const result = await userMemory.addEntry(store, args.content);
          if (result.success) {
            return `Entry added to ${store} store. ${result.usage}`;
          }
          return `Error: ${result.error}\nCurrent ${result.usage}`;
        }

        case "replace": {
          if (typeof args.index !== "number") {
            return "Error: 'index' is required for replace action.";
          }
          if (!args.content || typeof args.content !== "string") {
            return "Error: 'content' is required for replace action.";
          }
          const result = await userMemory.replaceEntry(store, args.index, args.content);
          if (result.success) {
            return `Entry ${args.index} replaced in ${store} store. ${result.usage}`;
          }
          return `Error: ${result.error}\nCurrent ${result.usage}`;
        }

        case "remove": {
          if (typeof args.index !== "number") {
            return "Error: 'index' is required for remove action.";
          }
          const result = await userMemory.removeEntry(store, args.index);
          if (result.success) {
            return `Entry ${args.index} removed from ${store} store. ${result.usage}`;
          }
          return `Error: ${result.error}\nCurrent ${result.usage}`;
        }

        default:
          return `Unknown action: ${action}`;
      }
    },
  };
}

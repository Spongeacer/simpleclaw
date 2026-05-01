/**
 * SimpleClaw — Memory Search Tool
 * Lets the agent search workspace knowledge and find files by description.
 */

import type { ITool, ILogger } from "../../core/interfaces.js";
import type { IMemoryIndex } from "../../core/interfaces.js";

export function createMemorySearchTool(memory: IMemoryIndex, logger: ILogger): ITool {
  return {
    name: "memory_search",
    description:
      "Search the workspace memory index for relevant knowledge or files. " +
      "Use this when you need to recall project context, find files by description, " +
      "or look up previous decisions and patterns. " +
      "Queries can be natural language (e.g. 'auth middleware', 'how to add a tool').",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language query to search for",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (default: 5)",
        },
        mode: {
          type: "string",
          description: "Search mode: 'memory' (knowledge docs), 'files' (code files), 'history' (archived session turns), or 'auto' (all). Default: auto",
        },
        session_id: {
          type: "string",
          description: "Required when mode='history': the session ID to search archived turns for",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const query = String(args.query);
      const maxResults = typeof args.max_results === "number" ? args.max_results : 5;
      const mode = String(args.mode ?? "auto");
      const sessionId = args.session_id ? String(args.session_id) : undefined;

      logger.info("Memory search", { query: query.slice(0, 80), mode, maxResults, sessionId });

      const lines: string[] = [`Search: "${query}"`, ""];

      if (mode === "auto" || mode === "memory") {
        const memories = await memory.search(query, { maxResults });
        if (memories.length > 0) {
          lines.push("=== Knowledge ===");
          for (const m of memories) {
            lines.push(`[${m.path}:${m.startLine}-${m.endLine}] ${m.text.slice(0, 200)}${m.text.length > 200 ? "..." : ""}`);
          }
          lines.push("");
        }
      }

      if (mode === "auto" || mode === "files") {
        const files = await memory.findFiles(query, { maxResults });
        if (files.length > 0) {
          lines.push("=== Files ===");
          for (const f of files) {
            lines.push(`- ${f.path}${f.description ? ` — ${f.description}` : ""}`);
          }
          lines.push("");
        }
      }

      if (mode === "auto" || mode === "history") {
        if (!sessionId) {
          lines.push("=== History ===");
          lines.push("(Provide session_id to search archived session history)");
          lines.push("");
        } else {
          const history = await memory.searchHistory(sessionId, query, { maxResults });
          if (history.length > 0) {
            lines.push("=== Session History ===");
            for (const h of history) {
              lines.push(`[${h.path}] ${h.text.slice(0, 300)}${h.text.length > 300 ? "..." : ""}`);
            }
            lines.push("");
          }
        }
      }

      if (lines.length <= 2) {
        lines.push("No relevant results found.");
      }

      return lines.join("\n");
    },
  };
}

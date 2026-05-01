/**
 * SimpleClaw — MCP Tool Adapter
 * Converts an MCP tool definition into a SimpleClaw ITool implementation.
 * Keeps the Core layer completely unaware of MCP.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ITool } from "../../core/interfaces.js";

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export function createMcpTool(
  client: Client,
  serverName: string,
  mcpTool: McpToolDef,
  namePrefix?: string,
): ITool {
  const prefix = namePrefix ?? serverName;
  const toolName = `${prefix}_${mcpTool.name}`;

  return {
    name: toolName,
    description: mcpTool.description
      ? `[MCP ${serverName}] ${mcpTool.description}`
      : `MCP tool from server "${serverName}": ${mcpTool.name}`,
    parameters: mcpTool.inputSchema,
    async execute(args: Record<string, unknown>): Promise<string> {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: args,
      });

      // Normalize MCP result content into plain text for SimpleClaw
      const contents = (result as Record<string, unknown>).content;
      if (!Array.isArray(contents)) {
        return JSON.stringify(result);
      }

      const texts: string[] = [];
      for (const item of contents) {
        if (typeof item !== "object" || item === null) {
          texts.push(String(item));
          continue;
        }
        if ("text" in item && typeof (item as Record<string, unknown>).text === "string") {
          texts.push((item as Record<string, unknown>).text as string);
        } else if ("data" in item && typeof (item as Record<string, unknown>).data === "string") {
          const mime = (item as Record<string, unknown>).mimeType ?? "binary";
          const data = (item as Record<string, unknown>).data as string;
          texts.push(`[${mime}]: ${data.slice(0, 200)}${data.length > 200 ? "..." : ""}`);
        } else if ("uri" in item && "text" in item) {
          const uri = (item as Record<string, unknown>).uri as string;
          const text = (item as Record<string, unknown>).text as string;
          texts.push(`[Resource ${uri}]: ${text}`);
        } else {
          texts.push(JSON.stringify(item));
        }
      }

      return texts.join("\n");
    },
  };
}

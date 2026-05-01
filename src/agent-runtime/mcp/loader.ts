/**
 * SimpleClaw — MCP Loader
 * Loads MCP servers from config and registers their tools into the runtime.
 * Best-effort: individual server failures are logged but never fatal.
 */

import type { ITool, ILogger } from "../../core/interfaces.js";
import { McpConnection, type McpServerConfig } from "./client.js";
import { createMcpTool, type McpToolDef } from "./adapter.js";

export interface McpLoadResult {
  tools: ITool[];
  connections: McpConnection[];
}

export async function loadMcpTools(
  configs: McpServerConfig[],
  logger: ILogger,
): Promise<McpLoadResult> {
  const tools: ITool[] = [];
  const connections: McpConnection[] = [];

  for (const cfg of configs) {
    try {
      const conn = new McpConnection(cfg, logger);
      await conn.connect();

      const toolList = await conn.client.listTools();
      for (const mcpTool of toolList.tools as unknown as McpToolDef[]) {
        tools.push(createMcpTool(conn.client, cfg.name, mcpTool, cfg.namePrefix));
      }

      connections.push(conn);
      logger.info(`MCP tools loaded`, {
        server: cfg.name,
        count: toolList.tools.length,
      });
    } catch (err) {
      logger.warn(`Failed to load MCP server`, {
        server: cfg.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { tools, connections };
}

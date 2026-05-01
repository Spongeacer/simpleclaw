/**
 * SimpleClaw — MCP Module exports
 */

export { McpConnection, type McpServerConfig, type McpTransportType } from "./client.js";
export { createMcpTool, type McpToolDef } from "./adapter.js";
export { loadMcpTools, type McpLoadResult } from "./loader.js";

/**
 * SimpleClaw — MCP Client
 * Low-coupling wrapper around the Model Context Protocol SDK.
 * Each instance manages one MCP server connection lifecycle.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Stream } from "node:stream";
import type { ILogger } from "../../core/interfaces.js";

export type McpTransportType = "stdio" | "sse";

export interface McpServerConfig {
  name: string;
  transport: McpTransportType;
  /** For stdio transport: command to spawn */
  command?: string;
  /** For stdio transport: arguments passed to command */
  args?: string[];
  /** For stdio transport: extra environment variables */
  env?: Record<string, string>;
  /** For sse transport: server URL endpoint */
  url?: string;
  /** Optional prefix for tool names (default: server name) */
  namePrefix?: string;
}

export class McpConnection {
  public readonly client: Client;
  private transport?: StdioClientTransport | SSEClientTransport;
  private connected = false;

  constructor(
    public readonly config: McpServerConfig,
    private logger: ILogger,
  ) {
    this.client = new Client(
      { name: "simpleclaw", version: "0.1.0" },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    if (this.config.transport === "stdio") {
      if (!this.config.command) {
        throw new Error(`MCP server "${this.config.name}" missing "command" for stdio transport`);
      }
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: this.config.env,
        stderr: "pipe",
      });

      // Pipe stderr to debug logger so MCP server logs are visible in dev mode
      const stderr = this.transport.stderr;
      if (stderr) {
        (stderr as Stream).on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8").trim();
          if (text) {
            this.logger.debug(`MCP stderr [${this.config.name}]`, { text });
          }
        });
      }
    } else if (this.config.transport === "sse") {
      if (!this.config.url) {
        throw new Error(`MCP server "${this.config.name}" missing "url" for sse transport`);
      }
      this.transport = new SSEClientTransport(new URL(this.config.url));
    } else {
      throw new Error(`Unsupported MCP transport "${String((this.config as unknown as Record<string, unknown>).transport)}"`);
    }

    await this.client.connect(this.transport);
    this.connected = true;
    this.logger.info(`MCP server connected`, {
      server: this.config.name,
      transport: this.config.transport,
    });
  }

  async disconnect(): Promise<void> {
    if (this.connected && this.transport) {
      await this.transport.close();
      this.connected = false;
      this.logger.info(`MCP server disconnected`, { server: this.config.name });
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }
}

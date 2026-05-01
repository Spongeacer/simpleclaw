/**
 * SimpleClaw — Tool registry
 * Replaces OpenClaw's 50+ scattered tool files with a clean registry pattern.
 */

import type { ToolCall, ToolResult } from "../core/types.js";
import type { ITool, IToolRegistry, IToolSchema } from "../core/interfaces.js";

export { type ITool as Tool } from "../core/interfaces.js";

export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, ITool>();

  register(tool: ITool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  list(): ITool[] {
    return Array.from(this.tools.values());
  }

  schema(): IToolSchema[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /** Global output truncation to prevent context overflow from large tool results. */
  private truncateOutput(output: string, toolName: string): string {
    // Different tools have different thresholds based on typical output size
    const thresholds: Record<string, number> = {
      grep: 6000,      // grep can return many matches
      bash: 8000,      // command output can be large
      ls: 4000,        // directory listings
      glob: 3000,      // file lists
      read: 12000,     // file reads preserve more
      web_fetch: 6000, // web page content
      memory_search: 4000, // search results
    };
    const maxLen = thresholds[toolName] ?? 6000;

    if (output.length <= maxLen) return output;

    // Smart truncation: keep head and tail, drop middle
    const headLen = Math.floor(maxLen * 0.6);
    const tailLen = maxLen - headLen - 100; // reserve space for notice
    const head = output.slice(0, headLen);
    const tail = output.slice(-tailLen);
    const removed = output.length - headLen - tailLen;

    return `${head}\n\n[...${removed} characters truncated by context manager...]\n\n${tail}`;
  }

  async execute(call: ToolCall, ctx?: import("../core/interfaces.js").ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { callId: call.id, output: `Tool "${call.name}" not found`, isError: true };
    }
    try {
      let output = await tool.execute(call.arguments, ctx);
      output = this.truncateOutput(output, call.name);
      return { callId: call.id, output };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { callId: call.id, output: msg, isError: true };
    }
  }

  /** Create a new registry containing only tools matching the predicate. */
  filter(predicate: (tool: ITool) => boolean): ToolRegistry {
    const filtered = new ToolRegistry();
    for (const tool of this.tools.values()) {
      if (predicate(tool)) {
        filtered.register(tool);
      }
    }
    return filtered;
  }
}

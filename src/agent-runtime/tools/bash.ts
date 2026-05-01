/**
 * SimpleClaw — Bash Tool
 * Execute shell commands with timeout and output limits.
 */

import type { ISandbox, ITool, IExecResult } from "../../core/interfaces.js";

export function createBashTool(sandbox: ISandbox): ITool {
  return {
    name: "bash",
    description:
      "Execute a local shell command in the workspace (run tests, build, install deps, etc). " +
      "NOT for fetching real-time data, web scraping, or external APIs — you do not have internet access for data retrieval. " +
      "Commands timeout after 120 seconds. Output truncated at 10KB per stream. " +
      "Prefer 'read' and 'edit' for file operations when possible.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (default 120, max 300)" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const command = String(args.command);
      const timeoutSec = typeof args.timeout === "number"
        ? Math.min(Math.max(1, args.timeout), 300)
        : 120;

      const result: IExecResult = await sandbox.exec(command, {
        timeoutMs: timeoutSec * 1000,
        maxOutputBytes: 10_000,
      });

      const parts: string[] = [];
      parts.push(`Command: ${command}`);
      parts.push(`Exit code: ${result.exitCode}`);

      if (result.stdout) {
        parts.push(`\n--- stdout ---\n${result.stdout}`);
      }
      if (result.stderr) {
        parts.push(`\n--- stderr ---\n${result.stderr}`);
      }

      return parts.join("\n");
    },
  };
}

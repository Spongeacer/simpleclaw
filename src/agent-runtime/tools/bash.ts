/**
 * SimpleClaw — Bash Tool (Linux environment)
 * Execute a command in a true Linux bash environment.
 *
 * - Windows: Requires Docker. If Docker is unavailable, returns an error
 *   directing the agent to use the 'shell' tool instead.
 * - Linux/macOS: Uses native bash (falls back from Docker if needed).
 *
 * Use this when you need Linux-specific tools (awk, sed, grep pipelines,
 * bash scripts, POSIX utilities). For simple cross-platform commands,
 * prefer the 'shell' tool.
 */

import type { ISandbox, ITool, IExecResult } from "../../core/interfaces.js";

export function createBashTool(sandbox: ISandbox): ITool {
  return {
    name: "bash",
    description:
      "Execute a command in a true Linux bash environment. " +
      "On Windows this requires Docker. On Linux/macOS it uses native bash. " +
      "Use this for Linux-specific tool chains: awk, sed, grep, find, xargs, " +
      "bash scripts, POSIX utilities, or when you need pipe chains. " +
      "For simple cross-platform commands (list files, cat file, env vars) " +
      "prefer the 'shell' tool instead. " +
      "Commands timeout after 120 seconds. Output truncated at 10KB per stream.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
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

      // Use execBash if available (Docker-first on Windows, native bash on Linux)
      const execFn = sandbox.execBash ?? sandbox.exec;
      const result: IExecResult = await execFn.call(sandbox, command, {
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

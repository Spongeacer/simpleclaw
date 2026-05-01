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

// Commands that can cause significant data loss or system changes.
// These are not blocked, but the description warns the approval policy.
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/,
  />\s*\/dev\/null/,
  /\bdd\s+if=.*of=\/dev/,
  /\bmkfs\./,
  /\bchmod\s+777\b/,
];

function isDangerous(command: string): string | undefined {
  for (const p of DANGEROUS_PATTERNS) {
    if (p.test(command)) {
      return `Command contains potentially destructive pattern: ${p.source}`;
    }
  }
  return undefined;
}

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
      "Commands timeout after 120 seconds. Output truncated at 10KB per stream. " +
      "Set run_in_background=true to start a long-running process and get a shell_id " +
      "for incremental output retrieval via the bash_output tool.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (default 120, max 600 for background)" },
        run_in_background: { type: "boolean", description: "Run the command in the background and return a shell_id immediately" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const command = String(args.command);
      const runInBackground = !!args.run_in_background;
      const maxTimeout = runInBackground ? 600 : 300;
      const timeoutSec = typeof args.timeout === "number"
        ? Math.min(Math.max(1, args.timeout), maxTimeout)
        : (runInBackground ? 600 : 120);

      const danger = isDangerous(command);
      if (danger) {
        return `Warning: ${danger}\n\nIf you intended to run this command, please confirm or rephrase it more specifically.`;
      }

      // Background mode
      if (runInBackground) {
        if (!sandbox.execBackground) {
          return "Error: Background execution is not supported by this sandbox.";
        }
        const { shellId } = await sandbox.execBackground(command, {
          timeoutMs: timeoutSec * 1000,
        });
        return `Background process started.\nShell ID: ${shellId}\nUse the bash_output tool to retrieve output. Use kill_shell to terminate.`;
      }

      // Foreground mode
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

/**
 * SimpleClaw — Git Tool
 * Basic git operations for code review and version control.
 */

import type { ITool, ILogger } from "../../core/interfaces.js";

export function createGitTool(
  execFn: (command: string, options?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
  logger: ILogger,
): ITool {
  return {
    name: "git",
    description:
      "Run git commands to inspect repository state. " +
      "Supported subcommands: status, diff, log, show, blame, branch. " +
      "Use this to understand what changed, who changed it, and when. " +
      "Do NOT use this to make commits or push — those require user approval.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Git subcommand and arguments (e.g. 'status', 'diff HEAD~1', 'log --oneline -10')",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const rawCommand = String(args.command).trim();

      // Whitelist allowed subcommands
      const allowed = new Set([
        "status", "diff", "log", "show", "blame", "branch",
        "stash", "remote", "config",
      ]);
      const firstWord = rawCommand.split(/\s+/)[0];
      if (!allowed.has(firstWord)) {
        return `Error: "${firstWord}" is not an allowed git subcommand for safety. Allowed: ${[...allowed].join(", ")}`;
      }

      // Block dangerous operations
      const blocked = ["push", "fetch", "pull", "clone", "reset", "clean", "rm", "mv", "commit", "merge", "rebase", "cherry-pick"];
      for (const b of blocked) {
        if (rawCommand.includes(b)) {
          return `Error: Git command contains blocked operation "${b}". These operations require manual user action.`;
        }
      }

      logger.info("Git command", { command: rawCommand });

      try {
        const result = await execFn(`git ${rawCommand}`, { timeoutMs: 30000 });

        const parts: string[] = [];
        if (result.stdout) {
          parts.push(result.stdout);
        }
        if (result.stderr && result.stderr !== result.stdout) {
          parts.push(`--- stderr ---\n${result.stderr}`);
        }

        const output = parts.join("\n").trim() || "(no output)";

        if (result.exitCode !== 0) {
          return `Git exit code ${result.exitCode}:\n${output}`;
        }
        return output;
      } catch (err) {
        logger.warn("Git command failed", { error: String(err) });
        return `Git error: ${String(err)}`;
      }
    },
  };
}

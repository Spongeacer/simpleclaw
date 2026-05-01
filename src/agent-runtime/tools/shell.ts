/**
 * SimpleClaw — Shell Tool (cross-platform)
 * Execute a command in the native shell of the current platform.
 *
 * Platform mapping:
 *   Windows  → PowerShell
 *   Linux    → sh / bash
 *   macOS    → sh / bash
 *
 * Use this for simple workspace operations. For Linux-specific tool chains
 * (awk, sed, grep pipelines, bash scripts) prefer the 'bash' tool.
 */

import type { ISandbox, ITool, IExecResult } from "../../core/interfaces.js";

export function createShellTool(sandbox: ISandbox): ITool {
  const info = sandbox.getPlatformInfo?.() ?? {
    platform: "unknown",
    shell: "unknown",
    availableCommands: "",
  };

  return {
    name: "shell",
    description:
      `Execute a command in the native shell of the current platform (${info.platform} → ${info.shell}). ` +
      "Available commands: " + info.availableCommands + " " +
      "Commands timeout after 120 seconds. Output truncated at 10KB per stream. " +
      "NOT for fetching real-time data or external APIs — you do not have internet access. " +
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

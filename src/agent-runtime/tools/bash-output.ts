/**
 * SimpleClaw — BashOutput Tool
 * Retrieve incremental output from a background shell process started by
 * the bash tool with run_in_background=true.
 */

import type { ISandbox, ITool } from "../../core/interfaces.js";

export function createBashOutputTool(sandbox: ISandbox): ITool {
  return {
    name: "bash_output",
    description:
      "Retrieve incremental output from a background shell process. " +
      "Use this after starting a command with bash + run_in_background=true. " +
      "Pass the shell_id returned by bash. Optionally pass an offset (character count) " +
      "to get only new output since the last call. Output is truncated at 30K chars.",
    parameters: {
      type: "object",
      properties: {
        shell_id: { type: "string", description: "Shell ID returned by the bash tool" },
        offset: { type: "number", description: "Character offset to start from (default 0)" },
      },
      required: ["shell_id"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const shellId = String(args.shell_id);
      const offset = typeof args.offset === "number" ? Math.max(0, args.offset) : 0;

      if (!sandbox.getBackgroundOutput) {
        return "Error: Background output retrieval is not supported by this sandbox.";
      }

      try {
        const { stdout, stderr, done, exitCode } = await sandbox.getBackgroundOutput(shellId, offset);
        const parts: string[] = [];
        parts.push(`Shell ID: ${shellId}`);
        parts.push(`Status: ${done ? "finished" : "running"}`);
        if (done && exitCode !== undefined) {
          parts.push(`Exit code: ${exitCode}`);
        }
        if (stdout) {
          parts.push(`\n--- stdout ---\n${stdout}`);
        }
        if (stderr) {
          parts.push(`\n--- stderr ---\n${stderr}`);
        }
        if (!stdout && !stderr) {
          parts.push("\n(no new output)");
        }
        return parts.join("\n");
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}

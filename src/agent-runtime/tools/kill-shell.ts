/**
 * SimpleClaw — KillShell Tool
 * Terminate a background shell process started by the bash tool.
 */

import type { ISandbox, ITool } from "../../core/interfaces.js";

export function createKillShellTool(sandbox: ISandbox): ITool {
  return {
    name: "kill_shell",
    description:
      "Terminate a background shell process. Use this to stop a long-running " +
      "command that was started with bash + run_in_background=true.",
    parameters: {
      type: "object",
      properties: {
        shell_id: { type: "string", description: "Shell ID returned by the bash tool" },
      },
      required: ["shell_id"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const shellId = String(args.shell_id);

      if (!sandbox.killBackground) {
        return "Error: Background process termination is not supported by this sandbox.";
      }

      try {
        const killed = await sandbox.killBackground(shellId);
        return killed
          ? `Shell ${shellId} terminated successfully.`
          : `Shell ${shellId} was not found or already finished.`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}

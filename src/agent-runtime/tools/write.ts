/**
 * SimpleClaw — Write Tool (Claude Code inspired)
 * Create a new file or completely overwrite an existing file.
 *
 * Design: Write is for NEW files. Edit is for existing files.
 * This distinction prevents LLM confusion about whether to use old_string="".
 */

import type { ISandbox, ITool } from "../../core/interfaces.js";
import { existsSync } from "fs";

export function createWriteTool(sandbox: ISandbox): ITool {
  return {
    name: "write",
    description:
      "Create a new file or completely overwrite an existing file with new content. " +
      "Use this ONLY for creating files that do not exist yet. " +
      "For modifying existing files, prefer the 'edit' tool. " +
      "You can create directories implicitly by writing to a path inside them.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative or absolute file path to write" },
        content: { type: "string", description: "Complete file content to write" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const path = String(args.path);
      const content = String(args.content);

      // Resolve through sandbox to check existence in the correct workspace
      const resolvedPath = sandbox.resolvePath ? sandbox.resolvePath(path) : path;
      const isExisting = existsSync(resolvedPath);
      if (isExisting) {
        // Warn but allow overwrite — the edit tool description already enforces read-before-edit.
        // For write, we allow overwrite with a clear warning so the model knows.
        await sandbox.writeFile(path, content);
        return `Overwritten existing file: ${path} (${content.split("\n").length} lines, ${content.length} chars)`;
      }

      await sandbox.writeFile(path, content);
      return `Created file: ${path} (${content.split("\n").length} lines, ${content.length} chars)`;
    },
  };
}

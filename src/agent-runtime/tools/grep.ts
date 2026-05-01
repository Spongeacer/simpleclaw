/**
 * SimpleClaw — Grep Tool
 * Search file contents by regex in the workspace.
 */

import { readdir, readFile, stat } from "fs/promises";
import { resolve, relative, join } from "path";
import type { ISandbox, ITool } from "../../core/interfaces.js";

const MAX_RESULTS = 50;
const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export function createGrepTool(_sandbox: ISandbox, workspace: string): ITool {
  return {
    name: "grep",
    description:
      "Search file contents by regular expression in the workspace. " +
      `Returns up to ${MAX_RESULTS} matches. ` +
      "Use this to find code patterns, function definitions, or references.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        path: { type: "string", description: "Directory to search in (default: workspace root)" },
        glob: { type: "string", description: "File glob filter, e.g. '*.ts' or '*.json'" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const pattern = String(args.pattern);
      const searchPath = args.path ? resolve(workspace, String(args.path)) : workspace;
      const glob = args.glob ? String(args.glob) : null;

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, "g");
      } catch (e) {
        throw new Error(`Invalid regex pattern: ${pattern}`, { cause: e });
      }

      const results: { file: string; line: number; text: string }[] = [];

      async function walk(dir: string): Promise<void> {
        if (results.length >= MAX_RESULTS) return;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= MAX_RESULTS) return;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            // Skip common non-source directories
            if (["node_modules", ".git", "dist", "build", ".next", ".venv", "__pycache__"].includes(entry.name)) {
              continue;
            }
            await walk(fullPath);
          } else if (entry.isFile()) {
            if (glob && !matchGlob(entry.name, glob)) continue;
            try {
              const s = await stat(fullPath);
              if (s.size > MAX_FILE_SIZE) continue;
              const content = await readFile(fullPath, "utf-8");
              const lines = content.split("\n");
              for (let i = 0; i < lines.length; i++) {
                regex.lastIndex = 0;
                if (regex.test(lines[i])) {
                  results.push({
                    file: relative(workspace, fullPath).replace(/\\/g, "/"),
                    line: i + 1,
                    text: lines[i].trim(),
                  });
                  if (results.length >= MAX_RESULTS) return;
                }
              }
            } catch {
              // skip unreadable files
            }
          }
        }
      }

      await walk(searchPath);

      if (results.length === 0) {
        return `No matches found for /${pattern}/`;
      }

      const lines = results.map((r) => `${r.file}:${r.line}: ${r.text}`);
      return `Found ${results.length} match(es):\n\n` + lines.join("\n");
    },
  };
}

function matchGlob(filename: string, glob: string): boolean {
  // Simple glob: *.ts, *.json, src/**/*.ts
  if (glob.startsWith("*.")) {
    const ext = glob.slice(1); // .ts
    return filename.endsWith(ext);
  }
  if (glob.includes("*")) {
    const parts = glob.split("*");
    let idx = 0;
    for (const part of parts) {
      const found = filename.indexOf(part, idx);
      if (found === -1) return false;
      idx = found + part.length;
    }
    return true;
  }
  return filename === glob;
}

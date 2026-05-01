/**
 * SimpleClaw — Read Tool
 * Reads a file with line numbers. Rejects binary files.
 *
 * Mature patterns from OpenClaw / Pawwork2:
 * - "Did you mean?" fuzzy path suggestions when file not found
 * - Directory paths auto-list contents
 * - Dual capping: line limit + byte limit
 */

import type { ISandbox, ITool } from "../../core/interfaces.js";
import type { FileAccessTracker } from "../file-tracker.js";
import { readdir, stat } from "fs/promises";
import { dirname, basename } from "path";

// Extensions that should not be read as text
const BINARY_EXT = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".ico", ".svg",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".wasm", ".class", ".o", ".a", ".obj",
  ".db", ".sqlite", ".sqlite3",
]);

const MAX_BYTES = 50_000; // ~12K tokens

function isBinaryByExtension(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return BINARY_EXT.has(ext);
}

function isBinaryByContent(content: string): boolean {
  const sample = content.slice(0, 8192);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) nonPrintable++;
  }
  return nonPrintable / sample.length > 0.3;
}

function addLineNumbers(content: string, offset = 1): string {
  const lines = content.split("\n");
  const maxDigits = String(offset + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(offset + i).padStart(maxDigits)} | ${line}`)
    .join("\n");
}

/**
 * When a file is not found, scan the parent directory for case-insensitive
 * fuzzy matches and return up to 3 suggestions.
 */
async function suggestSimilarPaths(missingPath: string, _sandbox: ISandbox): Promise<string[]> {
  try {
    const dir = dirname(missingPath);
    const name = basename(missingPath).toLowerCase();
    const entries = await readdir(dir).catch(() => []);
    const scored = entries
      .filter((e) => e.toLowerCase().includes(name) || name.includes(e.toLowerCase()))
      .map((e) => {
        const a = e.toLowerCase();
        const b = name;
        // Simple Jaccard-ish similarity: common substrings
        let common = 0;
        const setA = new Set(a);
        for (const ch of b) if (setA.has(ch)) common++;
        return { name: e, score: common / Math.max(a.length, b.length) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((s) => `${dir}/${s.name}`.replace(/\\/g, "/").replace(/\/+/g, "/"));
    return scored;
  } catch {
    return [];
  }
}

export function createReadTool(
  sandbox: ISandbox,
  tracker: FileAccessTracker
): ITool {
  return {
    name: "read",
    description:
      "Read a file from the workspace. Returns content with line numbers. " +
      "Use offset and limit to read large files in chunks. " +
      "You MUST read a file before editing it.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative or absolute file path" },
        offset: { type: "number", description: "Line number to start from (1-based)" },
        limit: { type: "number", description: "Max number of lines to read" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const path = String(args.path);

      if (isBinaryByExtension(path)) {
        throw new Error(
          `File "${path}" appears to be a binary file. Read tool only supports text files.`
        );
      }

      // Check if path is a directory (resolve through sandbox if available)
      const resolvedPath = sandbox.resolvePath ? sandbox.resolvePath(path) : path;
      try {
        const s = await stat(resolvedPath);
        if (s.isDirectory()) {
          const entries = await readdir(resolvedPath);
          const lines = entries
            .sort((a, b) => a.localeCompare(b))
            .map((e) => `  ${e}`);
          return `[Directory: ${path} (${entries.length} entries)]\n${lines.join("\n")}`;
        }
      } catch {
        // not found or not accessible — let readFile handle the error
      }

      let raw: string;
      try {
        raw = await sandbox.readFile(path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const suggestions = await suggestSimilarPaths(path, sandbox);
        if (suggestions.length > 0) {
          throw new Error(
            `${msg}\n\nDid you mean one of these?\n${suggestions.map((s) => `  - ${s}`).join("\n")}`
          );
        }
        throw err;
      }

      if (isBinaryByContent(raw)) {
        throw new Error(
          `File "${path}" contains binary content. Read tool only supports text files.`
        );
      }

      tracker.markRead(path);

      const lines = raw.split("\n");
      const offset = typeof args.offset === "number" ? Math.max(1, args.offset) : 1;
      const limit = typeof args.limit === "number" ? args.limit : lines.length;

      const startIndex = offset - 1;
      const sliced = lines.slice(startIndex, startIndex + limit);
      let numbered = addLineNumbers(sliced.join("\n"), offset);

      // Byte cap (soft truncation at line boundary)
      if (numbered.length > MAX_BYTES) {
        let cutAt = numbered.lastIndexOf("\n", MAX_BYTES);
        if (cutAt <= 0) cutAt = MAX_BYTES;
        numbered = numbered.slice(0, cutAt) + "\n... [output truncated by byte limit]";
      }

      const totalLines = lines.length;
      const header = `[File: ${path} (${totalLines} lines total)]\n`;
      const footer = (startIndex + limit < totalLines)
        ? `\n[${totalLines - startIndex - limit} more lines. Use offset=${offset + limit} to continue reading]`
        : "";

      return header + numbered + footer;
    },
  };
}

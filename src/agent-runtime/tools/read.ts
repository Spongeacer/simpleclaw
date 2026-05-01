/**
 * SimpleClaw — Read Tool
 * Reads a file with line numbers. Rejects binary files.
 */

import type { ISandbox, ITool } from "../../core/interfaces.js";
import type { FileAccessTracker } from "../file-tracker.js";

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

function isBinaryByExtension(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return BINARY_EXT.has(ext);
}

function isBinaryByContent(content: string): boolean {
  // Sample first 8KB for null bytes
  const sample = content.slice(0, 8192);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true; // null byte = binary
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

      const raw = await sandbox.readFile(path);

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
      const numbered = addLineNumbers(sliced.join("\n"), offset);

      const totalLines = lines.length;
      const header = `[File: ${path} (${totalLines} lines total)]\n`;
      const footer = limit < totalLines
        ? `\n[${totalLines - startIndex - limit} more lines. Use offset=${offset + limit} to continue reading]`
        : "";

      return header + numbered + footer;
    },
  };
}

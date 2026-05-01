/**
 * SimpleClaw — Edit Tool
 * Multi-strategy search-and-replace with read-before-write guard.
 * Strategies (tried in order):
 *   1. Exact match
 *   2. Line-trimmed match (ignores leading/trailing whitespace per line)
 *   3. Block-anchor match (first/last line anchors + middle fuzzy)
 */

import type { ISandbox, ITool } from "../../core/interfaces.js";
import type { FileAccessTracker } from "../file-tracker.js";

// ─── Replacer Strategies ──────────────────────────────────────────────────────

interface Match {
  index: number;
  before: string;
  after: string;
}

type Replacer = (content: string, oldStr: string, newStr: string) => Match | null;

const exactReplacer: Replacer = (content, oldStr) => {
  const idx = content.indexOf(oldStr);
  if (idx === -1) return null;
  return { index: idx, before: content.slice(0, idx), after: content.slice(idx + oldStr.length) };
};

const lineTrimmedReplacer: Replacer = (content, oldStr, _newStr) => {
  const oldLines = oldStr.split("\n").map((l) => l.trimEnd());
  const contentLines = content.split("\n");

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const chunk = contentLines.slice(i, i + oldLines.length).map((l) => l.trimEnd());
    if (chunk.join("\n") === oldLines.join("\n")) {
      const before = contentLines.slice(0, i).join("\n");
      const after = contentLines.slice(i + oldLines.length).join("\n");
      const prefix = before ? before + "\n" : "";
      const suffix = after ? "\n" + after : "";
      return { index: prefix.length, before: prefix, after: suffix };
    }
  }
  return null;
};

const blockAnchorReplacer: Replacer = (content, oldStr) => {
  const oldLines = oldStr.split("\n");
  if (oldLines.length < 2) return null;

  const firstLine = oldLines[0];
  const lastLine = oldLines[oldLines.length - 1];
  const contentLines = content.split("\n");

  const candidates: Match[] = [];

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    if (contentLines[i] !== firstLine) continue;
    const endIdx = i + oldLines.length - 1;
    if (contentLines[endIdx] !== lastLine) continue;

    // Middle lines: allow small differences
    let middleOk = true;
    for (let m = 1; m < oldLines.length - 1; m++) {
      if (contentLines[i + m] !== oldLines[m]) {
        middleOk = false;
        break;
      }
    }
    if (!middleOk) continue;

    const before = contentLines.slice(0, i).join("\n");
    const after = contentLines.slice(endIdx + 1).join("\n");
    const prefix = before ? before + "\n" : "";
    const suffix = after ? "\n" + after : "";
    candidates.push({ index: prefix.length, before: prefix, after: suffix });
  }

  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    // Return a sentinel to signal ambiguity
    throw new AmbiguousMatchError(`Found ${candidates.length} matches for old_string. Provide more surrounding context to disambiguate.`);
  }
  return candidates[0];
};

class AmbiguousMatchError extends Error {}

const REPLACERS: Replacer[] = [exactReplacer, lineTrimmedReplacer, blockAnchorReplacer];

// ─── Tool ─────────────────────────────────────────────────────────────────────

export function createEditTool(
  sandbox: ISandbox,
  tracker: FileAccessTracker
): ITool {
  return {
    name: "edit",
    description:
      "Apply a search-and-replace edit to a file. " +
      "You MUST read the file with the 'read' tool before editing. " +
      "old_string must be exact text from the file (can span multiple lines). " +
      "If old_string matches multiple locations, the edit will be rejected.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const path = String(args.path);
      const oldStr = String(args.old_string);
      const newStr = String(args.new_string);

      if (!oldStr) {
        throw new Error("old_string cannot be empty. Use the 'write' tool to create new files.");
      }

      if (!tracker.hasRead(path)) {
        throw new Error(
          `You must read "${path}" with the 'read' tool before editing it. ` +
          `This ensures you have the current file content and correct line numbers.`
        );
      }

      const content = await sandbox.readFile(path);

      let match: Match | null = null;
      let strategyName = "";

      for (const [i, replacer] of REPLACERS.entries()) {
        const names = ["exact", "line-trimmed", "block-anchor"];
        try {
          const result = replacer(content, oldStr, newStr);
          if (result) {
            match = result;
            strategyName = names[i];
            break;
          }
        } catch (e) {
          if (e instanceof AmbiguousMatchError) throw e;
          // continue to next strategy
        }
      }

      if (!match) {
        throw new Error(
          `old_string not found in file: ${path}\n` +
          `Tips: (1) Make sure old_string is copied exactly from the file. ` +
          `(2) Include more surrounding lines for uniqueness. ` +
          `(3) Check line endings (CRLF vs LF).`
        );
      }

      const replaced = match.before + newStr + match.after;
      await sandbox.writeFile(path, replaced);

      return `Edited ${path} (${strategyName} match).\n` +
        `--- old (${oldStr.split("\n").length} lines) ---\n${oldStr.slice(0, 200)}${oldStr.length > 200 ? "..." : ""}\n` +
        `--- new (${newStr.split("\n").length} lines) ---\n${newStr.slice(0, 200)}${newStr.length > 200 ? "..." : ""}`;
    },
  };
}

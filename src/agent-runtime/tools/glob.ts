/**
 * SimpleClaw — Glob Tool
 * Recursively find files matching a pattern.
 */

import { readdir } from "fs/promises";
import { resolve, relative } from "path";
import type { ITool } from "../../core/interfaces.js";

export function createGlobTool(workspace: string): ITool {
  return {
    name: "glob",
    description:
      "Recursively search for files matching a pattern. " +
      "Supports wildcards: `*` matches any filename characters, `**` matches any directory depth. " +
      "Examples: `src/**/*.ts` (all TS files under src), `*.json` (JSON files in root), `**/*.test.js`. " +
      "Use this when you need to find files by name pattern across the entire project.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match (e.g. 'src/**/*.ts', '*.md')",
        },
        max_results: {
          type: "number",
          description: "Maximum results to return (default 50, max 200)",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const pattern = String(args.pattern);
      const maxResults = Math.min(Math.max(1, Number(args.max_results ?? 50)), 200);

      const results = await globSearch(workspace, pattern, maxResults);

      if (results.length === 0) {
        return `No files matched pattern: "${pattern}"`;
      }

      const lines = [`Matched ${results.length} file(s) for "${pattern}":`, ""];
      for (const p of results) {
        lines.push(`  ${p}`);
      }
      return lines.join("\n");
    },
  };
}

async function globSearch(
  root: string,
  pattern: string,
  maxResults: number,
): Promise<string[]> {
  const results: string[] = [];

  // Normalize pattern: convert backslashes, remove leading ./
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = normalizedPattern.split("/");

  async function walk(currentDir: string, partIndex: number): Promise<void> {
    if (results.length >= maxResults) return;

    if (partIndex >= parts.length) {
      // Should not happen unless pattern ends with /
      return;
    }

    const part = parts[partIndex];
    const isLastPart = partIndex === parts.length - 1;

    if (part === "**") {
      // Match any depth
      if (isLastPart) {
        // Pattern ends with ** — match all directories
        return;
      }

      // ** followed by more parts: try matching at current depth and all subdirs
      const nextPart = parts[partIndex + 1];
      const remainingParts = parts.slice(partIndex + 1);

      // First, try matching next part at current level
      await matchAtLevel(currentDir, nextPart, remainingParts, partIndex + 1);

      // Then recurse into subdirectories
      const entries = await safeReaddir(currentDir);
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = resolve(currentDir, entry.name);
          await walk(subDir, partIndex); // stay at ** level
          if (results.length >= maxResults) return;
        }
      }
    } else {
      // Regular part (may contain * or ?)
      if (isLastPart) {
        // Match files/dirs in currentDir
        const entries = await safeReaddir(currentDir);
        for (const entry of entries) {
          if (matchGlob(entry.name, part)) {
            const fullPath = resolve(currentDir, entry.name);
            const relPath = relative(root, fullPath).replace(/\\/g, "/");
            results.push(relPath);
            if (results.length >= maxResults) return;
          }
        }
      } else {
        // Need to match a directory to descend into
        const entries = await safeReaddir(currentDir);
        for (const entry of entries) {
          if (entry.isDirectory() && matchGlob(entry.name, part)) {
            const subDir = resolve(currentDir, entry.name);
            await walk(subDir, partIndex + 1);
            if (results.length >= maxResults) return;
          }
        }
      }
    }
  }

  async function matchAtLevel(
    dir: string,
    part: string,
    remainingParts: string[],
    partIndex: number,
  ): Promise<void> {
    const entries = await safeReaddir(dir);
    for (const entry of entries) {
      if (matchGlob(entry.name, part)) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory() && remainingParts.length > 1) {
          await walk(fullPath, partIndex + 1);
        } else if (!entry.isDirectory() || remainingParts.length <= 1) {
          const relPath = relative(root, fullPath).replace(/\\/g, "/");
          results.push(relPath);
        }
        if (results.length >= maxResults) return;
      }
    }
  }

  await walk(root, 0);
  return results;
}

function matchGlob(name: string, pattern: string): boolean {
  // Simple glob matching: * matches any sequence, ? matches one char
  const regex = new RegExp(
    "^" +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") +
    "$",
  );
  return regex.test(name);
}

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

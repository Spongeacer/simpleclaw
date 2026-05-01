/**
 * SimpleClaw — LS Tool
 * List directory contents.
 */

import { readdir, stat } from "fs/promises";
import { resolve, relative } from "path";
import type { ITool } from "../../core/interfaces.js";

export function createLsTool(workspace: string): ITool {
  return {
    name: "ls",
    description:
      "List files and directories. Use this to explore the workspace structure. " +
      "Set depth > 1 to show a directory tree recursively.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (default: workspace root)" },
        depth: { type: "number", description: "Recursion depth for tree view (default 1, max 4). depth=1 lists single directory, depth=2 shows one level of subdirs, etc." },
      },
      required: [],
      additionalProperties: false,
    },
    execute: async (args) => {
      const targetPath = args.path
        ? resolve(workspace, String(args.path))
        : workspace;
      const depth = Math.min(Math.max(1, Number(args.depth ?? 1)), 4);

      const tree = await buildTree(workspace, targetPath, depth, 0);
      return tree;
    },
  };
}

async function buildTree(
  workspace: string,
  dirPath: string,
  maxDepth: number,
  currentDepth: number,
): Promise<string> {
  const relPath = relative(workspace, dirPath).replace(/\\/g, "/") || ".";
  const indent = "  ".repeat(currentDepth);
  const lines: string[] = [];

  if (currentDepth === 0) {
    lines.push(`Directory: ${relPath}`);
  }

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    lines.push(`${indent}  (cannot read)`);
    return lines.join("\n");
  }

  // Sort: dirs first, then files
  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    const fullPath = resolve(dirPath, entry.name);
    let size = "";
    try {
      const s = await stat(fullPath);
      if (s.isFile()) {
        size = ` (${formatBytes(s.size)})`;
      }
    } catch {
      // ignore
    }

    const prefix = entry.isDirectory() ? "📁" : "📄";
    lines.push(`${indent}  ${prefix} ${entry.name}${size}`);

    if (entry.isDirectory() && currentDepth + 1 < maxDepth) {
      const subTree = await buildTree(workspace, fullPath, maxDepth, currentDepth + 1);
      // Skip the header line for subdirs
      const subLines = subTree.split("\n").slice(1);
      lines.push(...subLines);
    }
  }

  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

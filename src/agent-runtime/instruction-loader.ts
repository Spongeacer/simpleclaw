/**
 * SimpleClaw — Instruction Loader
 * Scans for AGENTS.md / CLAUDE.md and loads them into the system prompt.
 * Inspired by OpenClaw's instruction system (src/session/instruction.ts).
 *
 * Scan order (first match wins):
 *   1. {workspace}/AGENTS.md
 *   2. {workspace}/CLAUDE.md
 *   3. ~/.simpleclaw/AGENTS.md
 */

import { readFile } from "fs/promises";
import { resolve } from "path";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

export interface InstructionResult {
  content: string;
  path: string;
}

/**
 * Find and load the first available instruction file.
 * Returns null if none found.
 */
export async function loadInstructions(workspace: string): Promise<InstructionResult | null> {
  // 1. Project-level: scan workspace and ancestors for AGENTS.md / CLAUDE.md
  for (const filename of INSTRUCTION_FILES) {
    const projectPath = resolve(workspace, filename);
    try {
      const content = await readFile(projectPath, "utf-8");
      return { content, path: projectPath };
    } catch {
      // not found, continue
    }
  }

  // 2. Global-level: ~/.simpleclaw/AGENTS.md
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const globalPath = resolve(home, ".simpleclaw", "AGENTS.md");
    try {
      const content = await readFile(globalPath, "utf-8");
      return { content, path: globalPath };
    } catch {
      // not found
    }
  }

  return null;
}

/**
 * Format instruction content for system prompt injection.
 */
export function formatInstruction(result: InstructionResult): string {
  return [
    "=== PROJECT INSTRUCTIONS ===",
    "",
    `Source: ${result.path}`,
    ``,
    result.content,
  ].join("\n");
}

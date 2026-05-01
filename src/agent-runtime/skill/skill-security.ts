/**
 * SimpleClaw — Skill Security
 * Lightweight but effective filesystem guards for skill loading.
 */

import { realpath, lstat, stat, readFile } from "fs/promises";
import { resolve, relative, isAbsolute, sep } from "path";
import type { SecurityLimits } from "./skill-types.js";
import { DEFAULT_SECURITY_LIMITS } from "./skill-types.js";

export interface SkillScanResult {
  ok: boolean;
  path?: string;
  reason?: string;
}

/**
 * Verify that a candidate path is within its configured root directory.
 * Uses realpath to resolve symlinks before comparison.
 */
export async function resolveSafeSkillPath(
  rootDir: string,
  candidatePath: string
): Promise<SkillScanResult> {
  const resolvedRoot = resolve(rootDir);

  let rootReal: string;
  try {
    rootReal = await realpath(resolvedRoot);
  } catch {
    return { ok: false, reason: `root directory not accessible: ${resolvedRoot}` };
  }

  const resolvedCandidate = resolve(candidatePath);

  // Reject symlinks at the candidate path itself
  try {
    const lstatResult = await lstat(resolvedCandidate);
    if (lstatResult.isSymbolicLink()) {
      return { ok: false, reason: `symlink rejected: ${resolvedCandidate}` };
    }
  } catch {
    // lstat may fail for non-existent paths; continue to realpath check
  }

  let candidateReal: string;
  try {
    candidateReal = await realpath(resolvedCandidate);
  } catch {
    return { ok: false, reason: `path not accessible: ${resolvedCandidate}` };
  }

  if (!isPathWithinRoot(rootReal, candidateReal)) {
    return {
      ok: false,
      reason: `path escapes root: ${candidateReal} (root: ${rootReal})`,
    };
  }

  return { ok: true, path: candidateReal };
}

/**
 * Check if candidate is within root using path.relative.
 */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith("..") && !rel.startsWith("." + sep) && !isAbsolute(rel))
  );
}

/**
 * Read a skill file with size guard. Returns null if file is unreadable or oversized.
 */
export async function readSkillFileSafe(
  filePath: string,
  limits?: Partial<SecurityLimits>
): Promise<string | null> {
  const maxBytes = limits?.maxSkillFileBytes ?? DEFAULT_SECURITY_LIMITS.maxSkillFileBytes;

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return null;
    }
    if (fileStat.size > maxBytes) {
      return null;
    }
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}



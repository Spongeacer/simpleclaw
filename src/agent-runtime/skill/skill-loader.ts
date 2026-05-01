/**
 * SimpleClaw — Skill Loader (Production Grade)
 * Scans for SKILL.md files with security guards, metadata parsing,
 * runtime eligibility checks, and hot-reload support.
 *
 * Scan order (later overrides earlier):
 *   1. builtin/      (package-level)
 *   2. ~/.simpleclaw/skills/  (user-level)
 *   3. {workspace}/skills/    (project-level, highest priority)
 */

import { readdir, stat } from "fs/promises";
import { resolve, join } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import type { ILogger } from "../../core/interfaces.js";
import type { SkillInfo, SkillMetadata, SkillSource, SecurityLimits } from "./skill-types.js";
import { DEFAULT_SECURITY_LIMITS } from "./skill-types.js";
import { resolveSafeSkillPath, readSkillFileSafe } from "./skill-security.js";

// ─── Public API ──────────────────────────────────────────────────────────────

export interface SkillLoadOptions {
  workspace: string;
  logger: ILogger;
  limits?: Partial<SecurityLimits>;
}

/**
 * Load all skills from all sources with security + eligibility checks.
 */
export async function loadAllSkills(options: SkillLoadOptions): Promise<SkillInfo[]> {
  const { workspace, logger, limits: userLimits } = options;
  const limits = { ...DEFAULT_SECURITY_LIMITS, ...userLimits };

  const dirs = resolveSkillScanDirs(workspace);
  const seenNames = new Map<string, SkillInfo>();

  for (const { dir, source } of dirs) {
    const found = await scanSkillSource({ dir, source, limits, logger });
    for (const skill of found) {
      // Later sources override earlier ones by name
      seenNames.set(skill.name, skill);
    }
  }

  const skills = Array.from(seenNames.values()).sort((a, b) => a.name.localeCompare(b.name));

  const eligibleCount = skills.filter((s) => s.eligible).length;
  logger.info("Skills loaded", {
    total: skills.length,
    eligible: eligibleCount,
    ineligible: skills.length - eligibleCount,
    sources: dirs.map((d) => d.source),
  });

  return skills;
}

/**
 * Format skill list for system prompt injection.
 * Only includes eligible skills.
 */
export function formatSkillList(skills: SkillInfo[], verbose = false): string {
  const eligible = skills.filter((s) => s.eligible);
  if (eligible.length === 0) return "";

  const lines: string[] = [
    "=== AVAILABLE SKILLS ===",
    "",
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the `skill` tool to load a skill when a task matches its description.",
    "",
  ];

  if (verbose) {
    lines.push("<available_skills>");
    for (const s of eligible) {
      const emoji = s.metadata?.emoji ? `${s.metadata.emoji} ` : "";
      lines.push("  <skill>");
      lines.push(`    <name>${s.name}</name>`);
      lines.push(`    <description>${emoji}${s.description}</description>`);
      lines.push("  </skill>");
    }
    lines.push("</available_skills>");
  } else {
    for (const s of eligible) {
      const emoji = s.metadata?.emoji ? `${s.metadata.emoji} ` : "";
      lines.push(`- **${s.name}**: ${emoji}${s.description}`);
    }
  }

  return lines.join("\n");
}

// ─── Scanning ────────────────────────────────────────────────────────────────

interface ScanOptions {
  dir: string;
  source: SkillSource;
  limits: SecurityLimits;
  logger: ILogger;
}

async function scanSkillSource(options: ScanOptions): Promise<SkillInfo[]> {
  const { dir, source, limits, logger } = options;

  // Verify root directory is safe
  const rootCheck = await resolveSafeSkillPath(dir, dir);
  if (!rootCheck.ok) {
    logger.debug("Skill source skipped", { source, dir, reason: rootCheck.reason });
    return [];
  }
  const rootReal = rootCheck.path!;

  let entries: string[] = [];
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return [];
    entries = await readdir(dir);
  } catch {
    return [];
  }

  // Filter to subdirectories (skip dotfiles and node_modules)
  const subdirs: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const fullPath = join(dir, name);
    try {
      const st = await stat(fullPath);
      if (st.isDirectory()) {
        subdirs.push(name);
      }
    } catch {
      // ignore
    }
  }

  // Respect max skills per source
  if (subdirs.length > limits.maxSkillsPerSource) {
    logger.warn("Skill source has too many entries, truncating", {
      source,
      dir,
      count: subdirs.length,
      max: limits.maxSkillsPerSource,
    });
    subdirs.length = limits.maxSkillsPerSource;
  }

  const skills: SkillInfo[] = [];
  for (const name of subdirs) {
    const skillDir = join(dir, name);
    const skillMd = join(skillDir, "SKILL.md");

    // Security: verify skillDir and SKILL.md are within root
    const dirCheck = await resolveSafeSkillPath(rootReal, skillDir);
    if (!dirCheck.ok) {
      logger.warn("Skill directory rejected", { source, name, reason: dirCheck.reason });
      continue;
    }
    const fileCheck = await resolveSafeSkillPath(rootReal, skillMd);
    if (!fileCheck.ok) {
      logger.warn("Skill file rejected", { source, name, reason: fileCheck.reason });
      continue;
    }

    const raw = await readSkillFileSafe(skillMd, limits);
    if (raw === null) {
      logger.debug("Skill file unreadable or oversized", { source, name, path: skillMd });
      continue;
    }

    const parsed = parseSkillMd(raw);
    if (!parsed) {
      logger.debug("Skill frontmatter invalid", { source, name, path: skillMd });
      continue;
    }

    const eligibility = evaluateSkillEligibility(parsed.metadata);
    const skill: SkillInfo = {
      name: parsed.name,
      description: parsed.description,
      triggers: parsed.triggers,
      location: skillMd,
      baseDir: dirCheck.path!,
      content: parsed.content,
      metadata: parsed.metadata,
      eligible: eligibility.eligible,
      ineligibleReason: eligibility.reason,
      source,
    };

    if (!skill.eligible) {
      logger.info("Skill ineligible", { name: skill.name, source, reason: skill.ineligibleReason });
    }

    skills.push(skill);
  }

  return skills;
}

// ─── Frontmatter Parsing ─────────────────────────────────────────────────────

interface ParsedSkillMd {
  name: string;
  description: string;
  triggers?: string[];
  content: string;
  metadata?: SkillMetadata;
}

function parseSkillMd(raw: string): ParsedSkillMd | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("---")) {
    return null;
  }

  const endIdx = trimmed.indexOf("\n---", 3);
  if (endIdx === -1) return null;

  const frontmatter = trimmed.slice(3, endIdx).trim();
  const content = trimmed.slice(endIdx + 4).trim();

  const data = parseYamlLike(frontmatter);
  const name = data.name;
  const description = data.description;

  if (!name || !description) return null;

  const metadata = parseMetadata(data.metadata);

  return {
    name: String(name),
    description: String(description),
    triggers: Array.isArray(data.triggers) ? data.triggers.map(String) : undefined,
    content,
    metadata: metadata ?? undefined,
  };
}

/**
 * Parse metadata value. Supports:
 * - Inline JSON object: {"os": [...], "requires": {...}}
 * - OpenClaw compatibility: {"openclaw": {...}} (unwraps the inner object)
 */
function parseMetadata(raw: unknown): SkillMetadata | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const target = parsed.openclaw ?? parsed;
    return normalizeMetadata(target);
  } catch {
    return null;
  }
}

function normalizeMetadata(raw: Record<string, unknown>): SkillMetadata | null {
  if (!raw || typeof raw !== "object") return null;

  const meta: SkillMetadata = {};

  if (typeof raw.always === "boolean") meta.always = raw.always;
  if (typeof raw.emoji === "string") meta.emoji = raw.emoji;
  if (typeof raw.homepage === "string") meta.homepage = raw.homepage;

  if (Array.isArray(raw.os)) {
    meta.os = raw.os.filter((s): s is string => typeof s === "string");
  }

  const requires = raw.requires;
  if (requires && typeof requires === "object") {
    const req: SkillMetadata["requires"] = {};
    const r = requires as Record<string, unknown>;
    if (Array.isArray(r.bins)) {
      req.bins = r.bins.filter((s): s is string => typeof s === "string");
    }
    if (Array.isArray(r.anyBins)) {
      req.anyBins = r.anyBins.filter((s): s is string => typeof s === "string");
    }
    if (Array.isArray(r.env)) {
      req.env = r.env.filter((s): s is string => typeof s === "string");
    }
    if (req.bins || req.anyBins || req.env) {
      meta.requires = req;
    }
  }

  if (Array.isArray(raw.install)) {
    meta.install = raw.install
      .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
      .map((i) => ({
        kind: String(i.kind || "manual") as NonNullable<SkillMetadata["install"]> [number]["kind"],
        command: typeof i.command === "string" ? i.command : undefined,
        label: typeof i.label === "string" ? i.label : undefined,
      }));
  }

  return Object.keys(meta).length > 0 ? meta : null;
}

// ─── YAML-like Parser (enhanced from original) ───────────────────────────────

function parseYamlLike(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");
  let currentKey: string | null = null;
  let currentList: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // List item
    if (line.trimStart().startsWith("- ")) {
      const item = line.trimStart().slice(2).trim();
      if (currentKey) {
        currentList.push(item);
      }
      continue;
    }

    // If we were building a list, flush it
    if (currentKey && currentList.length > 0) {
      result[currentKey] = currentList;
      currentList = [];
      currentKey = null;
    }

    // Key: value line
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    if (!value) {
      // Might be a list starting next line
      currentKey = key;
      currentList = [];
      continue;
    }

    // Array inline: ["a", "b"] or ['a', 'b']
    if (value.startsWith("[") && value.endsWith("]")) {
      try {
        const inner = value.slice(1, -1);
        result[key] = inner
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter((s) => s.length > 0);
      } catch {
        result[key] = value;
      }
      continue;
    }

    // Inline JSON object: {"a": 1}
    if (value.startsWith("{") && value.endsWith("}")) {
      result[key] = value; // leave as string for metadata parser
      continue;
    }

    // Plain value
    result[key] = value.replace(/^["']|["']$/g, "");
  }

  // Flush final list
  if (currentKey && currentList.length > 0) {
    result[currentKey] = currentList;
  }

  return result;
}

// ─── Eligibility ─────────────────────────────────────────────────────────────

export function evaluateSkillEligibility(
  metadata: SkillMetadata | undefined
): { eligible: boolean; reason?: string } {
  if (!metadata) {
    return { eligible: true };
  }

  if (metadata.always) {
    return { eligible: true };
  }

  if (metadata.os && metadata.os.length > 0) {
    const platform = process.platform;
    if (!metadata.os.includes(platform)) {
      return { eligible: false, reason: `OS mismatch: requires ${metadata.os.join(", ")}, running ${platform}` };
    }
  }

  if (metadata.requires) {
    const req = metadata.requires;

    if (req.bins && req.bins.length > 0) {
      const missing = req.bins.filter((b) => !hasBinary(b));
      if (missing.length > 0) {
        return { eligible: false, reason: `missing bins: ${missing.join(", ")}` };
      }
    }

    if (req.anyBins && req.anyBins.length > 0) {
      const hasAny = req.anyBins.some((b) => hasBinary(b));
      if (!hasAny) {
        return { eligible: false, reason: `missing any of bins: ${req.anyBins.join(", ")}` };
      }
    }

    if (req.env && req.env.length > 0) {
      const missing = req.env.filter((e) => !process.env[e]);
      if (missing.length > 0) {
        return { eligible: false, reason: `missing env: ${missing.join(", ")}` };
      }
    }
  }

  return { eligible: true };
}

// ─── Binary Check ────────────────────────────────────────────────────────────

const binaryCache = new Map<string, boolean>();

export function hasBinary(bin: string): boolean {
  const cached = binaryCache.get(bin);
  if (cached !== undefined) return cached;

  try {
    const cmd = process.platform === "win32" ? `where "${bin}"` : `which "${bin}"`;
    execSync(cmd, { stdio: "ignore", timeout: 5000 });
    binaryCache.set(bin, true);
    return true;
  } catch {
    binaryCache.set(bin, false);
    return false;
  }
}

// ─── Directory Resolution ────────────────────────────────────────────────────

export function resolveSkillScanDirs(workspace: string): Array<{ dir: string; source: SkillSource }> {
  const dirs: Array<{ dir: string; source: SkillSource }> = [];

  // 1. Builtin: locate package root relative to this file
  try {
    const __dirname = fileURLToPath(new URL(".", import.meta.url));
    const builtinDir = resolve(__dirname, "..", "..", "..", "..", "skills");
    dirs.push({ dir: builtinDir, source: "builtin" });
  } catch {
    // ignore
  }

  // 2. User-level
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    dirs.push({ dir: resolve(home, ".simpleclaw", "skills"), source: "user" });
  }

  // 3. Workspace-level (highest priority)
  dirs.push({ dir: resolve(workspace, "skills"), source: "workspace" });

  return dirs;
}

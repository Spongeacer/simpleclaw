/**
 * SimpleClaw — Bounded User Memory
 * Inspired by Hermes Agent's MEMORY.md / USER.md design.
 * 
 * Two bounded files persist across all sessions:
 * - MEMORY.md: project facts, environment details, lessons learned (~2200 chars)
 * - USER.md: user preferences, communication style (~1375 chars)
 * 
 * Entries are §-delimited. Capacity limits force information density.
 * Files are human-editable and git-friendly.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { ILogger } from "../../core/interfaces.js";

export interface IUserMemory {
  readonly memoryPath: string;
  readonly userPath: string;
  readonly memoryCharLimit: number;
  readonly userCharLimit: number;
  load(): Promise<{ memory: string; user: string; memoryUsage: string; userUsage: string }>;
  addEntry(type: "memory" | "user", entry: string): Promise<{ success: boolean; error?: string; usage: string }>;
  replaceEntry(type: "memory" | "user", index: number, entry: string): Promise<{ success: boolean; error?: string; usage: string }>;
  removeEntry(type: "memory" | "user", index: number): Promise<{ success: boolean; error?: string; usage: string }>;
  listEntries(type: "memory" | "user"): Promise<{ entries: string[]; usage: string }>;
}

const DEFAULT_MEMORY_LIMIT = 2200;
const DEFAULT_USER_LIMIT = 1375;
const SECTION_DELIMITER = "\n§\n";

// Security patterns for memory content (prompt injection, exfiltration)
const MEMORY_THREAT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+instructions/i, reason: "prompt_injection" },
  { pattern: /you\s+are\s+now\s+/i, reason: "role_hijack" },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, reason: "deception_hide" },
  { pattern: /system\s+prompt\s+override/i, reason: "sys_prompt_override" },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, reason: "disregard_rules" },
  { pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i, reason: "bypass_restrictions" },
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, reason: "exfil_curl" },
  { pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, reason: "exfil_wget" },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, reason: "read_secrets" },
  { pattern: /authorized_keys/i, reason: "ssh_backdoor" },
  { pattern: /\$HOME\/\.ssh|\~\/\.ssh/i, reason: "ssh_access" },
];

export class FileUserMemory implements IUserMemory {
  readonly memoryCharLimit: number;
  readonly userCharLimit: number;

  constructor(
    readonly memoryPath: string,
    readonly userPath: string,
    private logger: ILogger,
    opts?: { memoryCharLimit?: number; userCharLimit?: number },
  ) {
    this.memoryCharLimit = opts?.memoryCharLimit ?? DEFAULT_MEMORY_LIMIT;
    this.userCharLimit = opts?.userCharLimit ?? DEFAULT_USER_LIMIT;
  }

  static async create(
    baseDir: string,
    logger: ILogger,
    opts?: { memoryCharLimit?: number; userCharLimit?: number },
  ): Promise<FileUserMemory> {
    await mkdir(baseDir, { recursive: true });
    const memoryPath = join(baseDir, "MEMORY.md");
    const userPath = join(baseDir, "USER.md");
    return new FileUserMemory(memoryPath, userPath, logger, opts);
  }

  async load(): Promise<{ memory: string; user: string; memoryUsage: string; userUsage: string }> {
    const memory = await this.readFileSafe(this.memoryPath);
    const user = await this.readFileSafe(this.userPath);
    return {
      memory,
      user,
      memoryUsage: this.computeUsage(memory, this.memoryCharLimit),
      userUsage: this.computeUsage(user, this.userCharLimit),
    };
  }

  async addEntry(
    type: "memory" | "user",
    entry: string,
  ): Promise<{ success: boolean; error?: string; usage: string }> {
    const clean = entry.trim();
    if (!clean) return { success: false, error: "Empty entry", usage: "" };

    const scan = this.scanContent(clean);
    if (!scan.safe) return { success: false, error: `Security scan failed: ${scan.reason}`, usage: "" };

    const limit = type === "memory" ? this.memoryCharLimit : this.userCharLimit;
    const path = type === "memory" ? this.memoryPath : this.userPath;
    const current = await this.readFileSafe(path);
    const entries = this.parseEntries(current);

    // Deduplication: exact match
    if (entries.some(e => e.trim() === clean)) {
      return { success: true, usage: this.computeUsage(current, limit) };
    }

    const newContent = current ? `${current}${SECTION_DELIMITER}${clean}` : clean;
    if (newContent.length > limit) {
      return {
        success: false,
        error: `Memory at ${this.computeUsage(current, limit)}. Adding this entry (${clean.length} chars) would exceed the ${limit} char limit. Replace or remove existing entries first.`,
        usage: this.computeUsage(current, limit),
      };
    }

    await this.atomicWrite(path, newContent);
    this.logger.info(`User memory entry added`, { type, entryLength: clean.length });
    return { success: true, usage: this.computeUsage(newContent, limit) };
  }

  async replaceEntry(
    type: "memory" | "user",
    index: number,
    entry: string,
  ): Promise<{ success: boolean; error?: string; usage: string }> {
    const clean = entry.trim();
    if (!clean) return { success: false, error: "Empty entry", usage: "" };

    const scan = this.scanContent(clean);
    if (!scan.safe) return { success: false, error: `Security scan failed: ${scan.reason}`, usage: "" };

    const limit = type === "memory" ? this.memoryCharLimit : this.userCharLimit;
    const path = type === "memory" ? this.memoryPath : this.userPath;
    const current = await this.readFileSafe(path);
    const entries = this.parseEntries(current);

    if (index < 0 || index >= entries.length) {
      return { success: false, error: `Invalid index ${index}. Current entries: ${entries.length}`, usage: this.computeUsage(current, limit) };
    }

    entries[index] = clean;
    const newContent = entries.join(SECTION_DELIMITER);
    if (newContent.length > limit) {
      return {
        success: false,
        error: `Memory at ${this.computeUsage(newContent, limit)}. Consolidate further to fit within ${limit} chars.`,
        usage: this.computeUsage(newContent, limit),
      };
    }

    await this.atomicWrite(path, newContent);
    this.logger.info(`User memory entry replaced`, { type, index });
    return { success: true, usage: this.computeUsage(newContent, limit) };
  }

  async removeEntry(
    type: "memory" | "user",
    index: number,
  ): Promise<{ success: boolean; error?: string; usage: string }> {
    const limit = type === "memory" ? this.memoryCharLimit : this.userCharLimit;
    const path = type === "memory" ? this.memoryPath : this.userPath;
    const current = await this.readFileSafe(path);
    const entries = this.parseEntries(current);

    if (index < 0 || index >= entries.length) {
      return { success: false, error: `Invalid index ${index}. Current entries: ${entries.length}`, usage: this.computeUsage(current, limit) };
    }

    entries.splice(index, 1);
    const newContent = entries.join(SECTION_DELIMITER);
    await this.atomicWrite(path, newContent);
    this.logger.info(`User memory entry removed`, { type, index });
    return { success: true, usage: this.computeUsage(newContent, limit) };
  }

  async listEntries(type: "memory" | "user"): Promise<{ entries: string[]; usage: string }> {
    const limit = type === "memory" ? this.memoryCharLimit : this.userCharLimit;
    const path = type === "memory" ? this.memoryPath : this.userPath;
    const current = await this.readFileSafe(path);
    const entries = this.parseEntries(current);
    return { entries, usage: this.computeUsage(current, limit) };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private parseEntries(content: string): string[] {
    if (!content.trim()) return [];
    return content.split(SECTION_DELIMITER).map(e => e.trim()).filter(Boolean);
  }

  private computeUsage(content: string, limit: number): string {
    return `${content.length}/${limit} chars`;
  }

  private async readFileSafe(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "";
    }
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    const tmpPath = `${path}.tmp`;
    await writeFile(tmpPath, content, "utf-8");
    const { rename } = await import("fs/promises");
    await rename(tmpPath, path);
  }

  private scanContent(content: string): { safe: boolean; reason?: string } {
    for (const { pattern, reason } of MEMORY_THREAT_PATTERNS) {
      if (pattern.test(content)) {
        return { safe: false, reason };
      }
    }
    // Check for invisible unicode characters
    if (/[\u200B-\u200D\uFEFF]/.test(content)) {
      return { safe: false, reason: "invisible_unicode" };
    }
    return { safe: true };
  }
}

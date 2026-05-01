/**
 * SimpleClaw — Workspace Memory Index
 * Scans workspace files, builds incremental index in SQLite + FTS5.
 * Inspired by LOOM's context layer + OpenClaw's file indexing.
 */

import { readdir, stat, readFile, mkdir } from "fs/promises";
import { join, relative, resolve } from "path";
import type { ILogger } from "../../core/interfaces.js";
import type { IMemoryIndex } from "../../core/interfaces.js";
import type { MemorySearchResult, FileMapEntry, SyncResult } from "../../core/memory.js";
import { SqliteMemoryStore } from "./sqlite-store.js";
import { chunkMarkdown, extractExports, extractDescription } from "./markdown-chunker.js";

const IGNORE_DIRS = new Set([
  "node_modules", "dist", ".git", ".simpleclaw", ".openclaw-repair",
  "coverage", ".next", "build", "out", "target", "__pycache__", "venv", ".venv",
]);
const IGNORE_EXTS = new Set<string>([
  ".log", ".tmp", ".lock", ".min.js", ".min.css",
]);

export class WorkspaceMemoryIndex implements IMemoryIndex {
  private store: SqliteMemoryStore;

  constructor(
    dbPath: string,
    private logger: ILogger,
  ) {
    this.store = new SqliteMemoryStore(dbPath, logger);
  }

  get enabled(): boolean {
    return this.store.enabled;
  }

  // ── Sync ────────────────────────────────────────────────────────────────────

  async sync(workspaceDir: string): Promise<SyncResult> {
    if (!this.enabled) {
      return { indexedFiles: 0, removedFiles: 0, chunks: 0 };
    }

    const start = Date.now();
    const absWorkspace = resolve(workspaceDir);

    // 1. Discover files
    const files = await this.discoverFiles(absWorkspace);
    const indexedPaths = new Set(files.map(f => f.path));

    // 2. Get already indexed files
    const existingFiles = this.store.getAllFiles();
    const existingPaths = new Map(existingFiles.map(f => [f.path, f]));

    let indexed = 0;
    let removed = 0;
    let totalChunks = 0;

    // 3. Process new/changed files
    for (const file of files) {
      const existing = existingPaths.get(file.path);
      if (existing && existing.hash === file.hash) {
        continue; // unchanged
      }

      // Remove old chunks
      this.store.deleteChunksByPath(file.path);
      this.store.deleteFileMap(file.path);

      // Index file
      const chunks = await this.indexFile(file.path, file.content, absWorkspace);
      totalChunks += chunks;

      // Update tracking
      this.store.upsertFile(file.path, file.hash, file.mtime, file.size);

      indexed++;
    }

    // 4. Remove deleted files
    for (const existing of existingFiles) {
      if (!indexedPaths.has(existing.path)) {
        this.store.deleteChunksByPath(existing.path);
        this.store.deleteFileMap(existing.path);
        this.store.deleteFile(existing.path);
        removed++;
      }
    }

    const elapsed = Date.now() - start;
    this.logger.info("Memory sync complete", { indexed, removed, chunks: totalChunks, elapsedMs: elapsed });

    return { indexedFiles: indexed, removedFiles: removed, chunks: totalChunks };
  }

  private async discoverFiles(workspaceDir: string): Promise<Array<{
    path: string;
    hash: string;
    mtime: number;
    size: number;
    content: string;
  }>> {
    const result: Array<{ path: string; hash: string; mtime: number; size: number; content: string }> = [];

    const scanDir = async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          await scanDir(fullPath);
        } else if (entry.isFile()) {
          const relPath = relative(workspaceDir, fullPath).replace(/\\/g, "/");
          if (this.shouldIgnoreFile(relPath)) continue;

          try {
            const s = await stat(fullPath);
            const content = await readFile(fullPath, "utf-8");
            const hash = SqliteMemoryStore.hashContent(content);
            result.push({ path: relPath, hash, mtime: s.mtimeMs, size: s.size, content });
          } catch {
            // skip unreadable files
          }
        }
      }
    };

    // Scan memory/ dir and MEMORY.md
    const memoryDir = join(workspaceDir, "memory");
    const memoryRoot = join(workspaceDir, "MEMORY.md");

    if (await this.fileExists(memoryRoot)) {
      try {
        const s = await stat(memoryRoot);
        const content = await readFile(memoryRoot, "utf-8");
        const hash = SqliteMemoryStore.hashContent(content);
        result.push({ path: "MEMORY.md", hash, mtime: s.mtimeMs, size: s.size, content });
      } catch { /* ignore */ }
    }

    if (await this.dirExists(memoryDir)) {
      await scanDir(memoryDir);
    }

    // Also scan source code for file map (lightweight)
    const srcDir = join(workspaceDir, "src");
    if (await this.dirExists(srcDir)) {
      await this.scanSourceForMap(srcDir, workspaceDir);
    }

    return result;
  }

  private async scanSourceForMap(srcDir: string, workspaceDir: string): Promise<void> {
    const scan = async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          await scan(fullPath);
        } else if (entry.isFile() && /\.(ts|js|tsx|jsx|py|go|rs|java)$/.test(entry.name)) {
          const relPath = relative(workspaceDir, fullPath).replace(/\\/g, "/");
          try {
            const content = await readFile(fullPath, "utf-8");
            const exports = extractExports(content);
            const description = extractDescription(content);
            const keywords = this.inferKeywords(relPath, content);
            this.store.upsertFileMap({
              path: relPath,
              description: description || `${entry.name} source file`,
              exports,
              keywords,
            });
          } catch { /* ignore */ }
        }
      }
    };
    await scan(srcDir);
  }

  private inferKeywords(path: string, content: string): string[] {
    const keywords: string[] = [];
    // From path segments
    const segments = path.split("/").filter(s => s && !s.match(/^(src|dist|node_modules|index)$/));
    keywords.push(...segments);
    // From common patterns
    if (content.includes("export interface")) keywords.push("interface", "types");
    if (content.includes("export class")) keywords.push("class");
    if (content.includes("export function")) keywords.push("function");
    if (content.includes("async ")) keywords.push("async");
    return [...new Set(keywords)];
  }

  private shouldIgnoreFile(relPath: string): boolean {
    const lower = relPath.toLowerCase();
    if (lower.includes("/test/") || lower.includes(".test.") || lower.includes(".spec.")) return true;
    if ([...IGNORE_EXTS].some((ext: string) => lower.endsWith(ext))) return true;
    return false;
  }

  private async indexFile(relPath: string, content: string, _workspaceDir: string): Promise<number> {
    let chunks = 0;

    if (relPath.endsWith(".md")) {
      // Markdown: chunk by headings
      const mdChunks = chunkMarkdown(content);
      for (const chunk of mdChunks) {
        this.store.insertChunk(relPath, chunk.text, chunk.startLine, chunk.endLine);
        chunks++;
      }
    } else {
      // Code files: store first 3000 chars as a single chunk for FTS
      const preview = content.slice(0, 3000);
      this.store.insertChunk(relPath, preview, 1, content.split("\n").length);
      chunks = 1;
    }

    return chunks;
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  async search(query: string, opts?: { maxResults?: number }): Promise<MemorySearchResult[]> {
    if (!this.enabled) return [];
    return this.store.searchChunks(query, opts?.maxResults ?? 5);
  }

  async findFiles(query: string, opts?: { maxResults?: number }): Promise<FileMapEntry[]> {
    if (!this.enabled) return [];
    return this.store.searchFileMap(query, opts?.maxResults ?? 5);
  }

  async getRecentFiles(maxResults?: number): Promise<{ path: string; description?: string }[]> {
    if (!this.enabled) return [];
    const entries = this.store.getRecentFiles(maxResults ?? 10);
    return entries.map(e => ({ path: e.path, description: e.description }));
  }

  async touchFile(path: string): Promise<void> {
    if (!this.enabled) return;
    this.store.touchFile(path);
  }

  async getKnownPaths(): Promise<string[]> {
    if (!this.enabled) return [];
    return this.store.getAllPaths();
  }

  async updateAccessed(path: string): Promise<void> {
    await this.touchFile(path);
  }

  async correctPath(path: string): Promise<string | null> {
    if (!this.enabled) return null;
    const knownPaths = this.store.getAllPaths();
    if (knownPaths.includes(path)) return path;

    // Simple fuzzy match: check if any known path ends with or contains the requested path
    const candidates = knownPaths
      .map(p => ({ path: p, score: this.similarity(path, p) }))
      .filter(c => c.score > 0.5)
      .sort((a, b) => b.score - a.score);

    return candidates.length > 0 ? candidates[0].path : null;
  }

  private similarity(a: string, b: string): number {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    if (bl.endsWith(al) || bl.includes(al)) return 0.9;
    if (al.endsWith(bl) || al.includes(bl)) return 0.85;
    // Simple Levenshtein-like: count common substrings
    let common = 0;
    for (let i = 0; i < Math.min(al.length, bl.length); i++) {
      if (al[i] === bl[i]) common++;
    }
    return common / Math.max(al.length, bl.length);
  }

  // ── Root memory ─────────────────────────────────────────────────────────────

  async getRootMemory(workspaceDir: string): Promise<string | null> {
    const memoryPath = join(workspaceDir, "MEMORY.md");
    try {
      return await readFile(memoryPath, "utf-8");
    } catch {
      return null;
    }
  }

  // ── Save memory ─────────────────────────────────────────────────────────────

  // ── Lossless Context Management ─────────────────────────────────────────────

  async archiveTurns(sessionId: string, turns: Array<{
    id: string;
    role: string;
    content: string;
    reasoning?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    timestamp: Date;
  }>): Promise<void> {
    if (!this.enabled) return;
    this.store.archiveTurns(sessionId, turns);
    this.logger.debug("Turns archived", { sessionId, count: turns.length });
  }

  async searchHistory(sessionId: string | undefined, query: string, opts?: { maxResults?: number }): Promise<MemorySearchResult[]> {
    if (!this.enabled) return [];
    return this.store.searchHistory(sessionId, query, opts?.maxResults ?? 5);
  }

  // ── Save memory ─────────────────────────────────────────────────────────────

  async saveMemory(workspaceDir: string, title: string, content: string, type?: string): Promise<string> {
    const memoryDir = join(workspaceDir, "memory");
    await mkdir(memoryDir, { recursive: true });

    const safeTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const fileName = `${safeTitle}.md`;
    const filePath = join(memoryDir, fileName);

    const frontmatter = type ? `---\ntype: ${type}\ncreated: ${new Date().toISOString()}\n---\n\n` : "";
    const fullContent = `${frontmatter}# ${title}\n\n${content}\n`;

    await readFile(filePath, "utf-8").catch(() => ""); // check if exists
    const { writeFile } = await import("fs/promises");
    await writeFile(filePath, fullContent, "utf-8");

    this.logger.info("Memory saved", { path: relative(workspaceDir, filePath).replace(/\\/g, "/") });
    return relative(workspaceDir, filePath).replace(/\\/g, "/");
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async fileExists(path: string): Promise<boolean> {
    try {
      const s = await stat(path);
      return s.isFile();
    } catch {
      return false;
    }
  }

  private async dirExists(path: string): Promise<boolean> {
    try {
      const s = await stat(path);
      return s.isDirectory();
    } catch {
      return false;
    }
  }
}



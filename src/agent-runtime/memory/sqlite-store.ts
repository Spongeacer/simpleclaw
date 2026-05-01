/**
 * SimpleClaw — SQLite Memory Store
 * Uses node:sqlite (Node 22 builtin) with FTS5 for full-text search.
 * Gracefully degrades if sqlite is unavailable.
 */

import type { ILogger } from "../../core/interfaces.js";
import type { MemorySearchResult, FileMapEntry } from "../../core/memory.js";
import { createHash } from "crypto";

let sqlite: typeof import("node:sqlite") | null = null;
try {
  sqlite = await import("node:sqlite");
} catch {
  // graceful degradation
}

interface FileRecord {
  path: string;
  hash: string;
  mtime: number;
  size: number;
}

export class SqliteMemoryStore {
  private db?: InstanceType<NonNullable<typeof sqlite>["DatabaseSync"]>;

  constructor(dbPath: string, private logger: ILogger) {
    if (!sqlite) {
      this.logger.warn("node:sqlite unavailable, memory system disabled");
      return;
    }
    try {
      this.db = new sqlite.DatabaseSync(dbPath);
      this.initSchema();
    } catch (e) {
      this.logger.error("Failed to open memory database", { error: String(e) });
    }
  }

  get enabled(): boolean {
    return !!this.db;
  }

  private initSchema(): void {
    if (!this.db) return;

    this.db.exec(`PRAGMA journal_mode = WAL;`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_access (
        path TEXT PRIMARY KEY,
        last_accessed INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        text,
        path UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_map (
        path TEXT PRIMARY KEY,
        description TEXT,
        exports TEXT,
        keywords TEXT,
        last_accessed INTEGER
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        reasoning TEXT,
        timestamp INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_history_session ON session_history(session_id);
    `);

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_history_fts USING fts5(
        content,
        session_id UNINDEXED,
        turn_id UNINDEXED,
        role UNINDEXED
      );
    `);
  }

  insertChunk(path: string, text: string, startLine: number, endLine: number): void {
    if (!this.db) return;
    const stmt = this.db.prepare(
      `INSERT INTO chunks (text, path, start_line, end_line) VALUES (?, ?, ?, ?)`
    );
    stmt.run(text, path, startLine, endLine);
  }

  deleteChunksByPath(path: string): void {
    if (!this.db) return;
    const stmt = this.db.prepare(`DELETE FROM chunks WHERE path = ?`);
    stmt.run(path);
  }

  searchChunks(query: string, maxResults: number = 5): MemorySearchResult[] {
    if (!this.db) return [];
    try {
      const stmt = this.db.prepare(
        `SELECT text, path, start_line, end_line, rank AS score
         FROM chunks
         WHERE chunks MATCH ?
         ORDER BY rank
         LIMIT ?`
      );
      const rows = stmt.all(query, maxResults) as Array<{
        text: string; path: string; start_line: number; end_line: number; score: number;
      }>;
      return rows.map(r => ({
        path: r.path,
        text: r.text,
        startLine: r.start_line,
        endLine: r.end_line,
        score: r.score,
      }));
    } catch {
      return [];
    }
  }

  getAllFiles(): FileRecord[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(`SELECT path, hash, mtime, size FROM files`);
    return stmt.all() as unknown as FileRecord[];
  }

  upsertFile(path: string, hash: string, mtime: number, size: number): void {
    if (!this.db) return;
    const stmt = this.db.prepare(
      `INSERT INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, mtime=excluded.mtime, size=excluded.size`
    );
    stmt.run(path, hash, mtime, size);
  }

  deleteFile(path: string): void {
    if (!this.db) return;
    const stmt = this.db.prepare(`DELETE FROM files WHERE path = ?`);
    stmt.run(path);
  }

  touchFile(path: string): void {
    if (!this.db) return;
    const stmt = this.db.prepare(
      `INSERT INTO file_access (path, last_accessed) VALUES (?, ?)
       ON CONFLICT(path) DO UPDATE SET last_accessed=excluded.last_accessed`
    );
    stmt.run(path, Date.now());
  }

  getRecentFiles(maxResults: number = 10): FileMapEntry[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(
      `SELECT f.path, fm.description, fm.exports, fm.keywords, fa.last_accessed
       FROM file_access fa
       LEFT JOIN file_map fm ON fa.path = fm.path
       ORDER BY fa.last_accessed DESC
       LIMIT ?`
    );
    const rows = stmt.all(maxResults) as Array<{
      path: string; description: string | null; exports: string | null;
      keywords: string | null; last_accessed: number | null;
    }>;
    return rows.map(r => ({
      path: r.path,
      description: r.description ?? undefined,
      exports: r.exports ? JSON.parse(r.exports) : [],
      keywords: r.keywords ? JSON.parse(r.keywords) : [],
      lastAccessed: r.last_accessed ?? undefined,
    }));
  }

  upsertFileMap(entry: FileMapEntry): void {
    if (!this.db) return;
    const stmt = this.db.prepare(
      `INSERT INTO file_map (path, description, exports, keywords, last_accessed)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         description=excluded.description,
         exports=excluded.exports,
         keywords=excluded.keywords,
         last_accessed=excluded.last_accessed`
    );
    stmt.run(
      entry.path,
      entry.description ?? null,
      JSON.stringify(entry.exports),
      JSON.stringify(entry.keywords),
      entry.lastAccessed ?? null
    );
  }

  deleteFileMap(path: string): void {
    if (!this.db) return;
    const stmt = this.db.prepare(`DELETE FROM file_map WHERE path = ?`);
    stmt.run(path);
  }

  searchFileMap(query: string, maxResults: number = 5): FileMapEntry[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(
      `SELECT path, description, exports, keywords, last_accessed
       FROM file_map
       WHERE path LIKE ? OR description LIKE ? OR keywords LIKE ? OR exports LIKE ?
       ORDER BY last_accessed DESC NULLS LAST
       LIMIT ?`
    );
    const pattern = `%${query}%`;
    const rows = stmt.all(pattern, pattern, pattern, pattern, maxResults) as Array<{
      path: string; description: string | null; exports: string | null;
      keywords: string | null; last_accessed: number | null;
    }>;
    return rows.map(r => ({
      path: r.path,
      description: r.description ?? undefined,
      exports: r.exports ? JSON.parse(r.exports) : [],
      keywords: r.keywords ? JSON.parse(r.keywords) : [],
      lastAccessed: r.last_accessed ?? undefined,
    }));
  }

  getAllPaths(): string[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(`SELECT path FROM file_map`);
    const rows = stmt.all() as Array<{ path: string }>;
    return rows.map(r => r.path);
  }

  // ── Session History (Lossless Context Management) ──────────────────────────

  archiveTurns(sessionId: string, turns: Array<{
    id: string;
    role: string;
    content: string;
    reasoning?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    timestamp: Date;
  }>): void {
    if (!this.db || turns.length === 0) return;

    this.db.exec("BEGIN");
    try {
      const insertStmt = this.db.prepare(
        `INSERT INTO session_history (session_id, turn_id, role, content, tool_calls, reasoning, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const ftsStmt = this.db.prepare(
        `INSERT INTO session_history_fts (content, session_id, turn_id, role)
         VALUES (?, ?, ?, ?)`
      );

      for (const turn of turns) {
        const toolCallsJson = turn.toolCalls ? JSON.stringify(turn.toolCalls) : null;
        insertStmt.run(
          sessionId,
          turn.id,
          turn.role,
          turn.content,
          toolCallsJson,
          turn.reasoning ?? null,
          turn.timestamp.getTime()
        );
        ftsStmt.run(turn.content, sessionId, turn.id, turn.role);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  searchHistory(sessionId: string | undefined, query: string, maxResults: number = 5): Array<{
    path: string;
    text: string;
    startLine: number;
    endLine: number;
    score: number;
  }> {
    if (!this.db) return [];
    try {
      // Escape FTS5 special characters: " * ( ) AND OR NOT NEAR
      const safeQuery = query
        .replace(/"/g, '""')
        .replace(/[*()]/g, " ")
        .replace(/\b(AND|OR|NOT|NEAR)\b/g, m => `"${m.toLowerCase()}"`);

      let rows: Array<{ content: string; turn_id: string; role: string; timestamp: number; score: number; session_id?: string }>;

      if (sessionId) {
        const stmt = this.db.prepare(
          `SELECT h.content, h.turn_id, h.role, h.timestamp, rank AS score
           FROM session_history_fts fts
           JOIN session_history h ON fts.turn_id = h.turn_id AND fts.session_id = h.session_id
           WHERE session_history_fts MATCH ? AND h.session_id = ?
           ORDER BY rank
           LIMIT ?`
        );
        rows = stmt.all(safeQuery, sessionId, maxResults) as typeof rows;
      } else {
        const stmt = this.db.prepare(
          `SELECT h.content, h.turn_id, h.role, h.timestamp, rank AS score, h.session_id
           FROM session_history_fts fts
           JOIN session_history h ON fts.turn_id = h.turn_id AND fts.session_id = h.session_id
           WHERE session_history_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        );
        rows = stmt.all(safeQuery, maxResults) as typeof rows;
      }

      return rows.map(r => ({
        path: `${r.role} (${new Date(r.timestamp).toISOString()})${r.session_id ? ` [${r.session_id.slice(0, 8)}]` : ""}`,
        text: r.content,
        startLine: 0,
        endLine: 0,
        score: r.score,
      }));
    } catch {
      return [];
    }
  }

  getHistoryCount(sessionId: string): number {
    if (!this.db) return 0;
    const stmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM session_history WHERE session_id = ?`);
    const row = stmt.get(sessionId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  static hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }
}

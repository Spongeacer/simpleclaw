/**
 * SimpleClaw — Session store interface + implementations
 * Stateless gateway: all session state lives here, not in memory.
 */

import { DatabaseSync } from "node:sqlite";
import type { SessionId } from "../core/types.js";
import type { ISessionStore, ISessionState } from "../core/interfaces.js";

export { type ISessionState as SessionState } from "../core/interfaces.js";

// ─── Memory ──────────────────────────────────────────────────────────────────

export class MemorySessionStore implements ISessionStore {
  private data = new Map<SessionId, ISessionState>();

  async create(state: Omit<ISessionState, "createdAt" | "updatedAt">): Promise<ISessionState> {
    const now = new Date();
    const full: ISessionState = { ...state, createdAt: now, updatedAt: now };
    this.data.set(state.sessionId, full);
    return full;
  }

  async get(sessionId: SessionId): Promise<ISessionState | null> {
    return this.data.get(sessionId) ?? null;
  }

  async update(sessionId: SessionId, patch: Partial<Omit<ISessionState, "sessionId" | "createdAt">>): Promise<void> {
    const existing = this.data.get(sessionId);
    if (!existing) throw new Error(`Session not found: ${sessionId}`);
    Object.assign(existing, patch, { updatedAt: new Date() });
  }

  async delete(sessionId: SessionId): Promise<void> {
    this.data.delete(sessionId);
  }

  async list(agentId?: string): Promise<ISessionState[]> {
    const all = Array.from(this.data.values());
    return agentId ? all.filter((s) => s.agentId === agentId) : all;
  }
}

// ─── SQLite ──────────────────────────────────────────────────────────────────

export class SQLiteSessionStore implements ISessionStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        channel_id TEXT,
        parent_session_id TEXT,
        turns TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);`);
  }

  async create(state: Omit<ISessionState, "createdAt" | "updatedAt">): Promise<ISessionState> {
    const now = new Date();
    const full: ISessionState = { ...state, createdAt: now, updatedAt: now };
    const stmt = this.db.prepare(
      `INSERT INTO sessions (session_id, agent_id, channel_id, parent_session_id, turns, token_count, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      full.sessionId,
      full.agentId,
      full.channelId ?? null,
      full.parentSessionId ?? null,
      JSON.stringify(full.turns),
      full.tokenCount,
      full.metadata ? JSON.stringify(full.metadata) : null,
      full.createdAt.toISOString(),
      full.updatedAt.toISOString()
    );
    return full;
  }

  async get(sessionId: SessionId): Promise<ISessionState | null> {
    const stmt = this.db.prepare(`SELECT * FROM sessions WHERE session_id = ?`);
    const row = stmt.get(sessionId) as RawSessionRow | undefined;
    return row ? hydrate(row) : null;
  }

  async update(sessionId: SessionId, patch: Partial<Omit<ISessionState, "sessionId" | "createdAt">>): Promise<void> {
    const existing = await this.get(sessionId);
    if (!existing) throw new Error(`Session not found: ${sessionId}`);

    const merged: ISessionState = { ...existing, ...patch, updatedAt: new Date() };
    const stmt = this.db.prepare(
      `UPDATE sessions
       SET agent_id = ?, channel_id = ?, parent_session_id = ?, turns = ?, token_count = ?, metadata = ?, updated_at = ?
       WHERE session_id = ?`
    );
    stmt.run(
      merged.agentId,
      merged.channelId ?? null,
      merged.parentSessionId ?? null,
      JSON.stringify(merged.turns),
      merged.tokenCount,
      merged.metadata ? JSON.stringify(merged.metadata) : null,
      merged.updatedAt.toISOString(),
      sessionId
    );
  }

  async delete(sessionId: SessionId): Promise<void> {
    const stmt = this.db.prepare(`DELETE FROM sessions WHERE session_id = ?`);
    stmt.run(sessionId);
  }

  async list(agentId?: string): Promise<ISessionState[]> {
    let rows: RawSessionRow[];
    if (agentId) {
      const stmt = this.db.prepare(`SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC`);
      rows = stmt.all(agentId) as unknown as RawSessionRow[];
    } else {
      const stmt = this.db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`);
      rows = stmt.all() as unknown as RawSessionRow[];
    }
    return rows.map(hydrate);
  }

  close(): void {
    this.db.close();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface RawSessionRow {
  session_id: string;
  agent_id: string;
  channel_id: string | null;
  parent_session_id: string | null;
  turns: string;
  token_count: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

function hydrate(row: RawSessionRow): ISessionState {
  return {
    sessionId: row.session_id,
    agentId: row.agent_id,
    channelId: row.channel_id ?? undefined,
    parentSessionId: row.parent_session_id ?? undefined,
    turns: JSON.parse(row.turns),
    tokenCount: row.token_count,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

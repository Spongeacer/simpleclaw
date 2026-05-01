/**
 * SimpleClaw Core — Memory System Interfaces
 * Path-aware semantic memory for AI agents.
 * Inspired by LOOM's slot-based context + OpenClaw's file-index approach.
 */

// ─── Search Result ────────────────────────────────────────────────────────────

export interface MemorySearchResult {
  path: string;
  text: string;
  startLine: number;
  endLine: number;
  score: number;
}

export interface FileMapEntry {
  path: string;
  description?: string;
  exports: string[];
  keywords: string[];
  lastAccessed?: number;
}

// ─── Memory Index Interface ───────────────────────────────────────────────────

// Note: IMemoryIndex is defined in interfaces.ts to avoid duplication.
// This file exports additional memory-specific types used by the SQLite store.

export interface SyncResult {
  indexedFiles: number;
  removedFiles: number;
  chunks: number;
}

// SessionWorkingSet is defined privately in agent-engine.ts (transient per-session state).
// No global export needed — workspace memory types only below this line.

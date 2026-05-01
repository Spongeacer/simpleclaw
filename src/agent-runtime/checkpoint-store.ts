/**
 * SimpleClaw — Checkpoint Store
 * Append-only JSONL persistence for sub-agent events.
 * Enables crash recovery and post-hoc debugging of agent runs.
 *
 * Path: `{workspace}/.simpleclaw/checkpoints/{sessionId}.jsonl`
 */

import { mkdir, appendFile, readFile } from "fs/promises";
import { dirname } from "path";
import type { IChatEvent } from "../core/interfaces.js";

export interface CheckpointEntry {
  ts: string;
  event: IChatEvent;
}

export class CheckpointStore {
  constructor(private workspace: string) {}

  private path(sessionId: string): string {
    return `${this.workspace}/.simpleclaw/checkpoints/${sessionId}.jsonl`;
  }

  async append(sessionId: string, event: IChatEvent): Promise<void> {
    const filePath = this.path(sessionId);
    await mkdir(dirname(filePath), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), event } satisfies CheckpointEntry) + "\n";
    await appendFile(filePath, line, "utf-8");
  }

  async load(sessionId: string): Promise<IChatEvent[]> {
    try {
      const raw = await readFile(this.path(sessionId), "utf-8");
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return (JSON.parse(line) as CheckpointEntry).event;
          } catch {
            return null;
          }
        })
        .filter((e): e is IChatEvent => e !== null);
    } catch {
      return [];
    }
  }
}

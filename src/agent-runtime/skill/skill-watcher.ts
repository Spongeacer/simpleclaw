/**
 * SimpleClaw — Skill Watcher
 * Lightweight fs.watch-based hot-reload for skills.
 */

import { watch } from "fs";
import type { ILogger } from "../../core/interfaces.js";

export class SkillWatcher {
  private watchers: ReturnType<typeof watch>[] = [];
  private debounceTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private dirs: string[],
    private onChange: () => void | Promise<void>,
    private logger: ILogger,
    private debounceMs = 500,
  ) {}

  start(): void {
    for (const dir of this.dirs) {
      try {
        const w = watch(dir, { recursive: true }, (_eventType, filename) => {
          if (typeof filename === "string" && filename.endsWith("SKILL.md")) {
            this.handleChange();
          }
        });
        w.on("error", (err) => {
          this.logger.debug("Skill watcher error", { dir, error: String(err) });
        });
        this.watchers.push(w);
        this.logger.debug("Skill watcher started", { dir });
      } catch (err) {
        this.logger.debug("Failed to watch skill directory", { dir, error: String(err) });
      }
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.watchers = [];
    this.logger.debug("Skill watcher stopped");
  }

  private handleChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(async () => {
      this.logger.info("Skills changed, reloading...");
      try {
        await this.onChange();
      } catch (err) {
        this.logger.warn("Skill reload failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }, this.debounceMs);
  }
}

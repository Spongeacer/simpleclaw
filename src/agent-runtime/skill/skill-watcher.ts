/**
 * SimpleClaw — Skill Watcher
 * Cross-platform fs.watch-based hot-reload for skills.
 *
 * Note: Node.js fs.watch({ recursive: true }) is only supported on macOS and Windows.
 * On Linux we fall back to non-recursive watches plus per-subdirectory watchers.
 */

import { watch, existsSync } from "fs";
import type { ILogger } from "../../core/interfaces.js";

export class SkillWatcher {
  private watchers: ReturnType<typeof watch>[] = [];
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private pendingDirs: string[] = [];
  private isLinux = process.platform === "linux";

  constructor(
    private dirs: string[],
    private onChange: () => void | Promise<void>,
    private logger: ILogger,
    private debounceMs = 500,
  ) {}

  start(): void {
    for (const dir of this.dirs) {
      this.watchDir(dir);
    }
  }

  /** Add a new directory to watch at runtime (e.g. after skill_manage creates one). */
  addDir(dir: string): void {
    if (!this.dirs.includes(dir)) {
      this.dirs.push(dir);
    }
    this.watchDir(dir);
  }

  private watchDir(dir: string): void {
    if (!existsSync(dir)) {
      this.pendingDirs.push(dir);
      this.logger.debug("Skill directory does not exist yet, deferring watch", { dir });
      return;
    }

    try {
      if (this.isLinux) {
        // Linux: non-recursive watch on the top-level dir, then watch each subdir
        this.watchLinux(dir);
      } else {
        const w = watch(dir, { recursive: true }, (_eventType, filename) => {
          this.handleFilename(filename);
        });
        w.on("error", (err) => {
          this.logger.debug("Skill watcher error", { dir, error: String(err) });
        });
        this.watchers.push(w);
      }
      this.logger.debug("Skill watcher started", { dir });
    } catch (err) {
      this.logger.debug("Failed to watch skill directory", { dir, error: String(err) });
    }
  }

  private watchLinux(dir: string): void {
    // Watch the root directory for new subdirectories
    const rootWatcher = watch(dir, (_eventType, filename) => {
      this.handleFilename(filename);
      // When a new directory is created on Linux, add a watcher for it
      if (typeof filename === "string") {
        const { join } = require("path");
        const subPath = join(dir, filename);
        try {
          const { statSync } = require("fs");
          if (statSync(subPath).isDirectory()) {
            const sub = watch(subPath, (_et: string | null, fn: string | Buffer | null) => this.handleFilename(fn));
            sub.on("error", () => {});
            this.watchers.push(sub);
          }
        } catch { /* not a directory or doesn't exist */ }
      }
    });
    rootWatcher.on("error", () => {});
    this.watchers.push(rootWatcher);

    // Also watch existing subdirectories immediately
    try {
      const { readdirSync, statSync } = require("fs");
      const { join } = require("path");
      for (const entry of readdirSync(dir)) {
        const subPath = join(dir, entry);
        try {
          if (statSync(subPath).isDirectory()) {
            const sub = watch(subPath, (_et: string | null, fn: string | Buffer | null) => this.handleFilename(fn));
            sub.on("error", () => {});
            this.watchers.push(sub);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  private handleFilename(filename: string | Buffer | null): void {
    if (!filename) return;
    const name = Buffer.isBuffer(filename) ? filename.toString("utf-8") : filename;
    if (typeof name === "string" && name.endsWith("SKILL.md")) {
      this.handleChange();
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
    this.pendingDirs = [];
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

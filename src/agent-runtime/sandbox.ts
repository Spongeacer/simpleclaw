/**
 * SimpleClaw — Sandbox abstraction
 * MVP: docker backend + path safety. SSH backend deferred.
 */

import { spawn } from "child_process";
import { readFile, writeFile, mkdir, rename, unlink } from "fs/promises";
import { existsSync } from "fs";
import { resolve, isAbsolute, dirname, sep, join } from "path";
import { tmpdir } from "os";
import type { SandboxConfig } from "../core/types.js";
import type { ISandbox, ILogger, IExecResult } from "../core/interfaces.js";

/** Minimum secret length to redact (shorter values cause too many false positives) */
const REDACT_MIN_LENGTH = 4;

export interface Sandbox {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<IExecResult>;
}

export interface ExecOptions {
  timeoutMs?: number;    // default 120_000
  maxOutputBytes?: number; // default 10_000 per stream
}

export class PathGuard {
  constructor(
    private allowedPaths: string[],
    private deniedPaths: string[]
  ) {}

  assertSafe(rawPath: string, workspace: string): string {
    const target = isAbsolute(rawPath) ? rawPath : resolve(workspace, rawPath);
    const normalized = resolve(target);

    for (const denied of this.deniedPaths) {
      const d = resolve(denied);
      if (normalized === d || normalized.startsWith(d + sep)) {
        throw new Error(`Path "${rawPath}" is in denied list`);
      }
    }

    if (this.allowedPaths.length > 0) {
      const allowed = this.allowedPaths.some((a) => {
        const base = resolve(a);
        return normalized === base || normalized.startsWith(base + sep);
      });
      if (!allowed) {
        throw new Error(`Path "${rawPath}" is outside allowed paths`);
      }
    } else {
      const ws = resolve(workspace);
      if (!normalized.startsWith(ws + sep) && normalized !== ws) {
        throw new Error(`Path "${rawPath}" is outside workspace`);
      }
    }

    return normalized;
  }
}

export class DockerSandbox implements ISandbox {
  private guard: PathGuard;
  /** Per-file write lock queue. Keys are absolute paths. */
  private fileLocks = new Map<string, Promise<unknown>>();
  private _dockerChecked = false;
  private _dockerAvailable = false;

  constructor(
    private workspace: string,
    private config: SandboxConfig,
    private logger: ILogger,
    private env: Record<string, string> = {},
  ) {
    this.guard = new PathGuard(config.allowedPaths, config.deniedPaths);
    // Ensure workspace directory exists
    mkdir(this.workspace, { recursive: true }).catch((err) => {
      this.logger.error("Failed to create workspace directory", {
        path: this.workspace,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  resolvePath(rawPath: string): string {
    return this.guard.assertSafe(rawPath, this.workspace);
  }

  async readFile(rawPath: string): Promise<string> {
    const path = this.resolvePath(rawPath);
    return readFile(path, "utf-8");
  }

  async writeFile(rawPath: string, content: string, expectedContent?: string): Promise<void> {
    const path = this.guard.assertSafe(rawPath, this.workspace);
    await this.withWriteLock(path, async () => {
      // Optimistic concurrency check inside the write lock
      if (expectedContent !== undefined) {
        const current = await readFile(path, "utf-8").catch(() => "");
        if (current !== expectedContent) {
          throw new Error(
            `File "${rawPath}" was modified by another process while editing. ` +
            `Please re-read the file with the 'read' tool and try your edit again.`
          );
        }
      }
      await mkdir(dirname(path), { recursive: true });
      // Atomic write: write to temp file, then rename
      const tempPath = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
      try {
        await writeFile(tempPath, content, "utf-8");
        await rename(tempPath, path);
      } catch (err) {
        // Clean up temp file on failure
        try { await unlink(tempPath); } catch { /* ignore cleanup errors */ }
        throw err;
      }
    });
  }

  /**
   * Acquire an exclusive write lock for a file path.
   * Concurrent writes to the same path are serialized via a promise chain.
   *
   * Previous implementation had a check-then-act race: two callers could both
   * pass the while-loop before either set the lock. This chain-based approach
   * guarantees serial execution because each new caller chains onto the
   * previous lock promise atomically (no await between check and set).
   */
  private async withWriteLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.fileLocks.get(path);
    const current = (async () => {
      if (previous) await previous.catch(() => {});
      return fn();
    })();
    this.fileLocks.set(path, current);
    const timer = setTimeout(() => {
      this.logger.warn("Write lock held for a long time", { path, timeoutMs: 300_000 });
    }, 300_000);
    try {
      return await current;
    } finally {
      clearTimeout(timer);
      // Only delete if we're still the current lock (not overwritten by a later one)
      if (this.fileLocks.get(path) === current) {
        this.fileLocks.delete(path);
      }
    }
  }

  /**
   * Execute a command in the native shell of the current platform.
   * Windows → PowerShell, Linux/macOS → sh.
   */
  async exec(command: string, options: ExecOptions = {}): Promise<IExecResult> {
    if (this.config.backend === "none") {
      throw new Error("Sandbox backend is 'none'; shell execution disabled");
    }

    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxOutputBytes = options.maxOutputBytes ?? 10_000;

    this.logger.info("Shell exec", { command, workspace: this.workspace, timeoutMs, platform: process.platform });

    const isDockerAvailable = await this.checkDocker();
    if (!isDockerAvailable) {
      this.logger.warn("Docker not available; falling back to direct spawn for MVP");
      return this.directSpawn(command, timeoutMs, maxOutputBytes);
    }

    return this.dockerSpawn(command, timeoutMs, maxOutputBytes);
  }

  /**
   * Execute a command in a true Linux bash environment.
   * On Windows this requires Docker. If Docker is unavailable, throws an error.
   * On Linux/macOS this falls back to native bash if Docker is unavailable.
   */
  async execBash(command: string, options: ExecOptions = {}): Promise<IExecResult> {
    if (this.config.backend === "none") {
      throw new Error("Sandbox backend is 'none'; shell execution disabled");
    }

    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxOutputBytes = options.maxOutputBytes ?? 10_000;

    this.logger.info("Bash exec", { command, workspace: this.workspace, timeoutMs });

    const isDockerAvailable = await this.checkDocker();
    if (isDockerAvailable) {
      return this.dockerSpawn(command, timeoutMs, maxOutputBytes);
    }

    if (process.platform === "win32") {
      throw new Error(
        "Docker is not available on this Windows host. " +
        "The 'bash' tool requires a Linux environment. " +
        "Use the 'shell' tool instead for cross-platform commands."
      );
    }

    // Linux/macOS fallback: try native bash
    this.logger.warn("Docker not available; falling back to native bash");
    return this.directSpawn(command, timeoutMs, maxOutputBytes);
  }

  getPlatformInfo(): { platform: string; shell: string; availableCommands: string } {
    if (process.platform === "win32") {
      return {
        platform: "Windows",
        shell: "PowerShell",
        availableCommands:
          "Get-Content (cat), Get-ChildItem (ls), Select-String (grep), Measure-Object, " +
          "Remove-Item (rm), Copy-Item (cp), Move-Item (mv), New-Item (touch), " +
          "Write-Output (echo), Set-Location (cd). " +
          "For Linux-specific tools (awk, sed, bash scripts) use the 'bash' tool instead.",
      };
    }
    return {
      platform: "Linux/macOS",
      shell: "bash/sh",
      availableCommands:
        "ls, cat, grep, awk, sed, find, head, tail, wc, chmod, mkdir, rm, cp, mv, echo, cd.",
    };
  }

  // ─── Background Process Management ────────────────────────────────────────────

  private backgroundProcesses = new Map<
    string,
    {
      child: ReturnType<typeof spawn>;
      stdout: string;
      stderr: string;
      done: boolean;
      exitCode?: number;
      killed: boolean;
    }
  >();

  async execBackground(command: string, options: { timeoutMs?: number } = {}): Promise<{ shellId: string }> {
    if (this.config.backend === "none") {
      throw new Error("Sandbox backend is 'none'; shell execution disabled");
    }

    const timeoutMs = options.timeoutMs ?? 600_000; // max 600s default
    const shellId = `sh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    this.logger.info("Background shell start", { shellId, command, timeoutMs });

    const { shell, args } = this.getShellConfig();
    const child = spawn(shell, [...args, command], {
      cwd: this.workspace,
      env: { ...process.env, ...this.env },
    });

    this.backgroundProcesses.set(shellId, {
      child,
      stdout: "",
      stderr: "",
      done: false,
      killed: false,
    });

    child.stdout?.on("data", (d: Buffer) => {
      const proc = this.backgroundProcesses.get(shellId);
      if (proc) proc.stdout += d.toString("utf-8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      const proc = this.backgroundProcesses.get(shellId);
      if (proc) proc.stderr += d.toString("utf-8");
    });

    child.on("close", (code) => {
      const proc = this.backgroundProcesses.get(shellId);
      if (proc) {
        proc.done = true;
        proc.exitCode = code ?? 0;
        // Auto-cleanup after 5 minutes to prevent memory leaks
        setTimeout(() => {
          this.backgroundProcesses.delete(shellId);
        }, 300_000);
      }
    });

    child.on("error", (err) => {
      const proc = this.backgroundProcesses.get(shellId);
      if (proc) {
        proc.stderr += `\n[process error: ${err.message}]\n`;
        proc.done = true;
        proc.exitCode = -1;
      }
    });

    // Auto-kill after timeout
    if (timeoutMs > 0 && timeoutMs < Infinity) {
      setTimeout(() => {
        const proc = this.backgroundProcesses.get(shellId);
        if (proc && !proc.done) {
          this.killTree(proc.child);
          proc.killed = true;
        }
      }, timeoutMs);
    }

    return { shellId };
  }

  async getBackgroundOutput(
    shellId: string,
    offset = 0,
  ): Promise<{ stdout: string; stderr: string; done: boolean; exitCode?: number }> {
    const proc = this.backgroundProcesses.get(shellId);
    if (!proc) {
      throw new Error(`Shell "${shellId}" not found`);
    }
    return {
      stdout: this.redact(proc.stdout.slice(offset)),
      stderr: this.redact(proc.stderr.slice(offset)),
      done: proc.done,
      exitCode: proc.exitCode,
    };
  }

  async killBackground(shellId: string): Promise<boolean> {
    const proc = this.backgroundProcesses.get(shellId);
    if (!proc) return false;
    if (proc.done) return true;
    this.killTree(proc.child);
    proc.killed = true;
    proc.done = true;
    return true;
  }

  private async checkDocker(): Promise<boolean> {
    if (this._dockerChecked) return this._dockerAvailable;
    this._dockerChecked = true;
    try {
      const { stdout } = await this.directSpawn("docker version", 10_000, 1_000);
      this._dockerAvailable = stdout.includes("Version:");
      return this._dockerAvailable;
    } catch {
      this._dockerAvailable = false;
      return false;
    }
  }

  /**
   * Resolve the appropriate shell and args for the current platform.
   * Windows: PowerShell (pwsh.exe > powershell.exe) for proper stdout capture.
   * Unix: sh (bash is not guaranteed in minimal containers).
   */
  private getShellConfig(): { shell: string; args: string[] } {
    if (process.platform === "win32") {
      const programFiles = process.env.ProgramFiles || "C:\\Program Files";
      const pwsh7 = join(programFiles, "PowerShell", "7", "pwsh.exe");
      if (existsSync(pwsh7)) {
        return { shell: pwsh7, args: ["-NoProfile", "-NonInteractive", "-Command"] };
      }
      const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
      const ps51 = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      if (existsSync(ps51)) {
        return { shell: ps51, args: ["-NoProfile", "-NonInteractive", "-Command"] };
      }
      return { shell: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command"] };
    }
    return { shell: "sh", args: ["-c"] };
  }

  private directSpawn(command: string, timeoutMs: number, maxOutputBytes: number): Promise<IExecResult> {
    return new Promise((resolve, reject) => {
      const { shell, args } = this.getShellConfig();
      const child = spawn(shell, [...args, command], {
        cwd: this.workspace,
        env: { ...process.env, ...this.env },
      });

      let stdoutFull = "";
      let stderrFull = "";
      const killTimer = setTimeout(() => {
        this.killTree(child);
      }, timeoutMs);

      child.stdout?.on("data", (d: Buffer) => {
        stdoutFull += d;
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderrFull += d;
      });

      child.on("close", (code) => {
        clearTimeout(killTimer);
        const stdout = this.spillOrTruncate(stdoutFull, maxOutputBytes, "stdout");
        const stderr = this.spillOrTruncate(stderrFull, maxOutputBytes, "stderr");
        resolve({
          stdout: this.redact(stdout),
          stderr: this.redact(stderr),
          exitCode: code ?? 0,
        });
      });
      child.on("error", (err) => {
        clearTimeout(killTimer);
        reject(err);
      });
    });
  }

  /**
   * When output exceeds maxOutputBytes, write the full content to a temp file
   * and return only the tail preview. This prevents huge outputs from blowing
   * up the context window while preserving the data on disk (Pawwork2 pattern).
   */
  private spillOrTruncate(full: string, maxBytes: number, label: string): string {
    if (full.length <= maxBytes) return full;

    // Try to cut at a line boundary for clean preview
    const previewBytes = Math.floor(maxBytes * 0.8);
    let cutAt = full.lastIndexOf("\n", previewBytes);
    if (cutAt <= 0) cutAt = previewBytes;
    const tail = full.slice(cutAt);

    const tmpPath = join(tmpdir(), `simpleclaw-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`);
    writeFile(tmpPath, full, "utf-8").catch(() => {});

    return `[${label} exceeded ${maxBytes} chars; full output written to ${tmpPath}]\n` +
      `--- last ${tail.length} chars ---\n${tail}`;
  }

  /**
   * Redact known secret values from text before returning to LLM.
   * This prevents accidental exposure when commands like `echo $GITHUB_TOKEN`
   * or `env` are executed.
   */
  private redact(text: string): string {
    for (const value of Object.values(this.env)) {
      if (!value || value.length < REDACT_MIN_LENGTH) continue;
      // Simple string replacement (no regex to avoid escaping issues with arbitrary secrets)
      let idx = text.indexOf(value);
      while (idx !== -1) {
        text = text.slice(0, idx) + "[REDACTED]" + text.slice(idx + value.length);
        idx = text.indexOf(value);
      }
    }
    return text;
  }

  private dockerSpawn(command: string, timeoutMs: number, maxOutputBytes: number): Promise<IExecResult> {
    return new Promise((resolve, reject) => {
      const args = [
        "run", "--rm",
        "-v", `${this.workspace}:/workspace`,
        "-w", "/workspace",
        "--network", "none",
        ...Object.entries(this.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        "alpine:latest",
        "sh", "-c", command,
      ];
      const child = spawn("docker", args);

      let stdoutFull = "";
      let stderrFull = "";
      const killTimer = setTimeout(() => {
        this.killTree(child);
      }, timeoutMs);

      child.stdout?.on("data", (d: Buffer) => {
        stdoutFull += d;
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderrFull += d;
      });

      child.on("close", (code) => {
        clearTimeout(killTimer);
        const stdout = this.spillOrTruncate(stdoutFull, maxOutputBytes, "stdout");
        const stderr = this.spillOrTruncate(stderrFull, maxOutputBytes, "stderr");
        resolve({
          stdout: this.redact(stdout),
          stderr: this.redact(stderr),
          exitCode: code ?? 0,
        });
      });
      child.on("error", (err) => {
        clearTimeout(killTimer);
        reject(err);
      });
    });
  }

  dispose(): void {
    this.fileLocks.clear();
  }

  private killTree(child: ReturnType<typeof spawn>): void {
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true });
    } else {
      try { process.kill(-pid, "SIGTERM"); } catch (err) {
        this.logger.debug("SIGTERM failed", { pid, error: err instanceof Error ? err.message : String(err) });
      }
      setTimeout(() => {
        try { process.kill(-pid, "SIGKILL"); } catch (err) {
          this.logger.debug("SIGKILL failed", { pid, error: err instanceof Error ? err.message : String(err) });
        }
      }, 3000);
    }
  }
}

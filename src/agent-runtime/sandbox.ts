/**
 * SimpleClaw — Sandbox abstraction
 * MVP: docker backend + path safety. SSH backend deferred.
 */

import { spawn } from "child_process";
import { readFile, writeFile, mkdir, rename, unlink } from "fs/promises";
import { existsSync } from "fs";
import { resolve, isAbsolute, dirname, sep, join } from "path";
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

  constructor(
    private workspace: string,
    private config: SandboxConfig,
    private logger: ILogger,
    private env: Record<string, string> = {},
  ) {
    this.guard = new PathGuard(config.allowedPaths, config.deniedPaths);
    // Ensure workspace directory exists
    mkdir(this.workspace, { recursive: true }).catch(() => {});
  }

  async readFile(rawPath: string): Promise<string> {
    const path = this.guard.assertSafe(rawPath, this.workspace);
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
    try {
      return await current;
    } finally {
      // Only delete if we're still the current lock (not overwritten by a later one)
      if (this.fileLocks.get(path) === current) {
        this.fileLocks.delete(path);
      }
    }
  }

  async exec(command: string, options: ExecOptions = {}): Promise<IExecResult> {
    if (this.config.backend === "none") {
      throw new Error("Sandbox backend is 'none'; shell execution disabled");
    }

    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxOutputBytes = options.maxOutputBytes ?? 10_000;

    this.logger.info("Docker exec", { command, workspace: this.workspace, timeoutMs });

    const isDockerAvailable = await this.checkDocker();
    if (!isDockerAvailable) {
      this.logger.warn("Docker not available; falling back to direct spawn for MVP");
      return this.directSpawn(command, timeoutMs, maxOutputBytes);
    }

    return this.dockerSpawn(command, timeoutMs, maxOutputBytes);
  }

  private async checkDocker(): Promise<boolean> {
    try {
      const { stdout } = await this.directSpawn("docker version", 10_000, 1_000);
      return stdout.includes("Version:");
    } catch {
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

      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      const killTimer = setTimeout(() => {
        this.killTree(child);
      }, timeoutMs);

      child.stdout?.on("data", (d: Buffer) => {
        if (!stdoutTruncated) {
          stdout += d;
          if (stdout.length > maxOutputBytes) {
            stdout = stdout.slice(0, maxOutputBytes) + "\n... [stdout truncated]";
            stdoutTruncated = true;
          }
        }
      });
      child.stderr?.on("data", (d: Buffer) => {
        if (!stderrTruncated) {
          stderr += d;
          if (stderr.length > maxOutputBytes) {
            stderr = stderr.slice(0, maxOutputBytes) + "\n... [stderr truncated]";
            stderrTruncated = true;
          }
        }
      });

      child.on("close", (code) => {
        clearTimeout(killTimer);
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

      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      const killTimer = setTimeout(() => {
        this.killTree(child);
      }, timeoutMs);

      child.stdout?.on("data", (d: Buffer) => {
        if (!stdoutTruncated) {
          stdout += d;
          if (stdout.length > maxOutputBytes) {
            stdout = stdout.slice(0, maxOutputBytes) + "\n... [stdout truncated]";
            stdoutTruncated = true;
          }
        }
      });
      child.stderr?.on("data", (d: Buffer) => {
        if (!stderrTruncated) {
          stderr += d;
          if (stderr.length > maxOutputBytes) {
            stderr = stderr.slice(0, maxOutputBytes) + "\n... [stderr truncated]";
            stderrTruncated = true;
          }
        }
      });

      child.on("close", (code) => {
        clearTimeout(killTimer);
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

  private killTree(child: ReturnType<typeof spawn>): void {
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true });
    } else {
      try { process.kill(-pid, "SIGTERM"); } catch { /* ignore kill errors */ }
      setTimeout(() => {
        try { process.kill(-pid, "SIGKILL"); } catch { /* ignore kill errors */ }
      }, 3000);
    }
  }
}

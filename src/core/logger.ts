/**
 * SimpleClaw — Minimal structured logger
 * Replaces OpenClaw's tslog + complex log pipeline.
 */

import type { ILogger } from "./interfaces.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let globalLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export function getLogLevel(): LogLevel {
  return globalLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[globalLevel];
}

function timestamp(): string {
  return new Date().toISOString();
}

function write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const prefix = `[${timestamp()}] [${level.toUpperCase().padStart(5)}]`;
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  const out = level === "error" || level === "warn" ? console.error : console.log;
  out(`${prefix} ${msg}${metaStr}`);
}

export const logger: ILogger = {
  debug: (msg: string, meta?: Record<string, unknown>) => write("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write("error", msg, meta),
};

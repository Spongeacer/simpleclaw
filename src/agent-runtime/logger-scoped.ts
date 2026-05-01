/**
 * SimpleClaw — Scoped Logger
 * Decorates an ILogger with agent/session context so every log line is
 * automatically tagged with the sub-agent identity.
 */

import type { ILogger } from "../core/interfaces.js";

export class ScopedLogger implements ILogger {
  constructor(
    private delegate: ILogger,
    private agentId: string,
    private sessionId?: string,
  ) {}

  private meta(extra?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!extra && !this.sessionId) return { agentId: this.agentId };
    return { agentId: this.agentId, sessionId: this.sessionId, ...extra };
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.delegate.debug(msg, this.meta(meta));
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.delegate.info(msg, this.meta(meta));
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    this.delegate.warn(msg, this.meta(meta));
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    this.delegate.error(msg, this.meta(meta));
  }
}

/**
 * SimpleClaw — Gateway authentication & rate limiting
 * Stateless: rate-limit counters stored in SessionStore or external cache.
 */

import type { AuthConfig, RateLimitConfig } from "../core/types.js";
import { logger } from "../core/logger.js";

export interface AuthContext {
  ip: string;
  token?: string;
}

export interface AuthResult {
  success: boolean;
  role?: "client" | "extension";
  error?: string;
}

export class GatewayAuth {
  constructor(
    private config: AuthConfig,
    _rateLimit: RateLimitConfig
  ) {}

  async authenticate(ctx: AuthContext): Promise<AuthResult> {
    if (this.config.type === "none") {
      return { success: true, role: "client" };
    }

    if (this.config.type === "token") {
      if (ctx.token === this.config.token) {
        return { success: true, role: "client" };
      }
      logger.warn("Token auth failed", { ip: ctx.ip });
      return { success: false, error: "Invalid token" };
    }

    if (this.config.type === "password") {
      // TODO: constant-time comparison + bcrypt
      return { success: false, error: "Password auth not yet implemented" };
    }

    return { success: false, error: "Unsupported auth type" };
  }
}

// ─── Rate Limiter (memory-backed; upgrade to Redis for multi-instance) ────────

interface RateLimitEntry {
  count: number;
  windowStart: number;
  blockedUntil?: number;
}

export class RateLimiter {
  private store = new Map<string, RateLimitEntry>();

  constructor(private config: RateLimitConfig) {}

  isAllowed(scope: string, ip: string): boolean {
    const key = `${scope}:${ip}`;
    const now = Date.now();
    const entry = this.store.get(key);

    if (entry?.blockedUntil && now < entry.blockedUntil) {
      return false;
    }

    const windowMs = 60_000;
    if (!entry || now - entry.windowStart > windowMs) {
      this.store.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= this.config.maxRequestsPerMinute) {
      this.store.set(key, {
        ...entry,
        blockedUntil: now + this.config.blockDurationSeconds * 1000,
      });
      logger.warn("Rate limit exceeded", { scope, ip });
      return false;
    }

    entry.count++;
    return true;
  }
}

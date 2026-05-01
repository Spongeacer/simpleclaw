/**
 * SimpleClaw — Keys / Secrets Loader
 * Loads API keys and user credentials from a separate secrets file.
 *
 * Keeps sensitive credentials out of the main config file.
 *
 * Security notes:
 * - secrets.json / keys.json should NEVER be committed to version control.
 * - On Unix, recommended permissions: chmod 600 ~/.simpleclaw/secrets.json
 * - The "env" section is injected into sandbox/bash tools as environment variables.
 * - The "providers" section resolves {{name}} references in provider configs.
 * - Neither section is ever exposed to LLM prompts.
 *
 * File format (partitioned, recommended):
 * {
 *   "providers": {
 *     "moonshot": "sk-xxx",
 *     "openrouter": "sk-yyy"
 *   },
 *   "env": {
 *     "GITHUB_TOKEN": "ghp-xxx",
 *     "NPM_TOKEN": "npm_xxx"
 *   }
 * }
 *
 * Backward-compatible flat format (treated as providers only):
 * {
 *   "moonshot": "sk-xxx",
 *   "openrouter": "sk-yyy"
 * }
 */

import { readFileSync, existsSync, statSync } from "fs";
import { resolve } from "path";
import { logger } from "../core/logger.js";

export const KEYS_FILE_NAME = "keys.json";
export const SECRETS_FILE_NAME = "secrets.json";

export interface SecretsFile {
  providers?: Record<string, string>;
  env?: Record<string, string>;
  // backward compat: flat keys at root level
  [key: string]: unknown;
}

/**
 * Load secrets from the config directory.
 * Prefers secrets.json, falls back to keys.json for backward compatibility.
 */
export function loadSecrets(configDir: string): SecretsFile {
  const secretsPath = resolve(configDir, SECRETS_FILE_NAME);
  const keysPath = resolve(configDir, KEYS_FILE_NAME);

  const path = existsSync(secretsPath) ? secretsPath : keysPath;
  if (!existsSync(path)) {
    return {};
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      logger.warn(`${SECRETS_FILE_NAME} must be a plain object, ignoring`);
      return {};
    }
    checkFilePermissions(path);
    return raw as SecretsFile;
  } catch (e) {
    logger.warn("Failed to load secrets file", { path, error: String(e) });
    return {};
  }
}

/**
 * Extract provider API keys from secrets.
 * If the file uses the partitioned format, returns `secrets.providers`.
 * If it uses the flat format, returns all non-reserved keys as provider keys.
 */
export function getProviderKeys(secrets: SecretsFile): Record<string, string> {
  if (secrets.providers && typeof secrets.providers === "object") {
    return secrets.providers as Record<string, string>;
  }

  // Backward compat: flat object where everything is a provider key
  const keys: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets)) {
    if (k === "env" || k === "providers") continue;
    if (typeof v === "string") {
      keys[k] = v;
    }
  }
  return keys;
}

/**
 * Extract user service credentials (env vars) from secrets.
 */
export function getSecretsEnv(secrets: SecretsFile): Record<string, string> {
  if (secrets.env && typeof secrets.env === "object") {
    return secrets.env as Record<string, string>;
  }
  return {};
}

/**
 * Check file permissions and warn if the file is overly accessible.
 */
function checkFilePermissions(path: string): void {
  try {
    const stats = statSync(path);
    const mode = stats.mode;
    // On Unix-like systems, warn if world-readable or world-writable
    if (process.platform !== "win32") {
      if (mode & 0o044) {
        logger.warn(`${resolve(path)} is world-readable. Run: chmod 600 ${resolve(path)}`);
      }
      if (mode & 0o022) {
        logger.warn(`${resolve(path)} is group-writable. Run: chmod 600 ${resolve(path)}`);
      }
    }
  } catch {
    // ignore
  }
}

/**
 * Resolve a value that may contain key references like "{{moonshot}}".
 * If the value matches the reference syntax, look it up in keys.
 * Otherwise return the value unchanged.
 */
export function resolveKeyRef(value: string, keys: Record<string, string>): string {
  const match = value.match(/^\{\{\s*([^}\s]+)\s*\}\}$/);
  if (!match) return value;

  const keyName = match[1];
  const resolved = keys[keyName];
  if (resolved === undefined) {
    throw new Error(
      `Key reference "{{${keyName}}}" not found in secrets file. ` +
        `Available provider keys: ${Object.keys(keys).join(", ") || "(none)"}`
    );
  }
  return resolved;
}

/**
 * Mask a key for safe logging (e.g. "sk-12...34").
 */
export function maskKey(key: string): string {
  if (key.length <= 8) return "***";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

/**
 * Inject resolved provider keys into provider configs.
 * Mutates the config object in-place.
 */
export function injectProviderKeys(providers: Record<string, { apiKey: string }>, keys: Record<string, string>): void {
  for (const [name, provider] of Object.entries(providers)) {
    if (!provider.apiKey) continue;
    const resolved = resolveKeyRef(provider.apiKey, keys);
    if (resolved !== provider.apiKey) {
      provider.apiKey = resolved;
      logger.info(`Resolved API key for provider "${name}" from secrets file`, {
        key: maskKey(resolved),
      });
    }
  }
}

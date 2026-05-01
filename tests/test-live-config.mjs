/**
 * Live Test Configuration — Shared model / API settings for all live tests.
 *
 * Reads provider credentials and default model from ~/.simpleclaw/simpleclaw.json.
 * Falls back to OPENROUTER_API_KEY environment variable for CI compatibility.
 *
 * If no provider key is found, tests SKIP gracefully.
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { resolve } from 'path';

async function loadConfig() {
  // 1. Environment variable (CI / explicit override)
  if (process.env.OPENROUTER_API_KEY) {
    return {
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      model: process.env.OPENROUTER_MODEL || 'tencent/hy3-preview:free',
    };
  }

  // 2. User's simpleclaw.json
  try {
    const configPath = resolve(homedir(), '.simpleclaw', 'simpleclaw.json');
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);

    // Use the default model's provider
    const defaultModel = config.models?.default;
    const providerName = defaultModel?.provider || 'openrouter';
    const model = defaultModel?.model || 'tencent/hy3-preview:free';

    const provider = config.providers?.[providerName];
    if (provider?.apiKey && provider?.baseURL) {
      return {
        apiKey: provider.apiKey,
        baseURL: provider.baseURL,
        model,
      };
    }
  } catch {
    // ignore
  }

  return null;
}

const cfg = await loadConfig();
if (!cfg) {
  throw new Error(
    'No API provider configured. Set OPENROUTER_API_KEY environment variable ' +
    'or configure providers in ~/.simpleclaw/simpleclaw.json'
  );
}

export const API_KEY = cfg.apiKey;
export const BASE_URL = cfg.baseURL;
export const MODEL = cfg.model;

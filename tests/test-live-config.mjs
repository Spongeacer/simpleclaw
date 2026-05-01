/**
 * Live Test Configuration — Shared model / API settings for all live tests.
 *
 * Automatically probes OpenRouter for an available free-tier model that
 * supports tool calling. Falls back through a hard-coded candidate list if
 * probing fails. Caches the resolved model so all live tests use the same one.
 *
 * If OPENROUTER_API_KEY is missing, tests SKIP and a placeholder model is
 * returned so imports don’t crash.
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { resolve } from 'path';

async function loadProviderKey() {
  // 1. Environment variable (CI / explicit override)
  if (process.env.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_API_KEY;
  }
  // 2. User's simpleclaw.json providers section
  try {
    const configPath = resolve(homedir(), '.simpleclaw', 'simpleclaw.json');
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);
    const key = config.providers?.openrouter?.apiKey;
    if (key && typeof key === 'string') {
      return key;
    }
  } catch {
    // ignore
  }
  return undefined;
}

const apiKey = await loadProviderKey();
if (!apiKey) {
  throw new Error(
    'No API key found. Set OPENROUTER_API_KEY environment variable or configure providers.openrouter.apiKey in ~/.simpleclaw/simpleclaw.json'
  );
}
export const API_KEY = apiKey;
export const BASE_URL = 'https://openrouter.ai/api/v1';

// Free-tier candidates known (or believed) to support function calling.
// Ordered by preference.  Add or reorder as the OpenRouter roster changes.
const CANDIDATES = [
  'tencent/hy3-preview:free',
  'minimax/minimax-m2.5:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-3-4b-it:free',
  'deepseek/deepseek-chat-v3.1:free',
];

async function loadUserModel() {
  try {
    const configPath = resolve(homedir(), '.simpleclaw', 'simpleclaw.json');
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);
    return config.models?.default?.model ?? null;
  } catch {
    return null;
  }
}

/** Send a minimal chat request to verify the model is actually usable (HTTP 200). */
async function probeModel(model) {
  try {
    const resp = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'HTTP-Referer': 'https://simpleclaw.dev',
        'X-Title': 'SimpleClaw Live Tests',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1,
      }),
    });
    // Only accept a clean 200.  404 = not found, 429 = rate limited,
    // 400 = geo-blocked / unsupported — all mean "not usable right now".
    return resp.status === 200;
  } catch {
    return false;
  }
}

async function resolveModel() {
  if (!API_KEY) {
    return CANDIDATES[0];
  }

  // 1. Try known tool-calling-friendly candidates first
  //    (User config may be a reasoning/chat model that handles read
  //     but not multi-turn edit workflows.)
  for (const model of CANDIDATES) {
    const ok = await probeModel(model);
    if (ok) {
      return model;
    }
  }

  // 2. Fall back to user's configured free-tier model
  const userModel = await loadUserModel();
  if (userModel && userModel.endsWith(':free')) {
    const ok = await probeModel(userModel);
    if (ok) {
      return userModel;
    }
  }

  console.warn(
    `[live-config] No probed model responded cleanly — falling back to ${CANDIDATES[0]}`
  );
  return CANDIDATES[0];
}

export const MODEL = await resolveModel();

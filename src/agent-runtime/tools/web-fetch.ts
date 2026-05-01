/**
 * SimpleClaw — Web Fetch Tool
 * Fetch a web page and extract readable text content.
 *
 * Mature patterns borrowed from OpenClaw:
 * - Caching (TTL + LRU eviction)
 * - HTTP proxy support (HTTP_PROXY / HTTPS_PROXY / NO_PROXY)
 * - Smart content extraction (readability-like fallback chain)
 * - Streaming size limits
 */

import type { ITool, ILogger } from "../../core/interfaces.js";
import { checkSsrf } from "../ssrf-guard.js";
import { fetchWithTimeout } from "../net/fetch-proxy.js";

const MAX_CHARS = 8000;
const TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min
const CACHE_MAX_ENTRIES = 100;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const fetchCache = new Map<string, CacheEntry>();

function readCache(key: string): string | undefined {
  const entry = fetchCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    fetchCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function writeCache(key: string, value: string, ttlMs: number): void {
  if (fetchCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = fetchCache.keys().next();
    if (!oldest.done) fetchCache.delete(oldest.value);
  }
  fetchCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function createWebFetchTool(logger: ILogger): ITool {
  return {
    name: "web_fetch",
    description:
      "Fetch the content of a web page by URL and return the readable text. " +
      "Use this after `web_search` to read the full content of a specific result. " +
      "Content is truncated to ~8KB. JavaScript and styles are stripped.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full URL to fetch (must start with http:// or https://)",
        },
        max_chars: {
          type: "number",
          description: "Maximum characters to return (default 8000, max 15000)",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const url = String(args.url);
      const maxChars = Math.min(Math.max(100, Number(args.max_chars ?? MAX_CHARS)), 15000);

      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return "Error: URL must start with http:// or https://";
      }

      const ssrf = await checkSsrf(url);
      if (!ssrf.allowed) {
        return `Error: SSRF blocked — ${ssrf.reason}`;
      }

      // Cache check
      const cacheKey = url.toLowerCase();
      const cached = readCache(cacheKey);
      if (cached) {
        logger.info("Web fetch cache hit", { url: url.slice(0, 120) });
        return cached;
      }

      logger.info("Web fetch", { url: url.slice(0, 120) });

      let lastErr: unknown;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const res = await fetchWithTimeout(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "text/markdown,text/plain,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1",
              "Accept-Language": "en-US,en;q=0.5",
            },
            redirect: "follow",
            timeoutMs: TIMEOUT_MS,
          });

          if (!res.ok) {
            const bodyPreview = await readErrorBody(res);
            return `Fetch failed: HTTP ${res.status} ${res.statusText} for ${url}\n${bodyPreview}`;
          }

          const contentType = res.headers.get("content-type") ?? "";
          let result: string;

          if (contentType.includes("application/json")) {
            const json = await res.json();
            const text = JSON.stringify(json, null, 2);
            result = truncate(text, maxChars, `[JSON response from ${url}]`);
          } else if (contentType.includes("text/markdown")) {
            const text = await res.text();
            result = truncate(text, maxChars, `[Markdown from ${url}]`);
          } else {
            const html = await res.text();
            const text = extractReadableText(html);
            result = truncate(text, maxChars, `[Fetched from ${url}]`);
          }

          writeCache(cacheKey, result, CACHE_TTL_MS);
          return result;
        } catch (err) {
          lastErr = err;
          const errStr = String(err);
          const isNetwork = errStr.includes("AbortError") || errStr.includes("fetch failed") || errStr.includes("ENOTFOUND") || errStr.includes("ETIMEDOUT");
          if (isNetwork && attempt < MAX_RETRIES) {
            const delay = 2000 * (attempt + 1);
            logger.info("Web fetch retry", { attempt: attempt + 1, url: url.slice(0, 120), delay });
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          break;
        }
      }

      const errStr = String(lastErr);
      logger.warn("Web fetch error", { error: errStr, url: url.slice(0, 120) });
      if (errStr.includes("AbortError")) {
        return `Fetch error: Request to ${url} timed out after ${TIMEOUT_MS / 1000}s. This may be due to network restrictions or slow connectivity.`;
      }
      if (errStr.includes("fetch failed") || errStr.includes("ENOTFOUND")) {
        return `Fetch error: Unable to reach ${url}. This may be due to DNS failure, firewall, or missing HTTP proxy configuration.`;
      }
      return `Fetch error: ${errStr} for ${url}`;
    },
  };
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const clean = extractReadableText(text);
    return clean.length > 400 ? clean.slice(0, 400) + "..." : clean;
  } catch {
    return "";
  }
}

function extractReadableText(html: string): string {
  // Remove script and style blocks first
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "");

  // Try semantic containers first (readability-like)
  const semantic =
    text.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i)?.[1] ??
    text.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i)?.[1] ??
    text.match(/<section[\s\S]*?>([\s\S]*?)<\/section>/i)?.[1];

  if (semantic) {
    text = semantic;
  }

  // Strip remaining HTML tags
  text = text
    .replace(/<[^>]+>/g, "\n")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

  // Collapse excessive whitespace
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  return lines.join("\n");
}

function truncate(text: string, max: number, header: string): string {
  if (text.length <= max) {
    return `${header}\n\n${text}`;
  }
  return `${header}\n\n${text.slice(0, max)}\n\n... [content truncated, total ${text.length} chars]`;
}

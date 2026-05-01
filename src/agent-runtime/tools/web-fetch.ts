/**
 * SimpleClaw — Web Fetch Tool
 * Fetch a web page and extract readable text content.
 */

import type { ITool, ILogger } from "../../core/interfaces.js";
import { checkSsrf } from "../ssrf-guard.js";

const MAX_CHARS = 8000;
const TIMEOUT_MS = 15000;

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

      logger.info("Web fetch", { url: url.slice(0, 120) });

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const res = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
          },
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!res.ok) {
          return `Fetch failed: HTTP ${res.status} ${res.statusText}`;
        }

        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const json = await res.json();
          const text = JSON.stringify(json, null, 2);
          return truncate(text, maxChars, `[JSON response from ${url}]`);
        }

        const html = await res.text();
        const text = extractReadableText(html);
        return truncate(text, maxChars, `[Fetched from ${url}]`);
      } catch (err) {
        logger.warn("Web fetch error", { error: String(err), url: url.slice(0, 120) });
        return `Fetch error: ${String(err)}`;
      }
    },
  };
}

function extractReadableText(html: string): string {
  // Remove script and style blocks first
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  // Try to extract from <article> or <main> first
  const articleMatch = text.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
  const mainMatch = text.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);

  if (articleMatch) {
    text = articleMatch[1];
  } else if (mainMatch) {
    text = mainMatch[1];
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

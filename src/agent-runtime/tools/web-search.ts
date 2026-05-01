/**
 * SimpleClaw — Web Search Tool
 * Searches Bing and Baidu HTML pages (no API key required).
 * Falls back through providers until results are found.
 */

import type { ITool, ILogger } from "../../core/interfaces.js";
import { buildFetchOptions } from "../net/fetch-proxy.js";

const MAX_RESULTS = 5;
const MAX_SNIPPET_LEN = 300;
const SEARCH_TIMEOUT_MS = 30000;
const MAX_RETRIES = 1;

export function createWebSearchTool(logger: ILogger): ITool {
  return {
    name: "web_search",
    description:
      "Search the web for current information, news, documentation, or facts. " +
      "Uses Bing or Baidu (no API key needed). " +
      "Returns a list of results with title, URL, and short snippet. " +
      "Use this when the user asks about real-time events, recent news, or information outside your training data. " +
      "If search returns no results after 2 attempts with different queries, stop searching and answer from your training knowledge or explain the limitation.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (be specific, use keywords)",
        },
        max_results: {
          type: "number",
          description: `Maximum results to return (default ${MAX_RESULTS}, max 10)`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const query = String(args.query);
      const maxResults = Math.min(Math.max(1, Number(args.max_results ?? MAX_RESULTS)), 10);

      logger.info("Web search", { query: query.slice(0, 80), maxResults });

      const errors: string[] = [];

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        // Provider 1: Bing (usually most reliable for Chinese and international queries)
        try {
          const results = await searchBing(query, maxResults);
          if (results.length > 0) {
            return formatResults(query, results);
          }
          logger.info("Bing returned no results, trying Baidu", { query: query.slice(0, 80) });
        } catch (err) {
          const msg = extractError(err, "Bing");
          logger.warn(msg.short, { provider: "Bing", query: query.slice(0, 80), error: msg.full });
          errors.push(msg.short);
        }

        // Provider 2: Baidu
        try {
          const results = await searchBaidu(query, maxResults);
          if (results.length > 0) {
            return formatResults(query, results);
          }
          logger.info("Baidu returned no results", { query: query.slice(0, 80) });
        } catch (err) {
          const msg = extractError(err, "Baidu");
          logger.warn(msg.short, { provider: "Baidu", query: query.slice(0, 80), error: msg.full });
          errors.push(msg.short);
        }

        // Retry if this was a network-related failure on the first attempt
        const isNetworkFailure = errors.some(e =>
          e.includes("timed out") || e.includes("Unable to reach") || e.includes("fetch failed")
        );
        if (isNetworkFailure && attempt < MAX_RETRIES) {
          const delay = 2000 * (attempt + 1);
          logger.info("Web search retry", { attempt: attempt + 1, query: query.slice(0, 80), delay });
          await new Promise(r => setTimeout(r, delay));
          errors.length = 0; // clear for next attempt
          continue;
        }

        break;
      }

      if (errors.length > 0) {
        const unique = [...new Set(errors)];
        return `Search error for "${query}": ${unique.join("; ")}. ` +
          `If you are behind a corporate proxy, ensure HTTP_PROXY/HTTPS_PROXY environment variables are set.`;
      }

      return `No results found for "${query}". The search engines may have changed their page layout, or the query may need to be rephrased.`;
    },
  };
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function formatResults(query: string, results: SearchResult[]): string {
  const lines: string[] = [`Search results for "${query}":`, ""];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   URL: ${r.url}`);
    if (r.snippet) {
      const snippet = r.snippet.length > MAX_SNIPPET_LEN ? r.snippet.slice(0, MAX_SNIPPET_LEN) + "..." : r.snippet;
      lines.push(`   ${snippet}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function extractError(err: unknown, provider: string): { short: string; full: string } {
  const full = err instanceof Error ? err.message : String(err);
  if (full.includes("AbortError") || full.includes("timed out")) {
    return { short: `${provider}: Request timed out after ${SEARCH_TIMEOUT_MS / 1000}s`, full };
  }
  if (full.includes("fetch failed") || full.includes("ENOTFOUND") || full.includes("ETIMEDOUT") || full.includes("ECONNREFUSED")) {
    return { short: `${provider}: Unable to reach search engine`, full };
  }
  return { short: `${provider}: ${full}`, full };
}

// ─── Bing ─────────────────────────────────────────────────────────────────────

async function searchBing(query: string, maxResults: number): Promise<SearchResult[]> {
  const searchUrl = `https://cn.bing.com/search?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const proxyOpts = await buildFetchOptions(searchUrl);
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
      ...(proxyOpts as Record<string, unknown>),
    });
    clearTimeout(timeout);
    if (!res.ok) {
      throw new Error(`Bing returned HTTP ${res.status} ${res.statusText}`);
    }
    const html = await res.text();
    return parseBingResults(html, maxResults);
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

function parseBingResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Bing HTML may include extra attributes on the li tag, e.g. <li class="b_algo" data-id="...">
  const resultBlocks = html.split(/<li[^>]*class="b_algo"[^>]*>/);

  for (let i = 1; i < resultBlocks.length && results.length < max; i++) {
    const block = resultBlocks[i];
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/);
    // Snippet may be in <p> or inside <div class="b_caption">
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/) || block.match(/<div[^>]*class="b_caption"[^>]*>([\s\S]*?)<\/div>/);

    if (titleMatch) {
      const url = titleMatch[1];
      const title = stripHtml(titleMatch[2]).trim();
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : "";
      if (title && url) results.push({ title, url, snippet });
    }
  }

  return results;
}

// ─── Baidu ────────────────────────────────────────────────────────────────────

async function searchBaidu(query: string, maxResults: number): Promise<SearchResult[]> {
  const searchUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const proxyOpts = await buildFetchOptions(searchUrl);
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Cookie": "BAIDUID=test",
      },
      signal: controller.signal,
      ...(proxyOpts as Record<string, unknown>),
    });
    clearTimeout(timeout);
    if (!res.ok) {
      throw new Error(`Baidu returned HTTP ${res.status} ${res.statusText}`);
    }
    const html = await res.text();
    return parseBaiduResults(html, maxResults);
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

function parseBaiduResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Baidu results are in <div class="result"> elements (sometimes with extra classes)
  const resultBlocks = html.split(/<div[^>]*class="result[^"]*"[^>]*>/);

  for (let i = 1; i < resultBlocks.length && results.length < max; i++) {
    const block = resultBlocks[i];
    // Title: <h3 class="t"> <a href="...">title</a> </h3>
    const titleMatch = block.match(/<h3[^>]*class="t"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/);
    // Snippet: various class names, try a few patterns
    const snippetMatch =
      block.match(/<span[^>]*class="content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/) ||
      block.match(/<div[^>]*class="content-right_[^"]*"[^>]*>([\s\S]*?)<\/div>/) ||
      block.match(/<span[^>]*class="c-abstract"[^>]*>([\s\S]*?)<\/span>/);

    if (titleMatch) {
      let url = titleMatch[1];
      // Baidu sometimes wraps URLs in redirect: https://www.baidu.com/link?url=...
      if (url.startsWith("/link?")) {
        url = "https://www.baidu.com" + url;
      }
      const title = stripHtml(titleMatch[2]).trim();
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : "";
      if (title && url) results.push({ title, url, snippet });
    }
  }

  return results;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&ensp;/g, " ")
    .replace(/&emsp;/g, " ")
    .replace(/&#(?:x27|39);/g, "'")
    .replace(/&#(?:x22|34);/g, '"')
    .replace(/&#(?:x26|38);/g, "&")
    .replace(/&#(?:x3C|60);/g, "<")
    .replace(/&#(?:x3E|62);/g, ">")
    .replace(/&#(?:xA0|160);/g, " ")
    .replace(/&#0183;/g, "·")
    .replace(/\s+/g, " ");
}

/**
 * SimpleClaw — Web Search Tool
 * Uses DuckDuckGo HTML search (no API key required).
 * Fallback to a simple summary if parsing fails.
 */

import type { ITool, ILogger } from "../../core/interfaces.js";

const BING_SEARCH = "https://cn.bing.com/search";
const BAIDU_SEARCH = "https://www.baidu.com/s";
const MAX_RESULTS = 5;
const MAX_SNIPPET_LEN = 300;

export function createWebSearchTool(logger: ILogger): ITool {
  return {
    name: "web_search",
    description:
      "Search the web for current information, news, documentation, or facts. " +
      "Uses Bing (no API key needed). " +
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

      try {
        let results = await searchBing(query, maxResults);

        // Fallback to Baidu if Bing returns nothing
        if (results.length === 0) {
          logger.info("Bing returned no results, trying Baidu", { query: query.slice(0, 80) });
          results = await searchBaidu(query, maxResults);
        }

        if (results.length === 0) {
          return `No results found for "${query}".`;
        }

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
      } catch (err) {
        logger.warn("Web search error", { error: String(err) });
        return `Search error: ${String(err)}`;
      }
    },
  };
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchBing(query: string, maxResults: number): Promise<SearchResult[]> {
  const searchUrl = `${BING_SEARCH}?q=${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  if (!res.ok) return [];
  const html = await res.text();
  return parseBingResults(html, maxResults);
}

async function searchBaidu(query: string, maxResults: number): Promise<SearchResult[]> {
  const searchUrl = `${BAIDU_SEARCH}?wd=${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  if (!res.ok) return [];
  const html = await res.text();
  return parseBaiduResults(html, maxResults);
}

function parseBingResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Bing HTML may include extra attributes on the li tag, e.g. <li class="b_algo" data-id="...">
  const resultBlocks = html.split(/<li[^>]*class="b_algo"[^>]*>/);

  for (let i = 1; i < resultBlocks.length && results.length < max; i++) {
    const block = resultBlocks[i];
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/);
    // Snippet is now directly inside the first <p> tag within the result block
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);

    if (titleMatch) {
      const url = titleMatch[1];
      const title = stripHtml(titleMatch[2]).trim();
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : "";
      if (title && url) results.push({ title, url, snippet });
    }
  }

  return results;
}

function parseBaiduResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Baidu results are in <div class="result"> elements
  const resultBlocks = html.split('<div class="result"');

  for (let i = 1; i < resultBlocks.length && results.length < max; i++) {
    const block = resultBlocks[i];
    // Title: <h3 class="t"> <a href="...">title</a> </h3>
    const titleMatch = block.match(/<h3[^>]*class="t"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/);
    // Snippet: <span class="content-right_8Zs40">...</span> or <div class="content-right_8Zs40">...</div>
    const snippetMatch = block.match(/<(?:span|div)[^>]*class="content-right_[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/);

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

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

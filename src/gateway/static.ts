/**
 * SimpleClaw — Static file server for the test UI
 * Serves ui/ directory over HTTP, no external deps.
 */

import { readFile } from "fs/promises";
import { resolve, extname } from "path";
import { fileURLToPath } from "url";
import type { IncomingMessage, ServerResponse } from "http";
import { logger } from "../core/logger.js";

const __dirname = fileURLToPath(new URL("../..", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  basePath = resolve(__dirname, "ui")
): Promise<boolean> {
  const url = (req.url ?? "/").split("?")[0];
  const safePath = url.replace(/\.\./g, "").replace(/\/+/g, "/") || "/index.html";
  const filePath = resolve(basePath, safePath.startsWith("/") ? safePath.slice(1) : safePath);

  // Security: ensure within basePath
  if (!filePath.startsWith(basePath)) {
    res.writeHead(403).end("Forbidden");
    return true;
  }

  try {
    const data = await readFile(filePath);
    const mime = MIME[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": "no-cache",
    });
    res.end(data);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // Not found — let caller fall through or handle 404
      return false;
    }
    logger.error("Static serve error", { path: filePath, error: String(e) });
    res.writeHead(500).end("Internal error");
    return true;
  }
}

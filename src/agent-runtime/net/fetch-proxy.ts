/**
 * SimpleClaw — HTTP Proxy support for fetch()
 * Reads standard proxy env vars and wraps fetch with undici ProxyAgent when needed.
 */

let cachedDispatcher: unknown | null = null;
let cachedDispatcherResolved = false;

function getProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  );
}

function shouldBypassProxy(targetUrl: string): boolean {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
  if (!noProxy) return false;

  const hostname = new URL(targetUrl).hostname.toLowerCase();
  const patterns = noProxy.split(/[,\s]+/).filter(Boolean);

  for (const p of patterns) {
    const pattern = p.toLowerCase();
    if (pattern === "*") return true;
    if (hostname === pattern) return true;
    if (pattern.startsWith(".") && hostname.endsWith(pattern)) return true;
    if (pattern.startsWith(".") && hostname === pattern.slice(1)) return true;
  }
  return false;
}

export async function getProxyDispatcher(): Promise<unknown | undefined> {
  if (cachedDispatcherResolved) return cachedDispatcher ?? undefined;

  const proxyUrl = getProxyUrl();
  if (!proxyUrl) {
    cachedDispatcherResolved = true;
    cachedDispatcher = null;
    return undefined;
  }

  try {
    const undici = await import("undici");
    cachedDispatcher = new undici.ProxyAgent(proxyUrl);
    cachedDispatcherResolved = true;
    return cachedDispatcher;
  } catch {
    cachedDispatcherResolved = true;
    cachedDispatcher = null;
    return undefined;
  }
}

export async function buildFetchOptions(
  targetUrl: string
): Promise<{ dispatcher?: unknown }> {
  if (shouldBypassProxy(targetUrl)) return {};
  const dispatcher = await getProxyDispatcher();
  return dispatcher ? { dispatcher } : {};
}

/**
 * Fetch with timeout and proxy support.
 * Automatically applies proxy dispatcher and aborts after the given timeout.
 * Returns the Response object on success; throws on network/timeout errors.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? 30000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const proxyOpts = await buildFetchOptions(url);
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      ...(proxyOpts as Record<string, unknown>),
    });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

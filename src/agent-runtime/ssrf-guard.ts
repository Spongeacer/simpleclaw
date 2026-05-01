/**
 * SimpleClaw — SSRF Guard
 * Prevents Server-Side Request Forgery by blocking private/internal IPs
 * and well-known metadata endpoints before outgoing HTTP requests.
 */

import { lookup } from "dns/promises";
import { isIP } from "net";

export interface SsrfCheckResult {
  allowed: boolean;
  reason?: string;
}

// ─── Domain blacklist ────────────────────────────────────────────────────────

const HOSTNAME_BLACKLIST = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

// ─── IPv4 deny ranges (inclusive, as 32-bit integers) ────────────────────────

const IPV4_DENY_RANGES: Array<{ start: number; end: number; label: string }> = [
  { start: 0x00000000, end: 0x00000000, label: "0.0.0.0/32" },
  { start: 0x7f000000, end: 0x7fffffff, label: "127.0.0.0/8" },
  { start: 0x0a000000, end: 0x0affffff, label: "10.0.0.0/8" },
  { start: 0xac100000, end: 0xac1fffff, label: "172.16.0.0/12" },
  { start: 0xc0a80000, end: 0xc0a8ffff, label: "192.168.0.0/16" },
  { start: 0xa9fe0000, end: 0xa9feffff, label: "169.254.0.0/16" },
  { start: 0xe0000000, end: 0xefffffff, label: "224.0.0.0/4 (multicast)" },
  { start: 0xffffffff, end: 0xffffffff, label: "255.255.255.255/32" },
  // Docker default bridge + common container networks
  { start: 0xac110000, end: 0xac11ffff, label: "172.17.0.0/16 (Docker)" },
  { start: 0xc0000200, end: 0xc00002ff, label: "192.0.2.0/24 (TEST-NET-1)" },
  { start: 0xc6336400, end: 0xc63364ff, label: "198.51.100.0/24 (TEST-NET-2)" },
  { start: 0xcb007100, end: 0xcb0071ff, label: "203.0.113.0/24 (TEST-NET-3)" },
  { start: 0xc6120000, end: 0xc613ffff, label: "198.18.0.0/15 (benchmark)" },
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isIPv4Denied(ip: string): string | undefined {
  const int = ipv4ToInt(ip);
  for (const range of IPV4_DENY_RANGES) {
    if (int >= range.start && int <= range.end) {
      return range.label;
    }
  }
  return undefined;
}

// ─── IPv6 deny prefixes ──────────────────────────────────────────────────────

const IPV6_DENY_PREFIXES = [
  { prefix: "::1", label: "::1/128" },
  { prefix: "::", label: "::/128" },
  { prefix: "fe80:", label: "fe80::/10" },
  { prefix: "fc", label: "fc00::/7" },
  { prefix: "fd", label: "fd00::/7" },
  { prefix: "ff", label: "ff00::/8 (multicast)" },
];

function isIPv6Denied(ip: string): string | undefined {
  const lower = ip.toLowerCase();
  for (const p of IPV6_DENY_PREFIXES) {
    if (lower.startsWith(p.prefix)) return p.label;
  }
  return undefined;
}

// ─── Hostname blacklist ──────────────────────────────────────────────────────

function isHostnameBlacklisted(hostname: string): string | undefined {
  const lower = hostname.toLowerCase();
  if (HOSTNAME_BLACKLIST.has(lower)) {
    return `blacklisted hostname: ${hostname}`;
  }
  return undefined;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function checkSsrf(urlString: string): Promise<SsrfCheckResult> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { allowed: false, reason: "invalid URL" };
  }

  const hostname = url.hostname;

  // 1. Direct IP address check
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const deny = isIPv4Denied(hostname);
    if (deny) {
      return { allowed: false, reason: `forbidden IP address: ${hostname} (${deny})` };
    }
    return { allowed: true };
  }
  if (ipVersion === 6) {
    const deny = isIPv6Denied(hostname);
    if (deny) {
      return { allowed: false, reason: `forbidden IP address: ${hostname} (${deny})` };
    }
    return { allowed: true };
  }

  // 2. Hostname blacklist
  const blacklisted = isHostnameBlacklisted(hostname);
  if (blacklisted) {
    return { allowed: false, reason: blacklisted };
  }

  // 3. DNS resolution check
  try {
    const addresses = await lookup(hostname, { all: true });
    for (const addr of addresses) {
      const v = isIP(addr.address);
      if (v === 4) {
        const deny = isIPv4Denied(addr.address);
        if (deny) {
          return { allowed: false, reason: `DNS resolved to forbidden IP: ${addr.address} (${deny})` };
        }
      } else if (v === 6) {
        const deny = isIPv6Denied(addr.address);
        if (deny) {
          return { allowed: false, reason: `DNS resolved to forbidden IP: ${addr.address} (${deny})` };
        }
      }
    }
  } catch (err) {
    return { allowed: false, reason: `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { allowed: true };
}

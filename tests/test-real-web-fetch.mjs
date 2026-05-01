/**
 * Real Web Fetch Test
 * Tests web_fetch with real network calls + SSRF validation.
 * Run with: node tests/test-real-web-fetch.mjs
 */

import { createWebFetchTool } from '../dist/agent-runtime/tools/web-fetch.js';
import { logger } from '../dist/core/logger.js';

let failCount = 0;
let passCount = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  ❌ FAIL: ${message}`);
    failCount++;
  } else {
    passCount++;
  }
}

function assertIncludes(haystack, needle, message) {
  assert(
    haystack.includes(needle),
    `${message}\n  expected to include: "${needle}"\n  got: "${haystack.slice(0, 200).replace(/\n/g, ' ')}"`
  );
}

async function run() {
  console.log('\n🧪 Real Web Fetch Test\n');

  const tool = createWebFetchTool(logger);

  // ── Test 1: Fetch a real page ─────────────────────────────────────────────
  console.log('  Fetch httpbin.org (should bypass SSRF)...');
  {
    // httpbin.org is a public test API, usually not in benchmark IP ranges
    const result = await tool.execute({ url: 'https://httpbin.org/get' });
    if (result.includes('SSRF blocked')) {
      console.log('    ⏭️  skipped (network environment blocks external fetch)');
    } else {
      assertIncludes(result, 'httpbin.org', 'Should fetch httpbin content');
      assertIncludes(result, 'URL: https://httpbin.org/get', 'Should include source URL');
    }
  }

  // ── Test 2: Invalid URL scheme ────────────────────────────────────────────
  console.log('  Reject non-HTTP URL...');
  {
    const result = await tool.execute({ url: 'ftp://example.com/file.txt' });
    assertIncludes(result, 'Error: URL must start with http:// or https://', 'Should reject ftp URL');
  }

  // ── Test 3: SSRF blocked ──────────────────────────────────────────────────
  console.log('  SSRF block localhost...');
  {
    const result = await tool.execute({ url: 'http://127.0.0.1:8080/admin' });
    assertIncludes(result, 'SSRF blocked', 'Should block localhost');
  }

  console.log('  SSRF block private IP...');
  {
    const result = await tool.execute({ url: 'http://192.168.1.1' });
    assertIncludes(result, 'SSRF blocked', 'Should block private IP');
  }

  console.log('  SSRF block metadata endpoint...');
  {
    const result = await tool.execute({ url: 'http://metadata.google.internal' });
    assertIncludes(result, 'SSRF blocked', 'Should block metadata endpoint');
  }

  // ── Test 4: max_chars clamping ────────────────────────────────────────────
  console.log('  max_chars clamping...');
  {
    const result = await tool.execute({ url: 'https://httpbin.org/get', max_chars: 50 });
    if (!result.includes('SSRF blocked')) {
      const contentMatch = result.match(/Content:\n([\s\S]*)/);
      if (contentMatch) {
        const contentLength = contentMatch[1].length;
        assert(contentLength <= 60, `Content should be truncated near 50 chars, got ${contentLength}`);
      }
    }
  }

  // ── Test 5: Non-existent domain ───────────────────────────────────────────
  console.log('  Non-existent domain...');
  {
    const result = await tool.execute({ url: 'https://this-domain-does-not-exist-12345.xyz' });
    assertIncludes(result, 'Error:', 'Should return error for non-existent domain');
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});

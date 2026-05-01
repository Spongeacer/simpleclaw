/**
 * Web Search Tool — Unit & Integration Tests
 *
 * Tests:
 *   1. HTML parsers with fixture data (no network)
 *   2. Error handling paths via fetch mocking
 *   3. Real network smoke test (fast, skipped if offline)
 *
 * Run with: node tests/test-web-search-unit.mjs
 */

import { createWebSearchTool } from '../dist/agent-runtime/tools/web-search.js';

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

// ─── Fetch Mock Helper ────────────────────────────────────────────────────────

let originalFetch;
let mockFetchCalls = [];

function installMockFetch(responses) {
  originalFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = async (url, opts) => {
    mockFetchCalls.push({ url: String(url), opts });
    const res = responses[callIndex++];
    if (typeof res === 'function') return res(url, opts);
    return res;
  };
}

function uninstallMockFetch() {
  globalThis.fetch = originalFetch;
  mockFetchCalls = [];
}

function mockHtmlResponse(html, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => html,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n🧪 Web Search Unit Tests\n');

  const tool = createWebSearchTool({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  });

  // ── Test 1: Bing parser works with fixture HTML ───────────────────────────
  console.log('  Bing parser with fixture HTML...');
  {
    const bingHtml = `
<ol id="b_results">
  <li class="b_algo" data-id="1">
    <h2><a href="https://example.com/1">First <b>Result</b> Title</a></h2>
    <p>This is the first result snippet with some content.</p>
  </li>
  <li class="b_algo" data-id="2">
    <h2><a href="https://example.com/2">Second Result Title</a></h2>
    <div class="b_caption">Snippet inside b_caption div for second result.</div>
  </li>
  <li class="b_algo">
    <h2><a href="https://example.com/3">Third Result</a></h2>
  </li>
</ol>`;

    installMockFetch([
      mockHtmlResponse(bingHtml),
    ]);

    const result = await tool.execute({ query: 'fixture-bing', max_results: 5 });
    uninstallMockFetch();

    assertIncludes(result, 'Search results for "fixture-bing"', 'Should contain query header');
    assertIncludes(result, '1. First Result Title', 'Should parse title with inner HTML stripped');
    assertIncludes(result, 'URL: https://example.com/1', 'Should include first URL');
    assertIncludes(result, 'This is the first result snippet', 'Should include first snippet');
    assertIncludes(result, '2. Second Result Title', 'Should include second result');
    assertIncludes(result, 'Snippet inside b_caption div', 'Should parse snippet from b_caption');
    assertIncludes(result, '3. Third Result', 'Should include third result without snippet');
  }

  // ── Test 2: Baidu parser works with fixture HTML ──────────────────────────
  console.log('  Baidu parser with fixture HTML...');
  {
    const baiduHtml = `
<div class="result">
  <h3 class="t"><a href="https://baidu-example.com/a">Baidu First</a></h3>
  <span class="content-right_8Zs40">First snippet from Baidu.</span>
</div>
<div class="result c-container">
  <h3 class="t"><a href="/link?url=https://baidu-example.com/b">Baidu Second</a></h3>
  <div class="content-right_abc123">Second snippet with different class.</div>
</div>
<div class="result">
  <h3 class="t"><a href="https://baidu-example.com/c">Baidu Third</a></h3>
  <span class="c-abstract">Third snippet using c-abstract class.</span>
</div>`;

    // Bing returns empty, Baidu returns results
    installMockFetch([
      mockHtmlResponse('<html><body>no results</body></html>'), // Bing empty
      mockHtmlResponse(baiduHtml),                                // Baidu has results
    ]);

    const result = await tool.execute({ query: 'fixture-baidu', max_results: 5 });
    uninstallMockFetch();

    assertIncludes(result, 'Search results for "fixture-baidu"', 'Should contain query header');
    assertIncludes(result, '1. Baidu First', 'Should parse first Baidu title');
    assertIncludes(result, 'URL: https://baidu-example.com/a', 'Should include first Baidu URL');
    assertIncludes(result, '2. Baidu Second', 'Should include second result');
    assertIncludes(result, 'URL: https://www.baidu.com/link?url=https://baidu-example.com/b', 'Should prepend baidu.com to relative redirect URL');
    assertIncludes(result, '3. Baidu Third', 'Should include third result');
    assertIncludes(result, 'Third snippet using c-abstract', 'Should parse c-abstract snippet');
  }

  // ── Test 3: Network timeout produces informative error ────────────────────
  console.log('  Network failure error message...');
  {
    // Need 4 responses: Bing/Baidu for attempt 0, then retry Bing/Baidu for attempt 1
    const networkError = () => { throw new Error('fetch failed: connect ETIMEDOUT'); };
    installMockFetch([networkError, networkError, networkError, networkError]);

    const result = await tool.execute({ query: 'network-fail', max_results: 2 });
    uninstallMockFetch();

    assertIncludes(result, 'Search error for "network-fail"', 'Should indicate search error');
    assertIncludes(result, 'Unable to reach', 'Should mention unable to reach');
    assertIncludes(result, 'HTTP_PROXY/HTTPS_PROXY', 'Should hint at proxy configuration');
  }

  // ── Test 4: HTTP error from search engine ─────────────────────────────────
  console.log('  HTTP error handling...');
  {
    // Need 4 responses for retry logic
    installMockFetch([
      mockHtmlResponse('Forbidden', 403),
      mockHtmlResponse('Forbidden', 403),
      mockHtmlResponse('Forbidden', 403),
      mockHtmlResponse('Forbidden', 403),
    ]);

    const result = await tool.execute({ query: 'http-error', max_results: 2 });
    uninstallMockFetch();

    assertIncludes(result, 'Search error for "http-error"', 'Should indicate search error');
    assertIncludes(result, 'HTTP 403', 'Should mention HTTP status');
  }

  // ── Test 5: Empty results from both engines ───────────────────────────────
  console.log('  Empty results handling...');
  {
    installMockFetch([
      mockHtmlResponse('<html><body>no b_algo here</body></html>'),
      mockHtmlResponse('<html><body>no result class here</body></html>'),
    ]);

    const result = await tool.execute({ query: 'empty-results', max_results: 2 });
    uninstallMockFetch();

    assertIncludes(result, 'No results found for "empty-results"', 'Should indicate no results');
    assertIncludes(result, 'page layout', 'Should hint at page layout change');
  }

  // ── Test 6: max_results clamping ──────────────────────────────────────────
  console.log('  max_results clamping...');
  {
    // Generate HTML with many results
    let bingHtml = '<ol id="b_results">';
    for (let i = 0; i < 20; i++) {
      bingHtml += `<li class="b_algo"><h2><a href="https://example.com/${i}">Result ${i}</a></h2><p>Snippet ${i}</p></li>`;
    }
    bingHtml += '</ol>';

    installMockFetch([mockHtmlResponse(bingHtml)]);
    const result = await tool.execute({ query: 'many-results', max_results: 15 });
    uninstallMockFetch();

    // Should cap at 10
    const match = result.match(/^\d+\./gm);
    const count = match ? match.length : 0;
    assert(count <= 10, `Expected at most 10 results, got ${count}`);
    assert(count >= 5, `Expected at least 5 results, got ${count}`);
  }

  // ── Test 7: Real network smoke test (skipped if offline) ──────────────────
  console.log('  Real network smoke test...');
  {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);
      await fetch('https://cn.bing.com', { signal: controller.signal, method: 'HEAD' });

      // We're online — run a quick real search
      const result = await tool.execute({ query: 'github', max_results: 2 });
      assertIncludes(result, 'Search results for "github"', 'Real search should return formatted results');
      assertIncludes(result, 'URL:', 'Real search should contain URLs');
    } catch {
      console.log('    ⏭️  skipped (offline or Bing unreachable)');
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

function assertIncludes(haystack, needle, message) {
  assert(
    haystack.includes(needle),
    `${message}\n  expected to include: "${needle}"\n  got: "${haystack.slice(0, 200).replace(/\n/g, ' ')}"`
  );
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});

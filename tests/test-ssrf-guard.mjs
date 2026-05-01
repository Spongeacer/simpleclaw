/**
 * SSRF Guard Test
 * Verifies that private/internal IPs and metadata endpoints are blocked.
 */

import { checkSsrf } from '../dist/agent-runtime/ssrf-guard.js';

// ─── Allowed ─────────────────────────────────────────────────────────────────

async function testAllowsPublicIP() {
  const result = await checkSsrf('http://1.2.3.4/path');
  if (!result.allowed) {
    throw new Error(`Expected 1.2.3.4 to be allowed, got: ${result.reason}`);
  }
  console.log('  ✅ Public IPv4 allowed');
}

async function testAllowsPublicDomain() {
  const result = await checkSsrf('http://example.com');
  if (!result.allowed) {
    throw new Error(`Expected example.com to be allowed, got: ${result.reason}`);
  }
  console.log('  ✅ Public domain allowed');
}

// ─── IPv4 blocked ────────────────────────────────────────────────────────────

async function testBlocksIPv4Loopback() {
  const result = await checkSsrf('http://127.0.0.1');
  if (result.allowed) throw new Error('Expected 127.0.0.1 to be blocked');
  if (!result.reason.includes('127.0.0.0/8')) throw new Error(`Unexpected reason: ${result.reason}`);
  console.log('  ✅ 127.0.0.0/8 blocked');
}

async function testBlocksIPv4Private10() {
  const result = await checkSsrf('http://10.0.0.1');
  if (result.allowed) throw new Error('Expected 10.0.0.1 to be blocked');
  if (!result.reason.includes('10.0.0.0/8')) throw new Error(`Unexpected reason: ${result.reason}`);
  console.log('  ✅ 10.0.0.0/8 blocked');
}

async function testBlocksIPv4Private172() {
  const result = await checkSsrf('http://172.16.0.1');
  if (result.allowed) throw new Error('Expected 172.16.0.1 to be blocked');
  if (!result.reason.includes('172.16.0.0/12')) throw new Error(`Unexpected reason: ${result.reason}`);
  console.log('  ✅ 172.16.0.0/12 blocked');
}

async function testBlocksIPv4Private192() {
  const result = await checkSsrf('http://192.168.1.1');
  if (result.allowed) throw new Error('Expected 192.168.1.1 to be blocked');
  if (!result.reason.includes('192.168.0.0/16')) throw new Error(`Unexpected reason: ${result.reason}`);
  console.log('  ✅ 192.168.0.0/16 blocked');
}

async function testBlocksIPv4LinkLocal() {
  const result = await checkSsrf('http://169.254.169.254/latest/meta-data/');
  if (result.allowed) throw new Error('Expected 169.254.169.254 to be blocked');
  if (!result.reason.includes('169.254.0.0/16')) throw new Error(`Unexpected reason: ${result.reason}`);
  console.log('  ✅ 169.254.0.0/16 (metadata) blocked');
}

async function testBlocksIPv4Zero() {
  const result = await checkSsrf('http://0.0.0.0');
  if (result.allowed) throw new Error('Expected 0.0.0.0 to be blocked');
  if (!result.reason.includes('0.0.0.0')) throw new Error(`Unexpected reason: ${result.reason}`);
  console.log('  ✅ 0.0.0.0 blocked');
}

async function testBlocksIPv4Broadcast() {
  const result = await checkSsrf('http://255.255.255.255');
  if (result.allowed) throw new Error('Expected 255.255.255.255 to be blocked');
  if (!result.reason.includes('255.255.255.255')) throw new Error(`Unexpected reason: ${result.reason}`);
  console.log('  ✅ 255.255.255.255 blocked');
}

// ─── IPv6 blocked ────────────────────────────────────────────────────────────

async function testBlocksIPv6Loopback() {
  const result = await checkSsrf('http://[::1]');
  if (result.allowed) throw new Error('Expected ::1 to be blocked');
  if (!result.reason.includes('::1/128')) throw new Error(`Unexpected reason: ${result.reason}`);
  console.log('  ✅ ::1 blocked');
}

async function testBlocksIPv6Unspecified() {
  const result = await checkSsrf('http://[::]');
  if (result.allowed) throw new Error('Expected :: to be blocked');
  if (!result.reason.includes('::/128')) throw new Error(`Unexpected reason: ${result.reason}`);
  console.log('  ✅ :: blocked');
}

async function testBlocksIPv6LinkLocal() {
  const result = await checkSsrf('http://[fe80::1]');
  if (result.allowed) throw new Error('Expected fe80::1 to be blocked');
  if (!result.reason.includes('fe80::/10')) throw new Error(`Unexpected reason: ${result.reason}`);
  console.log('  ✅ fe80::/10 blocked');
}

async function testBlocksIPv6UniqueLocalFC() {
  const result = await checkSsrf('http://[fc00::1]');
  if (result.allowed) throw new Error('Expected fc00::1 to be blocked');
  if (!result.reason.includes('fc00::/7')) throw new Error(`Unexpected reason: ${result.reason}`);
  console.log('  ✅ fc00::/7 blocked');
}

async function testBlocksIPv6UniqueLocalFD() {
  const result = await checkSsrf('http://[fd00::1]');
  if (result.allowed) throw new Error('Expected fd00::1 to be blocked');
  if (!result.reason.includes('fd00::/7')) throw new Error(`Unexpected reason: ${result.reason}`);
  console.log('  ✅ fd00::/7 blocked');
}

// ─── Domain blacklist ────────────────────────────────────────────────────────

async function testBlocksLocalhost() {
  const result = await checkSsrf('http://localhost:8080/api');
  if (result.allowed) throw new Error('Expected localhost to be blocked');
  if (!result.reason.includes('blacklisted')) throw new Error(`Unexpected reason: ${result.reason}`);
  console.log('  ✅ localhost blocked');
}

async function testBlocksMetadataGoogle() {
  const result = await checkSsrf('http://metadata.google.internal');
  if (result.allowed) throw new Error('Expected metadata.google.internal to be blocked');
  if (!result.reason.includes('blacklisted')) throw new Error(`Unexpected reason: ${result.reason}`);
  console.log('  ✅ metadata.google.internal blocked');
}

// ─── Invalid URL ─────────────────────────────────────────────────────────────

async function testBlocksInvalidUrl() {
  const result = await checkSsrf('not-a-valid-url');
  if (result.allowed) throw new Error('Expected invalid URL to be blocked');
  if (!result.reason.includes('invalid URL')) throw new Error(`Unexpected reason: ${result.reason}`);
  console.log('  ✅ Invalid URL blocked');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  const tests = [
    testAllowsPublicIP,
    testAllowsPublicDomain,
    testBlocksIPv4Loopback,
    testBlocksIPv4Private10,
    testBlocksIPv4Private172,
    testBlocksIPv4Private192,
    testBlocksIPv4LinkLocal,
    testBlocksIPv4Zero,
    testBlocksIPv4Broadcast,
    testBlocksIPv6Loopback,
    testBlocksIPv6Unspecified,
    testBlocksIPv6LinkLocal,
    testBlocksIPv6UniqueLocalFC,
    testBlocksIPv6UniqueLocalFD,
    testBlocksLocalhost,
    testBlocksMetadataGoogle,
    testBlocksInvalidUrl,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (e) {
      console.log(`  ❌ ${test.name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${passed}/${tests.length} SSRF guard tests passed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});

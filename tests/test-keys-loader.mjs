/**
 * Keys / Secrets Loader Tests
 * Tests: loadSecrets, getProviderKeys, getSecretsEnv, resolveKeyRef, maskKey, injectProviderKeys
 */

import { loadSecrets, getProviderKeys, getSecretsEnv, resolveKeyRef, maskKey, injectProviderKeys } from '../dist/cli/keys-loader.js';
import { mkdir, writeFile, rm } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testLoadSecretsPartitioned() {
  const dir = resolve(tmpdir(), `simpleclaw-secrets-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  // No secrets.json → empty object
  const empty = loadSecrets(dir);
  if (Object.keys(empty).length !== 0) {
    throw new Error('Expected empty object when secrets.json missing');
  }

  // Write partitioned secrets.json
  await writeFile(resolve(dir, 'secrets.json'), JSON.stringify({
    providers: {
      moonshot: 'sk-moonshot-123',
      openrouter: 'sk-or-456',
    },
    env: {
      GITHUB_TOKEN: 'ghp-xxx',
      NPM_TOKEN: 'npm-yyy',
    },
  }), 'utf-8');

  const secrets = loadSecrets(dir);
  const providers = getProviderKeys(secrets);
  const env = getSecretsEnv(secrets);

  if (providers.moonshot !== 'sk-moonshot-123') {
    throw new Error('Expected moonshot provider key');
  }
  if (providers.openrouter !== 'sk-or-456') {
    throw new Error('Expected openrouter provider key');
  }
  if (env.GITHUB_TOKEN !== 'ghp-xxx') {
    throw new Error('Expected GITHUB_TOKEN in env');
  }
  if (env.NPM_TOKEN !== 'npm-yyy') {
    throw new Error('Expected NPM_TOKEN in env');
  }

  await rm(dir, { recursive: true, force: true });
  console.log('  ✅ Partitioned secrets.json loads providers and env correctly');
}

async function testLoadSecretsBackwardCompat() {
  const dir = resolve(tmpdir(), `simpleclaw-keys-compat-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  // Write old flat keys.json (no partitioned sections)
  await writeFile(resolve(dir, 'keys.json'), JSON.stringify({
    moonshot: 'sk-moon-123',
    openrouter: 'sk-or-456',
  }), 'utf-8');

  const secrets = loadSecrets(dir);
  const providers = getProviderKeys(secrets);
  const env = getSecretsEnv(secrets);

  if (providers.moonshot !== 'sk-moon-123') {
    throw new Error('Backward compat: expected moonshot key');
  }
  if (providers.openrouter !== 'sk-or-456') {
    throw new Error('Backward compat: expected openrouter key');
  }
  if (Object.keys(env).length !== 0) {
    throw new Error('Backward compat: expected empty env for flat format');
  }

  await rm(dir, { recursive: true, force: true });
  console.log('  ✅ Flat keys.json backward compatibility');
}

async function testResolveKeyRef() {
  const keys = { moonshot: 'sk-123', openrouter: 'sk-456' };

  if (resolveKeyRef('{{moonshot}}', keys) !== 'sk-123') {
    throw new Error('Failed to resolve {{moonshot}}');
  }
  if (resolveKeyRef('{{  openrouter  }}', keys) !== 'sk-456') {
    throw new Error('Failed to resolve {{  openrouter  }}');
  }
  if (resolveKeyRef('plain-text', keys) !== 'plain-text') {
    throw new Error('Non-reference should return unchanged');
  }

  try {
    resolveKeyRef('{{missing}}', keys);
    throw new Error('Expected error for missing key');
  } catch (e) {
    if (!e.message.includes('not found')) {
      throw new Error(`Unexpected error message: ${e.message}`);
    }
  }

  console.log('  ✅ resolveKeyRef handles references and plain values');
}

async function testMaskKey() {
  if (maskKey('sk-1234567890abcdef') !== 'sk-1...cdef') {
    throw new Error(`Unexpected mask result: ${maskKey('sk-1234567890abcdef')}`);
  }
  if (maskKey('short') !== '***') {
    throw new Error('Short key should be fully masked');
  }

  console.log('  ✅ maskKey hides sensitive parts');
}

async function testInjectProviderKeys() {
  const providers = {
    moonshot: { apiKey: '{{moonshot}}' },
    openrouter: { apiKey: '{{openrouter}}' },
    direct: { apiKey: 'hardcoded-key' },
  };

  const keys = {
    moonshot: 'sk-moon-123',
    openrouter: 'sk-or-456',
  };

  injectProviderKeys(providers, keys);

  if (providers.moonshot.apiKey !== 'sk-moon-123') {
    throw new Error('Expected moonshot key to be injected');
  }
  if (providers.openrouter.apiKey !== 'sk-or-456') {
    throw new Error('Expected openrouter key to be injected');
  }
  if (providers.direct.apiKey !== 'hardcoded-key') {
    throw new Error('Hardcoded key should remain unchanged');
  }

  console.log('  ✅ injectProviderKeys resolves references and preserves literals');
}

async function testSecretsNotExposedToPrompt() {
  const fs = await import('fs/promises');
  const path = await import('path');
  const { fileURLToPath } = await import('url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  const srcDir = path.resolve(__dirname, '../dist');
  const files = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.js')) {
        files.push(full);
      }
    }
  }
  await walk(srcDir);

  const importers = [];
  for (const f of files) {
    const content = await fs.readFile(f, 'utf-8');
    if (content.includes('keys-loader') && !f.includes('cli' + path.sep + 'keys-loader') && !f.includes('cli' + path.sep + 'index')) {
      importers.push(path.relative(srcDir, f));
    }
  }

  if (importers.length > 0) {
    throw new Error(`keys-loader imported outside CLI layer by: ${importers.join(', ')}`);
  }

  console.log('  ✅ keys-loader is isolated to CLI layer');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  const tests = [
    testLoadSecretsPartitioned,
    testLoadSecretsBackwardCompat,
    testResolveKeyRef,
    testMaskKey,
    testInjectProviderKeys,
    testSecretsNotExposedToPrompt,
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

  console.log(`\n${passed}/${tests.length} keys/secrets tests passed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});

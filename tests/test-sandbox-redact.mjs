/**
 * Sandbox Output Redaction Test
 * Verifies that secrets injected via env are redacted from stdout/stderr
 * before returning to the agent (and thus to the LLM).
 */

import { DockerSandbox } from '../dist/agent-runtime/sandbox.js';
import { mkdir, writeFile, rm } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

async function testRedactsEnvSecretsFromStdout() {
  const workspace = resolve(tmpdir(), `simpleclaw-redact-test-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger,
    { GITHUB_TOKEN: 'ghp_1234567890abcdef', NPM_TOKEN: 'npm_xxx' }
  );

  // Execute a command that would print the secret
  const result = await sandbox.exec('echo "Token: ghp_1234567890abcdef"');

  if (result.stdout.includes('ghp_1234567890abcdef')) {
    throw new Error('Secret should be redacted from stdout');
  }
  if (!result.stdout.includes('[REDACTED]')) {
    throw new Error('Expected [REDACTED] placeholder in stdout');
  }

  await rm(workspace, { recursive: true, force: true });
  console.log('  ✅ Secrets redacted from stdout');
}

async function testRedactsEnvSecretsFromStderr() {
  const workspace = resolve(tmpdir(), `simpleclaw-redact-test-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger,
    { SECRET: 'my-secret-value' }
  );

  // Execute a command that prints to stderr
  const isWin = process.platform === 'win32';
  const cmd = isWin
    ? 'echo Error: my-secret-value >&2'
    : 'echo "Error: my-secret-value" >&2';
  const result = await sandbox.exec(cmd);

  if (result.stderr.includes('my-secret-value')) {
    throw new Error('Secret should be redacted from stderr');
  }

  await rm(workspace, { recursive: true, force: true });
  console.log('  ✅ Secrets redacted from stderr');
}

async function testDoesNotRedactShortValues() {
  const workspace = resolve(tmpdir(), `simpleclaw-redact-test-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger,
    { SHORT: 'ab' } // below REDACT_MIN_LENGTH
  );

  const result = await sandbox.exec('echo "ab"');

  if (!result.stdout.includes('ab')) {
    throw new Error('Short values (below min length) should NOT be redacted');
  }

  await rm(workspace, { recursive: true, force: true });
  console.log('  ✅ Short secrets (< 4 chars) are not redacted (avoid false positives)');
}

async function testPreservesNonSecretOutput() {
  const workspace = resolve(tmpdir(), `simpleclaw-redact-test-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger,
    { TOKEN: 'ghp_1234567890abcdef' }
  );

  const result = await sandbox.exec('echo "Hello World"');

  if (!result.stdout.includes('Hello World')) {
    throw new Error('Non-secret output should be preserved');
  }

  await rm(workspace, { recursive: true, force: true });
  console.log('  ✅ Non-secret output preserved');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  const tests = [
    testRedactsEnvSecretsFromStdout,
    testRedactsEnvSecretsFromStderr,
    testDoesNotRedactShortValues,
    testPreservesNonSecretOutput,
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

  console.log(`\n${passed}/${tests.length} sandbox redaction tests passed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});

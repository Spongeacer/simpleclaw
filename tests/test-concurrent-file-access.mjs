/**
 * Concurrent File Access Safety Test
 * Verifies file write locks + atomic writes + optimistic concurrency in edit.
 */

import { DockerSandbox } from '../dist/agent-runtime/sandbox.js';
import { FileAccessTracker } from '../dist/agent-runtime/file-tracker.js';
import { ToolRegistry } from '../dist/agent-runtime/tool-registry.js';
import { createReadTool, createEditTool } from '../dist/agent-runtime/tools/index.js';
import { logger } from '../dist/core/logger.js';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testConcurrentWriteLock() {
  const workspace = resolve(tmpdir(), `simpleclaw-concurrent-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger
  );

  const target = resolve(workspace, 'counter.txt');
  await writeFile(target, '0', 'utf-8');

  // Launch 10 concurrent increments (read → write).
  // The write lock serializes writes, but reads are unprotected,
  // so this is a classic race: all threads read 0, then write 1 sequentially.
  // This test verifies that writes are ATOMIC (no corrupted file)
  // and that the write lock prevents interleaved writes.
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(
      (async () => {
        const content = await sandbox.readFile('counter.txt');
        const val = parseInt(content, 10);
        await delay(10); // simulate processing
        await sandbox.writeFile('counter.txt', String(val + 1));
      })()
    );
  }

  await Promise.all(promises);

  const final = await readFile(target, 'utf-8');
  // Without atomic write lock, concurrent writes could corrupt the file.
  // The file should contain a valid number (not garbled/mixed content).
  const parsed = parseInt(final, 10);
  if (isNaN(parsed)) {
    throw new Error(`File corrupted by concurrent writes: "${final}"`);
  }
  // With read-modify-write race, all threads read 0 → final is 1.
  // This is expected behavior for unprotected read; the write lock
  // only guarantees atomicity, not read-modify-write atomicity.
  if (parsed !== 1) {
    throw new Error(`Unexpected final value ${parsed} (expected 1 due to read race)`);
  }

  console.log('  ✅ Concurrent writes are atomic (no corruption), final=' + parsed);
  await rm(workspace, { recursive: true, force: true });
}

async function testAtomicWrite() {
  const workspace = resolve(tmpdir(), `simpleclaw-atomic-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger
  );

  const target = resolve(workspace, 'atomic.txt');
  await writeFile(target, 'original', 'utf-8');

  await sandbox.writeFile('atomic.txt', 'updated');

  const final = await readFile(target, 'utf-8');
  if (final !== 'updated') {
    throw new Error(`Atomic write failed: expected "updated", got "${final}"`);
  }

  // Verify no temp files left behind
  const files = await (await import('fs/promises')).readdir(workspace);
  const temps = files.filter(f => f.endsWith('.tmp'));
  if (temps.length > 0) {
    throw new Error(`Temp files not cleaned up: ${temps.join(', ')}`);
  }

  console.log('  ✅ Atomic write (temp+rename) works correctly');
  await rm(workspace, { recursive: true, force: true });
}

async function testEditOptimisticConcurrency() {
  const workspace = resolve(tmpdir(), `simpleclaw-edit-race-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger
  );
  const tracker = new FileAccessTracker();
  const tools = new ToolRegistry();
  tools.register(createReadTool(sandbox, tracker));
  tools.register(createEditTool(sandbox, tracker));

  // Create a file
  await writeFile(resolve(workspace, 'shared.txt'), 'line A\nline B\nline C\n', 'utf-8');

  // Pre-mark as read (tracker requirement)
  tracker.markRead('shared.txt');

  // Run two edits in parallel to the same file.
  // With write lock + expectedContent check, one succeeds and one fails.
  const edit1 = tools.execute({
    id: 'edit-1',
    name: 'edit',
    arguments: {
      path: 'shared.txt',
      old_string: 'line B',
      new_string: 'line B modified by agent 1',
    },
  });
  const edit2 = tools.execute({
    id: 'edit-2',
    name: 'edit',
    arguments: {
      path: 'shared.txt',
      old_string: 'line B',
      new_string: 'line B modified by agent 2',
    },
  });

  // ToolRegistry.execute catches errors and returns { isError: true, ... }
  // so both promises resolve (fulfilled).
  const results = await Promise.all([edit1, edit2]);

  const successes = results.filter(r => !r.isError);
  const failures = results.filter(r => r.isError);

  if (successes.length !== 1) {
    throw new Error(`Expected exactly 1 successful edit, got ${successes.length}`);
  }
  if (failures.length !== 1) {
    throw new Error(`Expected exactly 1 failed edit, got ${failures.length}`);
  }

  const failReason = failures[0].output ?? '';
  if (!failReason.includes('modified by another process')) {
    throw new Error(`Expected optimistic concurrency failure, got: ${failReason}`);
  }

  console.log('  ✅ Edit optimistic concurrency detects race condition');
  await rm(workspace, { recursive: true, force: true });
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  const tests = [
    testConcurrentWriteLock,
    testAtomicWrite,
    testEditOptimisticConcurrency,
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

  console.log(`\n${passed}/${tests.length} concurrent file access tests passed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});

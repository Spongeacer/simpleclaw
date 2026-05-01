/**
 * Session Store Tests
 * Validates both MemorySessionStore and SQLiteSessionStore.
 */

import { MemorySessionStore, SQLiteSessionStore } from '../dist/gateway/session-store.js';
import { rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ─── Memory Store ────────────────────────────────────────────────────────────

async function testMemoryStoreCrud() {
  const store = new MemorySessionStore();

  const created = await store.create({
    sessionId: 's1',
    agentId: 'a1',
    turns: [{ id: 't1', role: 'user', content: 'hello', timestamp: new Date() }],
    tokenCount: 10,
  });
  if (created.sessionId !== 's1') throw new Error('create failed');

  const got = await store.get('s1');
  if (!got || got.tokenCount !== 10) throw new Error('get failed');

  await store.update('s1', { tokenCount: 20 });
  const updated = await store.get('s1');
  if (updated?.tokenCount !== 20) throw new Error('update failed');

  const listed = await store.list();
  if (listed.length !== 1) throw new Error('list failed');

  const filtered = await store.list('a1');
  if (filtered.length !== 1) throw new Error('list filter failed');

  const emptyFilter = await store.list('a2');
  if (emptyFilter.length !== 0) throw new Error('list empty filter failed');

  await store.delete('s1');
  const deleted = await store.get('s1');
  if (deleted !== null) throw new Error('delete failed');

  console.log('  ✅ Memory store CRUD');
}

// ─── SQLite Store ────────────────────────────────────────────────────────────

async function testSQLiteStoreCrud() {
  const dbPath = join(tmpdir(), `sc-sessions-${Date.now()}.db`);
  const store = new SQLiteSessionStore(dbPath);

  const created = await store.create({
    sessionId: 's1',
    agentId: 'a1',
    channelId: 'c1',
    parentSessionId: 'p1',
    turns: [{ id: 't1', role: 'user', content: 'hello', timestamp: new Date() }],
    tokenCount: 10,
    metadata: { foo: 'bar' },
  });
  if (created.sessionId !== 's1') throw new Error('create failed');

  const got = await store.get('s1');
  if (!got) throw new Error('get returned null');
  if (got.agentId !== 'a1') throw new Error('agentId mismatch');
  if (got.channelId !== 'c1') throw new Error('channelId mismatch');
  if (got.parentSessionId !== 'p1') throw new Error('parentSessionId mismatch');
  if (got.tokenCount !== 10) throw new Error('tokenCount mismatch');
  if (got.turns.length !== 1) throw new Error('turns mismatch');
  if (got.metadata.foo !== 'bar') throw new Error('metadata mismatch');
  if (!(got.createdAt instanceof Date)) throw new Error('createdAt not Date');
  if (!(got.updatedAt instanceof Date)) throw new Error('updatedAt not Date');

  await store.update('s1', { tokenCount: 25, metadata: { updated: true } });
  const updated = await store.get('s1');
  if (updated?.tokenCount !== 25) throw new Error('update tokenCount failed');
  if (updated?.metadata.updated !== true) throw new Error('update metadata failed');

  // Create second session for list
  await store.create({
    sessionId: 's2',
    agentId: 'a1',
    turns: [],
    tokenCount: 5,
  });
  await store.create({
    sessionId: 's3',
    agentId: 'a2',
    turns: [],
    tokenCount: 0,
  });

  const all = await store.list();
  if (all.length !== 3) throw new Error(`expected 3 sessions, got ${all.length}`);

  const forA1 = await store.list('a1');
  if (forA1.length !== 2) throw new Error(`expected 2 for a1, got ${forA1.length}`);

  const forA2 = await store.list('a2');
  if (forA2.length !== 1) throw new Error(`expected 1 for a2, got ${forA2.length}`);

  await store.delete('s1');
  const deleted = await store.get('s1');
  if (deleted !== null) throw new Error('delete failed');

  store.close();

  // Verify database file was actually created
  if (!existsSync(dbPath)) throw new Error('SQLite database file not created');

  rmSync(dbPath);
  console.log('  ✅ SQLite store CRUD');
}

async function testSQLitePersistence() {
  const dbPath = join(tmpdir(), `sc-sessions-persist-${Date.now()}.db`);

  // Phase 1: create store, insert, close
  const store1 = new SQLiteSessionStore(dbPath);
  await store1.create({
    sessionId: 'persist-s1',
    agentId: 'a1',
    turns: [{ id: 't1', role: 'user', content: 'hello', timestamp: new Date() }],
    tokenCount: 42,
  });
  store1.close();

  // Phase 2: reopen, data should still be there
  const store2 = new SQLiteSessionStore(dbPath);
  const got = await store2.get('persist-s1');
  if (!got) throw new Error('Data not persisted across reopen');
  if (got.tokenCount !== 42) throw new Error('Persisted data corrupted');
  store2.close();

  rmSync(dbPath);
  console.log('  ✅ SQLite persistence across reopen');
}

async function testSQLiteNullFields() {
  const dbPath = join(tmpdir(), `sc-sessions-null-${Date.now()}.db`);
  const store = new SQLiteSessionStore(dbPath);

  const created = await store.create({
    sessionId: 'null-s1',
    agentId: 'a1',
    turns: [],
    tokenCount: 0,
    // channelId, parentSessionId, metadata omitted
  });
  if (created.channelId !== undefined) throw new Error('channelId should be undefined');
  if (created.parentSessionId !== undefined) throw new Error('parentSessionId should be undefined');
  if (created.metadata !== undefined) throw new Error('metadata should be undefined');

  const got = await store.get('null-s1');
  if (got?.channelId !== undefined) throw new Error('round-trip channelId should be undefined');
  if (got?.parentSessionId !== undefined) throw new Error('round-trip parentSessionId should be undefined');
  if (got?.metadata !== undefined) throw new Error('round-trip metadata should be undefined');

  store.close();
  rmSync(dbPath);
  console.log('  ✅ SQLite null fields round-trip');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  const tests = [
    testMemoryStoreCrud,
    testSQLiteStoreCrud,
    testSQLitePersistence,
    testSQLiteNullFields,
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

  console.log(`\n${passed}/${tests.length} session store tests passed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});

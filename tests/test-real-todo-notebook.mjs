/**
 * Real Todo & Notebook Edit Test
 * Tests todo_write, todo_read, and notebook_edit with real file operations.
 * Run with: node tests/test-real-todo-notebook.mjs
 */

import { DockerSandbox } from '../dist/agent-runtime/sandbox.js';
import { logger } from '../dist/core/logger.js';
import { mkdir, rm, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';

import {
  createTodoWriteTool,
  createTodoReadTool,
  createNotebookEditTool,
} from '../dist/agent-runtime/tools/index.js';

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
  console.log('\n🧪 Real Todo & Notebook Edit Test\n');

  const workspace = resolve(tmpdir(), `simpleclaw-todo-nb-test-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger
  );

  const todoWrite = createTodoWriteTool(sandbox);
  const todoRead = createTodoReadTool(sandbox);
  const notebookEdit = createNotebookEditTool(sandbox);

  // ── todo_write: create new todos ──────────────────────────────────────────
  console.log('  todo_write (create)...');
  {
    const result = await todoWrite.execute({
      todos: [
        { content: 'First task', status: 'pending', priority: 'high' },
        { content: 'Second task', status: 'in_progress' },
      ],
    });
    assertIncludes(result, 'First task', 'Should show first task');
    assertIncludes(result, 'Second task', 'Should show second task');
    assertIncludes(result, '🔴', 'Should show high priority emoji');
    assertIncludes(result, '▶️', 'Should show in_progress emoji');
  }

  // ── todo_read ─────────────────────────────────────────────────────────────
  console.log('  todo_read...');
  {
    const result = await todoRead.execute({});
    assertIncludes(result, 'First task', 'Should show first task');
    assertIncludes(result, 'Second task', 'Should show second task');
  }

  // ── todo_write: update existing by id ─────────────────────────────────────
  console.log('  todo_write (update + complete)...');
  {
    // Read todos.json directly to get IDs (todo_read does not output IDs)
    let todos;
    try {
      const raw = await sandbox.readFile('.simpleclaw/todos.json');
      todos = JSON.parse(raw);
    } catch {
      todos = [];
    }
    if (!Array.isArray(todos) || todos.length === 0) {
      assert(false, 'Could not load todos for update test');
    } else {
      const firstId = todos[0].id;
      const result = await todoWrite.execute({
        updates: [
          { id: firstId, content: 'First task updated', status: 'completed' },
        ],
      });
      assertIncludes(result, 'First task updated', 'Should show updated content');
      assertIncludes(result, '✅', 'Should show completed emoji');
    }
  }

  // ── todo_write: full replacement ──────────────────────────────────────────
  console.log('  todo_write (full replacement)...');
  {
    const result = await todoWrite.execute({
      todos: [
        { content: 'Replaced task A', status: 'pending' },
      ],
    });
    assertIncludes(result, 'Replaced task A', 'Should show replaced task');
    assert(!result.includes('First task'), 'Should not show old tasks');
  }

  // ── notebook_edit: replace cell ───────────────────────────────────────────
  console.log('  notebook_edit (replace)...');
  {
    const notebook = {
      cells: [
        { cell_type: 'code', source: 'print("hello")', metadata: {}, outputs: [], execution_count: 1 },
        { cell_type: 'markdown', source: '# Title', metadata: {} },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    await writeFile(resolve(workspace, 'test.ipynb'), JSON.stringify(notebook, null, 2), 'utf-8');

    const result = await notebookEdit.execute({
      path: 'test.ipynb',
      edit_mode: 'replace',
      cell_index: 0,
      cell_type: 'code',
      source: 'print("world")',
    });
    assertIncludes(result, 'Replaced cell 0', 'Should report cell replacement');

    const content = JSON.parse(await sandbox.readFile('test.ipynb'));
    const source0 = Array.isArray(content.cells[0].source) ? content.cells[0].source.join('') : content.cells[0].source;
    assert(source0.includes('world'), 'Should replace cell content');
  }

  // ── notebook_edit: insert cell ────────────────────────────────────────────
  console.log('  notebook_edit (insert)...');
  {
    const result = await notebookEdit.execute({
      path: 'test.ipynb',
      edit_mode: 'insert',
      cell_index: 1,
      cell_type: 'markdown',
      source: '## Subtitle',
    });
    assertIncludes(result, 'Inserted new markdown cell', 'Should report insertion');

    const content = JSON.parse(await sandbox.readFile('test.ipynb'));
    assert(content.cells.length === 3, 'Should have 3 cells after insert');
  }

  // ── notebook_edit: delete cell ────────────────────────────────────────────
  console.log('  notebook_edit (delete)...');
  {
    const result = await notebookEdit.execute({
      path: 'test.ipynb',
      edit_mode: 'delete',
      cell_index: 1,
    });
    assertIncludes(result, 'Deleted cell 1', 'Should report deletion');

    const content = JSON.parse(await sandbox.readFile('test.ipynb'));
    assert(content.cells.length === 2, 'Should have 2 cells after delete');
  }

  // ── notebook_edit: invalid file ───────────────────────────────────────────
  console.log('  notebook_edit (invalid extension)...');
  {
    const result = await notebookEdit.execute({
      path: 'not-a-notebook.txt',
      edit_mode: 'replace',
      cell_index: 0,
      cell_type: 'code',
      source: 'x',
    });
    assertIncludes(result, 'does not look like a notebook', 'Should reject non-ipynb');
  }

  // Cleanup
  await rm(workspace, { recursive: true, force: true });

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});

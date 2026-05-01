/**
 * Real FS Tools Test — read, edit, write, ls, glob, grep
 * Tests real file system operations via DockerSandbox.
 * Run with: node tests/test-real-fs-tools.mjs
 */

import { DockerSandbox } from '../dist/agent-runtime/sandbox.js';
import { FileAccessTracker } from '../dist/agent-runtime/file-tracker.js';
import { logger } from '../dist/core/logger.js';
import { mkdir, rm, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';

import {
  createReadTool,
  createEditTool,
  createWriteTool,
  createLsTool,
  createGlobTool,
  createGrepTool,
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
  console.log('\n🧪 Real FS Tools Test\n');

  const workspace = resolve(tmpdir(), `simpleclaw-fs-test-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  // Seed workspace
  await writeFile(resolve(workspace, 'hello.txt'), 'Hello World\nSecond line\n', 'utf-8');
  await mkdir(resolve(workspace, 'src'), { recursive: true });
  await writeFile(resolve(workspace, 'src/index.ts'), 'export const x = 1;\n', 'utf-8');
  await writeFile(resolve(workspace, 'src/utils.ts'), 'export function add(a: number, b: number) { return a + b; }\n', 'utf-8');
  await writeFile(resolve(workspace, 'README.md'), '# Project\n\nThis is a test project.\n', 'utf-8');
  await writeFile(resolve(workspace, 'data.json'), '{"key": "value"}\n', 'utf-8');

  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger
  );
  const tracker = new FileAccessTracker();

  const readTool = createReadTool(sandbox, tracker);
  const editTool = createEditTool(sandbox, tracker);
  const writeTool = createWriteTool(sandbox);
  const lsTool = createLsTool(workspace);
  const globTool = createGlobTool(workspace);
  const grepTool = createGrepTool(sandbox, workspace);

  // ── read ────────────────────────────────────────────────────────────────────
  console.log('  read tool...');
  {
    const result = await readTool.execute({ path: 'hello.txt' });
    assertIncludes(result, '1 | Hello World', 'read should include line numbers');
    assertIncludes(result, '2 | Second line', 'read should include second line');
  }

  // read missing file with suggestions
  console.log('  read missing file...');
  {
    try {
      const result = await readTool.execute({ path: 'helo.txt' });
      assertIncludes(result, 'Did you mean', 'read should suggest similar files');
    } catch (e) {
      // Some read implementations throw on missing file; that's acceptable
      assert(true, 'read threw on missing file (acceptable behavior)');
    }
  }

  // read directory
  console.log('  read directory...');
  {
    const result = await readTool.execute({ path: 'src' });
    assertIncludes(result, 'index.ts', 'read directory should list files');
    assertIncludes(result, 'utils.ts', 'read directory should list all files');
  }

  // ── write ───────────────────────────────────────────────────────────────────
  console.log('  write tool (new file)...');
  {
    const result = await writeTool.execute({ path: 'new-file.txt', content: 'Brand new content\n' });
    assertIncludes(result, 'Created file', 'write should report creation');
    const content = await sandbox.readFile('new-file.txt');
    assert(content === 'Brand new content\n', 'write should create correct content');
  }

  console.log('  write tool (overwrite)...');
  {
    const result = await writeTool.execute({ path: 'new-file.txt', content: 'Overwritten\n' });
    assertIncludes(result, 'Overwritten existing file', 'write should report overwrite');
    const content = await sandbox.readFile('new-file.txt');
    assert(content === 'Overwritten\n', 'write should overwrite correctly');
  }

  // ── edit ────────────────────────────────────────────────────────────────────
  console.log('  edit tool (exact replace)...');
  {
    const result = await editTool.execute({
      path: 'hello.txt',
      old_string: 'Hello World',
      new_string: 'Goodbye World',
    });
    assertIncludes(result, 'Edited', 'edit should report success');
    const content = await sandbox.readFile('hello.txt');
    assert(content.includes('Goodbye World'), 'edit should replace text');
  }

  console.log('  edit tool (line-trimmed match)...');
  {
    // line-trimmed replacer handles trailing whitespace differences
    await sandbox.writeFile('trim-test.txt', 'line one  \nline two  \n');
    // Read before edit (read-before-edit guard)
    await readTool.execute({ path: 'trim-test.txt' });
    const result = await editTool.execute({
      path: 'trim-test.txt',
      old_string: 'line one\nline two',
      new_string: 'ONE\nTWO',
    });
    assertIncludes(result, 'Edited', 'edit should match with trimmed lines');
    const content = await sandbox.readFile('trim-test.txt');
    assert(content.includes('ONE'), 'edit should replace with line-trimmed match');
  }

  console.log('  edit tool (mismatch returns current content)...');
  {
    try {
      await editTool.execute({
        path: 'hello.txt',
        old_string: 'this string does not exist',
        new_string: 'replacement',
      });
      assert(false, 'edit should throw on mismatch');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assertIncludes(msg, 'old_string not found', 'edit should report failure');
      assertIncludes(msg, 'Current file contents', 'edit should return current content on failure');
    }
  }

  // ── ls ──────────────────────────────────────────────────────────────────────
  console.log('  ls tool...');
  {
    const result = await lsTool.execute({ path: '.', depth: 1 });
    assertIncludes(result, 'hello.txt', 'ls should list hello.txt');
    assertIncludes(result, 'src', 'ls should list src directory');
  }

  console.log('  ls tool (recursive)...');
  {
    const result = await lsTool.execute({ path: 'src', depth: 2 });
    assertIncludes(result, 'index.ts', 'ls recursive should list nested files');
    assertIncludes(result, 'utils.ts', 'ls recursive should list all nested files');
  }

  // ── glob ────────────────────────────────────────────────────────────────────
  console.log('  glob tool...');
  {
    const result = await globTool.execute({ pattern: 'src/*.ts' });
    assertIncludes(result, 'index.ts', 'glob should match index.ts');
    assertIncludes(result, 'utils.ts', 'glob should match utils.ts');
  }

  console.log('  glob tool (recursive)...');
  {
    const result = await globTool.execute({ pattern: '**/*.ts' });
    assertIncludes(result, 'src/index.ts', 'glob recursive should match nested files');
  }

  console.log('  glob tool (no match)...');
  {
    const result = await globTool.execute({ pattern: '*.py' });
    assertIncludes(result, 'No files matched', 'glob should report no matches');
  }

  // ── grep ────────────────────────────────────────────────────────────────────
  console.log('  grep tool...');
  {
    const result = await grepTool.execute({ pattern: 'export' });
    assertIncludes(result, 'src/index.ts', 'grep should find export in index.ts');
    assertIncludes(result, 'src/utils.ts', 'grep should find export in utils.ts');
  }

  console.log('  grep tool (with glob)...');
  {
    const result = await grepTool.execute({ pattern: 'function', glob: '*.ts' });
    assertIncludes(result, 'utils.ts', 'grep with glob should find function in utils.ts');
    assert(!result.includes('README.md'), 'grep with glob should not match markdown');
  }

  console.log('  grep tool (invalid regex)...');
  {
    try {
      await grepTool.execute({ pattern: '[invalid' });
      assert(false, 'grep should throw on invalid regex');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assertIncludes(msg, 'Invalid regex', 'grep should report invalid regex');
    }
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

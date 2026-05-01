/**
 * Real Git Tool Test
 * Tests git commands in a real git repository.
 * Run with: node tests/test-real-git.mjs
 */

import { createGitTool } from '../dist/agent-runtime/tools/index.js';
import { logger } from '../dist/core/logger.js';
import { mkdir, rm, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

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
  console.log('\n🧪 Real Git Tool Test\n');

  const workspace = resolve(tmpdir(), `simpleclaw-git-test-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  // Initialize a real git repo
  execSync('git init', { cwd: workspace, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: workspace, stdio: 'ignore' });
  execSync('git config user.name "Test User"', { cwd: workspace, stdio: 'ignore' });

  await writeFile(resolve(workspace, 'README.md'), '# Test Project\n', 'utf-8');
  execSync('git add README.md', { cwd: workspace, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: workspace, stdio: 'ignore' });

  await mkdir(resolve(workspace, 'src'), { recursive: true });
  await writeFile(resolve(workspace, 'src/main.ts'), 'console.log("hello");\n', 'utf-8');
  execSync('git add src/main.ts', { cwd: workspace, stdio: 'ignore' });
  execSync('git commit -m "add main.ts"', { cwd: workspace, stdio: 'ignore' });

  // execFn for git tool
  async function execFn(command, options = {}) {
    try {
      const stdout = execSync(command, {
        cwd: workspace,
        encoding: 'utf-8',
        timeout: options.timeoutMs ?? 30000,
        windowsHide: true,
      });
      return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
    } catch (e) {
      return {
        stdout: e.stdout?.toString() ?? '',
        stderr: e.stderr?.toString() ?? '',
        exitCode: e.status ?? 1,
      };
    }
  }

  const gitTool = createGitTool(execFn, logger);

  // ── git status ────────────────────────────────────────────────────────────
  console.log('  git status...');
  {
    const result = await gitTool.execute({ command: 'status' });
    assertIncludes(result, 'On branch', 'git status should show branch');
  }

  // ── git log ───────────────────────────────────────────────────────────────
  console.log('  git log...');
  {
    const result = await gitTool.execute({ command: 'log --oneline' });
    assertIncludes(result, 'add main.ts', 'git log should show commits');
    assertIncludes(result, 'initial commit', 'git log should show initial commit');
  }

  // ── git branch ────────────────────────────────────────────────────────────
  console.log('  git branch...');
  {
    const result = await gitTool.execute({ command: 'branch' });
    assertIncludes(result, '*', 'git branch should show current branch');
  }

  // ── git diff ──────────────────────────────────────────────────────────────
  console.log('  git diff...');
  {
    await writeFile(resolve(workspace, 'README.md'), '# Test Project\n\nUpdated.\n', 'utf-8');
    const result = await gitTool.execute({ command: 'diff' });
    assertIncludes(result, 'Updated', 'git diff should show changes');
  }

  // ── git show ──────────────────────────────────────────────────────────────
  console.log('  git show...');
  {
    const result = await gitTool.execute({ command: 'show --stat HEAD' });
    assertIncludes(result, 'add main.ts', 'git show should show latest commit');
  }

  // ── blocked commands ──────────────────────────────────────────────────────
  console.log('  git blocked command (push)...');
  {
    const result = await gitTool.execute({ command: 'push origin main' });
    assertIncludes(result, 'not an allowed', 'git push should be blocked');
  }

  console.log('  git blocked command (commit)...');
  {
    const result = await gitTool.execute({ command: 'commit -m "test"' });
    assertIncludes(result, 'not an allowed', 'git commit should be blocked');
  }

  console.log('  git disallowed subcommand...');
  {
    const result = await gitTool.execute({ command: 'rebase main' });
    assertIncludes(result, 'not an allowed', 'git rebase should be disallowed');
  }

  // ── git blame ─────────────────────────────────────────────────────────────
  console.log('  git blame...');
  {
    const result = await gitTool.execute({ command: 'blame README.md' });
    assertIncludes(result, 'Test User', 'git blame should show author');
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

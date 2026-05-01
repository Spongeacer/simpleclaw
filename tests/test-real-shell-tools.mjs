/**
 * Real Shell Tools Test — bash, shell, bash_output, kill_shell
 * Tests real command execution via DockerSandbox.
 * Run with: node tests/test-real-shell-tools.mjs
 */

import { DockerSandbox } from '../dist/agent-runtime/sandbox.js';
import { logger } from '../dist/core/logger.js';
import { mkdir, rm } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';

import {
  createBashTool,
  createShellTool,
  createBashOutputTool,
  createKillShellTool,
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
  console.log('\n🧪 Real Shell Tools Test\n');

  const workspace = resolve(tmpdir(), `simpleclaw-shell-test-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger
  );

  const bashTool = createBashTool(sandbox);
  const shellTool = createShellTool(sandbox);
  const bashOutputTool = createBashOutputTool(sandbox);
  const killShellTool = createKillShellTool(sandbox);

  // ── shell tool ────────────────────────────────────────────────────────────
  console.log('  shell tool (echo)...');
  {
    const result = await shellTool.execute({ command: 'echo hello-from-shell' });
    assertIncludes(result, 'hello-from-shell', 'shell should execute echo');
    assertIncludes(result, 'Exit code: 0', 'shell should report exit code 0');
  }

  console.log('  shell tool (invalid command)...');
  {
    const result = await shellTool.execute({ command: 'this_command_does_not_exist_12345' });
    assert(!result.includes('Exit code: 0'), 'invalid command should not have exit code 0');
  }

  // ── bash tool ─────────────────────────────────────────────────────────────
  // Bash requires Docker on Windows; skip if unavailable
  console.log('  bash tool...');
  let bashAvailable = false;
  try {
    const result = await bashTool.execute({ command: 'echo hello-from-bash' });
    assertIncludes(result, 'hello-from-bash', 'bash should execute echo');
    bashAvailable = true;
  } catch (e) {
    if (String(e).includes('Docker is not available')) {
      console.log('    ⏭️  bash skipped (Docker not available on Windows)');
    } else {
      throw e;
    }
  }

  if (bashAvailable) {
    console.log('  bash tool (dangerous pattern warning)...');
    {
      const result = await bashTool.execute({ command: 'rm -rf /tmp/test' });
      assertIncludes(result, 'potentially destructive', 'bash should warn about dangerous pattern');
    }
  }

  // ── background bash + bash_output + kill_shell ────────────────────────────
  if (bashAvailable && sandbox.execBackground) {
    console.log('  bash tool (background)...');
    {
      const result = await bashTool.execute({
        command: 'for i in 1 2 3; do echo line-$i; sleep 1; done',
        run_in_background: true,
      });
      assertIncludes(result, 'shell_id', 'background bash should return shell_id');

      const shellIdMatch = result.match(/shell_id: ([a-zA-Z0-9_-]+)/);
      if (shellIdMatch) {
        const shellId = shellIdMatch[1];

        // Wait a bit for output
        await new Promise(r => setTimeout(r, 1500));

        console.log('  bash_output tool...');
        const outputResult = await bashOutputTool.execute({ shell_id: shellId, offset: 0 });
        assertIncludes(outputResult, 'line-1', 'bash_output should contain output');
        assertIncludes(outputResult, 'Status: running', 'bash_output should show running status');

        // Wait for completion
        await new Promise(r => setTimeout(r, 3000));

        console.log('  bash_output (finished)...');
        const finalResult = await bashOutputTool.execute({ shell_id: shellId, offset: 0 });
        assertIncludes(finalResult, 'line-3', 'final output should contain all lines');
        assertIncludes(finalResult, 'Status: finished', 'final output should show finished');

        console.log('  kill_shell tool (already finished)...');
        const killResult = await killShellTool.execute({ shell_id: shellId });
        assertIncludes(killResult, 'not found or already finished', 'kill_shell should report already finished');
      }
    }

    console.log('  kill_shell tool (active process)...');
    {
      const result = await bashTool.execute({
        command: 'sleep 30',
        run_in_background: true,
      });
      const shellIdMatch = result.match(/shell_id: ([a-zA-Z0-9_-]+)/);
      if (shellIdMatch) {
        const shellId = shellIdMatch[1];

        const killResult = await killShellTool.execute({ shell_id: shellId });
        assertIncludes(killResult, 'terminated successfully', 'kill_shell should terminate active process');
      }
    }
  } else {
    console.log('  ⏭️  background shell tests skipped (bash not available)');
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

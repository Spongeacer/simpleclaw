/**
 * Windows shell compatibility test
 */

import { DockerSandbox } from '../dist/agent-runtime/sandbox.js';
import { logger } from '../dist/core/logger.js';
import { mkdir, rm } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';

async function run() {
  const workspace = resolve(tmpdir(), `simpleclaw-shell-test-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const sandbox = new DockerSandbox(
    workspace,
    { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] },
    logger
  );

  console.log(`Platform: ${process.platform}`);
  console.log(`Workspace: ${workspace}\n`);

  // Test 1: echo
  console.log('Test 1: echo');
  // Use quoted string so PowerShell treats it as a single argument
  const echoCmd = process.platform === 'win32'
    ? 'Write-Output "Hello from SimpleClaw"'
    : 'echo "Hello from SimpleClaw"';
  const r1 = await sandbox.exec(echoCmd);
  console.log(`  exitCode: ${r1.exitCode}`);
  console.log(`  stdout: ${r1.stdout.trim()}`);
  console.log(`  stderr: ${r1.stderr.trim()}`);

  // Test 2: dir / ls
  console.log('\nTest 2: directory listing');
  const cmd2 = process.platform === 'win32' ? 'Get-ChildItem -Name' : 'ls';
  const r2 = await sandbox.exec(cmd2);
  console.log(`  exitCode: ${r2.exitCode}`);
  console.log(`  stdout: ${r2.stdout.trim() || '(empty)'}`);

  // Test 3: write then read via shell
  console.log('\nTest 3: write file via shell then read');
  const testFile = 'shell-test.txt';
  const writeCmd = process.platform === 'win32'
    ? `Set-Content ${testFile} -Value "shell-test-content"`
    : `echo "shell-test-content" > ${testFile}`;
  const r3 = await sandbox.exec(writeCmd);
  console.log(`  write exitCode: ${r3.exitCode}`);

  const content = await sandbox.readFile(testFile);
  console.log(`  read content: ${content.trim()}`);

  // Test 4: invalid command
  console.log('\nTest 4: invalid command');
  const r4 = await sandbox.exec('this_command_does_not_exist_12345');
  console.log(`  exitCode: ${r4.exitCode}`);
  console.log(`  stderr: ${r4.stderr.slice(0, 100)}`);

  // Cleanup
  await rm(workspace, { recursive: true, force: true });

  // Summary
  const ok = r1.exitCode === 0 && r1.stdout.includes('Hello from SimpleClaw')
          && r2.exitCode === 0
          && r3.exitCode === 0 && content.includes('shell-test-content')
          && r4.exitCode !== 0;

  console.log(ok ? '\nAll shell tests passed!' : '\nSome shell tests failed!');
  process.exit(ok ? 0 : 1);
}

run().catch(e => {
  console.error('Shell test error:', e);
  process.exit(1);
});

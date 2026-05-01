import { createAgent } from '../src/agent-runtime/index.ts';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DockerSandbox } from '../src/agent-runtime/sandbox/docker-sandbox.ts';

const logger = { info: ()=>{}, warn: ()=>{}, debug: ()=>{}, error: console.error };
const agent = createAgent({
  apiKey: process.env.OPENROUTER_API_KEY,
  model: 'tencent/hy3-preview:free',
  provider: 'openrouter',
  enablePlanMode: false,
  logger
});

const workspace = join(tmpdir(), 'simpleclaw-swe-verify', 'swe-04');
mkdirSync(workspace, { recursive: true });
mkdirSync(join(workspace, 'src'), { recursive: true });

const files = {
  'package.json': JSON.stringify({ name: 'swe-04', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2),
  'src/config.js': `function parseConfig(text) {
  const result = {};
  const lines = text.split('\\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [key, value] = trimmed.split('=');
    result[key.trim()] = value.trim();
  }
  return result;
}
module.exports = { parseConfig };
`,
  'test.js': `const { parseConfig } = require('./src/config.js');
function assertEqual(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(msg + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
assertEqual(parseConfig('host=localhost\\n# this is a comment\\nport=3000'), { host: 'localhost', port: '3000' }, 'comment ignored');
assertEqual(parseConfig('# comment only\\n'), {}, 'only comments');
assertEqual(parseConfig('a=1\\nb=2'), { a: '1', b: '2' }, 'no comments');
console.log('All tests passed!');
`
};

for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(workspace, name), content);
}

const start = Date.now();
const result = await agent.chat(
  'The parseConfig function in src/config.js incorrectly includes lines that start with "#" (comments). Comment lines should be ignored. Please fix it.',
  { sessionId: 'swe-04-verify', workspacePath: workspace }
);

const sandbox = new DockerSandbox(workspace, { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] }, logger);
const testResult = await sandbox.exec('node test.js');
const passed = testResult.exitCode === 0;

console.log('swe-04 result:', passed ? 'PASS' : 'FAIL');
console.log('Duration:', Date.now() - start, 'ms');
console.log('Tools:', result.toolCalls?.length || 0);
if (!passed) console.log('Output:', testResult.stdout + testResult.stderr);

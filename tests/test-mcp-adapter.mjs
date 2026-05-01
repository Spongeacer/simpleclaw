/**
 * MCP Adapter Tests
 * Validates the MCP→ITool adapter without requiring real MCP servers.
 */

import { createMcpTool } from '../dist/agent-runtime/mcp/adapter.js';
import { loadMcpTools } from '../dist/agent-runtime/mcp/loader.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockClient(result) {
  return {
    async callTool(_params) {
      return result;
    },
  };
}

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testMcpToolNaming() {
  const client = createMockClient({ content: [{ type: 'text', text: 'ok' }] });
  const tool = createMcpTool(client, 'filesystem', {
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: {} },
  });

  if (tool.name !== 'filesystem_read_file') {
    throw new Error(`Expected "filesystem_read_file", got "${tool.name}"`);
  }
  if (!tool.description.includes('Read a file')) {
    throw new Error('Expected description to preserve original text');
  }

  const output = await tool.execute({ path: '/tmp/test.txt' });
  if (output !== 'ok') {
    throw new Error(`Expected "ok", got "${output}"`);
  }

  console.log('  ✅ MCP tool naming and basic execution');
}

async function testMcpToolCustomPrefix() {
  const client = createMockClient({ content: [{ type: 'text', text: 'ok' }] });
  const tool = createMcpTool(client, 'filesystem', {
    name: 'read_file',
    description: 'Read',
    inputSchema: { type: 'object' },
  }, 'fs');

  if (tool.name !== 'fs_read_file') {
    throw new Error(`Expected "fs_read_file", got "${tool.name}"`);
  }

  console.log('  ✅ MCP tool custom name prefix');
}

async function testMcpToolResultNormalization() {
  const client = createMockClient({
    content: [
      { type: 'text', text: 'Hello world' },
      { type: 'image', data: 'base64data...verylong', mimeType: 'image/png' },
      { type: 'resource', uri: 'file:///tmp/test', text: 'Resource text' },
      { type: 'unknown', foo: 'bar' },
    ],
  });

  const tool = createMcpTool(client, 'test', {
    name: 'multi',
    description: 'Multi',
    inputSchema: { type: 'object' },
  });

  const output = await tool.execute({});

  if (!output.includes('Hello world')) throw new Error('Missing text content');
  if (!output.includes('[image/png]')) throw new Error('Missing image content');
  if (!output.includes('Resource text')) throw new Error('Missing resource content');
  if (!output.includes('unknown')) throw new Error('Missing unknown fallback');

  console.log('  ✅ MCP result normalization for mixed content types');
}

async function testMcpToolResultFallback() {
  const client = createMockClient({ raw: 'data' });
  const tool = createMcpTool(client, 'test', {
    name: 'fallback',
    description: 'Fallback',
    inputSchema: { type: 'object' },
  });

  const output = await tool.execute({});
  if (output !== '{"raw":"data"}') {
    throw new Error(`Expected JSON fallback, got "${output}"`);
  }

  console.log('  ✅ MCP result fallback to JSON when no content array');
}

async function testMcpToolParametersPassedThrough() {
  let capturedArgs = null;
  const client = {
    async callTool(params) {
      capturedArgs = params.arguments;
      return { content: [{ type: 'text', text: 'done' }] };
    },
  };

  const tool = createMcpTool(client, 'test', {
    name: 'compute',
    description: 'Compute',
    inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
  });

  await tool.execute({ x: 42 });
  if (capturedArgs?.x !== 42) {
    throw new Error('Expected arguments to be forwarded to MCP client');
  }

  console.log('  ✅ MCP tool arguments forwarded to client.callTool');
}

async function testLoadMcpToolsBestEffort() {
  // loadMcpTools should fail gracefully when a server config is invalid
  const configs = [
    {
      name: 'bad-server',
      transport: 'stdio',
      // missing command — should fail but not throw
    },
  ];

  const { tools, connections } = await loadMcpTools(configs, nullLogger);

  if (tools.length !== 0) {
    throw new Error(`Expected 0 tools from failed server, got ${tools.length}`);
  }
  if (connections.length !== 0) {
    throw new Error(`Expected 0 connections from failed server, got ${connections.length}`);
  }

  console.log('  ✅ MCP loader best-effort failure handling');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  const tests = [
    testMcpToolNaming,
    testMcpToolCustomPrefix,
    testMcpToolResultNormalization,
    testMcpToolResultFallback,
    testMcpToolParametersPassedThrough,
    testLoadMcpToolsBestEffort,
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

  console.log(`\n${passed}/${tests.length} MCP adapter tests passed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});

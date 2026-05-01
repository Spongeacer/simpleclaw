/**
 * Tool Schema Tests
 * Tests: additionalProperties: false on all tools, strict mode provider behavior.
 */

import { ToolRegistry } from '../dist/agent-runtime/tool-registry.js';
import {
  createReadTool,
  createEditTool,
  createBashTool,
  createThinkTool,
  createGrepTool,
  createLsTool,
  createGlobTool,
  createGitTool,
  createMemorySearchTool,
  createMemorySaveTool,
  createWebSearchTool,
  createWebFetchTool,
  createSpawnTool,
  createSkillTool,
} from '../dist/agent-runtime/tools/index.js';
import { OpenAICompatibleClient } from '../dist/agent-runtime/providers/openai-compatible.js';
import { FileAccessTracker } from '../dist/agent-runtime/file-tracker.js';
import { DockerSandbox } from '../dist/agent-runtime/sandbox.js';
import { logger } from '../dist/core/logger.js';
import { mkdir, rm } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hasAdditionalPropertiesFalse(schema, path = 'root') {
  if (typeof schema !== 'object' || schema === null) return [];

  const errors = [];

  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) {
      errors.push(`Missing additionalProperties: false at ${path}`);
    }
    if (schema.properties) {
      for (const [key, val] of Object.entries(schema.properties)) {
        errors.push(...hasAdditionalPropertiesFalse(val, `${path}.properties.${key}`));
      }
    }
  }

  if (schema.type === 'array' && schema.items) {
    errors.push(...hasAdditionalPropertiesFalse(schema.items, `${path}.items`));
  }

  for (const composite of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[composite])) {
      for (let i = 0; i < schema[composite].length; i++) {
        errors.push(...hasAdditionalPropertiesFalse(schema[composite][i], `${path}.${composite}[${i}]`));
      }
    }
  }

  return errors;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testAllToolsHaveAdditionalPropertiesFalse() {
  const workspace = resolve(tmpdir(), `simpleclaw-schema-test-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const sandbox = new DockerSandbox(workspace, { enabled: true, backend: 'docker', allowedPaths: [], deniedPaths: [] }, logger);
  const tracker = new FileAccessTracker();
  const tools = new ToolRegistry();

  tools.register(createReadTool(sandbox, tracker));
  tools.register(createEditTool(sandbox, tracker));
  tools.register(createBashTool(sandbox));
  tools.register(createThinkTool());
  tools.register(createGrepTool(sandbox, workspace));
  tools.register(createLsTool(workspace));
  tools.register(createGlobTool(workspace));
  tools.register(createGitTool(async (cmd) => ({ stdout: '', stderr: '', exitCode: 0 }), logger));
  tools.register(createMemorySearchTool({ search: async () => [], findFiles: async () => [] }, logger));
  tools.register(createMemorySaveTool({ saveMemory: async () => 'memory.md' }, workspace, logger));
  tools.register(createWebSearchTool(logger));
  tools.register(createWebFetchTool(logger));
  tools.register(createSpawnTool({ spawn: async () => ({ result: 'ok' }) }, logger));
  tools.register(createSkillTool([{ name: 'test', description: 'Test skill', location: '/tmp/SKILL.md', content: 'Test' }], logger));

  const schemas = tools.schema();
  let totalErrors = 0;

  for (const s of schemas) {
    const errors = hasAdditionalPropertiesFalse(s.parameters, `${s.name}.parameters`);
    if (errors.length > 0) {
      for (const err of errors) {
        console.log(`    ⚠️  ${err}`);
      }
      totalErrors += errors.length;
    }
  }

  await rm(workspace, { recursive: true, force: true });

  if (totalErrors > 0) {
    throw new Error(`${totalErrors} schema(s) missing additionalProperties: false`);
  }

  console.log(`  ✅ All ${schemas.length} tools have additionalProperties: false`);
}

async function testStrictModeAddsStrictFlag() {
  // We can't easily test the actual HTTP request without a mock server,
  // but we can verify the client constructor and the toApiMessage behavior.
  // Instead, we verify that strictToolSchema is read from modelRef by
  // inspecting a manually constructed payload.

  const clientStrict = new OpenAICompatibleClient(
    { provider: 'openai', model: 'gpt-4', strictToolSchema: true },
    { apiKey: 'fake', baseURL: 'http://localhost' }
  );

  const clientNonStrict = new OpenAICompatibleClient(
    { provider: 'openai', model: 'gpt-4', strictToolSchema: false },
    { apiKey: 'fake', baseURL: 'http://localhost' }
  );

  // Verify the flag is accessible
  if (clientStrict.modelRef.strictToolSchema !== true) {
    throw new Error('Expected strictToolSchema=true on strict client');
  }
  if (clientNonStrict.modelRef.strictToolSchema !== false) {
    throw new Error('Expected strictToolSchema=false on non-strict client');
  }

  console.log('  ✅ Strict mode flag correctly attached to modelRef');
}

async function testCapabilitiesOverridesStrictToolSchema() {
  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        };
      },
      async text() { return ''; },
    };
  };

  try {
    // capabilities.strictToolSchema: true should enable strict even when strictToolSchema: false
    const client = new OpenAICompatibleClient(
      { provider: 'openai', model: 'gpt-4', strictToolSchema: false, capabilities: { strictToolSchema: true } },
      { apiKey: 'fake', baseURL: 'http://localhost' }
    );

    await client.complete(
      [{ role: 'user', content: 'test' }],
      [{ name: 'test', description: 'test', parameters: { type: 'object', properties: {} } }]
    );

    if (!capturedBody) {
      throw new Error('Fetch was not called');
    }

    const tool = capturedBody.tools[0];
    if (!tool.function.strict) {
      throw new Error('Expected strict: true when capabilities.strictToolSchema=true');
    }
    if (tool.function.parameters.additionalProperties !== false) {
      throw new Error('Expected additionalProperties: false when capabilities.strictToolSchema=true');
    }

    console.log('  ✅ capabilities.strictToolSchema overrides strictToolSchema');
  } finally {
    global.fetch = originalFetch;
  }
}

async function testCapabilitiesDisablesStrict() {
  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        };
      },
      async text() { return ''; },
    };
  };

  try {
    // capabilities.strictToolSchema: false should disable strict even when strictToolSchema: true
    const client = new OpenAICompatibleClient(
      { provider: 'openrouter', model: 'hy3-preview', strictToolSchema: true, capabilities: { strictToolSchema: false } },
      { apiKey: 'fake', baseURL: 'http://localhost' }
    );

    await client.complete(
      [{ role: 'user', content: 'test' }],
      [{ name: 'test', description: 'test', parameters: { type: 'object', properties: {} } }]
    );

    if (!capturedBody) {
      throw new Error('Fetch was not called');
    }

    const tool = capturedBody.tools[0];
    if (tool.function.strict) {
      throw new Error('Expected strict: false when capabilities.strictToolSchema=false');
    }
    if (tool.function.parameters.additionalProperties !== undefined) {
      throw new Error('Expected no additionalProperties injection when capabilities.strictToolSchema=false');
    }

    console.log('  ✅ capabilities.strictToolSchema=false disables strict mode');
  } finally {
    global.fetch = originalFetch;
  }
}

async function testSchemaNormalizationRecursion() {
  // Mock fetch to capture the request body and verify schema normalization
  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        };
      },
      async text() { return ''; },
    };
  };

  try {
    const client = new OpenAICompatibleClient(
      { provider: 'openai', model: 'gpt-4', strictToolSchema: true },
      { apiKey: 'fake', baseURL: 'http://localhost' }
    );

    const nestedSchema = {
      name: 'nested_test',
      description: 'Test nested schema',
      parameters: {
        type: 'object',
        properties: {
          top: {
            type: 'object',
            properties: {
              inner: { type: 'string' },
            },
          },
          list: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number' },
              },
            },
          },
        },
        required: ['top'],
      },
    };

    await client.complete(
      [{ role: 'user', content: 'test' }],
      [nestedSchema]
    );

    if (!capturedBody) {
      throw new Error('Fetch was not called');
    }

    const tool = capturedBody.tools[0];
    if (!tool.function.strict) {
      throw new Error('Expected strict: true on tool');
    }

    // Verify root object
    const rootParams = tool.function.parameters;
    if (rootParams.additionalProperties !== false) {
      throw new Error('Expected root additionalProperties: false');
    }

    // Verify nested object (top)
    const topParams = rootParams.properties.top;
    if (topParams.additionalProperties !== false) {
      throw new Error('Expected nested top.additionalProperties: false');
    }

    // Verify array items object
    const itemParams = rootParams.properties.list.items;
    if (itemParams.additionalProperties !== false) {
      throw new Error('Expected array item additionalProperties: false');
    }

    console.log('  ✅ Nested schema normalization adds strict + additionalProperties: false');
  } finally {
    global.fetch = originalFetch;
  }
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  const tests = [
    testAllToolsHaveAdditionalPropertiesFalse,
    testStrictModeAddsStrictFlag,
    testCapabilitiesOverridesStrictToolSchema,
    testCapabilitiesDisablesStrict,
    testSchemaNormalizationRecursion,
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

  console.log(`\n${passed}/${tests.length} tool schema tests passed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});

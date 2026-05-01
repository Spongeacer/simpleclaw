/**
 * Prompt assembly test — verifies system prompt structure
 * Uses a mock LLM that records the system prompt for inspection.
 */

import { AgentEngine } from '../dist/core/agent-engine.js';
import { ToolRegistry } from '../dist/agent-runtime/tool-registry.js';
import {
  createReadTool,
  createEditTool,
  createBashTool,
  createThinkTool,
  createGrepTool,
  createLsTool,
  createWebSearchTool,
  createWebFetchTool,
  createGlobTool,
  createGitTool,
  createMemorySearchTool,
  createMemorySaveTool,
  createSkillTool,
} from '../dist/agent-runtime/tools/index.js';
import { FileAccessTracker } from '../dist/agent-runtime/file-tracker.js';
import { DockerSandbox } from '../dist/agent-runtime/sandbox.js';
import { ApprovalGate } from '../dist/agent-runtime/approval.js';
import { MemorySessionStore } from '../dist/gateway/session-store.js';
import { logger } from '../dist/core/logger.js';
import { mkdir, writeFile, rm } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';

// ─── Mock LLM that records the system prompt ─────────────────────────────────

class RecordingLLM {
  modelRef = { provider: 'mock', model: 'mock-recorder' };
  calls = [];

  async complete(messages, tools) {
    // Merge all system messages (stable prefix + dynamic suffix)
    const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
    const systemPrompt = systemParts.join('\n\n');
    this.calls.push({ systemPrompt, messageCount: messages.length });
    return { text: 'Recorded.', usage: { promptTokens: 10, completionTokens: 2 } };
  }
}

// ─── Test ────────────────────────────────────────────────────────────────────

async function run() {
  const workspace = resolve(tmpdir(), `simpleclaw-prompt-test-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  // Create AGENTS.md in workspace
  await writeFile(resolve(workspace, 'AGENTS.md'), '# Project Rules\n\n- Use TypeScript.\n- No any types.', 'utf-8');

  // Create skills
  await mkdir(resolve(workspace, 'skills', 'code-review'), { recursive: true });
  await writeFile(
    resolve(workspace, 'skills', 'code-review', 'SKILL.md'),
    '---\nname: code-review\ndescription: Review code for bugs\n---\n\n# Code Review\n\nCheck logic, style, security.',
    'utf-8'
  );

  console.log(`Workspace: ${workspace}\n`);

  const store = new MemorySessionStore();
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
  tools.register(createWebSearchTool(logger));
  tools.register(createWebFetchTool(logger));

  const skills = [
    { name: 'code-review', description: 'Review code for bugs', location: resolve(workspace, 'skills/code-review/SKILL.md'), baseDir: resolve(workspace, 'skills/code-review'), content: 'Check logic, style, security.', eligible: true, source: 'workspace' },
  ];
  tools.register(createSkillTool(skills, logger));

  const approval = new ApprovalGate('never', logger);
  const llm = new RecordingLLM();

  // Load instructions
  const { loadInstructions, formatInstruction } = await import('../dist/agent-runtime/instruction-loader.js');
  const { formatSkillList } = await import('../dist/agent-runtime/skill/skill-loader.js');
  const instr = await loadInstructions(workspace);
  const instructions = instr ? formatInstruction(instr) : undefined;
  const skillsPrompt = formatSkillList(skills);

  const engine = new AgentEngine({
    config: {
      id: 'test-agent',
      name: 'Test',
      model: { provider: 'mock', model: 'mock-recorder' },
      systemPrompt: 'You are a helpful assistant.',
      tools: ['read', 'edit', 'bash', 'grep', 'ls', 'skill'],
      approvalPolicy: 'never',
      workspace,
      memory: { enabled: false },
    },
    store,
    llm,
    tools,
    approval,
    logger,
    instructions,
    skills: skillsPrompt,
  });

  // Create session and run chat
  const session = await store.create({
    sessionId: `prompt-sess-${Date.now()}`,
    agentId: 'test-agent',
    turns: [],
    tokenCount: 0,
  });

  const events = [];
  for await (const event of engine.chat(session.sessionId, 'Hello')) {
    events.push(event);
  }

  // Inspect the system prompt
  const systemPrompt = llm.calls[0]?.systemPrompt || '';

  console.log('=== SYSTEM PROMPT INSPECTION ===\n');

  const checks = [
    { name: 'PROTOCOL section', test: () => systemPrompt.includes('=== PROTOCOL ===') },
    { name: 'DECISION RULE', test: () => systemPrompt.includes('### DECISION RULE') },
    { name: 'SKILL RULE', test: () => systemPrompt.includes('SKILL RULE') },
    { name: 'INSTRUCTIONS section (AGENTS.md)', test: () => systemPrompt.includes('=== PROJECT INSTRUCTIONS ===') && systemPrompt.includes('Use TypeScript') },
    { name: 'SKILLS section (code-review)', test: () => systemPrompt.includes('=== AVAILABLE SKILLS ===') && systemPrompt.includes('code-review') },
    { name: 'TOOLS section', test: () => systemPrompt.includes('=== TOOLS ===') },
    { name: 'WORKSPACE section', test: () => systemPrompt.includes('=== WORKSPACE ===') },
    { name: 'Skill tool in available tools', test: () => systemPrompt.includes('skill') && systemPrompt.includes('Load a specialized skill') },
  ];

  let passed = 0;
  let failed = 0;
  for (const check of checks) {
    const ok = check.test();
    console.log(`${ok ? '✅' : '❌'} ${check.name}`);
    if (ok) passed++; else failed++;
  }

  console.log(`\nSystem prompt length: ${systemPrompt.length} chars`);
  console.log(`LLM calls: ${llm.calls.length}`);

  // Cleanup
  await rm(workspace, { recursive: true, force: true });

  if (failed > 0) {
    console.log('\n=== FULL SYSTEM PROMPT ===');
    console.log(systemPrompt);
  }

  console.log(`\n${passed}/${checks.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});

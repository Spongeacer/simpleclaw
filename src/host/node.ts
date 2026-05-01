/**
 * SimpleClaw — Node.js Host
 * Assembles Core + Node Runtime and starts the Gateway.
 */

import { createServer } from "http";
import { mkdir } from "fs/promises";
import { Gateway } from "../gateway/server.js";
import { AgentEngine } from "../core/agent-engine.js";
import { createRouter } from "../agent-runtime/provider-factory.js";
import { ToolRegistry } from "../agent-runtime/tool-registry.js";
import {
  createReadTool,
  createEditTool,
  createBashTool,
  createThinkTool,
  createGrepTool,
  createLsTool,
  createSpawnTool,
  createSpawnMultipleTool,
  createMemorySearchTool,
  createMemorySaveTool,
  createUserMemoryTool,
  createSkillManageTool,
  createWebSearchTool,
  createWebFetchTool,
  createGlobTool,
  createGitTool,
} from "../agent-runtime/tools/index.js";
import { FileAccessTracker } from "../agent-runtime/file-tracker.js";
import { DockerSandbox } from "../agent-runtime/sandbox.js";
import { ApprovalGate } from "../agent-runtime/approval.js";
import { MemorySessionStore, SQLiteSessionStore } from "../gateway/session-store.js";
import { MemoryTaskQueue } from "../agent-runtime/task-queue-memory.js";
import { NotificationBus } from "../core/notification-bus.js";
import { BackgroundWorker } from "../agent-runtime/background-worker.js";
import { AgentPool } from "../agent-runtime/agent-pool.js";
import { AgentEngineFactory } from "../agent-runtime/agent-engine-factory.js";
import { WorkspaceMemoryIndex } from "../agent-runtime/memory/index.js";
import { FileUserMemory } from "../agent-runtime/memory/user-memory.js";
import { loadInstructions, formatInstruction } from "../agent-runtime/instruction-loader.js";
import { loadAllSkills, formatSkillList, resolveSkillScanDirs } from "../agent-runtime/skill/skill-loader.js";
import { createSkillTool } from "../agent-runtime/skill/skill-tool.js";
import { SkillWatcher } from "../agent-runtime/skill/skill-watcher.js";
import { loadMcpTools } from "../agent-runtime/mcp/loader.js";
import type { McpConnection } from "../agent-runtime/mcp/client.js";
import { logger } from "../core/logger.js";
import type { SimpleClawConfig } from "../core/config-schema.js";

export interface NodeHostOptions {
  config: SimpleClawConfig;
  secretsEnv?: Record<string, string>;
}

export async function startNodeHost(options: NodeHostOptions): Promise<{ close: () => Promise<void> }> {
  const { config } = options;
  const agentConfig = config.agents[0];

  // Assemble Runtime implementations
  const router = createRouter(config.providers, config.models);
  const store = config.gateway.sessionStore.type === "sqlite"
    ? new SQLiteSessionStore(config.gateway.sessionStore.path)
    : new MemorySessionStore();
  const sandbox = new DockerSandbox(
    agentConfig.workspace,
    agentConfig.sandbox ?? { enabled: true, backend: "docker", allowedPaths: [], deniedPaths: [] },
    logger,
    options.secretsEnv ?? {}
  );
  const tracker = new FileAccessTracker();
  const tools = new ToolRegistry();
  tools.register(createReadTool(sandbox, tracker));
  tools.register(createEditTool(sandbox, tracker));
  tools.register(createBashTool(sandbox));
  tools.register(createThinkTool());
  tools.register(createGrepTool(sandbox, agentConfig.workspace));
  tools.register(createLsTool(agentConfig.workspace));
  tools.register(createWebSearchTool(logger));
  tools.register(createWebFetchTool(logger));
  tools.register(createGlobTool(agentConfig.workspace));
  tools.register(createGitTool((cmd, opts) => sandbox.exec(cmd, opts), logger));

  const approval = new ApprovalGate(agentConfig.approvalPolicy, logger);

  // Assemble Memory System
  let memory: WorkspaceMemoryIndex | undefined;
  if (agentConfig.memory?.enabled !== false) {
    const memoryDbPath = agentConfig.workspace.replace(/\\/g, "/").replace(/^~/, process.env.HOME || process.env.USERPROFILE || ".") + "/.simpleclaw/memory.db";
    memory = new WorkspaceMemoryIndex(memoryDbPath, logger);
    try {
      await memory.sync(agentConfig.workspace);
      logger.info("Memory system initialized", { dbPath: memoryDbPath, files: (await memory.getKnownPaths()).length });
    } catch (err) {
      logger.warn("Memory system failed to initialize", { error: String(err) });
      memory = undefined;
    }
  }

  // Assemble User Memory (bounded cross-session memory)
  const userMemory = await FileUserMemory.create(
    (process.env.SIMPLECLAW_HOME ?? `${process.env.HOME || process.env.USERPROFILE || "."}/.simpleclaw`) + "/memories",
    logger,
  );
  tools.register(createUserMemoryTool(userMemory, logger));

  // Register skill management tool
  const userSkillsDir = (process.env.SIMPLECLAW_HOME ?? `${process.env.HOME || process.env.USERPROFILE || "."}/.simpleclaw`) + "/skills";
  await mkdir(userSkillsDir, { recursive: true });

  // Extract reusable skill reload logic
  async function reloadSkills(): Promise<void> {
    const newSkills = await loadAllSkills({ workspace: agentConfig.workspace, logger });
    tools.register(createSkillTool(newSkills, logger));
    skillsPrompt = formatSkillList(newSkills);
    engine.updateSkills(skillsPrompt);
    logger.info("Skills hot-reloaded", { count: newSkills.length });
  }

  tools.register(createSkillManageTool({ skillsDir: userSkillsDir, logger, onChange: reloadSkills }));

  // Assemble Agent Pool for multi-agent collaboration
  const engineFactory = new AgentEngineFactory(store, approval, logger, undefined, userMemory);
  const pool = new AgentPool(agentConfig, store, router, tools, logger, engineFactory);
  tools.register(createSpawnTool(pool, logger));
  tools.register(createSpawnMultipleTool(pool, logger));

  // Register memory tools
  if (memory) {
    tools.register(createMemorySearchTool(memory, logger));
    tools.register(createMemorySaveTool(memory, agentConfig.workspace, logger));
  }

  // Load project instructions (AGENTS.md / CLAUDE.md)
  let instructions: string | undefined;
  try {
    const instr = await loadInstructions(agentConfig.workspace);
    if (instr) {
      instructions = formatInstruction(instr);
      logger.info("Instructions loaded", { source: instr.path });
    }
  } catch {
    // ignore
  }

  // Load skills
  const skills = await loadAllSkills({ workspace: agentConfig.workspace, logger });
  if (skills.length > 0) {
    tools.register(createSkillTool(skills, logger));
    logger.info("Skills loaded", { count: skills.length, names: skills.map((s) => s.name) });
  }
  let skillsPrompt = formatSkillList(skills);

  // Start skill watcher for hot-reload
  const skillWatchDirs = resolveSkillScanDirs(agentConfig.workspace)
    .filter((s) => s.source !== "builtin")
    .map((s) => s.dir);
  const skillWatcher = new SkillWatcher(skillWatchDirs, reloadSkills, logger);
  skillWatcher.start();

  // Load MCP tools (best-effort: failures are logged but never fatal)
  const mcpConnections: McpConnection[] = [];
  if (config.mcpServers.length > 0) {
    try {
      const { tools: mcpTools, connections } = await loadMcpTools(config.mcpServers, logger);
      for (const t of mcpTools) {
        tools.register(t);
      }
      mcpConnections.push(...connections);
    } catch (err) {
      logger.warn("MCP loader failed to import", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Assemble Core Engine
  const llm = router.resolve(agentConfig.model);
  const engine = new AgentEngine({
    config: agentConfig,
    store,
    llm,
    tools,
    approval,
    logger,
    memory,
    instructions,
    skills: skillsPrompt,
    userMemory,
  });

  // Assemble Task Queue + Background Worker
  const taskQueue = new MemoryTaskQueue();
  const notificationBus = new NotificationBus();
  const worker = new BackgroundWorker(taskQueue, engine, notificationBus, logger);
  worker.start();

  // Assemble Gateway
  const gateway = new Gateway(config.gateway, engine, store, taskQueue, notificationBus);
  const server = createServer();
  gateway.attach(server);

  const { port, host } = config.gateway;
  server.listen(port, host);

  logger.info(`SimpleClaw Gateway listening`, { host, port });
  logger.info(`Web UI: http://${host}:${port}/ui/index.html`);
  logger.info(`Health: http://${host}:${port}/health`);
  logger.info(`Agent: ${agentConfig.name} (${agentConfig.model.provider}/${agentConfig.model.model})`);

  return {
    close: async () => {
      logger.info("Shutting down...");
      skillWatcher.stop();
      for (const conn of mcpConnections) {
        try {
          await conn.disconnect();
        } catch {
          // ignore cleanup errors
        }
      }
      worker.stop();
      await gateway.close();
      server.close();
    },
  };
}

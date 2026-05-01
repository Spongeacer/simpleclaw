/**
 * SimpleClaw — Agent Engine Factory
 * Runtime implementation of IAgentEngineFactory.
 */

import { AgentEngine } from "../core/agent-engine.js";
import type {
  IAgentEngine,
  IAgentEngineFactory,
  IApprovalGate,
  ILLMClient,
  ILogger,
  ISessionStore,
  IToolRegistry,
} from "../core/interfaces.js";
import type { AgentConfig } from "../core/types.js";

export class AgentEngineFactory implements IAgentEngineFactory {
  constructor(
    private store: ISessionStore,
    private approval: IApprovalGate,
    private logger: ILogger,
  ) {}

  create(config: AgentConfig, llm: ILLMClient, tools: IToolRegistry): IAgentEngine {
    return new AgentEngine(config, this.store, llm, tools, this.approval, this.logger);
  }
}

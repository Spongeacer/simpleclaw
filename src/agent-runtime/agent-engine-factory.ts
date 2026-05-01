/**
 * SimpleClaw — Agent Engine Factory
 * Runtime implementation of IAgentEngineFactory.
 */

import { AgentEngine } from "../core/agent-engine.js";
import type {
  IAgentEngine,
  IAgentEngineFactory,
  IApprovalGate,
  IContextEngine,
  ILLMClient,
  ILogger,
  ISessionStore,
  IToolRegistry,
  IUserMemory,
} from "../core/interfaces.js";
import type { AgentConfig } from "../core/types.js";

export class AgentEngineFactory implements IAgentEngineFactory {
  constructor(
    private store: ISessionStore,
    private approval: IApprovalGate,
    private logger: ILogger,
    private contextEngine?: IContextEngine,
    private userMemory?: IUserMemory,
  ) {}

  create(config: AgentConfig, llm: ILLMClient, tools: IToolRegistry): IAgentEngine {
    return new AgentEngine({
      config,
      store: this.store,
      llm,
      tools,
      approval: this.approval,
      logger: this.logger,
      contextEngine: this.contextEngine,
      userMemory: this.userMemory,
    });
  }
}

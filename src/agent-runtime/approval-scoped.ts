/**
 * SimpleClaw — Scoped Approval Gate
 * Decorates an IApprovalGate with agent/session context so approvals from
 * sub-agents can be distinguished from parent-agent approvals.
 */

import type { IApprovalGate, IApprovalRequest, ILogger } from "../core/interfaces.js";

export class ScopedApprovalGate implements IApprovalGate {
  constructor(
    private delegate: IApprovalGate,
    private agentId: string,
    private sessionId: string,
    private logger: ILogger,
  ) {}

  isRequired(toolName: string): boolean {
    return this.delegate.isRequired(toolName);
  }

  async request(req: IApprovalRequest): Promise<"approved" | "denied"> {
    this.logger.info("Sub-agent approval request", {
      agentId: this.agentId,
      sessionId: this.sessionId,
      tool: req.toolName,
    });
    return this.delegate.request(req);
  }

  listPending(): IApprovalRequest[] {
    return this.delegate.listPending();
  }
}

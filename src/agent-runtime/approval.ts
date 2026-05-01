/**
 * SimpleClaw — Approval mechanism
 * Two-phase: register request → wait for decision.
 * MVP: auto-approve in "dangerous" mode after logging; interactive deferred.
 */

import type { ApprovalPolicy } from "../core/types.js";
import type { IApprovalGate, IApprovalRequest, ILogger } from "../core/interfaces.js";

export interface ApprovalRequest {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  timestamp: Date;
}

export type ApprovalDecision = "approved" | "denied";

export class ApprovalGate implements IApprovalGate {
  private pending = new Map<string, IApprovalRequest>();

  constructor(private policy: ApprovalPolicy, private logger: ILogger) {}

  isRequired(toolName: string): boolean {
    if (this.policy === "always") return true;
    if (this.policy === "never") return false;
    const dangerousTools = ["shell", "writeFile", "edit", "delete", "exec"];
    return dangerousTools.some((d) => toolName.toLowerCase().includes(d));
  }

  async request(req: IApprovalRequest): Promise<"approved" | "denied"> {
    if (!this.isRequired(req.toolName)) {
      return "approved";
    }

    this.pending.set(req.id, req);
    this.logger.warn("Approval required", {
      id: req.id,
      tool: req.toolName,
      args: JSON.stringify(req.arguments).slice(0, 200),
    });

    await this.delay(5000);
    this.logger.info("Auto-approved (MVP mode)", { id: req.id });
    this.pending.delete(req.id);
    return "approved";
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  listPending(): IApprovalRequest[] {
    return Array.from(this.pending.values());
  }
}

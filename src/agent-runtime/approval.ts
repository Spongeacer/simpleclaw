/**
 * SimpleClaw — Approval mechanism
 * Two-phase: register request → wait for decision.
 *
 * Policies:
 *   - "always":  every tool call requires approval
 *   - "never":   no approval required
 *   - "dangerous": bash/edit require approval
 *
 * SECURITY: When policy is "dangerous" and no onApprove callback is provided,
 * dangerous operations are DENIED rather than auto-approved. The old MVP
 * behaviour (5-second delay then auto-approve) was a security hole.
 */

import type { ApprovalPolicy } from "../core/types.js";
import type { IApprovalGate, IApprovalRequest, ILogger } from "../core/interfaces.js";

export class ApprovalGate implements IApprovalGate {
  private pending = new Map<string, IApprovalRequest>();

  constructor(
    private policy: ApprovalPolicy,
    private logger: ILogger,
    /** Optional callback for interactive approval. If undefined and policy is "dangerous", dangerous ops are denied. */
    private onApprove?: (req: IApprovalRequest) => Promise<"approved" | "denied">,
  ) {}

  isRequired(toolName: string): boolean {
    if (this.policy === "always") return true;
    if (this.policy === "never") return false;
    const dangerousTools = ["bash", "edit"];
    return dangerousTools.some((d) => toolName.toLowerCase() === d);
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

    // SECURITY: without an onApprove callback, dangerous operations are denied.
    if (!this.onApprove) {
      this.logger.error("Approval denied: no onApprove callback configured for dangerous policy", {
        id: req.id,
        tool: req.toolName,
      });
      this.pending.delete(req.id);
      return "denied";
    }

    const decision = await this.onApprove(req);
    this.logger.info(`Approval ${decision}`, { id: req.id });
    this.pending.delete(req.id);
    return decision;
  }

  listPending(): IApprovalRequest[] {
    return Array.from(this.pending.values());
  }
}

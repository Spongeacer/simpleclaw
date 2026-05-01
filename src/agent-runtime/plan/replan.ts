/**
 * SimpleClaw — Replan Policy
 * Determines when a failed plan step should trigger dynamic replanning.
 */

import type { DAG, DAGNode } from "./dag.js";

export interface ReplanTrigger {
  reason: string;
  failedStepId: string;
  partialSummary: string;
}

export interface ReplanPolicyOptions {
  /** Max replan attempts per agent turn. Default: 2. */
  maxReplanAttempts?: number;
  /** Steps that are leaf nodes (no dependents) never trigger replan. Default: true. */
  skipLeafFailures?: boolean;
  /** Steps with maxRetries > 0 that exhausted retries trigger replan. Default: true. */
  retryExhaustionTriggersReplan?: boolean;
}

export class ReplanPolicy {
  private attempts = 0;

  constructor(private options: ReplanPolicyOptions = {}) {}

  shouldReplan(failedNode: DAGNode, dag: DAG): ReplanTrigger | undefined {
    const {
      maxReplanAttempts = 2,
      skipLeafFailures = true,
      retryExhaustionTriggersReplan = true,
    } = this.options;

    if (this.attempts >= maxReplanAttempts) {
      return undefined;
    }

    const step = failedNode.step;

    // Leaf failures don't need replan — just report the error
    if (skipLeafFailures && failedNode.dependents.size === 0) {
      return undefined;
    }

    // If retries were configured and exhausted, trigger replan
    if (
      retryExhaustionTriggersReplan &&
      (step.maxRetries ?? 0) > 0 &&
      failedNode.retryCount >= (step.maxRetries ?? 0)
    ) {
      this.attempts++;
      return {
        reason: `Step "${step.id}" exhausted all ${step.maxRetries} retries`,
        failedStepId: step.id,
        partialSummary: dag.buildResultSummary(),
      };
    }

    // Critical step with dependents failed
    if (failedNode.dependents.size > 0) {
      this.attempts++;
      return {
        reason: `Critical step "${step.id}" failed, blocking ${failedNode.dependents.size} downstream step(s)`,
        failedStepId: step.id,
        partialSummary: dag.buildResultSummary(),
      };
    }

    return undefined;
  }

  reset(): void {
    this.attempts = 0;
  }
}

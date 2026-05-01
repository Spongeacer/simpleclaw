/**
 * SimpleClaw — Hook Registry
 * Lifecycle hooks for plan step execution.
 */

import type { PlanStep, StepResult } from "./dag.js";

export type HookPhase = "preExecute" | "postExecute" | "onError";

export interface HookContext {
  step: PlanStep;
  result?: StepResult;
  error?: Error;
  sessionId?: string;
}

export type HookHandler = (ctx: HookContext) => Promise<void> | void;

export class HookRegistry {
  private hooks = new Map<HookPhase, HookHandler[]>();

  register(phase: HookPhase, handler: HookHandler): void {
    const existing = this.hooks.get(phase) ?? [];
    existing.push(handler);
    this.hooks.set(phase, existing);
  }

  async run(phase: HookPhase, ctx: HookContext): Promise<void> {
    const handlers = this.hooks.get(phase) ?? [];
    for (const handler of handlers) {
      await handler(ctx);
    }
  }

  clear(phase?: HookPhase): void {
    if (phase) {
      this.hooks.delete(phase);
    } else {
      this.hooks.clear();
    }
  }
}

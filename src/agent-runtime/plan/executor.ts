/**
 * SimpleClaw — DAG Executor
 * Parallel execution engine with dependency-aware scheduling.
 */

import type { IToolRegistry } from "../../core/interfaces.js";
import type { ToolCall } from "../../core/types.js";
import { DAG, type Plan, type StepResult, type DAGLevel, type DAGNode } from "./dag.js";
import { VariableResolver } from "./resolver.js";
import { HookRegistry } from "./hooks.js";

export interface ExecutionOptions {
  maxConcurrency?: number;
  timeoutMs?: number;
  sessionId?: string;
}

export interface ExecutionResult {
  dag: DAG;
  levels: DAGLevel[];
  totalDurationMs: number;
  success: boolean;
}

export class DAGExecutor {
  private resolver = new VariableResolver();

  async execute(
    plan: Plan,
    tools: IToolRegistry,
    hooks: HookRegistry,
    options: ExecutionOptions = {}
  ): Promise<ExecutionResult> {
    const dag = new DAG(plan);
    dag.validate();

    const levels = dag.topologicalLevels();
    const startTime = Date.now();

    for (const level of levels) {
      await this.executeLevel(level, dag, tools, hooks, options);
    }

    const totalDurationMs = Date.now() - startTime;
    const success = this.isPlanSuccessful(dag);

    return { dag, levels, totalDurationMs, success };
  }

  private async executeLevel(
    level: DAGLevel,
    dag: DAG,
    tools: IToolRegistry,
    hooks: HookRegistry,
    options: ExecutionOptions
  ): Promise<void> {
    const { maxConcurrency = Infinity, sessionId } = options;

    // Resolve variables for all steps in this level
    const resolvedArgs = new Map<string, Record<string, unknown>>();
    for (const stepId of level.stepIds) {
      const node = dag.getNode(stepId);
      if (!node) continue;

      // Skip steps whose dependencies failed
      if (this.hasFailedDependency(node, dag)) {
        dag.markSkipped(stepId, "Dependency failed");
        continue;
      }

      try {
        resolvedArgs.set(stepId, this.resolver.resolve(node.step.args, dag) as Record<string, unknown>);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`    [executor debug] var resolution failed for ${stepId}: ${msg}`);
        for (const dep of node.step.depends_on ?? []) {
          const depNode = dag.getNode(dep);
          console.log(`    [executor debug] dep ${dep} status=${depNode?.status}`);
        }
        dag.markFailed(stepId, { output: `Variable resolution failed: ${msg}`, isError: true });
        await hooks.run("onError", { step: node.step, error: err instanceof Error ? err : new Error(msg), sessionId });
        continue;
      }
    }

    // Execute steps with concurrency limit
    const pending = Array.from(resolvedArgs.keys());
    while (pending.length > 0) {
      const batchSize = Math.min(pending.length, maxConcurrency);
      const batch = pending.splice(0, batchSize);

      await Promise.all(
        batch.map((stepId) => {
          const args = resolvedArgs.get(stepId);
          if (!args) throw new Error(`Resolved arguments missing for step "${stepId}"`);
          return this.executeStep(stepId, dag, tools, hooks, args, options);
        })
      );
    }
  }

  private async executeStep(
    stepId: string,
    dag: DAG,
    tools: IToolRegistry,
    hooks: HookRegistry,
    resolvedArgs: Record<string, unknown>,
    options: ExecutionOptions
  ): Promise<void> {
    const node = dag.getNode(stepId);
    if (!node || node.status !== "pending") return;

    const { sessionId, timeoutMs } = options;
    const maxRetries = node.step.maxRetries ?? 0;

    // Run pre-execute hooks
    await hooks.run("preExecute", { step: node.step, sessionId });

    dag.markRunning(stepId);

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const call: ToolCall = {
          id: stepId,
          name: node.step.tool,
          arguments: resolvedArgs,
        };

        const resultPromise = tools.execute(call);
        const result = timeoutMs
          ? await this.withTimeout(resultPromise, timeoutMs)
          : await resultPromise;

        // Treat isError=true as a failure (tool executed but returned an error)
        if (result.isError) {
          throw new Error(result.output);
        }

        dag.markCompleted(stepId, { output: result.output, isError: false });

        // Run post-execute hooks
        await hooks.run("postExecute", {
          step: node.step,
          result: { output: result.output, isError: false },
          sessionId,
        });

        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < maxRetries) {
          const delay = node.step.retryDelayMs ?? 0;
          if (delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
          }
          dag.reset(stepId);
          dag.markRunning(stepId);
        }
      }
    }

    // All retries exhausted
    const errorResult: StepResult = {
      output: lastError?.message ?? "Execution failed",
      isError: true,
    };
    dag.markFailed(stepId, errorResult);

    await hooks.run("onError", {
      step: node.step,
      error: lastError ?? new Error("Execution failed"),
      result: errorResult,
      sessionId,
    });
  }

  private hasFailedDependency(node: DAGNode, dag: DAG): boolean {
    for (const depId of node.step.depends_on ?? []) {
      const dep = dag.getNode(depId);
      if (dep && (dep.status === "failed" || dep.status === "skipped")) {
        return true;
      }
    }
    return false;
  }

  private isPlanSuccessful(dag: DAG): boolean {
    for (const [, node] of dag.getAllNodes()) {
      if (node.status === "failed") {
        return false;
      }
    }
    return true;
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Step timed out after ${ms}ms`)), ms)
      ),
    ]);
  }
}

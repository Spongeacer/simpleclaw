/**
 * SimpleClaw — DAG (Directed Acyclic Graph) Engine
 * Plan representation, validation, and topological ordering.
 */

export interface PlanStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  depends_on?: string[];
  condition?: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface Plan {
  version: 1;
  steps: PlanStep[];
}

export interface StepResult {
  output: string;
  isError?: boolean;
}

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface DAGNode {
  step: PlanStep;
  dependents: Set<string>;
  dependenciesRemaining: number;
  status: StepStatus;
  result?: StepResult;
  startTime?: number;
  endTime?: number;
  retryCount: number;
}

export interface DAGLevel {
  level: number;
  stepIds: string[];
}

export class DAG {
  private nodes = new Map<string, DAGNode>();

  constructor(public readonly plan: Plan) {
    this.buildGraph();
  }

  /** Validate plan integrity: unique IDs, valid dependencies, no cycles. */
  validate(): void {
    const ids = new Set<string>();
    for (const step of this.plan.steps) {
      if (ids.has(step.id)) {
        throw new DAGError(`Duplicate step id: "${step.id}"`);
      }
      ids.add(step.id);
    }

    for (const step of this.plan.steps) {
      for (const dep of step.depends_on ?? []) {
        if (!ids.has(dep)) {
          throw new DAGError(
            `Step "${step.id}" depends on unknown step: "${dep}"`
          );
        }
      }
    }

    // Cycle detection via DFS
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const visit = (id: string): boolean => {
      visited.add(id);
      recStack.add(id);
      const node = this.nodes.get(id);
      if (node) {
        for (const dep of node.step.depends_on ?? []) {
          if (!visited.has(dep)) {
            if (visit(dep)) return true;
          } else if (recStack.has(dep)) {
            return true;
          }
        }
      }
      recStack.delete(id);
      return false;
    };

    for (const step of this.plan.steps) {
      if (!visited.has(step.id)) {
        if (visit(step.id)) {
          throw new DAGError(
            `Cycle detected in plan (involving step "${step.id}")`
          );
        }
      }
    }
  }

  /** Return execution levels using Kahn's algorithm. Nodes at the same level can run in parallel. */
  topologicalLevels(): DAGLevel[] {
    // Clone dependency counts so we don't mutate internal state
    const remaining = new Map<string, number>();
    for (const [id, node] of this.nodes) {
      remaining.set(id, node.dependenciesRemaining);
    }

    const levels: DAGLevel[] = [];
    let currentLevel = 0;

    while (remaining.size > 0) {
      const ready: string[] = [];
      for (const [id, count] of remaining) {
        if (count === 0) {
          ready.push(id);
        }
      }

      if (ready.length === 0) {
        // This should never happen if validate() passed, but guard anyway
        const pending = Array.from(remaining.keys()).join(", ");
        throw new DAGError(`Deadlock in plan execution. Pending steps: ${pending}`);
      }

      levels.push({ level: currentLevel, stepIds: ready });

      for (const id of ready) {
        remaining.delete(id);
        const node = this.nodes.get(id);
        if (node) {
          for (const dependent of node.dependents) {
            const current = remaining.get(dependent);
            if (current !== undefined) {
              remaining.set(dependent, current - 1);
            }
          }
        }
      }

      currentLevel++;
    }

    return levels;
  }

  getNode(id: string): DAGNode | undefined {
    return this.nodes.get(id);
  }

  getAllNodes(): Map<string, DAGNode> {
    return new Map(this.nodes);
  }

  markRunning(id: string): void {
    const node = this.nodes.get(id);
    if (node) {
      node.status = "running";
      node.startTime = Date.now();
    }
  }

  markCompleted(id: string, result: StepResult): void {
    const node = this.nodes.get(id);
    if (node) {
      node.status = "completed";
      node.result = result;
      node.endTime = Date.now();
    }
  }

  markFailed(id: string, result: StepResult): void {
    const node = this.nodes.get(id);
    if (node) {
      node.status = "failed";
      node.result = result;
      node.endTime = Date.now();
      node.retryCount++;
    }
  }

  markSkipped(id: string, reason?: string): void {
    const node = this.nodes.get(id);
    if (node) {
      node.status = "skipped";
      node.result = { output: reason ?? "Skipped", isError: false };
      node.endTime = Date.now();
    }
  }

  /** Reset a node to pending (for retry). */
  reset(id: string): void {
    const node = this.nodes.get(id);
    if (node) {
      node.status = "pending";
      node.startTime = undefined;
      node.endTime = undefined;
    }
  }

  /** Summarize completed results for replanning context. */
  buildResultSummary(): string {
    const lines: string[] = [];
    for (const [id, node] of this.nodes) {
      if (node.status === "completed" && node.result) {
        const preview = node.result.output.slice(0, 200).replace(/\n/g, " ");
        lines.push(`- ${id} (${node.step.tool}): ${preview}`);
      } else if (node.status === "failed" && node.result) {
        lines.push(`- ${id} (${node.step.tool}): FAILED — ${node.result.output.slice(0, 200)}`);
      }
    }
    return lines.join("\n");
  }

  private buildGraph(): void {
    // First pass: create all nodes
    for (const step of this.plan.steps) {
      this.nodes.set(step.id, {
        step,
        dependents: new Set(),
        dependenciesRemaining: step.depends_on?.length ?? 0,
        status: "pending",
        retryCount: 0,
      });
    }

    // Second pass: wire dependents
    for (const step of this.plan.steps) {
      for (const dep of step.depends_on ?? []) {
        const depNode = this.nodes.get(dep);
        if (depNode) {
          depNode.dependents.add(step.id);
        }
      }
    }
  }
}

export class DAGError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DAGError";
  }
}

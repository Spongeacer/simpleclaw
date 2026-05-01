/**
 * SimpleClaw — Variable Resolver
 * Interpolates {{step_id.output}} references within plan step arguments.
 */

import type { DAG } from "./dag.js";

const OUTPUT_REF_RE = /\{\{\s*([a-zA-Z0-9_-]+)\.output\s*\}\}/g;

export class VariableResolver {
  /**
   * Recursively resolve variable references in a value.
   * Supports objects, arrays, and strings.
   */
  resolve(template: unknown, dag: DAG): unknown {
    if (typeof template === "string") {
      return this.resolveString(template, dag);
    }
    if (Array.isArray(template)) {
      return template.map((item) => this.resolve(item, dag));
    }
    if (typeof template === "object" && template !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(template)) {
        result[key] = this.resolve(val, dag);
      }
      return result;
    }
    // Primitives (number, boolean, null) pass through
    return template;
  }

  private resolveString(template: string, dag: DAG): string {
    return template.replace(OUTPUT_REF_RE, (_match, stepId) => {
      const node = dag.getNode(stepId);
      if (!node) {
        throw new ResolutionError(
          `Variable reference "{{${stepId}.output}}" points to unknown step`
        );
      }
      if (node.status === "failed" || node.status === "skipped") {
        throw new ResolutionError(
          `Variable reference "{{${stepId}.output}}" points to step "${stepId}" which is ${node.status}`
        );
      }
      if (node.status !== "completed" || !node.result) {
        throw new ResolutionError(
          `Variable reference "{{${stepId}.output}}" points to incomplete step "${stepId}" (status: ${node.status})`
        );
      }
      return node.result.output;
    });
  }
}

export class ResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolutionError";
  }
}

/**
 * SimpleClaw Core — Task Queue interface
 * Decouples task submission from execution.
 */

import type { Task } from "./task.js";
import type { TaskStatus } from "./types.js";

export interface ITaskQueue {
  enqueue(task: Omit<Task, "taskId" | "status" | "createdAt" | "events">): Promise<Task>;
  dequeue(): Promise<Task | null>;
  update(taskId: string, patch: Partial<Omit<Task, "taskId">>): Promise<void>;
  get(taskId: string): Promise<Task | null>;
  list(options?: { sessionId?: string; status?: TaskStatus; limit?: number }): Promise<Task[]>;
}

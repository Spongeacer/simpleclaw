/**
 * SimpleClaw — In-memory task queue
 * MVP implementation. Replace with SQLite/Redis for production.
 */

import type { ITaskQueue } from "../core/task-queue.js";
import type { Task } from "../core/task.js";
import type { TaskStatus } from "../core/types.js";

export class MemoryTaskQueue implements ITaskQueue {
  private tasks = new Map<string, Task>();
  private queue: string[] = []; // ordered task IDs
  private nextId = 1;

  async enqueue(taskData: Omit<Task, "taskId" | "status" | "createdAt" | "events">): Promise<Task> {
    const taskId = `task-${Date.now()}-${this.nextId++}`;
    const task: Task = {
      ...taskData,
      taskId,
      status: "queued",
      createdAt: new Date(),
      events: [],
    };
    this.tasks.set(taskId, task);
    this.queue.push(taskId);
    return task;
  }

  async dequeue(): Promise<Task | null> {
    while (this.queue.length > 0) {
      const taskId = this.queue.shift()!;
      const task = this.tasks.get(taskId);
      if (task && task.status === "queued") {
        return task;
      }
    }
    return null;
  }

  async update(taskId: string, patch: Partial<Omit<Task, "taskId">>): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    Object.assign(task, patch);
  }

  async get(taskId: string): Promise<Task | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async list(options?: { sessionId?: string; status?: TaskStatus; limit?: number }): Promise<Task[]> {
    let results = Array.from(this.tasks.values());
    if (options?.sessionId) {
      results = results.filter(t => t.sessionId === options.sessionId);
    }
    if (options?.status) {
      results = results.filter(t => t.status === options.status);
    }
    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    if (options?.limit) {
      results = results.slice(0, options.limit);
    }
    return results;
  }
}

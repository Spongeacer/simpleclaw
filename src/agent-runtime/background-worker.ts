/**
 * SimpleClaw — Background Worker
 * Polls the task queue and executes agent turns asynchronously.
 */

import type { ITaskQueue } from "../core/task-queue.js";
import type { IAgentEngine, ILogger, INotificationBus } from "../core/interfaces.js";

export class BackgroundWorker {
  private running = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private queue: ITaskQueue,
    private engine: IAgentEngine,
    private bus: INotificationBus,
    private logger: ILogger,
  ) {}

  start(): void {
    this.running = true;
    this.timer = setInterval(() => this.poll(), 1000);
    this.logger.info("BackgroundWorker started");
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.logger.info("BackgroundWorker stopped");
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    const task = await this.queue.dequeue();
    if (!task) return;

    this.logger.info("Worker processing task", { taskId: task.taskId, sessionId: task.sessionId });

    await this.queue.update(task.taskId, { status: "running", startedAt: new Date() });
    this.bus.publish(task.taskId, { kind: "status", status: "running" });

    const events = [];
    try {
      for await (const event of this.engine.chat(task.sessionId, task.message)) {
        events.push(event);
        this.bus.publish(task.taskId, { kind: "event", event });
      }

      const finalText = events
        .filter(e => e.type === "text")
        .map(e => e.text)
        .join("\n");

      await this.queue.update(task.taskId, {
        status: "completed",
        completedAt: new Date(),
        events,
        result: finalText || "Done",
      });
      this.bus.publish(task.taskId, { kind: "status", status: "completed" });

      this.logger.info("Task completed", { taskId: task.taskId, eventCount: events.length });

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error("Task failed", { taskId: task.taskId, error: msg });
      await this.queue.update(task.taskId, {
        status: "failed",
        completedAt: new Date(),
        events,
        error: msg,
      });
      this.bus.publish(task.taskId, { kind: "status", status: "failed", error: msg });
    }
  }
}

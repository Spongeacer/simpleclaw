/**
 * SimpleClaw Core — Notification Bus
 * In-memory pub/sub for real-time task event streaming.
 */

import type { INotificationBus, TaskHandler, TaskNotification } from "./interfaces.js";

export class NotificationBus implements INotificationBus {
  private subs = new Map<string, Set<TaskHandler>>();

  subscribe(taskId: string, handler: TaskHandler): () => void {
    if (!this.subs.has(taskId)) {
      this.subs.set(taskId, new Set());
    }
    this.subs.get(taskId)!.add(handler);
    return () => {
      this.subs.get(taskId)?.delete(handler);
    };
  }

  publish(taskId: string, notif: TaskNotification): void {
    const handlers = this.subs.get(taskId);
    if (!handlers) return;
    for (const h of handlers) {
      try { h(taskId, notif); } catch { /* handler errors must not break publishing */ }
    }
    if (handlers.size === 0) {
      this.subs.delete(taskId);
    }
  }

  unsubscribeAll(taskId: string): void {
    this.subs.delete(taskId);
  }
}

/**
 * SimpleClaw Core — Task types
 * A Task represents a unit of work queued for background execution.
 */

import type { IChatEvent } from "./interfaces.js";
import type { TaskStatus } from "./types.js";

export interface Task {
  taskId: string;
  sessionId: string;
  agentId: string;
  message: string;
  status: TaskStatus;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  events: IChatEvent[];
  result?: string;
  error?: string;
}

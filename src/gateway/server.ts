/**
 * SimpleClaw — Minimal stateless Gateway
 * Receives JSON-RPC over WebSocket, delegates to Agent Runtime.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { Server as HttpServer } from "http";
import { logger } from "../core/logger.js";
import type { JsonRpcFrame, JsonRpcRequest, JsonRpcResponse } from "../core/protocol.js";

import { GatewayMethods, isJsonRpcRequest, buildError, buildResult } from "../core/protocol.js";
import type { GatewayConfig } from "../core/types.js";
import { GatewayAuth, RateLimiter } from "./auth.js";
import type { ISessionStore } from "../core/interfaces.js";
import { MemorySessionStore } from "./session-store.js";
import type { IAgentEngine } from "../core/interfaces.js";
import type { ITaskQueue } from "../core/task-queue.js";
import type { INotificationBus } from "../core/interfaces.js";
import { serveStatic } from "./static.js";

interface Client {
  ws: WebSocket;
  role?: "client" | "extension";
  authenticated: boolean;
}

export class Gateway {
  private wss?: WebSocketServer;
  private clients = new Map<WebSocket, Client>();
  private auth: GatewayAuth;
  private rateLimiter: RateLimiter;
  private sessionStore: ISessionStore;

  constructor(
    config: GatewayConfig,
    private engine: IAgentEngine,
    sessionStore?: ISessionStore,
    private taskQueue?: ITaskQueue,
    private notificationBus?: INotificationBus,
  ) {
    this.auth = new GatewayAuth(config.auth, config.rateLimit);
    this.rateLimiter = new RateLimiter(config.rateLimit);
    this.sessionStore = sessionStore ?? new MemorySessionStore();
  }

  attach(httpServer: HttpServer): void {
    // Serve static UI files on HTTP GET
    httpServer.on("request", async (req, res) => {
      // Serve static UI files on HTTP GET
      if (req.method === "GET" && (req.url?.startsWith("/ui") || req.url === "/")) {
        const subReq = Object.create(req);
        subReq.url = req.url === "/" ? "/index.html" : req.url!.slice(3) || "/index.html";
        const served = await serveStatic(subReq, res);
        if (served) return;
      }
      // Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
        return;
      }
      // Default: 404
      res.writeHead(404).end("Not found");
    });

    this.wss = new WebSocketServer({ server: httpServer });
    this.wss.on("connection", (ws, req) => {
      const ip = req.socket.remoteAddress ?? "unknown";
      const client: Client = { ws, authenticated: false };
      this.clients.set(ws, client);

      logger.info("WS connected", { ip });

      ws.on("message", (data) => this.handleMessage(ws, client, data, ip));
      ws.on("close", () => {
        this.clients.delete(ws);
        logger.info("WS disconnected", { ip });
      });
      ws.on("error", (err) => logger.error("WS error", { ip, error: err.message }));
    });
  }

  private async handleMessage(ws: WebSocket, client: Client, data: unknown, ip: string): Promise<void> {
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(String(data)) as JsonRpcFrame;
    } catch {
      this.send(ws, buildError(null, -32700, "Parse error"));
      return;
    }

    if (!isJsonRpcRequest(frame)) return;

    if (!this.rateLimiter.isAllowed("rpc", ip)) {
      this.send(ws, buildError(frame.id, -32000, "Rate limit exceeded"));
      return;
    }

    if (!client.authenticated && frame.method !== GatewayMethods.CONNECT) {
      this.send(ws, buildError(frame.id, -32001, "Not authenticated"));
      return;
    }

    try {
      const streamed = await this.dispatch(frame, client, ip);
      if (streamed !== null) {
        this.send(ws, buildResult(frame.id, streamed));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("RPC dispatch error", { method: frame.method, error: msg });
      this.send(ws, buildError(frame.id, -32002, msg));
    }
  }

  private async dispatch(req: JsonRpcRequest, client: Client, ip: string): Promise<unknown> {
    switch (req.method) {
      case GatewayMethods.CONNECT: {
        const params = (req.params ?? {}) as { token?: string; role?: string };
        const authResult = await this.auth.authenticate({ ip, token: params.token });
        if (!authResult.success) {
          throw new Error(authResult.error ?? "Auth failed");
        }
        client.authenticated = true;
        client.role = (params.role as "client" | "extension") ?? "client";
        return { sessionToken: "todo-jwt", gatewayVersion: "0.1.0" };
      }

      case GatewayMethods.CHAT_SEND: {
        const { sessionId, agentId, message } = req.params as { sessionId: string; agentId: string; message: string };

        // Async task mode: enqueue and stream events via notification bus
        if (this.taskQueue && this.notificationBus) {
          const task = await this.taskQueue.enqueue({ sessionId, agentId, message });

          return new Promise((resolve) => {
            const unsub = this.notificationBus!.subscribe(task.taskId, (_tid, notif) => {
              if (notif.kind === "event") {
                this.send(client.ws, buildResult(req.id, notif.event));
              } else if (notif.kind === "status") {
                if (notif.status === "completed" || notif.status === "failed") {
                  unsub();
                  resolve({ taskId: task.taskId, status: notif.status });
                }
              }
            });
          });
        }

        // Fallback: direct synchronous streaming
        try {
          const stream = this.engine.chat(sessionId, message);
          for await (const event of stream) {
            this.send(client.ws, buildResult(req.id, event));
          }
        } catch (streamErr) {
          const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
          this.send(client.ws, buildError(req.id, -32003, msg));
        }
        return null;
      }

      case GatewayMethods.TASKS_CREATE: {
        if (!this.taskQueue) throw new Error("Task queue not configured");
        const { sessionId, agentId, message } = req.params as { sessionId: string; agentId: string; message: string };
        const task = await this.taskQueue.enqueue({ sessionId, agentId, message });
        return { taskId: task.taskId, status: task.status };
      }

      case GatewayMethods.TASKS_GET: {
        if (!this.taskQueue) throw new Error("Task queue not configured");
        const { taskId } = req.params as { taskId: string };
        const task = await this.taskQueue.get(taskId);
        if (!task) throw new Error("Task not found");
        return {
          taskId: task.taskId,
          status: task.status,
          result: task.result,
          error: task.error,
          events: task.events,
          createdAt: task.createdAt,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
        };
      }

      case GatewayMethods.TASKS_LIST: {
        if (!this.taskQueue) throw new Error("Task queue not configured");
        const { sessionId, status } = req.params as { sessionId?: string; status?: string };
        const validStatus = status && ["queued", "running", "completed", "failed", "cancelled"].includes(status)
          ? status as import("../core/types.js").TaskStatus
          : undefined;
        return this.taskQueue.list({ sessionId, status: validStatus });
      }

      case GatewayMethods.SESSIONS_CREATE: {
        const { agentId, channelId, initialMessage } = req.params as {
          agentId: string;
          channelId?: string;
          initialMessage?: string;
        };
        const sessionId = crypto.randomUUID();
        await this.sessionStore.create({
          sessionId,
          agentId,
          channelId,
          turns: [],
          tokenCount: 0,
        });
        if (initialMessage) {
          // Enqueue as a background task instead of unawaited fire-and-forget
          // to avoid racing with a subsequent CHAT_SEND for the same session.
          if (this.taskQueue) {
            const task = await this.taskQueue.enqueue({ sessionId, agentId, message: initialMessage });
            return { sessionId, agentId, taskId: task.taskId };
          }
          // Fallback: fire-and-forget only when no task queue is available
          (async () => {
            try {
              for await (const _ of this.engine.chat(sessionId, initialMessage)) {
                /* discard background stream */
              }
            } catch {
              /* ignore background errors */
            }
          })();
        }
        return { sessionId, agentId };
      }

      case GatewayMethods.SESSIONS_GET: {
        const { sessionId } = req.params as { sessionId: string };
        const session = await this.sessionStore.get(sessionId);
        if (!session) throw new Error("Session not found");
        return {
          sessionId: session.sessionId,
          agentId: session.agentId,
          turns: session.turns,
          tokenCount: session.tokenCount,
        };
      }

      default:
        throw new Error(`Unknown method: ${req.method}`);
    }
  }

  private send(ws: WebSocket, frame: JsonRpcResponse): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }

  async close(): Promise<void> {
    for (const [ws] of this.clients) {
      ws.close();
    }
    this.clients.clear();
    this.wss?.close();
  }
}

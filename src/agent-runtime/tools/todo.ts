/**
 * SimpleClaw — Todo Tool Suite (Claude Code inspired, enhanced)
 *
 * - todo_write: full replacement or incremental updates, auto-persisted
 * - todo_read:  read the current persisted todo list
 *
 * Persistence: `{workspace}/.simpleclaw/todos.json`
 */

import type { ISandbox, ITool } from "../../core/interfaces.js";

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
  createdAt?: string; // ISO
  completedAt?: string; // ISO
}

const TODO_FILE = ".simpleclaw/todos.json";

function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

async function loadTodos(sandbox: ISandbox): Promise<TodoItem[]> {
  try {
    const raw = await sandbox.readFile(TODO_FILE);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveTodos(sandbox: ISandbox, todos: TodoItem[]): Promise<void> {
  await sandbox.writeFile(TODO_FILE, JSON.stringify(todos, null, 2) + "\n");
}

function validateStatus(s: unknown): TodoItem["status"] | undefined {
  if (s === "pending" || s === "in_progress" || s === "completed") return s;
  return undefined;
}

function validatePriority(p: unknown): TodoItem["priority"] | undefined {
  if (p === "high" || p === "medium" || p === "low") return p;
  return undefined;
}

function normalizeTodo(raw: unknown, existing?: TodoItem): TodoItem | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;

  const content = r.content !== undefined ? String(r.content).trim() : (existing?.content ?? "");
  const status = validateStatus(r.status) ?? existing?.status ?? "pending";
  const priority = validatePriority(r.priority) ?? existing?.priority;

  if (!content) return undefined;

  const item: TodoItem = {
    id: existing?.id ?? (r.id ? String(r.id) : generateId()),
    content,
    status,
    priority,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };

  if (status === "completed" && existing?.status !== "completed") {
    item.completedAt = new Date().toISOString();
  } else if (existing?.completedAt && status === "completed") {
    item.completedAt = existing.completedAt;
  }

  return item;
}

function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return "📋 No todos.";

  const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
  const warnings: string[] = [];
  if (inProgressCount === 0) warnings.push("Warning: No task is currently in_progress.");
  if (inProgressCount > 1) warnings.push(`Warning: ${inProgressCount} tasks are in_progress. Only one should be active.`);

  const priorityEmoji = { high: "🔴", medium: "🟡", low: "🟢" };

  const lines: string[] = ["📋 Task List", ""];
  for (const t of todos) {
    const icon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "▶️" : "⏳";
    const pri = t.priority ? `${priorityEmoji[t.priority]} ` : "";
    lines.push(`${icon} ${pri}${t.content}`);
  }

  const completed = todos.filter((t) => t.status === "completed").length;
  lines.push("");
  lines.push(`Progress: ${completed}/${todos.length} completed`);

  if (warnings.length > 0) {
    lines.push("");
    lines.push(...warnings);
  }

  return lines.join("\n");
}

export function createTodoWriteTool(sandbox: ISandbox): ITool {
  return {
    name: "todo_write",
    description:
      "Create or update the session todo list. " +
      "The list is automatically persisted to disk. " +
      "You can either replace the entire list (todos) or apply incremental updates (updates).\n" +
      "Rules:\n" +
      "- Update todos in real-time as you work.\n" +
      "- Mark completed IMMEDIATELY after finishing.\n" +
      "- Exactly ONE task should be 'in_progress' at any time.\n" +
      "- Use priority (high/medium/low) to signal urgency.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Optional: full replacement list. Each item needs content and status. If provided, this completely replaces the current list.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Optional stable ID. Omit to auto-generate." },
              content: { type: "string", description: "Task description. E.g. 'Fix auth bug'" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              priority: { type: "string", enum: ["high", "medium", "low"], description: "Optional priority" },
            },
            required: ["content", "status"],
          },
        },
        updates: {
          type: "array",
          description: "Optional: incremental updates by ID. Use this to change status/priority of existing items without rewriting the whole list.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "ID of the todo to update" },
              content: { type: "string", description: "New description (optional)" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              priority: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["id"],
          },
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const hasTodos = Array.isArray(args.todos);
      const hasUpdates = Array.isArray(args.updates);

      if (!hasTodos && !hasUpdates) {
        return "Error: Provide either 'todos' (full replacement) or 'updates' (incremental).";
      }

      let current = await loadTodos(sandbox);

      // Full replacement mode
      if (hasTodos) {
        current = (args.todos as unknown[])
          .map((t) => normalizeTodo(t))
          .filter((t): t is TodoItem => t !== undefined);
      }

      // Incremental update mode
      if (hasUpdates) {
        for (const u of args.updates as unknown[]) {
          if (typeof u !== "object" || u === null) continue;
          const updateId = String((u as Record<string, unknown>).id ?? "");
          if (!updateId) continue;
          const idx = current.findIndex((t) => t.id === updateId);
          if (idx >= 0) {
            current[idx] = normalizeTodo(u, current[idx]) ?? current[idx];
          } else {
            const created = normalizeTodo(u);
            if (created) current.push(created);
          }
        }
      }

      await saveTodos(sandbox, current);
      return formatTodoList(current);
    },
  };
}

export function createTodoReadTool(sandbox: ISandbox): ITool {
  return {
    name: "todo_read",
    description: "Read the current persisted todo list. Use this to check progress before deciding next steps.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      const todos = await loadTodos(sandbox);
      if (todos.length === 0) {
        return "No todos found. Use todo_write to create a task list.";
      }
      return formatTodoList(todos);
    },
  };
}

/**
 * SimpleClaw — Configuration schema (Zod)
 */

import { z } from "zod";

export const ModelRefSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  strictToolSchema: z.boolean().optional(),
  contextWindow: z.number().positive().optional(),
  capabilities: z.object({
    strictToolSchema: z.boolean().default(false),
  }).optional(),
});

export const SandboxConfigSchema = z.object({
  enabled: z.boolean().default(true),
  backend: z.enum(["docker", "none"]).default("docker"),
  allowedPaths: z.array(z.string()).default([]),
  deniedPaths: z.array(z.string()).default(["/etc", "/proc", "/sys", "/dev", "/root"]),
});

export const AgentConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  model: ModelRefSchema,
  systemPrompt: z.string().optional(),
  tools: z.array(z.string()).default([]),
  sandbox: SandboxConfigSchema.optional(),
  approvalPolicy: z.enum(["always", "dangerous", "never"]).default("dangerous"),
  workspace: z.string().default("~/.simpleclaw/workspace"),
  compaction: z.object({
    thresholdTokens: z.number().positive().optional(),
    thresholdPercent: z.number().min(0).max(1).optional(),
    preserveTurns: z.number().positive().optional(),
    summaryMaxLength: z.number().positive().optional(),
  }).optional(),
  memory: z.object({
    enabled: z.boolean().default(true),
    maxResults: z.number().positive().default(5),
  }).optional(),
  maxIterations: z.number().positive().optional(),
  planMode: z.enum(["auto", "off", "always"]).default("auto"),
});

export const AuthConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("token"), token: z.string().min(1) }),
  z.object({ type: z.literal("password"), passwordHash: z.string().min(1) }),
]);

export const RateLimitConfigSchema = z.object({
  maxRequestsPerMinute: z.number().positive().default(60),
  blockDurationSeconds: z.number().positive().default(300),
});

export const SessionStoreConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("memory") }),
  z.object({ type: z.literal("sqlite"), path: z.string().default("~/.simpleclaw/sessions.db") }),
]);

export const GatewayConfigSchema = z.object({
  port: z.number().positive().default(18789),
  host: z.string().default("127.0.0.1"),
  auth: AuthConfigSchema,
  rateLimit: RateLimitConfigSchema.default({}),
  sessionStore: SessionStoreConfigSchema.default({ type: "sqlite" }),
});

export const ProviderConfigSchema = z.object({
  type: z.literal("openai-compatible").default("openai-compatible"),
  apiKey: z.string().min(1),
  baseURL: z.string().url(),
});

export const McpServerConfigSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(["stdio", "sse"]),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  url: z.string().url().optional(),
  namePrefix: z.string().optional(),
});

export const SimpleClawConfigSchema = z.object({
  version: z.literal(1).default(1),
  gateway: GatewayConfigSchema,
  agents: z.array(AgentConfigSchema).min(1),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  models: z.object({
    default: ModelRefSchema,
    routing: z.record(z.string(), ModelRefSchema).optional(),
  }),
  plugins: z.array(z.object({
    name: z.string(),
    version: z.string().optional(),
    config: z.record(z.unknown()).optional(),
  })).default([]),
  mcpServers: z.array(McpServerConfigSchema).default([]),
});

// ─── Type Exports ─────────────────────────────────────────────────────────────

export type SimpleClawConfig = z.infer<typeof SimpleClawConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type ModelRef = z.infer<typeof ModelRefSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: SimpleClawConfig = {
  version: 1,
  gateway: {
    port: 18789,
    host: "127.0.0.1",
    auth: { type: "none" },
    rateLimit: { maxRequestsPerMinute: 60, blockDurationSeconds: 300 },
    sessionStore: { type: "sqlite", path: "~/.simpleclaw/sessions.db" },
  },
  agents: [
    {
      id: "default",
      name: "SimpleClaw",
      model: { provider: "moonshot", model: "moonshot-v1-8k" },
      tools: ["read", "edit", "shell", "web_fetch"],
      approvalPolicy: "dangerous",
      workspace: "~/.simpleclaw/workspace",
      planMode: "auto",
    },
  ],
  providers: {},
  models: {
    default: { provider: "mock", model: "mock" },
  },
  plugins: [],
  mcpServers: [],
};

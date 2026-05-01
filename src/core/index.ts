/**
 * SimpleClaw — Core exports (Layer 1)
 * Pure logic. Zero platform dependencies.
 */

export * from "./types.js";
export { GatewayMethods, isJsonRpcRequest, buildError, buildResult } from "./protocol.js";
export type { JsonRpcFrame, JsonRpcRequest, JsonRpcResponse, JsonRpcError, ConnectParams, ConnectResult, ChatSendParams, SessionsCreateParams, SessionsCreateResult, SessionsGetResult, ChannelsSendParams } from "./protocol.js";
export { SimpleClawConfigSchema, DEFAULT_CONFIG } from "./config-schema.js";
export type { SimpleClawConfig, AgentConfig, GatewayConfig, ModelRef, ProviderConfig } from "./config-schema.js";
export * from "./interfaces.js";
export * from "./agent-engine.js";
export * from "./logger.js";
export * from "./plugin-loader.js";

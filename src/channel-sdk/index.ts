/**
 * SimpleClaw — Channel SDK (Layer 4 infrastructure)
 * Provides the base adapter and message formatter for all channel extensions.
 */

export type { ChannelAdapter } from "../core/interfaces.js";

export { BaseChannelAdapter } from "./base-adapter.js";
export { MessageFormatter } from "./formatter.js";

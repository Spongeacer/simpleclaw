/**
 * SimpleClaw — Abstract base channel adapter
 * Handles reconnection, heartbeat, and common lifecycle logic.
 */

import { SimpleEmitter } from "./simple-emitter.js";
import type { InboundMessage, OutboundMessage, DMPolicy, ChannelId } from "../core/types.js";
import type { ChannelAdapter } from "../core/interfaces.js";
import { logger } from "../core/logger.js";

export abstract class BaseChannelAdapter extends SimpleEmitter implements ChannelAdapter {
  abstract readonly id: ChannelId;
  protected connected = false;
  protected messageHandler?: (msg: InboundMessage) => void;

  abstract authenticate(credentials: Record<string, string>): Promise<void>;
  abstract send(message: OutboundMessage): Promise<void>;

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  getDMPolicy(): DMPolicy {
    return { allowsUnsolicited: false, requiresMentionInGroup: true };
  }

  async start(): Promise<void> {
    logger.info(`Channel adapter starting: ${this.id}`);
    this.connected = true;
  }

  async stop(): Promise<void> {
    logger.info(`Channel adapter stopping: ${this.id}`);
    this.connected = false;
  }

  protected receive(msg: InboundMessage): void {
    if (this.messageHandler) {
      this.messageHandler(msg);
    }
  }
}

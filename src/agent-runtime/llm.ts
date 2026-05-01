/**
 * SimpleClaw — LLM abstraction + multi-model router
 * Defines the contract; concrete providers live in extensions.
 */

import type { ModelRef } from "../core/types.js";
import type { ILLMClient } from "../core/interfaces.js";

export { type ILLMMessage as LLMMessage, type ILLMResponse as LLMResponse, type ILLMClient as LLMClient } from "../core/interfaces.js";

export class ModelRouter {
  private clients = new Map<string, ILLMClient>();

  register(client: ILLMClient): void {
    const key = `${client.modelRef.provider}/${client.modelRef.model}`;
    this.clients.set(key, client);
  }

  resolve(ref: ModelRef): ILLMClient {
    const key = `${ref.provider}/${ref.model}`;
    const client = this.clients.get(key);
    if (!client) {
      throw new Error(`No LLM client registered for ${key}`);
    }
    return client;
  }
}



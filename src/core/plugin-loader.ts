/**
 * SimpleClaw — Plugin loader
 * Supports dynamic import of external channel/provider/tool packages.
 */

import { logger } from "./logger.js";
import type { LoadedPlugin, ChannelAdapter } from "./types.js";

export interface PluginResolver {
  resolve(name: string): Promise<LoadedPlugin>;
}

export class PluginRegistry {
  private channels = new Map<string, ChannelAdapter>();
  private plugins = new Map<string, LoadedPlugin>();

  constructor(private resolver: PluginResolver) {}

  async loadChannel(name: string, config?: Record<string, unknown>): Promise<ChannelAdapter> {
    if (this.channels.has(name)) return this.channels.get(name)!;

    const plugin = await this.resolver.resolve(name);
    if (plugin.manifest.type !== "channel") {
      throw new Error(`Plugin "${name}" is not a channel adapter`);
    }

    const factory = (plugin.exports as { createAdapter?: (cfg: unknown) => ChannelAdapter }).createAdapter;
    if (!factory) {
      throw new Error(`Channel plugin "${name}" does not export createAdapter`);
    }

    const adapter = factory(config ?? {});
    this.channels.set(name, adapter);
    this.plugins.set(name, plugin);
    logger.info(`Loaded channel adapter: ${name}`, { version: plugin.manifest.version });
    return adapter;
  }

  getChannel(name: string): ChannelAdapter | undefined {
    return this.channels.get(name);
  }

  listChannels(): string[] {
    return Array.from(this.channels.keys());
  }

  unloadChannel(name: string): void {
    const adapter = this.channels.get(name);
    if (adapter) {
      adapter.stop().catch(() => {});
      this.channels.delete(name);
      this.plugins.delete(name);
      logger.info(`Unloaded channel adapter: ${name}`);
    }
  }
}

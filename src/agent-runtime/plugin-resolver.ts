/**
 * SimpleClaw — Node.js module resolver for plugins
 * Layer 2: Runtime implementation of PluginResolver.
 */

import { logger } from "../core/logger.js";
import type { PluginResolver } from "../core/plugin-loader.js";
import type { LoadedPlugin } from "../core/types.js";

export class NodeModuleResolver implements PluginResolver {
  constructor(private readonly prefix = "@simpleclaw-ext") {}

  async resolve(name: string): Promise<LoadedPlugin> {
    const pkgName = name.startsWith(".") ? name : `${this.prefix}/${name}`;
    try {
      const mod = await import(pkgName);
      const manifest = mod.manifest ?? {
        name,
        version: "0.0.0",
        type: "tool",
        entry: pkgName,
      };
      return { manifest, exports: mod };
    } catch (e) {
      logger.error(`Failed to load plugin "${name}"`, { pkgName, error: String(e) });
      throw new Error(
        `Plugin "${name}" not found. Install it with: npm install ${pkgName}`
      );
    }
  }
}

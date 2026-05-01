/**
 * SimpleClaw — Provider factory
 * Creates LLM clients from configuration, zero hard-coded providers.
 */

import type { ModelRef } from "../core/types.js";
import type { ProviderConfig } from "../core/config-schema.js";
import { logger } from "../core/logger.js";
import { ModelRouter } from "./llm.js";
import { OpenAICompatibleClient } from "./providers/openai-compatible.js";

export function createRouter(
  providers: Record<string, ProviderConfig>,
  models: { default: ModelRef; routing?: Record<string, ModelRef> }
): ModelRouter {
  const router = new ModelRouter();

  // Register default model
  registerModel(router, models.default, providers);

  // Register routing models (dedupe by provider+model)
  if (models.routing) {
    for (const [, ref] of Object.entries(models.routing)) {
      registerModel(router, ref, providers);
    }
  }

  return router;
}

function registerModel(
  router: ModelRouter,
  ref: ModelRef,
  providers: Record<string, ProviderConfig>
): void {
  const key = `${ref.provider}/${ref.model}`;

  // Skip if already registered
  try {
    router.resolve(ref);
    return;
  } catch {
    // not registered yet, continue
  }

  const cfg = providers[ref.provider];
  if (!cfg) {
    throw new Error(
      `No provider config found for "${ref.provider}" (model: ${key}). ` +
      `Please add it to the "providers" section of your simpleclaw.json config.`
    );
  }

  switch (cfg.type) {
    case "openai-compatible":
      router.register(
        new OpenAICompatibleClient(ref, {
          apiKey: cfg.apiKey,
          baseURL: cfg.baseURL,
        })
      );
      logger.info(`Registered provider`, { provider: ref.provider, model: ref.model });
      break;
    default:
      throw new Error(
        `Unknown provider type "${cfg.type}" for provider "${ref.provider}". ` +
        `Supported types: "openai-compatible".`
      );
  }
}

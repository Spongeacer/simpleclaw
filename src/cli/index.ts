#!/usr/bin/env node
/**
 * SimpleClaw — CLI entry point
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { startNodeHost } from "../host/node.js";
import { logger, setLogLevel } from "../core/logger.js";
import { SimpleClawConfigSchema, DEFAULT_CONFIG } from "../core/config-schema.js";
import type { SimpleClawConfig } from "../core/config-schema.js";
import { loadSecrets, getProviderKeys, getSecretsEnv, injectProviderKeys, SECRETS_FILE_NAME } from "./keys-loader.js";

const CONFIG_PATH = resolve(homedir(), ".simpleclaw", "simpleclaw.json");

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

function expandConfigPaths(config: SimpleClawConfig): SimpleClawConfig {
  for (const agent of config.agents) {
    agent.workspace = expandHome(agent.workspace);
    if (agent.sandbox) {
      agent.sandbox.allowedPaths = agent.sandbox.allowedPaths.map(expandHome);
      agent.sandbox.deniedPaths = agent.sandbox.deniedPaths.map(expandHome);
    }
  }
  if (config.gateway.sessionStore.type === "sqlite" && config.gateway.sessionStore.path) {
    config.gateway.sessionStore.path = expandHome(config.gateway.sessionStore.path);
  }
  return config;
}

function loadConfig(): { config: SimpleClawConfig; secrets: ReturnType<typeof loadSecrets> } {
  if (!existsSync(CONFIG_PATH)) {
    logger.info("No config found, using defaults", { path: CONFIG_PATH });
    return { config: expandConfigPaths(DEFAULT_CONFIG), secrets: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    const config = expandConfigPaths(SimpleClawConfigSchema.parse(raw));

    // Load secrets.json (or keys.json) and resolve references like "{{moonshot}}"
    const configDir = resolve(CONFIG_PATH, "..");
    const secrets = loadSecrets(configDir);
    const providerKeys = getProviderKeys(secrets);
    injectProviderKeys(config.providers, providerKeys);

    return { config, secrets };
  } catch (e) {
    logger.error("Invalid config", { path: CONFIG_PATH, error: String(e) });
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "start";

  if (command === "--version" || command === "-v") {
    console.log("0.1.0");
    return;
  }

  if (command === "setup") {
    const configDir = resolve(CONFIG_PATH, "..");
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    // Write example secrets.json if it doesn't exist
    const secretsPath = resolve(configDir, SECRETS_FILE_NAME);
    if (!existsSync(secretsPath)) {
      writeFileSync(secretsPath, JSON.stringify({
        "_comment": "NEVER commit this file. Store API keys and service credentials here.",
        "providers": {
          "moonshot": "your-moonshot-key",
          "openrouter": "your-openrouter-key"
        },
        "env": {
          "GITHUB_TOKEN": "ghp-your-github-token",
          "NPM_TOKEN": "npm-your-npm-token"
        }
      }, null, 2) + "\n", "utf-8");
      // Restrict permissions on Unix (owner read/write only)
      if (process.platform !== "win32") {
        try { chmodSync(secretsPath, 0o600); } catch {}
      }
    }

    console.log(`SimpleClaw setup complete.`);
    console.log(`Config path:  ${CONFIG_PATH}`);
    console.log(`Secrets path: ${secretsPath}`);
    console.log("");
    console.log("secrets.json supports two sections:");
    console.log("- providers: API keys for AI models (referenced as {{name}} in simpleclaw.json)");
    console.log("- env:       Service credentials injected into bash/exec tools as environment variables");
    console.log("");
    console.log("Example provider config with key reference:");
    console.log(JSON.stringify({
      providers: {
        openrouter: {
          type: "openai-compatible",
          apiKey: "{{openrouter}}",
          baseURL: "https://openrouter.ai/api/v1"
        }
      },
      models: {
        default: { provider: "openrouter", model: "tencent/hy3-preview:free" }
      }
    }, null, 2));
    return;
  }

  if (command === "start" || command === "dev") {
    const { config, secrets } = loadConfig();
    setLogLevel(command === "dev" ? "debug" : "info");

    const host = await startNodeHost({ config, secretsEnv: getSecretsEnv(secrets) });

    process.on("SIGINT", async () => {
      await host.close();
      process.exit(0);
    });

    return;
  }

  console.log(`Unknown command: ${command}`);
  console.log("Usage: simpleclaw [start|dev|setup|--version]");
  process.exit(1);
}

main().catch((e) => {
  logger.error("Fatal error", { error: String(e) });
  process.exit(1);
});

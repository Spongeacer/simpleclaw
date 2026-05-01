/**
 * SimpleClaw — OpenAI-compatible LLM Client
 * Works with Moonshot, OpenAI, DeepSeek, and any other OpenAI-compatible API.
 */

import type { ModelRef, ToolCall } from "../../core/types.js";
import type { ILLMClient, ILLMMessage, ILLMResponse, IToolSchema } from "../../core/interfaces.js";

export interface OpenAICompatibleOptions {
  apiKey: string;
  baseURL: string;
}

export class OpenAICompatibleClient implements ILLMClient {
  readonly modelRef: ModelRef;
  private apiKey: string;
  private baseURL: string;

  constructor(modelRef: ModelRef, options: OpenAICompatibleOptions) {
    this.modelRef = modelRef;
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL.replace(/\/$/, "");
  }

  async complete(
    messages: ILLMMessage[],
    tools?: IToolSchema[]
  ): Promise<ILLMResponse> {
    const body: Record<string, unknown> = {
      model: this.modelRef.model,
      messages: messages.map((m) => this.toApiMessage(m)),
      temperature: this.modelRef.temperature ?? 0.7,
      max_tokens: this.modelRef.maxTokens ?? 4096,
    };

    if (tools && tools.length > 0) {
      const supportsStrict =
        this.modelRef.capabilities?.strictToolSchema ??
        this.modelRef.strictToolSchema ??
        false;
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: supportsStrict
            ? ensureAdditionalPropertiesFalse(structuredClone(t.parameters))
            : t.parameters,
          ...(supportsStrict ? { strict: true } : {}),
        },
      }));
      body.tool_choice = "auto";
    }

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "unknown");
      throw new Error(`${this.modelRef.provider} API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    if (!choice) throw new Error("No completion choice returned");

    const msg = choice.message;
    const toolCalls: ToolCall[] | undefined = msg.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>,
    }));

    const { text, reasoning } = this.extractReasoningAndText(msg as unknown as Record<string, unknown>);

    return {
      text,
      reasoning,
      toolCalls,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  }

  /**
   * Extract reasoning and final text from a model response.
   * Supports multiple formats:
   *   - DeepSeek-R1: <think>...</think> embedded in content
   *   - OpenAI / OpenRouter: separate reasoning_content / reasoning_text field
   *   - Tencent Hy3: content empty, reasoning field holds text
   */
  private extractReasoningAndText(msg: Record<string, unknown>): { text: string; reasoning?: string } {
    let text = typeof msg.content === "string" ? msg.content : "";
    let reasoning: string | undefined;

    // 1. DeepSeek-R1 style: <think>...</think> embedded in content
    if (text.includes("<think>")) {
      const fullMatch = text.match(/<think>([\s\S]*?)<\/think>/);
      if (fullMatch) {
        reasoning = fullMatch[1].trim();
        text = text.slice(text.indexOf("</think>") + 8).trim();
      } else {
        // Tag not closed yet — entire visible content is reasoning so far
        reasoning = text.replace(/<\/?think>/g, "").trim();
        text = "";
      }
      return { text, reasoning };
    }

    // 2. OpenAI / OpenRouter style: separate reasoning fields
    for (const field of ["reasoning_content", "reasoning_text"] as const) {
      const value = msg[field];
      if (typeof value === "string" && value.length > 0) {
        reasoning = value;
        break;
      }
    }

    // 3. Tencent Hy3 fallback: content empty, reasoning holds the text
    if (!text && typeof msg.reasoning === "string") {
      text = msg.reasoning;
    }

    return { text, reasoning };
  }

  private toApiMessage(m: ILLMMessage): Record<string, unknown> {
    const result: Record<string, unknown> = { role: m.role, content: m.content };

    if (m.role === "tool") {
      result.tool_call_id = m.toolCallId ?? "";
    }

    // Re-assemble reasoning + content for multi-turn context
    if (m.role !== "tool") {
      const raw = (m as unknown as { reasoning?: string }).reasoning;
      if (raw) {
        result.content = `<think>${raw}</think>\n${m.content}`;
      }
    }

    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      result.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }));
    }

    // Cache control support (Anthropic / OpenRouter)
    if (m.cacheControl && this.supportsCacheControl()) {
      result.cache_control = m.cacheControl;
    }

    return result;
  }

  /**
   * Determine if the provider supports explicit cache control.
   * Anthropic native API and OpenRouter (for Claude models) support this.
   */
  private supportsCacheControl(): boolean {
    const provider = this.modelRef.provider.toLowerCase();
    const model = this.modelRef.model.toLowerCase();
    if (provider === "anthropic") return true;
    if (provider === "openrouter") {
      // OpenRouter supports cache control for Anthropic-family models
      return model.includes("claude") || model.includes("anthropic");
    }
    return false;
  }
}

/**
 * Recursively ensure all object schemas have `additionalProperties: false`.
 * This is required for OpenAI strict mode.
 */
function ensureAdditionalPropertiesFalse(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) {
    return schema;
  }

  const obj = schema as Record<string, unknown>;

  if (obj.type === "object") {
    const result: Record<string, unknown> = { ...obj, additionalProperties: false };
    if (obj.properties && typeof obj.properties === "object") {
      const props: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj.properties as Record<string, unknown>)) {
        props[key] = ensureAdditionalPropertiesFalse(val);
      }
      result.properties = props;
    }
    // Also process items if this is an array of objects
    if (obj.items) {
      result.items = ensureAdditionalPropertiesFalse(obj.items);
    }
    // Process anyOf/oneOf/allOf
    for (const composite of ["anyOf", "oneOf", "allOf"] as const) {
      if (Array.isArray(obj[composite])) {
        result[composite] = obj[composite].map(ensureAdditionalPropertiesFalse);
      }
    }
    return result;
  }

  if (obj.type === "array" && obj.items) {
    return { ...obj, items: ensureAdditionalPropertiesFalse(obj.items) };
  }

  // For non-object schemas, still recurse into properties/items if present
  const result: Record<string, unknown> = { ...obj };
  if (obj.properties && typeof obj.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj.properties as Record<string, unknown>)) {
      props[key] = ensureAdditionalPropertiesFalse(val);
    }
    result.properties = props;
  }
  if (obj.items) {
    result.items = ensureAdditionalPropertiesFalse(obj.items);
  }
  for (const composite of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(obj[composite])) {
      result[composite] = obj[composite].map(ensureAdditionalPropertiesFalse);
    }
  }
  return result;
}

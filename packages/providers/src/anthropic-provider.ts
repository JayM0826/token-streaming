import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse } from "@token-streaming/protocol";
import { formatProviderHttpError } from "./http-error.js";
import { formatProviderNetworkError } from "./network-error.js";

export interface AnthropicMessagesProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface AnthropicMessageBody {
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
export const DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS = 16_384;

export class AnthropicMessagesProvider implements ModelProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicMessagesProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async generate(input: ModelRequest): Promise<ModelResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01"
        },
        signal: controller.signal,
        body: JSON.stringify(buildAnthropicRequest(input, this.model))
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`Anthropic request timed out after ${this.timeoutMs}ms.`);
      }
      throw formatProviderNetworkError("Anthropic network request failed", error, [this.apiKey]);
    } finally {
      clearTimeout(timeout);
    }

    const body = await readResponseBody(response);
    if (!response.ok) {
      throw formatProviderHttpError("Anthropic request failed", response, body, [this.apiKey]);
    }
    return {
      provider: this.name,
      model: body.model ?? this.model,
      content: extractText(body),
      usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens }
    };
  }
}

function buildAnthropicRequest(input: ModelRequest, model: string): Record<string, unknown> {
  const system = input.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n").trim();
  const messages = input.messages.filter((message) => message.role !== "system").map(toAnthropicMessage);
  if (messages.length === 0) {
    throw new Error("Anthropic Messages API requires at least one non-system message.");
  }
  return {
    model,
    max_tokens: input.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS,
    ...(system ? { system } : {}),
    messages,
    ...(input.reasoningEffort && supportsEffort(model) ? { output_config: { effort: input.reasoningEffort } } : {})
  };
}

function toAnthropicMessage(message: ModelMessage): { role: "user" | "assistant"; content: string } {
  return { role: message.role === "assistant" ? "assistant" : "user", content: message.content };
}

function supportsEffort(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    /^claude-(?:fable|mythos)-(?:5|preview)/.test(normalized) ||
    /^claude-opus-(?:5|4-(?:5|6|7|8))/.test(normalized) ||
    /^claude-sonnet-(?:5|4-6)/.test(normalized)
  );
}

function extractText(body: AnthropicMessageBody): string {
  return (body.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

async function readResponseBody(response: Response): Promise<AnthropicMessageBody> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as AnthropicMessageBody;
  } catch {
    if (response.ok) {
      throw new Error("Anthropic response was not valid JSON.");
    }
    return { error: { message: text } };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

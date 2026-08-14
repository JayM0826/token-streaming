import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse } from "@token-streaming/protocol";
import { formatProviderHttpError } from "./http-error.js";
import { formatProviderNetworkError } from "./network-error.js";

export interface OpenAIChatCompletionsProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface ChatCompletionBody {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

export class OpenAIChatCompletionsProvider implements ModelProvider {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIChatCompletionsProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gpt-5.5";
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async generate(input: ModelRequest): Promise<ModelResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages: input.messages.map(toChatMessage),
          ...(input.reasoningEffort !== undefined ? { reasoning_effort: input.reasoningEffort } : {}),
          ...(input.maxOutputTokens !== undefined ? { max_completion_tokens: input.maxOutputTokens } : {})
        })
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`OpenAI-compatible chat request timed out after ${this.timeoutMs}ms.`);
      }
      throw formatProviderNetworkError("OpenAI-compatible chat network request failed", error, [this.apiKey]);
    } finally {
      clearTimeout(timeout);
    }

    const body = await readResponseBody(response);
    if (!response.ok) {
      throw formatProviderHttpError("OpenAI-compatible chat request failed", response, body, [this.apiKey]);
    }

    return {
      provider: this.name,
      model: this.model,
      content: extractContent(body),
      usage: {
        inputTokens: body.usage?.prompt_tokens,
        outputTokens: body.usage?.completion_tokens
      }
    };
  }
}

function toChatMessage(message: ModelMessage): { role: string; content: string } {
  return {
    role: message.role === "tool" ? "user" : message.role,
    content: message.content
  };
}

function extractContent(body: ChatCompletionBody): string {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => item.text)
      .filter((text): text is string => typeof text === "string")
      .join("\n")
      .trim();
  }
  return "";
}

async function readResponseBody(response: Response): Promise<ChatCompletionBody> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as ChatCompletionBody;
  } catch {
    if (response.ok) {
      throw new Error("OpenAI-compatible chat response was not valid JSON.");
    }
    return {
      error: {
        message: text
      }
    };
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

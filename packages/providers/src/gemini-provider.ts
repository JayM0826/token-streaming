import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse } from "@token-streaming/protocol";
import { formatProviderHttpError } from "./http-error.js";
import { formatProviderNetworkError } from "./network-error.js";

export interface GeminiInteractionsProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface GeminiInteractionBody {
  model?: string;
  output_text?: string;
  steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: { total_input_tokens?: number; total_output_tokens?: number };
  error?: { code?: number | string; message?: string; status?: string };
}

export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

export class GeminiInteractionsProvider implements ModelProvider {
  readonly name = "gemini";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiInteractionsProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_GEMINI_MODEL;
    this.baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com/v1").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async generate(input: ModelRequest): Promise<ModelResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/interactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        signal: controller.signal,
        body: JSON.stringify(buildGeminiRequest(input, this.model))
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`Gemini request timed out after ${this.timeoutMs}ms.`);
      }
      throw formatProviderNetworkError("Gemini network request failed", error, [this.apiKey]);
    } finally {
      clearTimeout(timeout);
    }

    const body = await readResponseBody(response);
    if (!response.ok) {
      throw formatProviderHttpError("Gemini request failed", response, body, [this.apiKey]);
    }
    return {
      provider: this.name,
      model: body.model ?? this.model,
      content: extractText(body),
      usage: { inputTokens: body.usage?.total_input_tokens, outputTokens: body.usage?.total_output_tokens }
    };
  }
}

function buildGeminiRequest(input: ModelRequest, model: string): Record<string, unknown> {
  const systemInstruction = input.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n").trim();
  const messages = input.messages.filter((message) => message.role !== "system");
  if (messages.length === 0) {
    throw new Error("Gemini Interactions API requires at least one non-system message.");
  }
  const generationConfig = {
    ...(input.reasoningEffort ? { thinking_level: input.reasoningEffort } : {}),
    ...(input.maxOutputTokens !== undefined ? { max_output_tokens: input.maxOutputTokens } : {})
  };
  return {
    model,
    store: false,
    ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
    input: formatGeminiInput(messages),
    ...(Object.keys(generationConfig).length ? { generation_config: generationConfig } : {})
  };
}

function formatGeminiInput(messages: ModelMessage[]): string {
  if (messages.length === 1 && messages[0]?.role !== "assistant") {
    return messages[0]?.content ?? "";
  }
  return messages.map((message) => `${formatRole(message.role)}:\n${message.content}`).join("\n\n").trim();
}

function formatRole(role: ModelMessage["role"]): string {
  return role === "assistant" ? "Assistant" : role === "tool" ? "Tool result" : "User";
}

function extractText(body: GeminiInteractionBody): string {
  if (typeof body.output_text === "string") {
    return body.output_text;
  }
  return (body.steps ?? [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

async function readResponseBody(response: Response): Promise<GeminiInteractionBody> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as GeminiInteractionBody;
  } catch {
    if (response.ok) {
      throw new Error("Gemini response was not valid JSON.");
    }
    return { error: { message: text } };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

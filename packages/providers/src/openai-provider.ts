import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse } from "@token-streaming/protocol";

export interface OpenAIResponsesProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface OpenAIResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface OpenAIResponsesBody {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  usage?: OpenAIResponsesUsage;
  error?: {
    message?: string;
  };
}

export class OpenAIResponsesProvider implements ModelProvider {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIResponsesProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gpt-5.5";
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async generate(input: ModelRequest): Promise<ModelResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          input: toResponsesInput(input.messages),
          reasoning: {
            effort: input.reasoningEffort ?? "medium"
          },
          ...(input.maxOutputTokens !== undefined ? { max_output_tokens: input.maxOutputTokens } : {})
        })
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`OpenAI request timed out after ${this.timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new Error(body.error?.message ?? `OpenAI request failed with HTTP ${response.status}`);
    }

    return {
      provider: this.name,
      model: this.model,
      content: extractOutputText(body),
      usage: {
        inputTokens: body.usage?.input_tokens,
        outputTokens: body.usage?.output_tokens
      }
    };
  }
}

function toResponsesInput(messages: ModelMessage[]): Array<{ role: string; content: string }> {
  return messages.map((message) => ({
    role: message.role === "tool" ? "user" : message.role,
    content: message.content
  }));
}

function extractOutputText(body: OpenAIResponsesBody): string {
  if (body.output_text) {
    return body.output_text;
  }

  const content = body.output
    ?.flatMap((item) => item.content ?? [])
    .map((item) => item.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n")
    .trim();

  return content || "";
}

async function readResponseBody(response: Response): Promise<OpenAIResponsesBody> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as OpenAIResponsesBody;
  } catch {
    if (response.ok) {
      throw new Error("OpenAI response was not valid JSON.");
    }
    return {
      error: {
        message: `OpenAI request failed with HTTP ${response.status}: ${text.slice(0, 500)}`
      }
    };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

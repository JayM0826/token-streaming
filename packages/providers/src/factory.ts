import type { ModelProvider } from "@token-streaming/protocol";
import { OpenAIChatCompletionsProvider } from "./openai-chat-provider.js";
import { OpenAIResponsesProvider } from "./openai-provider.js";
import { StubModelProvider } from "./stub-provider.js";

export type ProviderName = "stub" | "openai" | "auto";
export type OpenAIApiProtocol = "responses" | "chat-completions";

export interface ProviderFactoryOptions {
  provider?: ProviderName;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  apiProtocol?: OpenAIApiProtocol;
}

export function createModelProvider(options: ProviderFactoryOptions = {}): ModelProvider {
  const requestedProvider = options.provider ?? "auto";
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL;
  const apiProtocol = resolveOpenAIApiProtocol(options.apiProtocol ?? process.env.OPENAI_API_PROTOCOL);

  if (requestedProvider === "openai") {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required when --provider openai is selected.");
    }
    return createOpenAIProvider(apiProtocol, apiKey, options.model, baseUrl);
  }

  if (requestedProvider === "auto" && apiKey) {
    return createOpenAIProvider(apiProtocol, apiKey, options.model, baseUrl);
  }

  return new StubModelProvider();
}

export function resolveOpenAIApiProtocol(value: string | undefined): OpenAIApiProtocol {
  if (value === undefined || value === "responses") {
    return "responses";
  }
  if (value === "chat-completions") {
    return value;
  }
  throw new Error(`Invalid OpenAI API protocol "${value}". Use responses or chat-completions.`);
}

function createOpenAIProvider(
  protocol: OpenAIApiProtocol,
  apiKey: string,
  model: string | undefined,
  baseUrl: string | undefined
): ModelProvider {
  if (protocol === "chat-completions") {
    return new OpenAIChatCompletionsProvider({ apiKey, model, baseUrl });
  }
  return new OpenAIResponsesProvider({ apiKey, model, baseUrl });
}

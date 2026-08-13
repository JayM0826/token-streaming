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
  timeoutMs?: number;
}

export const DEFAULT_OPENAI_TIMEOUT_MS = 30_000;
export const MAX_OPENAI_TIMEOUT_MS = 600_000;

export function createModelProvider(options: ProviderFactoryOptions = {}): ModelProvider {
  const requestedProvider = options.provider ?? "auto";
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL;
  const apiProtocol = resolveOpenAIApiProtocol(options.apiProtocol ?? process.env.OPENAI_API_PROTOCOL);
  const model = normalizedModel(options.model) ?? normalizedModel(process.env.OPENAI_MODEL);

  if (requestedProvider === "openai") {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required when --provider openai is selected.");
    }
    return createOpenAIProvider(apiProtocol, apiKey, model, baseUrl, resolveOpenAITimeoutMs(options.timeoutMs));
  }

  if (requestedProvider === "auto" && apiKey) {
    return createOpenAIProvider(apiProtocol, apiKey, model, baseUrl, resolveOpenAITimeoutMs(options.timeoutMs));
  }

  return new StubModelProvider();
}

function normalizedModel(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
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

export function resolveOpenAITimeoutMs(value: number | string | undefined = process.env.OPENAI_TIMEOUT_MS): number {
  if (value === undefined || value === "") {
    return DEFAULT_OPENAI_TIMEOUT_MS;
  }
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_OPENAI_TIMEOUT_MS) {
    throw new Error(`Invalid OpenAI timeout "${value}". Use an integer from 1 to ${MAX_OPENAI_TIMEOUT_MS} milliseconds.`);
  }
  return parsed;
}

function createOpenAIProvider(
  protocol: OpenAIApiProtocol,
  apiKey: string,
  model: string | undefined,
  baseUrl: string | undefined,
  timeoutMs: number
): ModelProvider {
  if (protocol === "chat-completions") {
    return new OpenAIChatCompletionsProvider({ apiKey, model, baseUrl, timeoutMs });
  }
  return new OpenAIResponsesProvider({ apiKey, model, baseUrl, timeoutMs });
}

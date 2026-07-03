import type { ModelProvider } from "@token-streaming/protocol";
import { OpenAIResponsesProvider } from "./openai-provider.js";
import { StubModelProvider } from "./stub-provider.js";

export type ProviderName = "stub" | "openai" | "auto";

export interface ProviderFactoryOptions {
  provider?: ProviderName;
  model?: string;
  apiKey?: string;
}

export function createModelProvider(options: ProviderFactoryOptions = {}): ModelProvider {
  const requestedProvider = options.provider ?? "auto";
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

  if (requestedProvider === "openai") {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required when --provider openai is selected.");
    }
    return new OpenAIResponsesProvider({ apiKey, model: options.model });
  }

  if (requestedProvider === "auto" && apiKey) {
    return new OpenAIResponsesProvider({ apiKey, model: options.model });
  }

  return new StubModelProvider();
}

import type { ModelProvider } from "@token-streaming/protocol";
import { AnthropicMessagesProvider, DEFAULT_ANTHROPIC_MODEL } from "./anthropic-provider.js";
import {
  CodexExecProvider,
  DEFAULT_CODEX_EXEC_TIMEOUT_MS,
  detectCodexExec,
  type CodexExecRunner
} from "./codex-exec-provider.js";
import { DEFAULT_GEMINI_MODEL, GeminiInteractionsProvider } from "./gemini-provider.js";
import { OpenAIChatCompletionsProvider } from "./openai-chat-provider.js";
import { OpenAIResponsesProvider } from "./openai-provider.js";
import { StubModelProvider } from "./stub-provider.js";

export type CommercialProviderName = "openai" | "anthropic" | "gemini";
export type LocalProviderName = "codex";
export type ConcreteProviderName = "stub" | CommercialProviderName | LocalProviderName;
export type ProviderName = ConcreteProviderName | "auto";
export type OpenAIApiProtocol = "responses" | "chat-completions";

type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

export interface ProviderFactoryOptions {
  provider?: ProviderName;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  apiProtocol?: OpenAIApiProtocol;
  timeoutMs?: number;
  cwd?: string;
  codexExecPath?: string;
  codexExecRunner?: CodexExecRunner;
  environment?: ProviderEnvironment;
}

export interface ResolvedProviderConfig {
  requestedProvider: ProviderName;
  provider: ConcreteProviderName;
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  endpoint?: string;
  apiProtocol?: OpenAIApiProtocol;
  timeoutMs: number;
  optionalEnv: string[];
  cwd?: string;
  executablePath?: string;
  executableFound?: boolean;
  executableSource?: "configured" | "desktop" | "path" | "missing";
  searchedExecutablePaths?: string[];
}

interface CommercialProviderDefinition {
  apiKeyEnv: string;
  baseUrlEnv: string;
  modelEnv: string;
  timeoutEnv: string;
  defaultBaseUrl: string;
  defaultModel: string;
}

export const DEFAULT_OPENAI_TIMEOUT_MS = 30_000;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
export const MAX_OPENAI_TIMEOUT_MS = 600_000;
export const MAX_PROVIDER_TIMEOUT_MS = 600_000;
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const COMMERCIAL_PROVIDER_NAMES: readonly CommercialProviderName[] = ["openai", "anthropic", "gemini"];

const DEFINITIONS: Record<CommercialProviderName, CommercialProviderDefinition> = {
  openai: {
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    modelEnv: "OPENAI_MODEL",
    timeoutEnv: "OPENAI_TIMEOUT_MS",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: DEFAULT_OPENAI_MODEL
  },
  anthropic: {
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    modelEnv: "ANTHROPIC_MODEL",
    timeoutEnv: "ANTHROPIC_TIMEOUT_MS",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: DEFAULT_ANTHROPIC_MODEL
  },
  gemini: {
    apiKeyEnv: "GEMINI_API_KEY",
    baseUrlEnv: "GEMINI_BASE_URL",
    modelEnv: "GEMINI_MODEL",
    timeoutEnv: "GEMINI_TIMEOUT_MS",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1",
    defaultModel: DEFAULT_GEMINI_MODEL
  }
};

export function createModelProvider(options: ProviderFactoryOptions = {}): ModelProvider {
  const config = resolveProviderConfig(options);
  if (config.provider === "stub") {
    return new StubModelProvider();
  }
  if (config.provider === "codex") {
    if (!config.executablePath || !config.executableFound) {
      throw new Error("A runnable Codex executable is required when --provider codex is selected. Set CODEX_EXEC_PATH if auto-detection cannot find it.");
    }
    return new CodexExecProvider({
      executablePath: config.executablePath,
      model: config.model,
      cwd: config.cwd,
      timeoutMs: config.timeoutMs,
      environment: options.environment,
      runner: options.codexExecRunner
    });
  }
  if (!config.apiKey || !config.model || !config.baseUrl) {
    throw new Error(`${config.apiKeyEnv} is required when --provider ${config.provider} is selected.`);
  }

  if (config.provider === "anthropic") {
    return new AnthropicMessagesProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs });
  }
  if (config.provider === "gemini") {
    return new GeminiInteractionsProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs });
  }
  return createOpenAIProvider(config.apiProtocol ?? "responses", config.apiKey, config.model, config.baseUrl, config.timeoutMs);
}

export function resolveProviderConfig(options: ProviderFactoryOptions = {}): ResolvedProviderConfig {
  const environment = options.environment ?? process.env;
  const requestedProvider = options.provider ?? "auto";
  const provider = resolveEffectiveProviderName(requestedProvider, { model: options.model, apiKey: options.apiKey, environment });

  if (provider === "stub") {
    return { requestedProvider, provider, timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS, optionalEnv: [] };
  }
  if (provider === "codex") {
    const detection = detectCodexExec({ configuredPath: options.codexExecPath, environment });
    return {
      requestedProvider,
      provider,
      model: normalizedValue(options.model) ?? normalizedValue(environment.CODEX_EXEC_MODEL),
      timeoutMs: resolveProviderTimeoutMs(options.timeoutMs ?? environment.CODEX_EXEC_TIMEOUT_MS, provider),
      optionalEnv: ["CODEX_EXEC_PATH", "CODEX_EXEC_MODEL", "CODEX_EXEC_TIMEOUT_MS"],
      cwd: options.cwd,
      executablePath: detection.executablePath,
      executableFound: detection.found,
      executableSource: detection.source,
      searchedExecutablePaths: detection.searchedPaths
    };
  }

  const definition = DEFINITIONS[provider];
  const apiKey = options.apiKey !== undefined ? normalizedValue(options.apiKey) : normalizedValue(environment[definition.apiKeyEnv]);
  const baseUrl = normalizeBaseUrl(normalizedValue(options.baseUrl) ?? normalizedValue(environment[definition.baseUrlEnv]) ?? definition.defaultBaseUrl);
  const model = normalizedValue(options.model) ?? normalizedValue(environment[definition.modelEnv]) ?? definition.defaultModel;
  const timeoutMs = resolveProviderTimeoutMs(options.timeoutMs ?? environment[definition.timeoutEnv], provider);
  const apiProtocol = provider === "openai" ? resolveOpenAIApiProtocol(options.apiProtocol ?? environment.OPENAI_API_PROTOCOL) : undefined;

  return {
    requestedProvider,
    provider,
    model,
    apiKey,
    apiKeyEnv: definition.apiKeyEnv,
    baseUrl,
    endpoint: formatProviderEndpoint(provider, baseUrl, apiProtocol),
    ...(apiProtocol ? { apiProtocol } : {}),
    timeoutMs,
    optionalEnv: [definition.baseUrlEnv, ...(provider === "openai" ? ["OPENAI_API_PROTOCOL"] : []), definition.modelEnv, definition.timeoutEnv]
  };
}

export function resolveEffectiveProviderName(
  requestedProvider: ProviderName,
  options: { model?: string; apiKey?: string; environment?: ProviderEnvironment } = {}
): ConcreteProviderName {
  if (requestedProvider !== "auto") {
    return requestedProvider;
  }
  if (normalizedValue(options.apiKey)) {
    return "openai";
  }

  const environment = options.environment ?? process.env;
  const inferred = inferProviderFromModel(options.model);
  if (inferred) {
    return normalizedValue(environment[DEFINITIONS[inferred].apiKeyEnv]) ? inferred : "stub";
  }
  return COMMERCIAL_PROVIDER_NAMES.find((name) => normalizedValue(environment[DEFINITIONS[name].apiKeyEnv])) ?? "stub";
}

export function availableProviderNames(environment: ProviderEnvironment = process.env): ConcreteProviderName[] {
  return ["stub", ...COMMERCIAL_PROVIDER_NAMES.filter((name) => normalizedValue(environment[DEFINITIONS[name].apiKeyEnv]))];
}

export function resolveEnvironmentModel(provider: ProviderName, environment: ProviderEnvironment = process.env): string | undefined {
  const effectiveProvider = provider === "auto" ? resolveEffectiveProviderName(provider, { environment }) : provider;
  if (effectiveProvider === "stub") {
    return undefined;
  }
  if (effectiveProvider === "codex") {
    return normalizedValue(environment.CODEX_EXEC_MODEL);
  }
  return normalizedValue(environment[DEFINITIONS[effectiveProvider].modelEnv]);
}

export function providerApiKeyEnvironmentName(provider: CommercialProviderName): string {
  return DEFINITIONS[provider].apiKeyEnv;
}

export function resolveOpenAIApiProtocol(value: string | undefined): OpenAIApiProtocol {
  if (value === undefined || value.trim() === "" || value === "responses") {
    return "responses";
  }
  if (value === "chat-completions") {
    return value;
  }
  throw new Error(`Invalid OpenAI API protocol "${value}". Use responses or chat-completions.`);
}

export function resolveOpenAITimeoutMs(value: number | string | undefined = process.env.OPENAI_TIMEOUT_MS): number {
  return resolveProviderTimeoutMs(value, "openai");
}

export function resolveProviderTimeoutMs(value: number | string | undefined, provider: CommercialProviderName | LocalProviderName): number {
  if (value === undefined || value === "") {
    return provider === "codex" ? DEFAULT_CODEX_EXEC_TIMEOUT_MS : DEFAULT_PROVIDER_TIMEOUT_MS;
  }
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_PROVIDER_TIMEOUT_MS) {
    const label = provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Anthropic" : provider === "gemini" ? "Gemini" : "Codex exec";
    throw new Error(`Invalid ${label} timeout "${value}". Use an integer from 1 to ${MAX_PROVIDER_TIMEOUT_MS} milliseconds.`);
  }
  return parsed;
}

export function formatProviderEndpoint(
  provider: CommercialProviderName,
  baseUrl: string,
  apiProtocol?: OpenAIApiProtocol
): string {
  const base = normalizeBaseUrl(baseUrl);
  if (provider === "openai") {
    return apiProtocol === "chat-completions" ? `${base}/chat/completions` : `${base}/responses`;
  }
  return provider === "anthropic" ? `${base}/messages` : `${base}/interactions`;
}

export function inferProviderFromModel(model: string | undefined): CommercialProviderName | undefined {
  const normalized = normalizedValue(model)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith("claude-")) {
    return "anthropic";
  }
  if (normalized.startsWith("gemini-") || normalized.startsWith("gemma-")) {
    return "gemini";
  }
  if (/^(gpt-|o[1-9](?:-|$)|chatgpt-)/.test(normalized)) {
    return "openai";
  }
  return undefined;
}

function normalizedValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function createOpenAIProvider(
  protocol: OpenAIApiProtocol,
  apiKey: string,
  model: string,
  baseUrl: string,
  timeoutMs: number
): ModelProvider {
  return protocol === "chat-completions"
    ? new OpenAIChatCompletionsProvider({ apiKey, model, baseUrl, timeoutMs })
    : new OpenAIResponsesProvider({ apiKey, model, baseUrl, timeoutMs });
}

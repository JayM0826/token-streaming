import type { ProductMode, RepoManifest } from "@token-streaming/protocol";
import { inspectCodexExec, type CodexExecInspection, type CodexExecRunner } from "./codex-exec-provider.js";
import {
  availableProviderNames,
  createModelProvider,
  DEFAULT_PROVIDER_NAME,
  resolveEnvironmentModel,
  resolveProviderConfig,
  type ConcreteProviderName,
  type OpenAIApiProtocol,
  type ProviderName,
  type ResolvedProviderConfig
} from "./factory.js";
import { resolveModelSelection, type ModelSelection } from "./model-policy.js";
import { isTransientProviderNetworkError } from "./network-error.js";

type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

export interface ModelDoctorOptions {
  mode: ProductMode;
  requestedProvider?: ProviderName;
  requestedModel?: string;
  environmentModel?: string;
  manifest?: Pick<RepoManifest, "models">;
  apiKey?: string;
  baseUrl?: string;
  apiProtocol?: OpenAIApiProtocol;
  timeoutMs?: number;
  probe?: boolean;
  environment?: ProviderEnvironment;
  cwd?: string;
  codexExecPath?: string;
  codexExecRunner?: CodexExecRunner;
  codexExecInspector?: typeof inspectCodexExec;
}

export interface ModelDoctorConnection {
  provider: ConcreteProviderName;
  transport: "api" | "local-exec" | "stub";
  hasApiKey: boolean;
  apiKeyEnv?: string;
  baseUrl?: string;
  endpoint?: string;
  apiProtocol?: OpenAIApiProtocol;
  model?: string;
  timeoutMs: number;
  optionalEnv: string[];
  executablePath?: string;
  executableFound?: boolean;
  executableSource?: "configured" | "desktop" | "path" | "missing";
  executableVersion?: string;
  serviceTier?: "fast" | "flex";
  cwd?: string;
}

export interface ModelDoctorResult {
  ok: boolean;
  selection: ModelSelection;
  effectiveProvider: ConcreteProviderName;
  requestTimeoutMs: number;
  connection: ModelDoctorConnection;
  checks: ModelDoctorCheck[];
}

export interface ModelDoctorCheck {
  name: string;
  status: "ok" | "warning" | "error" | "skipped";
  message: string;
}

export async function diagnoseModelProvider(options: ModelDoctorOptions): Promise<ModelDoctorResult> {
  const environment = options.environment ?? process.env;
  const requestedProvider = options.requestedProvider ?? DEFAULT_PROVIDER_NAME;
  const availableProviders = availableProviderNames(environment);
  if (options.apiKey?.trim() && !availableProviders.includes("openai")) {
    availableProviders.push("openai");
  }
  const selection = resolveModelSelection({
    mode: options.mode,
    requestedProvider,
    requestedModel: options.requestedModel,
    environmentModel: options.environmentModel ?? resolveEnvironmentModel(providerHint(options), environment),
    manifest: options.manifest,
    availableProviders
  });
  const config = resolveProviderConfig({
    provider: selection.provider,
    model: selection.model,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    apiProtocol: options.apiProtocol,
    timeoutMs: options.timeoutMs,
    cwd: options.cwd,
    codexExecPath: options.codexExecPath,
    environment
  });
  const checks: ModelDoctorCheck[] = [
    {
      name: "model-selection",
      status: "ok",
      message: `provider=${selection.provider}, model=${config.model ?? selection.model ?? "provider default"}, source=${selection.source}`
    }
  ];

  const codexInspection = await appendConnectionChecks(checks, selection, config, options);
  if (options.probe) {
    if (config.provider === "codex" && !codexInspection?.runnable) {
      checks.push({ name: "probe", status: "skipped", message: "Codex model probe skipped because the executable is not runnable." });
    } else {
      checks.push(await runProbe(config, options));
    }
  } else {
    checks.push({
      name: "probe",
      status: "skipped",
      message: "Model probe skipped. Pass --probe to send a minimal provider request."
    });
  }

  const connection = publicConnection(config, codexInspection);
  return {
    ok: checks.every((check) => check.status !== "error"),
    selection: {
      ...selection,
      ...(selection.model ? {} : config.model ? { model: config.model } : {})
    },
    effectiveProvider: config.provider,
    requestTimeoutMs: config.timeoutMs,
    connection,
    checks
  };
}

async function appendConnectionChecks(
  checks: ModelDoctorCheck[],
  selection: ModelSelection,
  config: ResolvedProviderConfig,
  options: ModelDoctorOptions
): Promise<CodexExecInspection | undefined> {
  if (config.provider === "stub") {
    if (selection.provider === "auto") {
      checks.push({
        name: "provider-api-key",
        status: "warning",
        message: "No commercial provider API key is set; provider=auto will use the local stub provider."
      });
    }
    return undefined;
  }

  if (config.provider === "codex") {
    if (!config.executablePath || !config.executableFound) {
      checks.push({
        name: "codex-exec",
        status: "error",
        message: "No Codex executable was found. Install Codex CLI or set CODEX_EXEC_PATH to an executable file."
      });
      return { runnable: false, message: "Codex executable was not found." };
    }
    const inspector = options.codexExecInspector ?? inspectCodexExec;
    const inspection = await inspector(config.executablePath, { timeoutMs: 5_000, environment: options.environment });
    checks.push({ name: "codex-exec", status: inspection.runnable ? "ok" : "error", message: inspection.message });
    checks.push({
      name: "codex-sandbox",
      status: "ok",
      message: "Codex requests use ephemeral sessions, stdin prompts, and the read-only sandbox."
    });
    checks.push({
      name: "codex-timeout",
      status: "ok",
      message: `Codex exec requests time out after ${config.timeoutMs}ms.`
    });
    return inspection;
  }

  if (!config.apiKey) {
    checks.push({
      name: `${config.provider}-api-key`,
      status: "error",
      message: `${config.apiKeyEnv} is required when provider=${config.provider}.`
    });
    return undefined;
  }

  checks.push({
    name: `${config.provider}-api-key`,
    status: "ok",
    message: `${config.apiKeyEnv} is available.`
  });
  checks.push({
    name: `${config.provider}-base-url`,
    status: "ok",
    message: `Using ${config.provider} endpoint at ${config.endpoint}.`
  });
  if (config.provider === "openai") {
    checks.push({
      name: "openai-api-protocol",
      status: "ok",
      message: `Using ${config.apiProtocol} endpoint at ${config.endpoint}.`
    });
  }
  checks.push({
    name: `${config.provider}-timeout`,
    status: "ok",
    message: `${capitalize(config.provider)} requests time out after ${config.timeoutMs}ms.`
  });
  return undefined;
}

async function runProbe(config: ResolvedProviderConfig, options: ModelDoctorOptions): Promise<ModelDoctorCheck> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const provider = createModelProvider({
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        apiProtocol: config.apiProtocol,
        timeoutMs: config.timeoutMs,
        cwd: config.cwd,
        codexExecPath: config.executablePath,
        codexExecRunner: options.codexExecRunner,
        environment: {}
      });
      const response = await provider.generate({
        mode: "auto",
        reasoningEffort: "low",
        maxOutputTokens: 16,
        messages: [{ role: "user", content: "Respond with the word ok." }]
      });
      return {
        name: "probe",
        status: response.content.trim() ? "ok" : "warning",
        message: `Probe completed with provider=${response.provider ?? provider.name}, model=${response.model ?? "unknown"}, attempts=${attempt}.`
      };
    } catch (error) {
      if (attempt === 1 && isTransientProviderNetworkError(error)) {
        continue;
      }
      return {
        name: "probe",
        status: "error",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
  throw new Error("Unreachable probe state.");
}

function publicConnection(config: ResolvedProviderConfig, codexInspection?: CodexExecInspection): ModelDoctorConnection {
  return {
    provider: config.provider,
    transport: config.provider === "stub" ? "stub" : config.provider === "codex" ? "local-exec" : "api",
    hasApiKey: Boolean(config.apiKey),
    ...(config.apiKeyEnv ? { apiKeyEnv: config.apiKeyEnv } : {}),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.apiProtocol ? { apiProtocol: config.apiProtocol } : {}),
    ...(config.model ? { model: config.model } : {}),
    timeoutMs: config.timeoutMs,
    optionalEnv: config.optionalEnv,
    ...(config.executablePath ? { executablePath: config.executablePath } : {}),
    ...(config.executableFound !== undefined ? { executableFound: config.executableFound } : {}),
    ...(config.executableSource ? { executableSource: config.executableSource } : {}),
    ...(codexInspection?.version ? { executableVersion: codexInspection.version } : {}),
    ...(config.serviceTier ? { serviceTier: config.serviceTier } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {})
  };
}

function providerHint(options: ModelDoctorOptions): ProviderName {
  if (options.requestedProvider && options.requestedProvider !== "auto") {
    return options.requestedProvider;
  }
  const manifestProvider = options.manifest?.models?.default_provider;
  if (
    manifestProvider === "stub" ||
    manifestProvider === "openai" ||
    manifestProvider === "anthropic" ||
    manifestProvider === "gemini" ||
    manifestProvider === "codex"
  ) {
    return manifestProvider;
  }
  return "auto";
}

function capitalize(value: string): string {
  return value === "openai" ? "OpenAI" : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

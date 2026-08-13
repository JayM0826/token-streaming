import type { ProductMode, RepoManifest } from "@token-streaming/protocol";
import { createModelProvider, resolveOpenAIApiProtocol, type OpenAIApiProtocol, type ProviderName } from "./factory.js";
import { resolveModelSelection, type ModelSelection } from "./model-policy.js";

export interface ModelDoctorOptions {
  mode: ProductMode;
  requestedProvider?: ProviderName;
  requestedModel?: string;
  manifest?: Pick<RepoManifest, "models">;
  apiKey?: string;
  baseUrl?: string;
  apiProtocol?: OpenAIApiProtocol;
  probe?: boolean;
}

export interface ModelDoctorResult {
  ok: boolean;
  selection: ModelSelection;
  effectiveProvider: "stub" | "openai";
  checks: ModelDoctorCheck[];
}

export interface ModelDoctorCheck {
  name: string;
  status: "ok" | "warning" | "error" | "skipped";
  message: string;
}

export async function diagnoseModelProvider(options: ModelDoctorOptions): Promise<ModelDoctorResult> {
  const selection = resolveModelSelection({
    mode: options.mode,
    requestedProvider: options.requestedProvider,
    requestedModel: options.requestedModel,
    manifest: options.manifest
  });
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL;
  const apiProtocol = resolveOpenAIApiProtocol(options.apiProtocol ?? process.env.OPENAI_API_PROTOCOL);
  const checks: ModelDoctorCheck[] = [];
  const effectiveProvider = resolveEffectiveProvider(selection.provider, apiKey);

  checks.push({
    name: "model-selection",
    status: "ok",
    message: `provider=${selection.provider}, model=${selection.model ?? "provider default"}, source=${selection.source}`
  });

  if (selection.provider === "openai" && !apiKey) {
    checks.push({
      name: "openai-api-key",
      status: "error",
      message: "OPENAI_API_KEY is required when provider=openai."
    });
  } else if (selection.provider === "auto" && !apiKey) {
    checks.push({
      name: "openai-api-key",
      status: "warning",
      message: "OPENAI_API_KEY is not set; provider=auto will use the local stub provider."
    });
  } else if (effectiveProvider === "openai") {
    checks.push({
      name: "openai-api-key",
      status: "ok",
      message: "OPENAI_API_KEY is available."
    });
    checks.push({
      name: "openai-base-url",
      status: "ok",
      message: baseUrl ? `Using custom OpenAI-compatible base URL: ${baseUrl}` : "Using default OpenAI base URL: https://api.openai.com/v1."
    });
    checks.push({
      name: "openai-api-protocol",
      status: "ok",
      message: `Using ${apiProtocol} endpoint at ${formatEndpoint(baseUrl, apiProtocol)}.`
    });
  }

  if (options.probe) {
    checks.push(await runProbe(selection, apiKey, baseUrl, apiProtocol));
  } else {
    checks.push({
      name: "probe",
      status: "skipped",
      message: "Network probe skipped. Pass --probe to send a minimal provider request."
    });
  }

  return {
    ok: checks.every((check) => check.status !== "error"),
    selection,
    effectiveProvider,
    checks
  };
}

async function runProbe(
  selection: ModelSelection,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  apiProtocol: OpenAIApiProtocol
): Promise<ModelDoctorCheck> {
  try {
    const provider = createModelProvider({
      provider: selection.provider,
      model: selection.model,
      apiKey,
      baseUrl,
      apiProtocol
    });
    const response = await provider.generate({
      mode: "auto",
      reasoningEffort: "low",
      maxOutputTokens: 16,
      messages: [
        {
          role: "user",
          content: "Respond with the word ok."
        }
      ]
    });
    return {
      name: "probe",
      status: response.content.trim() ? "ok" : "warning",
      message: `Probe completed with provider=${response.provider ?? provider.name}, model=${response.model ?? "unknown"}.`
    };
  } catch (error) {
    return {
      name: "probe",
      status: "error",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function formatEndpoint(baseUrl: string | undefined, protocol: OpenAIApiProtocol): string {
  const base = (baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return protocol === "responses" ? `${base}/responses` : `${base}/chat/completions`;
}

function resolveEffectiveProvider(provider: ProviderName, apiKey: string | undefined): "stub" | "openai" {
  if (provider === "openai") {
    return "openai";
  }
  if (provider === "auto" && apiKey) {
    return "openai";
  }
  return "stub";
}

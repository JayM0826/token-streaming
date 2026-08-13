import type { ProductMode, RepoManifest } from "@token-streaming/protocol";
import {
  createModelProvider,
  resolveOpenAIApiProtocol,
  resolveOpenAITimeoutMs,
  type OpenAIApiProtocol,
  type ProviderName
} from "./factory.js";
import { resolveModelSelection, type ModelSelection } from "./model-policy.js";
import { isTransientProviderNetworkError } from "./network-error.js";

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
}

export interface ModelDoctorResult {
  ok: boolean;
  selection: ModelSelection;
  effectiveProvider: "stub" | "openai";
  requestTimeoutMs: number;
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
    environmentModel: options.environmentModel ?? process.env.OPENAI_MODEL,
    manifest: options.manifest
  });
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL;
  const apiProtocol = resolveOpenAIApiProtocol(options.apiProtocol ?? process.env.OPENAI_API_PROTOCOL);
  const requestTimeoutMs = resolveOpenAITimeoutMs(options.timeoutMs);
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
    checks.push({
      name: "openai-timeout",
      status: "ok",
      message: `OpenAI-compatible requests time out after ${requestTimeoutMs}ms.`
    });
  }

  if (options.probe) {
    checks.push(await runProbe(selection, apiKey, baseUrl, apiProtocol, requestTimeoutMs));
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
    requestTimeoutMs,
    checks
  };
}

async function runProbe(
  selection: ModelSelection,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  apiProtocol: OpenAIApiProtocol,
  timeoutMs: number
): Promise<ModelDoctorCheck> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const provider = createModelProvider({
        provider: selection.provider,
        model: selection.model,
        apiKey,
        baseUrl,
        apiProtocol,
        timeoutMs
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

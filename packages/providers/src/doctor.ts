import type { ProductMode, RepoManifest } from "@token-streaming/protocol";
import { createModelProvider, type ProviderName } from "./factory.js";
import { resolveModelSelection, type ModelSelection } from "./model-policy.js";

export interface ModelDoctorOptions {
  mode: ProductMode;
  requestedProvider?: ProviderName;
  requestedModel?: string;
  manifest?: Pick<RepoManifest, "models">;
  apiKey?: string;
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
  }

  if (options.probe) {
    checks.push(await runProbe(selection, apiKey));
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

async function runProbe(selection: ModelSelection, apiKey: string | undefined): Promise<ModelDoctorCheck> {
  try {
    const provider = createModelProvider({
      provider: selection.provider,
      model: selection.model,
      apiKey
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

function resolveEffectiveProvider(provider: ProviderName, apiKey: string | undefined): "stub" | "openai" {
  if (provider === "openai") {
    return "openai";
  }
  if (provider === "auto" && apiKey) {
    return "openai";
  }
  return "stub";
}

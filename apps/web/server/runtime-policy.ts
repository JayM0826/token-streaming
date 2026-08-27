import { getRuntimeEnv } from "@/db";

export interface MarketplaceRuntimePolicy {
  platformFeeBps: number;
  welcomeCreditMicros: string;
  maximumInputCharacters: number;
  maximumGatewayResponseBytes: number;
  inferenceRequestsPerMinute: number;
  inferenceReservationTimeoutSeconds: number;
  standardOutputRetentionHours: number;
  standardArtifactRetentionHours: number;
  strictOutputRetentionMinutes: number;
  strictArtifactRetentionMinutes: number;
  maximumTenantArtifactBytes: number;
  maximumActiveArtifactTasksPerTenant: number;
  artifactLeaseMinutes: number;
  artifactMaximumExecutionMinutes: number;
  artifactQueueTimeoutMinutes: number;
  artifactMaximumAttempts: number;
}

export function getMarketplaceRuntimePolicy(): MarketplaceRuntimePolicy {
  return {
    platformFeeBps: integerSetting("MARKETPLACE_PLATFORM_FEE_BPS", 1200, 0, 5000),
    welcomeCreditMicros: decimalSetting("MARKETPLACE_WELCOME_CREDIT_MICROS", "100000000"),
    maximumInputCharacters: 40_000,
    maximumGatewayResponseBytes: 2_000_000,
    inferenceRequestsPerMinute: 5,
    inferenceReservationTimeoutSeconds: 120,
    standardOutputRetentionHours: 24,
    standardArtifactRetentionHours: 48,
    strictOutputRetentionMinutes: 60,
    strictArtifactRetentionMinutes: 60,
    maximumTenantArtifactBytes: 512 * 1024 * 1024,
    maximumActiveArtifactTasksPerTenant: 3,
    artifactLeaseMinutes: 5,
    artifactMaximumExecutionMinutes: 360,
    artifactQueueTimeoutMinutes: 30,
    artifactMaximumAttempts: 3
  };
}

function integerSetting(
  key: "MARKETPLACE_PLATFORM_FEE_BPS",
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = getRuntimeEnv()[key];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function decimalSetting(key: "MARKETPLACE_WELCOME_CREDIT_MICROS", fallback: string): string {
  const value = getRuntimeEnv()[key] ?? fallback;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) {
    throw new Error(`${key} must be a non-negative decimal integer.`);
  }
  return value;
}

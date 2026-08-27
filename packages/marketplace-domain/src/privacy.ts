import {
  MARKETPLACE_PRIVACY_MODES,
  type MarketplacePrivacyMode
} from "@token-streaming/protocol";
import { MarketplaceDomainError } from "./errors.js";

export interface MarketplacePrivacyRetentionPolicy {
  standardOutputRetentionHours: number;
  standardArtifactRetentionHours: number;
  strictOutputRetentionMinutes: number;
  strictArtifactRetentionMinutes: number;
}

export interface MarketplacePrivacyRetentionMilliseconds {
  output: number;
  artifact: number;
}

export function parseMarketplacePrivacyMode(value: unknown): MarketplacePrivacyMode {
  if (!(MARKETPLACE_PRIVACY_MODES as readonly unknown[]).includes(value)) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "privacyMode must be standard or strict.");
  }
  return value as MarketplacePrivacyMode;
}

export function assertSupplierProcessingAcknowledged(value: unknown): asserts value is true {
  if (value !== true) {
    throw new MarketplaceDomainError(
      "PRIVACY_ACKNOWLEDGEMENT_REQUIRED",
      "Customer acknowledgement is required before plaintext is sent to a supplier and its upstream provider."
    );
  }
}

export function calculateMarketplacePrivacyRetentionMilliseconds(
  modeInput: unknown,
  policy: MarketplacePrivacyRetentionPolicy
): MarketplacePrivacyRetentionMilliseconds {
  const mode = parseMarketplacePrivacyMode(modeInput);
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new MarketplaceDomainError("INVALID_ARGUMENT", `${name} must be a positive integer.`);
    }
  }
  return mode === "strict"
    ? {
        output: policy.strictOutputRetentionMinutes * 60_000,
        artifact: policy.strictArtifactRetentionMinutes * 60_000
      }
    : {
        output: policy.standardOutputRetentionHours * 60 * 60_000,
        artifact: policy.standardArtifactRetentionHours * 60 * 60_000
      };
}

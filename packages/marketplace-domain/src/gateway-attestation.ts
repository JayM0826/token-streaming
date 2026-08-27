import {
  SUPPLIER_GATEWAY_PROTOCOL_VERSION,
  type CapacityLimits,
  type SupplierGatewayAttestationResponse
} from "@token-streaming/protocol";
import { MarketplaceDomainError } from "./errors.js";
import {
  assertCapacityLimits,
  assertExactKeys,
  assertIdentifier,
  assertSafeInput,
  assertText,
  assertUniqueStrings
} from "./validation.js";

export interface SupplierGatewayAttestationExpectation {
  requestId: string;
  challenge: string;
  providerId: string;
  modelPattern: string;
  dataClasses: Array<"P0" | "P1">;
  limits: CapacityLimits;
}

export interface VerifiedSupplierGatewayAttestation {
  providerId: string;
  matchedModels: string[];
  dataClasses: Array<"P0" | "P1">;
  limits: CapacityLimits;
}

export function verifySupplierGatewayAttestation(
  expectation: SupplierGatewayAttestationExpectation,
  attestation: SupplierGatewayAttestationResponse
): VerifiedSupplierGatewayAttestation {
  assertSafeInput(expectation);
  assertExactKeys(expectation, "attestationExpectation", [
    "requestId",
    "challenge",
    "providerId",
    "modelPattern",
    "dataClasses",
    "limits"
  ]);
  assertIdentifier(expectation.requestId, "attestationExpectation.requestId");
  assertText(expectation.challenge, "attestationExpectation.challenge", 128);
  assertIdentifier(expectation.providerId, "attestationExpectation.providerId");
  assertText(expectation.modelPattern, "attestationExpectation.modelPattern", 120);
  if (expectation.modelPattern.includes("*") && !expectation.modelPattern.endsWith("*")) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "modelPattern wildcard must be terminal.");
  }
  assertUniqueStrings(expectation.dataClasses, "attestationExpectation.dataClasses", (value) => {
    if (value !== "P0" && value !== "P1") {
      throw new MarketplaceDomainError("UNSUPPORTED_DATA_CLASS", "Gateway attestation accepts only P0/P1.");
    }
  });
  assertCapacityLimits(expectation.limits, "attestationExpectation.limits");

  assertSafeInput(attestation);
  assertRemoteShape(attestation);
  const matchedModels = attestation.allowed_models.filter((model) => matchesPattern(model, expectation.modelPattern));
  const requestMatches = attestation.request_id === expectation.requestId;
  const challengeMatches = attestation.challenge === expectation.challenge;
  const providerMatches = attestation.provider_id === expectation.providerId;
  const dataClassesMatch = expectation.dataClasses.every((value) => attestation.allowed_data_classes.includes(value));
  const capacityMatches = withinLimits(expectation.limits, {
    requestsPerMinute: attestation.limits.requests_per_minute,
    tokensPerMinute: attestation.limits.tokens_per_minute,
    concurrency: attestation.limits.concurrency,
    maxOutputTokens: attestation.limits.max_output_tokens
  });

  if (
    attestation.status !== "ready" ||
    attestation.protocol_version !== SUPPLIER_GATEWAY_PROTOCOL_VERSION ||
    !requestMatches ||
    !challengeMatches ||
    !providerMatches ||
    matchedModels.length === 0 ||
    !dataClassesMatch ||
    !capacityMatches
  ) {
    throw mismatch({
      ready: attestation.status === "ready",
      protocolMatches: attestation.protocol_version === SUPPLIER_GATEWAY_PROTOCOL_VERSION,
      requestMatches,
      challengeMatches,
      providerMatches,
      modelMatches: matchedModels.length > 0,
      dataClassesMatch,
      capacityMatches
    });
  }

  return {
    providerId: attestation.provider_id,
    matchedModels,
    dataClasses: [...expectation.dataClasses],
    limits: { ...expectation.limits }
  };
}

function assertRemoteShape(value: SupplierGatewayAttestationResponse): void {
  try {
    assertExactKeys(value, "supplierGatewayAttestation", [
      "status",
      "protocol_version",
      "provider_id",
      "allowed_models",
      "allowed_data_classes",
      "limits",
      "request_id",
      "challenge"
    ]);
    assertIdentifier(value.request_id, "supplierGatewayAttestation.request_id");
    assertText(value.challenge, "supplierGatewayAttestation.challenge", 128);
    assertIdentifier(value.provider_id, "supplierGatewayAttestation.provider_id");
    assertUniqueStrings(value.allowed_models, "supplierGatewayAttestation.allowed_models", (model) => {
      assertText(model, "supplierGatewayAttestation.allowed_model", 120);
      if (model.includes("*")) throw new Error("Attested model names must be exact.");
    });
    assertUniqueStrings(value.allowed_data_classes, "supplierGatewayAttestation.allowed_data_classes", (dataClass) => {
      if (dataClass !== "P0" && dataClass !== "P1") throw new Error("Unsupported attested data class.");
    });
    assertExactKeys(value.limits, "supplierGatewayAttestation.limits", [
      "requests_per_minute",
      "tokens_per_minute",
      "concurrency",
      "max_output_tokens"
    ]);
    assertCapacityLimits(
      {
        requestsPerMinute: value.limits.requests_per_minute,
        tokensPerMinute: value.limits.tokens_per_minute,
        concurrency: value.limits.concurrency,
        maxOutputTokens: value.limits.max_output_tokens
      },
      "supplierGatewayAttestation.normalizedLimits"
    );
  } catch {
    throw mismatch({ remoteShapeValid: false });
  }
}

function withinLimits(requested: CapacityLimits, available: CapacityLimits): boolean {
  return (
    requested.requestsPerMinute <= available.requestsPerMinute &&
    requested.tokensPerMinute <= available.tokensPerMinute &&
    requested.concurrency <= available.concurrency &&
    requested.maxOutputTokens <= available.maxOutputTokens
  );
}

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

function mismatch(details: Readonly<Record<string, unknown>>): MarketplaceDomainError {
  return new MarketplaceDomainError(
    "GATEWAY_ATTESTATION_MISMATCH",
    "Supplier gateway attestation does not match the authorization claim.",
    details
  );
}

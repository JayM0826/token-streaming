import assert from "node:assert/strict";
import test from "node:test";
import {
  MarketplaceDomainError,
  verifySupplierGatewayAttestation
} from "../dist/index.js";

test("signed gateway attestation fits an authorization claim", () => {
  const verified = verifySupplierGatewayAttestation(expectation(), attestation());
  assert.deepEqual(verified, {
    providerId: "provider-test",
    matchedModels: ["model-family-pro", "model-family-mini"],
    dataClasses: ["P0", "P1"],
    limits: {
      requestsPerMinute: 30,
      tokensPerMinute: 100_000,
      concurrency: 2,
      maxOutputTokens: 4_096
    }
  });
});

test("gateway attestation rejects request, challenge, provider, and model mismatches", () => {
  for (const overrides of [
    { request_id: "attestation-other-request" },
    { challenge: "different-challenge-value-123456" },
    { provider_id: "provider-other" },
    { allowed_models: ["unrelated-model"] },
    { status: "draining" },
    { protocol_version: "gongsuanyun.gateway.v1" }
  ]) {
    assertAttestationMismatch(() => verifySupplierGatewayAttestation(expectation(), attestation(overrides)));
  }
});

test("gateway attestation rejects narrower data and capacity than requested", () => {
  assertAttestationMismatch(() =>
    verifySupplierGatewayAttestation(expectation(), attestation({ allowed_data_classes: ["P0"] }))
  );
  for (const [field, value] of [
    ["requests_per_minute", 29],
    ["tokens_per_minute", 99_999],
    ["concurrency", 1],
    ["max_output_tokens", 4_095]
  ]) {
    assertAttestationMismatch(() =>
      verifySupplierGatewayAttestation(
        expectation(),
        attestation({ limits: { ...attestation().limits, [field]: value } })
      )
    );
  }
});

test("gateway attestation rejects malformed or wildcard node inventory", () => {
  assertAttestationMismatch(() => verifySupplierGatewayAttestation(expectation(), null));
  assertAttestationMismatch(() =>
    verifySupplierGatewayAttestation(expectation(), attestation({ allowed_models: ["model-family-*"] }))
  );
  assertAttestationMismatch(() =>
    verifySupplierGatewayAttestation(expectation(), { ...attestation(), unexpected: true })
  );
});

function expectation() {
  return {
    requestId: "attestation-request-123456",
    challenge: "challenge-value-abcdefghijklmnopqrstuvwxyz",
    providerId: "provider-test",
    modelPattern: "model-family-*",
    dataClasses: ["P0", "P1"],
    limits: {
      requestsPerMinute: 30,
      tokensPerMinute: 100_000,
      concurrency: 2,
      maxOutputTokens: 4_096
    }
  };
}

function attestation(overrides = {}) {
  return {
    status: "ready",
    protocol_version: "gongsuanyun.gateway.v3",
    request_id: "attestation-request-123456",
    challenge: "challenge-value-abcdefghijklmnopqrstuvwxyz",
    provider_id: "provider-test",
    allowed_models: ["model-family-pro", "model-family-mini", "other-model"],
    allowed_data_classes: ["P0", "P1"],
    limits: {
      requests_per_minute: 60,
      tokens_per_minute: 200_000,
      concurrency: 4,
      max_output_tokens: 8_192
    },
    ...overrides
  };
}

function assertAttestationMismatch(operation) {
  assert.throws(
    operation,
    (error) => error instanceof MarketplaceDomainError && error.code === "GATEWAY_ATTESTATION_MISMATCH"
  );
}

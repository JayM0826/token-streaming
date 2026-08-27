import assert from "node:assert/strict";
import test from "node:test";
import {
  MarketplaceDomainError,
  verifySupplierExecutionEvidence
} from "../dist/index.js";

test("execution evidence matches the purchased provider, exact model, content, and usage", () => {
  assert.deepEqual(verifySupplierExecutionEvidence(expectation(), evidence()), {
    providerId: "provider-test",
    requestedModel: "model-a-2026-08-01",
    servedModel: "model-a-2026-08-01",
    providerRequestId: "provider-request-123",
    inputSha256: "a".repeat(64),
    outputSha256: "b".repeat(64),
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    completedAt: "2026-08-25T04:00:30.000Z",
    receiptRef: "receipt-123"
  });
});

test("execution evidence rejects service substitution and digest or usage tampering", () => {
  for (const overrides of [
    { provider_id: "provider-other" },
    { requested_model: "model-b" },
    { served_model: "model-cheap" },
    { input_sha256: "c".repeat(64) },
    { output_sha256: "d".repeat(64) },
    { usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } },
    { request_id: "job-other-123456" },
    { completed_at: "2026-08-25T05:00:00.000Z" }
  ]) {
    assertEvidenceMismatch(() => verifySupplierExecutionEvidence(expectation(), evidence(overrides)));
  }
});

test("execution evidence rejects malformed or extended payloads", () => {
  assertEvidenceMismatch(() => verifySupplierExecutionEvidence(expectation(), null));
  assertEvidenceMismatch(() => verifySupplierExecutionEvidence(expectation(), { ...evidence(), extra: true }));
  assertEvidenceMismatch(() => verifySupplierExecutionEvidence(expectation(), evidence({ provider_request_id: "" })));
});

function expectation() {
  return {
    requestId: "job-request-123456",
    providerId: "provider-test",
    requestedModel: "model-a-2026-08-01",
    inputSha256: "a".repeat(64),
    outputSha256: "b".repeat(64),
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    requestStartedAt: "2026-08-25T04:00:00.000Z",
    verifiedAt: "2026-08-25T04:01:00.000Z"
  };
}

function evidence(overrides = {}) {
  return {
    evidence_version: "gongsuanyun.execution-evidence.v1",
    request_id: "job-request-123456",
    provider_id: "provider-test",
    requested_model: "model-a-2026-08-01",
    served_model: "model-a-2026-08-01",
    provider_request_id: "provider-request-123",
    input_sha256: "a".repeat(64),
    output_sha256: "b".repeat(64),
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    completed_at: "2026-08-25T04:00:30.000Z",
    receipt_ref: "receipt-123",
    ...overrides
  };
}

function assertEvidenceMismatch(operation) {
  assert.throws(
    operation,
    (error) => error instanceof MarketplaceDomainError && error.code === "SERVICE_EVIDENCE_MISMATCH"
  );
}

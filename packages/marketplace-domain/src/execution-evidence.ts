import {
  SUPPLIER_GATEWAY_EXECUTION_EVIDENCE_VERSION,
  type SupplierGatewayExecutionEvidence,
  type SupplierGatewayUsage
} from "@token-streaming/protocol";
import { MarketplaceDomainError } from "./errors.js";
import {
  assertExactKeys,
  assertIdentifier,
  assertSafeInput,
  assertText,
  assertTimestamp
} from "./validation.js";

export interface SupplierExecutionEvidenceExpectation {
  requestId: string;
  providerId: string;
  requestedModel: string;
  inputSha256: string;
  outputSha256: string;
  usage: SupplierGatewayUsage;
  requestStartedAt: string;
  verifiedAt: string;
}

export interface VerifiedSupplierExecutionEvidence {
  providerId: string;
  requestedModel: string;
  servedModel: string;
  providerRequestId: string;
  inputSha256: string;
  outputSha256: string;
  usage: SupplierGatewayUsage;
  completedAt: string;
  receiptRef: string | null;
}

export function verifySupplierExecutionEvidence(
  expectation: SupplierExecutionEvidenceExpectation,
  evidence: SupplierGatewayExecutionEvidence
): VerifiedSupplierExecutionEvidence {
  validateExpectation(expectation);
  validateEvidenceShape(evidence);

  const completedAt = assertTimestamp(evidence.completed_at, "executionEvidence.completed_at");
  const requestStartedAt = assertTimestamp(expectation.requestStartedAt, "executionEvidenceExpectation.requestStartedAt");
  const verifiedAt = assertTimestamp(expectation.verifiedAt, "executionEvidenceExpectation.verifiedAt");
  const withinClockWindow = completedAt >= requestStartedAt - 5 * 60_000 && completedAt <= verifiedAt + 5 * 60_000;
  const usageMatches = sameUsage(evidence.usage, expectation.usage);

  if (
    evidence.evidence_version !== SUPPLIER_GATEWAY_EXECUTION_EVIDENCE_VERSION ||
    evidence.request_id !== expectation.requestId ||
    evidence.provider_id !== expectation.providerId ||
    evidence.requested_model !== expectation.requestedModel ||
    evidence.served_model !== expectation.requestedModel ||
    evidence.input_sha256 !== expectation.inputSha256 ||
    evidence.output_sha256 !== expectation.outputSha256 ||
    !usageMatches ||
    !withinClockWindow
  ) {
    throw mismatch({
      versionMatches: evidence.evidence_version === SUPPLIER_GATEWAY_EXECUTION_EVIDENCE_VERSION,
      requestMatches: evidence.request_id === expectation.requestId,
      providerMatches: evidence.provider_id === expectation.providerId,
      requestedModelMatches: evidence.requested_model === expectation.requestedModel,
      servedModelMatches: evidence.served_model === expectation.requestedModel,
      inputDigestMatches: evidence.input_sha256 === expectation.inputSha256,
      outputDigestMatches: evidence.output_sha256 === expectation.outputSha256,
      usageMatches,
      withinClockWindow
    });
  }

  return {
    providerId: evidence.provider_id,
    requestedModel: evidence.requested_model,
    servedModel: evidence.served_model,
    providerRequestId: evidence.provider_request_id,
    inputSha256: evidence.input_sha256,
    outputSha256: evidence.output_sha256,
    usage: { ...evidence.usage },
    completedAt: evidence.completed_at,
    receiptRef: evidence.receipt_ref ?? null
  };
}

function validateExpectation(expectation: SupplierExecutionEvidenceExpectation): void {
  assertSafeInput(expectation);
  assertExactKeys(expectation, "executionEvidenceExpectation", [
    "requestId",
    "providerId",
    "requestedModel",
    "inputSha256",
    "outputSha256",
    "usage",
    "requestStartedAt",
    "verifiedAt"
  ]);
  assertIdentifier(expectation.requestId, "executionEvidenceExpectation.requestId");
  assertIdentifier(expectation.providerId, "executionEvidenceExpectation.providerId");
  assertText(expectation.requestedModel, "executionEvidenceExpectation.requestedModel", 200);
  assertSha256(expectation.inputSha256, "executionEvidenceExpectation.inputSha256");
  assertSha256(expectation.outputSha256, "executionEvidenceExpectation.outputSha256");
  validateUsage(expectation.usage, "executionEvidenceExpectation.usage");
}

function validateEvidenceShape(evidence: SupplierGatewayExecutionEvidence): void {
  try {
    assertSafeInput(evidence);
    assertExactKeys(evidence, "executionEvidence", [
      "evidence_version",
      "request_id",
      "provider_id",
      "requested_model",
      "served_model",
      "provider_request_id",
      "input_sha256",
      "output_sha256",
      "usage",
      "completed_at",
      "receipt_ref"
    ]);
    assertIdentifier(evidence.request_id, "executionEvidence.request_id");
    assertIdentifier(evidence.provider_id, "executionEvidence.provider_id");
    assertText(evidence.requested_model, "executionEvidence.requested_model", 200);
    assertText(evidence.served_model, "executionEvidence.served_model", 200);
    assertText(evidence.provider_request_id, "executionEvidence.provider_request_id", 256);
    assertSha256(evidence.input_sha256, "executionEvidence.input_sha256");
    assertSha256(evidence.output_sha256, "executionEvidence.output_sha256");
    validateUsage(evidence.usage, "executionEvidence.usage");
    if (evidence.receipt_ref !== undefined) {
      assertText(evidence.receipt_ref, "executionEvidence.receipt_ref", 256);
    }
  } catch {
    throw mismatch({ remoteShapeValid: false });
  }
}

function validateUsage(value: SupplierGatewayUsage, label: string): void {
  assertExactKeys(value, label, ["input_tokens", "output_tokens", "total_tokens"]);
  if (
    !Number.isSafeInteger(value.input_tokens) || value.input_tokens < 1 ||
    !Number.isSafeInteger(value.output_tokens) || value.output_tokens < 0 ||
    !Number.isSafeInteger(value.total_tokens) || value.total_tokens !== value.input_tokens + value.output_tokens
  ) {
    throw mismatch({ usageValid: false });
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw mismatch({ invalidDigest: label });
  }
}

function sameUsage(left: SupplierGatewayUsage, right: SupplierGatewayUsage): boolean {
  return left.input_tokens === right.input_tokens &&
    left.output_tokens === right.output_tokens &&
    left.total_tokens === right.total_tokens;
}

function mismatch(details: Readonly<Record<string, unknown>>): MarketplaceDomainError {
  return new MarketplaceDomainError(
    "SERVICE_EVIDENCE_MISMATCH",
    "Supplier execution evidence does not match the purchased service.",
    details
  );
}

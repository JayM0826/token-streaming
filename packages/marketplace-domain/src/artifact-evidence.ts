import {
  SUPPLIER_ARTIFACT_EXECUTION_EVIDENCE_VERSION,
  type SupplierArtifactExecutionEvidence,
  type SupplierGatewayUsage
} from "@token-streaming/protocol";
import { MarketplaceDomainError } from "./errors.js";
import { assertExactKeys, assertIdentifier, assertSafeInput, assertText, assertTimestamp } from "./validation.js";

export interface SupplierArtifactEvidenceExpectation {
  taskId: string;
  providerId: string;
  requestedModel: string;
  artifactId: string;
  artifactManifestSha256: string;
  outputSha256: string;
  usage: SupplierGatewayUsage;
  requestStartedAt: string;
  verifiedAt: string;
}

export interface VerifiedSupplierArtifactEvidence {
  providerId: string;
  requestedModel: string;
  servedModel: string;
  artifactId: string;
  artifactManifestSha256: string;
  artifactContentSha256: string;
  outputSha256: string;
  providerRequestIdsSha256: string;
  segmentsCompleted: number;
  usage: SupplierGatewayUsage;
  completedAt: string;
}

export function verifySupplierArtifactEvidence(
  expectation: SupplierArtifactEvidenceExpectation,
  evidence: SupplierArtifactExecutionEvidence
): VerifiedSupplierArtifactEvidence {
  validateExpectation(expectation);
  validateEvidence(evidence);
  const completedAt = assertTimestamp(evidence.completed_at, "artifactEvidence.completed_at");
  const startedAt = assertTimestamp(expectation.requestStartedAt, "artifactExpectation.requestStartedAt");
  const verifiedAt = assertTimestamp(expectation.verifiedAt, "artifactExpectation.verifiedAt");
  const withinClockWindow = completedAt >= startedAt - 5 * 60_000 && completedAt <= verifiedAt + 5 * 60_000;
  if (
    evidence.evidence_version !== SUPPLIER_ARTIFACT_EXECUTION_EVIDENCE_VERSION ||
    evidence.task_id !== expectation.taskId ||
    evidence.provider_id !== expectation.providerId ||
    evidence.requested_model !== expectation.requestedModel ||
    evidence.served_model !== expectation.requestedModel ||
    evidence.artifact_id !== expectation.artifactId ||
    evidence.artifact_manifest_sha256 !== expectation.artifactManifestSha256 ||
    evidence.output_sha256 !== expectation.outputSha256 ||
    !sameUsage(evidence.usage, expectation.usage) ||
    !withinClockWindow
  ) {
    throw mismatch();
  }
  return {
    providerId: evidence.provider_id,
    requestedModel: evidence.requested_model,
    servedModel: evidence.served_model,
    artifactId: evidence.artifact_id,
    artifactManifestSha256: evidence.artifact_manifest_sha256,
    artifactContentSha256: evidence.artifact_content_sha256,
    outputSha256: evidence.output_sha256,
    providerRequestIdsSha256: evidence.provider_request_ids_sha256,
    segmentsCompleted: evidence.segments_completed,
    usage: { ...evidence.usage },
    completedAt: evidence.completed_at
  };
}

function validateExpectation(value: SupplierArtifactEvidenceExpectation): void {
  assertSafeInput(value);
  assertExactKeys(value, "artifactExpectation", [
    "taskId", "providerId", "requestedModel", "artifactId", "artifactManifestSha256",
    "outputSha256", "usage", "requestStartedAt", "verifiedAt"
  ]);
  assertIdentifier(value.taskId, "artifactExpectation.taskId");
  assertIdentifier(value.providerId, "artifactExpectation.providerId");
  assertIdentifier(value.artifactId, "artifactExpectation.artifactId");
  assertText(value.requestedModel, "artifactExpectation.requestedModel", 200);
  assertSha256(value.artifactManifestSha256);
  assertSha256(value.outputSha256);
  validateUsage(value.usage);
}

function validateEvidence(value: SupplierArtifactExecutionEvidence): void {
  try {
    assertSafeInput(value);
    assertExactKeys(value, "artifactEvidence", [
      "evidence_version", "task_id", "provider_id", "requested_model", "served_model",
      "artifact_id", "artifact_manifest_sha256", "artifact_content_sha256", "output_sha256",
      "provider_request_ids_sha256", "segments_completed", "usage", "completed_at"
    ]);
    assertIdentifier(value.task_id, "artifactEvidence.task_id");
    assertIdentifier(value.provider_id, "artifactEvidence.provider_id");
    assertIdentifier(value.artifact_id, "artifactEvidence.artifact_id");
    assertText(value.requested_model, "artifactEvidence.requested_model", 200);
    assertText(value.served_model, "artifactEvidence.served_model", 200);
    assertSha256(value.artifact_manifest_sha256);
    assertSha256(value.artifact_content_sha256);
    assertSha256(value.output_sha256);
    assertSha256(value.provider_request_ids_sha256);
    if (!Number.isSafeInteger(value.segments_completed) || value.segments_completed < 1 || value.segments_completed > 100_000) {
      throw mismatch();
    }
    validateUsage(value.usage);
  } catch {
    throw mismatch();
  }
}

function validateUsage(value: SupplierGatewayUsage): void {
  assertExactKeys(value, "artifactEvidence.usage", ["input_tokens", "output_tokens", "total_tokens"]);
  if (
    !Number.isSafeInteger(value.input_tokens) || value.input_tokens < 1 ||
    !Number.isSafeInteger(value.output_tokens) || value.output_tokens < 0 ||
    !Number.isSafeInteger(value.total_tokens) || value.total_tokens !== value.input_tokens + value.output_tokens
  ) throw mismatch();
}

function assertSha256(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw mismatch();
}

function sameUsage(left: SupplierGatewayUsage, right: SupplierGatewayUsage): boolean {
  return left.input_tokens === right.input_tokens &&
    left.output_tokens === right.output_tokens &&
    left.total_tokens === right.total_tokens;
}

function mismatch(): MarketplaceDomainError {
  return new MarketplaceDomainError(
    "SERVICE_EVIDENCE_MISMATCH",
    "Supplier artifact execution evidence does not match the purchased task."
  );
}

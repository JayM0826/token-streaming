import assert from "node:assert/strict";
import test from "node:test";

import {
  MarketplaceDomainError,
  verifySupplierArtifactEvidence
} from "../dist/index.js";

const usage = { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 };

function expectation(overrides = {}) {
  return {
    taskId: "artifact-task-test-12345678",
    providerId: "provider-authorized",
    requestedModel: "model-exact-2026-08-26",
    artifactId: "artifact-test-12345678",
    artifactManifestSha256: "a".repeat(64),
    outputSha256: "b".repeat(64),
    usage,
    requestStartedAt: "2026-08-26T00:00:00.000Z",
    verifiedAt: "2026-08-26T00:10:00.000Z",
    ...overrides
  };
}

function evidence(overrides = {}) {
  return {
    evidence_version: "gongsuanyun.artifact-evidence.v1",
    task_id: "artifact-task-test-12345678",
    provider_id: "provider-authorized",
    requested_model: "model-exact-2026-08-26",
    served_model: "model-exact-2026-08-26",
    artifact_id: "artifact-test-12345678",
    artifact_manifest_sha256: "a".repeat(64),
    artifact_content_sha256: "c".repeat(64),
    output_sha256: "b".repeat(64),
    provider_request_ids_sha256: "d".repeat(64),
    segments_completed: 4,
    usage,
    completed_at: "2026-08-26T00:09:30.000Z",
    ...overrides
  };
}

test("artifact evidence binds exact provider, model, artifact, output, usage, and completion window", () => {
  const verified = verifySupplierArtifactEvidence(expectation(), evidence());
  assert.equal(verified.servedModel, "model-exact-2026-08-26");
  assert.equal(verified.artifactContentSha256, "c".repeat(64));
  assert.deepEqual(verified.usage, usage);
});

test("artifact evidence rejects cheaper-model substitution and altered usage or content", () => {
  for (const altered of [
    evidence({ served_model: "model-cheaper" }),
    evidence({ provider_id: "provider-other" }),
    evidence({ artifact_manifest_sha256: "e".repeat(64) }),
    evidence({ output_sha256: "f".repeat(64) }),
    evidence({ usage: { input_tokens: 1201, output_tokens: 300, total_tokens: 1501 } }),
    evidence({ completed_at: "2026-08-26T01:00:00.000Z" })
  ]) {
    assert.throws(
      () => verifySupplierArtifactEvidence(expectation(), altered),
      (error) => error instanceof MarketplaceDomainError && error.code === "SERVICE_EVIDENCE_MISMATCH"
    );
  }
});

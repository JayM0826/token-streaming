import assert from "node:assert/strict";
import test from "node:test";

import {
  MarketplaceDomainError,
  decideArtifactTaskCancellation,
  projectArtifactTaskStatus
} from "../dist/index.js";

test("queued cancellation is immediate and releases its reservation", () => {
  assert.deepEqual(decideArtifactTaskCancellation({ status: "queued", privacyMode: "standard" }), {
    publicStatus: "cancelled",
    persistedStatus: "cancelled",
    releaseReservation: true,
    artifactRetention: "retained"
  });
});

test("leased cancellation is two-phase and keeps its reservation", () => {
  for (const status of ["claimed", "running"]) {
    assert.deepEqual(decideArtifactTaskCancellation({ status, privacyMode: "strict" }), {
      publicStatus: "cancelling",
      persistedStatus: status,
      releaseReservation: false,
      artifactRetention: "purge-scheduled"
    });
  }
});

test("replayed cancellation stays idempotently cancelled", () => {
  assert.deepEqual(decideArtifactTaskCancellation({ status: "cancelled", privacyMode: "strict" }), {
    publicStatus: "cancelled",
    persistedStatus: "cancelled",
    releaseReservation: true,
    artifactRetention: "purge-scheduled"
  });
});

test("completed and failed tasks reject cancellation", () => {
  for (const status of ["completed", "failed"]) {
    assert.throws(
      () => decideArtifactTaskCancellation({ status, privacyMode: "standard" }),
      (error) => error instanceof MarketplaceDomainError && error.code === "INVALID_ARTIFACT_TASK_STATE"
    );
  }
});

test("public projection exposes cancelling only for leased work with a request marker", () => {
  assert.equal(projectArtifactTaskStatus({ status: "running", cancellationRequested: true }), "cancelling");
  assert.equal(projectArtifactTaskStatus({ status: "claimed", cancellationRequested: false }), "claimed");
  assert.equal(projectArtifactTaskStatus({ status: "cancelled", cancellationRequested: true }), "cancelled");
});

import type { ArtifactTaskStatus, MarketplacePrivacyMode } from "@token-streaming/protocol";

import { MarketplaceDomainError } from "./errors.js";

export type PersistedArtifactTaskStatus = Exclude<ArtifactTaskStatus, "cancelling">;

export interface ArtifactTaskCancellationDecision {
  publicStatus: Extract<ArtifactTaskStatus, "cancelling" | "cancelled">;
  persistedStatus: PersistedArtifactTaskStatus;
  releaseReservation: boolean;
  artifactRetention: "retained" | "purge-scheduled";
}

export function projectArtifactTaskStatus(input: {
  status: PersistedArtifactTaskStatus;
  cancellationRequested: boolean;
}): ArtifactTaskStatus {
  return input.cancellationRequested && (input.status === "claimed" || input.status === "running")
    ? "cancelling"
    : input.status;
}

/**
 * Defines the provider-neutral two-phase cancellation contract. Queued work can
 * release its reservation immediately. Leased work keeps both its persisted
 * running state and reservation until the lease holder observes cancellation or
 * the lease expires, preventing cancellation from racing a billable completion.
 */
export function decideArtifactTaskCancellation(input: {
  status: PersistedArtifactTaskStatus;
  privacyMode: MarketplacePrivacyMode;
}): ArtifactTaskCancellationDecision {
  const artifactRetention = input.privacyMode === "strict" ? "purge-scheduled" : "retained";
  switch (input.status) {
    case "queued":
      return {
        publicStatus: "cancelled",
        persistedStatus: "cancelled",
        releaseReservation: true,
        artifactRetention
      };
    case "claimed":
    case "running":
      return {
        publicStatus: "cancelling",
        persistedStatus: input.status,
        releaseReservation: false,
        artifactRetention
      };
    case "cancelled":
      return {
        publicStatus: "cancelled",
        persistedStatus: "cancelled",
        releaseReservation: true,
        artifactRetention
      };
    case "completed":
    case "failed":
      throw new MarketplaceDomainError(
        "INVALID_ARTIFACT_TASK_STATE",
        "A terminal artifact task cannot be cancelled.",
        { status: input.status }
      );
  }
}

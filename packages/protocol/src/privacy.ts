export const MARKETPLACE_PRIVACY_MODES = ["standard", "strict"] as const;

export type MarketplacePrivacyMode = typeof MARKETPLACE_PRIVACY_MODES[number];

export interface MarketplacePrivacySummary {
  supplierReceivesPlaintext: true;
  providerReceivesPlaintext: true;
  promptBodyPersisted: false;
  contentDigestsKeyed: true;
  loginProfileCopiedToMarketplace: false;
  standardOutputRetentionHours: number;
  standardArtifactRetentionHours: number;
  strictOutputRetentionMinutes: number;
  strictArtifactRetentionMinutes: number;
  activeContentCanBePurged: true;
}

export type PurgeableMarketplaceResource = "inference-job" | "artifact" | "artifact-task";

export interface PurgeMarketplaceContentRequest {
  resourceType: PurgeableMarketplaceResource;
  resourceId: string;
}

export interface PurgeMarketplaceContentResponse {
  ok: true;
  requestId: string;
  resourceType: PurgeableMarketplaceResource;
  resourceId: string;
  purgedAt: string;
}

export const MARKETPLACE_SCHEMA_VERSION = 1 as const;

export type SupplierKind = "individual" | "organization";

export type SupplierStatus = "pending-verification" | "active" | "suspended" | "rejected";

export type SupplierVerificationKind = "identity" | "business" | "beneficial-ownership" | "tax" | "payout";

export type SupplierVerificationStatus = "verified" | "rejected";

export interface SupplierRegistrationInput {
  supplierId: string;
  kind: SupplierKind;
  legalName: string;
  displayName: string;
  countryCode: string;
  taxResidenceCountryCode: string;
}

export interface SupplierVerificationInput {
  verificationId: string;
  kind: SupplierVerificationKind;
  status: SupplierVerificationStatus;
  evidenceRef: string;
  completedAt: string;
  expiresAt?: string;
}

export interface SupplierVerification extends SupplierVerificationInput {}

export type CapacitySourceType = "api-project" | "commercial-account" | "subscription-plan" | "self-hosted-license";

export type CapacityAuthorizedUse = "managed-inference" | "inference-resale";

export type CapacityMeteringMode = "provider-report" | "signed-receipt" | "dedicated-counter";

export type ProviderAuthorizationStatus = "pending" | "active" | "suspended" | "revoked";

export type MarketplaceDataClass = "P0" | "P1" | "P2" | "P3";

export interface CapacityLimits {
  requestsPerMinute: number;
  tokensPerMinute: number;
  concurrency: number;
  maxOutputTokens: number;
}

export interface ProviderAuthorizationInput {
  authorizationId: string;
  providerId: string;
  sourceType: CapacitySourceType;
  authorizedUse: CapacityAuthorizedUse;
  meteringMode: CapacityMeteringMode;
  evidenceRef: string;
  modelPatterns: string[];
  regionCodes: string[];
  allowedDataClasses: MarketplaceDataClass[];
  capacityCeiling: CapacityLimits;
  validFrom: string;
  validUntil: string;
  status: Exclude<ProviderAuthorizationStatus, "revoked">;
}

export type ProviderAuthorization = Omit<ProviderAuthorizationInput, "status"> & {
  status: ProviderAuthorizationStatus;
};

export interface MarketplaceCommandContext {
  tenantId: string;
  actorId: string;
  commandId: string;
  eventId: string;
  occurredAt: string;
}

export interface MarketplaceEventEnvelope<
  TType extends string,
  TAggregateType extends "supplier" | "capacity-offer",
  TPayload
> {
  schemaVersion: typeof MARKETPLACE_SCHEMA_VERSION;
  eventId: string;
  tenantId: string;
  actorId: string;
  causationId: string;
  aggregateType: TAggregateType;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  type: TType;
  payload: TPayload;
}

export type SupplierRegisteredEvent = MarketplaceEventEnvelope<
  "supplier.registered",
  "supplier",
  SupplierRegistrationInput
>;

export type SupplierVerificationRecordedEvent = MarketplaceEventEnvelope<
  "supplier.verification-recorded",
  "supplier",
  SupplierVerificationInput
>;

export type ProviderAuthorizationRecordedEvent = MarketplaceEventEnvelope<
  "supplier.provider-authorization-recorded",
  "supplier",
  ProviderAuthorizationInput
>;

export type ProviderAuthorizationRevokedEvent = MarketplaceEventEnvelope<
  "supplier.provider-authorization-revoked",
  "supplier",
  { authorizationId: string; reasonCode: string }
>;

export type SupplierActivatedEvent = MarketplaceEventEnvelope<
  "supplier.activated",
  "supplier",
  { activatedAt: string }
>;

export type SupplierSuspendedEvent = MarketplaceEventEnvelope<
  "supplier.suspended",
  "supplier",
  { reasonCode: string }
>;

export type SupplierEvent =
  | SupplierRegisteredEvent
  | SupplierVerificationRecordedEvent
  | ProviderAuthorizationRecordedEvent
  | ProviderAuthorizationRevokedEvent
  | SupplierActivatedEvent
  | SupplierSuspendedEvent;

export interface SupplierState {
  supplierId: string;
  tenantId: string;
  kind: SupplierKind;
  legalName: string;
  displayName: string;
  countryCode: string;
  taxResidenceCountryCode: string;
  status: SupplierStatus;
  verifications: SupplierVerification[];
  authorizations: ProviderAuthorization[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CapacityRateComponent {
  unit: string;
  amountMicros: string;
}

export interface CapacityOfferInput {
  offerId: string;
  authorizationId: string;
  providerId: string;
  model: string;
  serviceTier?: string;
  regionCode: string;
  dataClasses: MarketplaceDataClass[];
  limits: CapacityLimits;
  currency: string;
  rates: CapacityRateComponent[];
  validFrom: string;
  validUntil: string;
}

export interface CapacityOfferPublishedPayload extends CapacityOfferInput {
  supplierId: string;
  sourceType: CapacitySourceType;
}

export type CapacityOfferPublishedEvent = MarketplaceEventEnvelope<
  "capacity-offer.published",
  "capacity-offer",
  CapacityOfferPublishedPayload
>;

export type CapacityOfferEvent = CapacityOfferPublishedEvent;

export interface CapacityOfferState extends CapacityOfferPublishedPayload {
  tenantId: string;
  status: "active";
  version: number;
  publishedAt: string;
}

export type MarketplaceEvent = SupplierEvent | CapacityOfferEvent;

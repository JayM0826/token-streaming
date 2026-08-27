import type {
  CapacityLimits,
  CapacitySourceType,
  MarketplaceDataClass,
  SupplierKind,
  SupplierStatus
} from "./marketplace.js";
import type { ArtifactTaskView, ArtifactView } from "./artifact-task.js";
import type { MarketplacePrivacyMode, MarketplacePrivacySummary } from "./privacy.js";

export const MARKETPLACE_API_VERSION = "v1" as const;

export type MarketplaceApiErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "ADMIN_REQUIRED"
  | "REVIEWER_CONFLICT"
  | "INVALID_REQUEST"
  | "CSRF_REJECTED"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "SUPPLIER_REQUIRED"
  | "SUPPLIER_NOT_ACTIVE"
  | "AUTHORIZATION_REQUIRED"
  | "AUTHORIZATION_PENDING"
  | "INSUFFICIENT_BALANCE"
  | "CAPACITY_UNAVAILABLE"
  | "GATEWAY_HOST_NOT_ALLOWED"
  | "GATEWAY_ATTESTATION_FAILED"
  | "SERVICE_EVIDENCE_FAILED"
  | "ARTIFACT_STORAGE_UNAVAILABLE"
  | "ARTIFACT_NOT_READY"
  | "ARTIFACT_INTEGRITY_FAILED"
  | "ARTIFACT_TYPE_UNSUPPORTED"
  | "ARTIFACT_TASK_UNAVAILABLE"
  | "ARTIFACT_LEASE_INVALID"
  | "ARTIFACT_TASK_CANCELLED"
  | "PRIVACY_ACKNOWLEDGEMENT_REQUIRED"
  | "RESOURCE_QUOTA_EXCEEDED"
  | "GATEWAY_FAILED"
  | "DATABASE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface MarketplaceApiErrorBody {
  ok: false;
  error: {
    code: MarketplaceApiErrorCode;
    message: string;
    requestId: string;
    retryable: boolean;
  };
}

export interface MarketplaceUserView {
  displayName: string;
  email: string;
  isAdmin: boolean;
}

export interface SupplierProfileView {
  supplierId: string;
  kind: SupplierKind;
  displayName: string;
  legalName: string;
  countryCode: string;
  status: SupplierStatus;
  supplyEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AuthorizationReviewStatus = "pending" | "approved" | "rejected";

export interface AuthorizationRequestView {
  requestId: string;
  supplierId: string;
  supplierDisplayName: string;
  providerId: string;
  sourceType: CapacitySourceType;
  modelPattern: string;
  regionCode: string;
  dataClasses: MarketplaceDataClass[];
  limits: CapacityLimits;
  evidenceRef: string;
  gatewayHost: string;
  validUntil: string;
  status: AuthorizationReviewStatus;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface CapacityOfferView {
  offerId: string;
  supplierId: string;
  supplierDisplayName: string;
  providerId: string;
  sourceType: CapacitySourceType;
  model: string;
  regionCode: string;
  dataClasses: MarketplaceDataClass[];
  limits: CapacityLimits;
  currency: "CNY";
  priceMicrosPerMillionTokens: string;
  status: "active" | "paused" | "expired";
  validFrom: string;
  validUntil: string;
  createdAt: string;
  mine: boolean;
}

export interface UsageSummaryView {
  completedJobs: number;
  failedJobs: number;
  totalTokens: number;
  supplierEarningsMicros: string;
  buyerSpendMicros: string;
  promotionalBalanceMicros: string;
}

export interface LedgerEntryView {
  entryId: string;
  jobId: string | null;
  entryType: "promotional-credit" | "inference-debit" | "supplier-credit" | "platform-fee" | "adjustment";
  direction: "debit" | "credit";
  amountMicros: string;
  currency: "CNY";
  createdAt: string;
}

export interface InferenceJobView {
  jobId: string;
  offerId: string;
  model: string;
  privacyMode: MarketplacePrivacyMode;
  status: "reserved" | "running" | "completed" | "failed";
  totalTokens: number | null;
  chargeMicros: string | null;
  errorCode: string | null;
  serviceProof: ServiceProofView | null;
  contentExpiresAt: string | null;
  contentPurgedAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ServiceProofView {
  assurance: "node-signed-provider-response";
  providerId: string;
  requestedModel: string;
  servedModel: string;
  providerRequestId: string;
  unitPriceMicrosPerMillionTokens: string;
  buyerChargeMicros: string;
  evidenceDigest: string;
  completedAt: string;
}

export interface MarketplaceDashboardSnapshot {
  apiVersion: typeof MARKETPLACE_API_VERSION;
  generatedAt: string;
  user: MarketplaceUserView;
  supplier: SupplierProfileView | null;
  authorizationRequests: AuthorizationRequestView[];
  offers: CapacityOfferView[];
  marketOffers: CapacityOfferView[];
  usage: UsageSummaryView;
  ledger: LedgerEntryView[];
  jobs: InferenceJobView[];
  artifacts: ArtifactView[];
  artifactTasks: ArtifactTaskView[];
  pendingReviews: AuthorizationRequestView[];
  privacy: MarketplacePrivacySummary;
}

export interface RegisterSupplierRequest {
  commandId: string;
  kind: SupplierKind;
  legalName: string;
  displayName: string;
  countryCode: string;
  taxResidenceCountryCode: string;
}

export interface CreateAuthorizationRequest {
  commandId: string;
  providerId: string;
  sourceType: CapacitySourceType;
  meteringMode: "provider-report" | "signed-receipt" | "dedicated-counter";
  evidenceRef: string;
  modelPattern: string;
  regionCode: string;
  dataClasses: MarketplaceDataClass[];
  limits: CapacityLimits;
  validUntil: string;
  gatewayEndpoint: string;
  gatewayBearerToken: string;
}

export interface ReviewAuthorizationRequest {
  commandId: string;
  decision: "approve" | "reject";
  reviewNote?: string;
}

export interface CreateCapacityOfferRequest {
  commandId: string;
  authorizationRequestId: string;
  model: string;
  dataClasses: MarketplaceDataClass[];
  limits: CapacityLimits;
  priceMicrosPerMillionTokens: string;
  validUntil: string;
}

export interface SetSupplyRequest {
  commandId: string;
  enabled: boolean;
}

export interface RunInferenceRequest {
  model: string;
  input: string;
  dataClass: Extract<MarketplaceDataClass, "P0" | "P1">;
  maxOutputTokens: number;
  privacyMode: MarketplacePrivacyMode;
  supplierProcessingAcknowledged: true;
}

export interface RunInferenceResponse {
  ok: true;
  requestId: string;
  job: InferenceJobView;
  output: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  serviceProof: ServiceProofView;
}

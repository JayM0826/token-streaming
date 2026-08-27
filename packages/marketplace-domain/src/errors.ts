export type MarketplaceDomainErrorCode =
  | "INVALID_ARGUMENT"
  | "CREDENTIAL_MATERIAL_REJECTED"
  | "TENANT_MISMATCH"
  | "INVALID_EVENT_HISTORY"
  | "INVALID_SUPPLIER_STATE"
  | "VERIFICATION_INCOMPLETE"
  | "AUTHORIZATION_REQUIRED"
  | "AUTHORIZATION_SCOPE_MISMATCH"
  | "GATEWAY_ATTESTATION_MISMATCH"
  | "SERVICE_EVIDENCE_MISMATCH"
  | "PRIVACY_ACKNOWLEDGEMENT_REQUIRED"
  | "INVALID_ARTIFACT_TASK_STATE"
  | "DUPLICATE_RECORD"
  | "UNSUPPORTED_DATA_CLASS";

export class MarketplaceDomainError extends Error {
  readonly code: MarketplaceDomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: MarketplaceDomainErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "MarketplaceDomainError";
    this.code = code;
    this.details = details;
  }
}

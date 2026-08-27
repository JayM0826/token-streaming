import type { MarketplaceDataClass } from "./marketplace.js";

export const SUPPLIER_GATEWAY_PROTOCOL_VERSION = "gongsuanyun.gateway.v3" as const;
export const SUPPLIER_GATEWAY_EXECUTION_EVIDENCE_VERSION = "gongsuanyun.execution-evidence.v1" as const;

export const SUPPLIER_GATEWAY_HEADERS = {
  jobId: "x-gongsuanyun-job-id",
  timestamp: "x-gongsuanyun-timestamp",
  nonce: "x-gongsuanyun-nonce",
  signature: "x-gongsuanyun-signature"
} as const;

export interface SupplierGatewayInferenceRequest {
  protocol_version: typeof SUPPLIER_GATEWAY_PROTOCOL_VERSION;
  request_id: string;
  model: string;
  input: string;
  data_class: Extract<MarketplaceDataClass, "P0" | "P1">;
  max_output_tokens: number;
  stream: false;
}

export interface SupplierGatewayUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface SupplierGatewayInferenceResponse {
  output: string;
  usage: SupplierGatewayUsage;
  execution_evidence: SupplierGatewayExecutionEvidence;
  execution_evidence_signature: string;
}

export interface SupplierGatewayExecutionEvidence {
  evidence_version: typeof SUPPLIER_GATEWAY_EXECUTION_EVIDENCE_VERSION;
  request_id: string;
  provider_id: string;
  requested_model: string;
  served_model: string;
  provider_request_id: string;
  input_sha256: string;
  output_sha256: string;
  usage: SupplierGatewayUsage;
  completed_at: string;
  receipt_ref?: string;
}

export type SupplierGatewayErrorCode =
  | "INVALID_REQUEST"
  | "AUTHENTICATION_FAILED"
  | "SIGNATURE_INVALID"
  | "REQUEST_EXPIRED"
  | "REPLAY_DETECTED"
  | "MODEL_NOT_ALLOWED"
  | "DATA_CLASS_NOT_ALLOWED"
  | "CAPACITY_EXCEEDED"
  | "IDEMPOTENCY_CONFLICT"
  | "UPSTREAM_AUTH_FAILED"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_RESPONSE_INVALID"
  | "UPSTREAM_MODEL_MISMATCH"
  | "INTERNAL_ERROR";

export interface SupplierGatewayErrorResponse {
  error: {
    code: SupplierGatewayErrorCode;
    message: string;
    retryable: boolean;
    request_id?: string;
  };
}

export interface SupplierGatewayHealthResponse {
  status: "ready" | "draining";
  protocol_version: typeof SUPPLIER_GATEWAY_PROTOCOL_VERSION;
  provider_id: string;
  allowed_models: string[];
  allowed_data_classes: Array<Extract<MarketplaceDataClass, "P0" | "P1">>;
  limits: {
    requests_per_minute: number;
    tokens_per_minute: number;
    concurrency: number;
    max_output_tokens: number;
  };
}

export interface SupplierGatewayReadinessResponse {
  status: "ready" | "draining";
  protocol_version: typeof SUPPLIER_GATEWAY_PROTOCOL_VERSION;
}

export interface SupplierGatewayAttestationRequest {
  protocol_version: typeof SUPPLIER_GATEWAY_PROTOCOL_VERSION;
  request_id: string;
  challenge: string;
}

export interface SupplierGatewayAttestationResponse extends SupplierGatewayHealthResponse {
  request_id: string;
  challenge: string;
}

export interface SupplierGatewaySignatureInput {
  timestamp: string;
  nonce: string;
  jobId: string;
  bodySha256: string;
}

export function createSupplierGatewaySignaturePayload(input: SupplierGatewaySignatureInput): string {
  return [input.timestamp, input.nonce, input.jobId, input.bodySha256].join("\n");
}

export function createSupplierGatewayExecutionEvidencePayload(
  evidence: SupplierGatewayExecutionEvidence
): string {
  return [
    evidence.evidence_version,
    evidence.request_id,
    evidence.provider_id,
    evidence.requested_model,
    evidence.served_model,
    evidence.provider_request_id,
    evidence.input_sha256,
    evidence.output_sha256,
    String(evidence.usage.input_tokens),
    String(evidence.usage.output_tokens),
    String(evidence.usage.total_tokens),
    evidence.completed_at,
    evidence.receipt_ref ?? ""
  ].join("\n");
}

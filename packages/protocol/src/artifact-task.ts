import type { MarketplaceDataClass } from "./marketplace.js";
import type { MarketplacePrivacyMode } from "./privacy.js";
import type { SupplierGatewayUsage } from "./supplier-gateway.js";

export const ARTIFACT_PROTOCOL_VERSION = "gongsuanyun.artifact.v1" as const;
export const SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION = "gongsuanyun.artifact-worker.v2" as const;
export const SUPPLIER_ARTIFACT_EXECUTION_EVIDENCE_VERSION = "gongsuanyun.artifact-evidence.v1" as const;

export const ARTIFACT_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
export const ARTIFACT_MAX_SIZE_BYTES = 256 * 1024 * 1024;
export const ARTIFACT_MAX_CHUNKS = ARTIFACT_MAX_SIZE_BYTES / ARTIFACT_CHUNK_SIZE_BYTES;

export const ARTIFACT_SUPPORTED_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "text/xml"
] as const;

export type ArtifactSupportedMediaType = typeof ARTIFACT_SUPPORTED_MEDIA_TYPES[number];
export type ArtifactStatus = "uploading" | "ready" | "expired" | "deleted";
export type ArtifactTaskStatus = "queued" | "claimed" | "running" | "completed" | "failed" | "cancelled";

export interface ArtifactChunkDescriptor {
  partNumber: number;
  sizeBytes: number;
  sha256: string;
}

export interface ArtifactView {
  artifactId: string;
  protocolVersion: typeof ARTIFACT_PROTOCOL_VERSION;
  fileName: string;
  privacyMode: MarketplacePrivacyMode;
  mediaType: ArtifactSupportedMediaType;
  sizeBytes: number;
  chunkSizeBytes: number;
  chunkCount: number;
  uploadedChunks: number;
  manifestSha256: string | null;
  status: ArtifactStatus;
  contentPurgedAt: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface CreateArtifactUploadRequest {
  fileName: string | null;
  mediaType: ArtifactSupportedMediaType;
  sizeBytes: number;
  privacyMode: MarketplacePrivacyMode;
}

export interface CreateArtifactUploadResponse {
  ok: true;
  requestId: string;
  artifact: ArtifactView;
}

export interface UploadArtifactChunkResponse {
  ok: true;
  requestId: string;
  artifactId: string;
  part: ArtifactChunkDescriptor;
  uploadedChunks: number;
}

export interface CompleteArtifactUploadRequest {
  parts: ArtifactChunkDescriptor[];
}

export interface CompleteArtifactUploadResponse {
  ok: true;
  requestId: string;
  artifact: ArtifactView;
}

export interface CreateArtifactTaskRequest {
  artifactId: string;
  model: string;
  instruction: string;
  dataClass: Extract<MarketplaceDataClass, "P0" | "P1">;
  maxOutputTokens: number;
  maxTotalTokens: number;
  supplierProcessingAcknowledged: true;
}

export interface ArtifactTaskProgressView {
  completedSegments: number;
  totalSegments: number | null;
  processedBytes: number;
  totalBytes: number;
  attempt: number;
  updatedAt: string;
}

export interface ArtifactTaskView {
  taskId: string;
  artifactId: string;
  fileName: string;
  offerId: string;
  model: string;
  privacyMode: MarketplacePrivacyMode;
  status: ArtifactTaskStatus;
  progress: ArtifactTaskProgressView;
  output: string | null;
  totalTokens: number | null;
  chargeMicros: string | null;
  errorCode: string | null;
  evidenceDigest: string | null;
  contentExpiresAt: string | null;
  contentPurgedAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CreateArtifactTaskResponse {
  ok: true;
  requestId: string;
  task: ArtifactTaskView;
}

export interface SupplierArtifactWorkerClaimRequest {
  protocol_version: typeof SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION;
  request_id: string;
  worker_id: string;
  provider_id: string;
  allowed_models: string[];
  supported_media_types: ArtifactSupportedMediaType[];
  max_artifact_bytes: number;
}

export interface SupplierArtifactAssignment {
  protocol_version: typeof SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION;
  task_id: string;
  lease_token: string;
  lease_expires_at: string;
  attempt: number;
  resume_from_segment: number;
  privacy_mode: MarketplacePrivacyMode;
  model: string;
  instruction: string;
  data_class: Extract<MarketplaceDataClass, "P0" | "P1">;
  max_output_tokens: number;
  max_total_tokens: number;
  artifact: {
    artifact_id: string;
    file_name: string;
    media_type: ArtifactSupportedMediaType;
    size_bytes: number;
    manifest_sha256: string;
    chunks: Array<{
      part_number: number;
      size_bytes: number;
      sha256: string;
    }>;
  };
}

export interface SupplierArtifactWorkerClaimResponse {
  protocol_version: typeof SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION;
  request_id: string;
  task: SupplierArtifactAssignment | null;
  retry_after_ms: number;
}

export interface SupplierArtifactTaskCheckpointRequest {
  protocol_version: typeof SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION;
  request_id: string;
  task_id: string;
  lease_token: string;
  completed_segments: number;
  total_segments: number;
  processed_bytes: number;
  usage: SupplierGatewayUsage;
}

export interface SupplierArtifactTaskCompleteRequest {
  protocol_version: typeof SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION;
  request_id: string;
  task_id: string;
  lease_token: string;
  output: string;
  usage: SupplierGatewayUsage;
  execution_evidence: SupplierArtifactExecutionEvidence;
  execution_evidence_signature: string;
}

export interface SupplierArtifactTaskFailureRequest {
  protocol_version: typeof SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION;
  request_id: string;
  task_id: string;
  lease_token: string;
  code: string;
  retryable: boolean;
}

export interface SupplierArtifactExecutionEvidence {
  evidence_version: typeof SUPPLIER_ARTIFACT_EXECUTION_EVIDENCE_VERSION;
  task_id: string;
  provider_id: string;
  requested_model: string;
  served_model: string;
  artifact_id: string;
  artifact_manifest_sha256: string;
  artifact_content_sha256: string;
  output_sha256: string;
  provider_request_ids_sha256: string;
  segments_completed: number;
  usage: SupplierGatewayUsage;
  completed_at: string;
}

export function createArtifactManifestPayload(input: {
  artifactId: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  chunks: readonly ArtifactChunkDescriptor[];
}): string {
  return [
    ARTIFACT_PROTOCOL_VERSION,
    input.artifactId,
    input.fileName,
    input.mediaType,
    String(input.sizeBytes),
    ...input.chunks.map((part) => `${part.partNumber}:${part.sizeBytes}:${part.sha256}`)
  ].join("\n");
}

export function createSupplierArtifactExecutionEvidencePayload(
  evidence: SupplierArtifactExecutionEvidence
): string {
  return [
    evidence.evidence_version,
    evidence.task_id,
    evidence.provider_id,
    evidence.requested_model,
    evidence.served_model,
    evidence.artifact_id,
    evidence.artifact_manifest_sha256,
    evidence.artifact_content_sha256,
    evidence.output_sha256,
    evidence.provider_request_ids_sha256,
    String(evidence.segments_completed),
    String(evidence.usage.input_tokens),
    String(evidence.usage.output_tokens),
    String(evidence.usage.total_tokens),
    evidence.completed_at
  ].join("\n");
}

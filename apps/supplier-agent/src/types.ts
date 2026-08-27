import type { SupplierNodeLogEvent, UpstreamProtocol } from "@token-streaming/supplier-node/runtime";

export const SUPPLIER_AGENT_PROFILE_VERSION = 2 as const;
export const SUPPLIER_AGENT_VAULT_VERSION = 1 as const;

export interface SupplierAgentProfileInput {
  providerId: string;
  allowedModels: string[];
  allowedDataClasses: Array<"P0" | "P1">;
  publicGatewayEndpoint: string;
  controlPlaneBaseUrl: string;
  gatewayPort: number;
  upstreamProtocol: UpstreamProtocol;
  upstreamBaseUrl: string;
  upstreamHostAllowlist: string[];
  limits: {
    requestsPerMinute: number;
    tokensPerMinute: number;
    concurrency: number;
    maxOutputTokens: number;
    maxInputBytes: number;
    maxArtifactBytes: number;
    artifactSegmentBytes: number;
  };
}

export interface SupplierAgentProfile extends SupplierAgentProfileInput {
  profileVersion: typeof SUPPLIER_AGENT_PROFILE_VERSION;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierAgentSecrets {
  gatewayToken: string;
  upstreamApiKey: string;
}

export interface SupplierAgentSetupInput {
  profile: SupplierAgentProfileInput;
  upstreamApiKey: string;
  gatewayToken?: string;
  passphrase: string;
}

export interface EncryptedSupplierAgentVault {
  vaultVersion: typeof SUPPLIER_AGENT_VAULT_VERSION;
  kdf: "scrypt-v1";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface SupplierAgentMetrics {
  completedJobs: number;
  failedJobs: number;
  replayedJobs: number;
  attestations: number;
  totalTokens: number;
  lastEventAt: string | null;
  lastErrorCode: string | null;
}

export interface SupplierAgentStatus {
  configured: boolean;
  unlocked: boolean;
  nodeStatus: "not-configured" | "locked" | "online" | "draining";
  managementUrl: string;
  providerId: string | null;
  models: string[];
  publicGatewayEndpoint: string | null;
  gatewayPort: number | null;
  artifactWorker: {
    state: "stopped" | "polling" | "processing" | "error";
    taskId: string | null;
    completedSegments: number;
    totalSegments: number | null;
    processedBytes: number;
    lastCompletedAt: string | null;
    lastErrorCode: string | null;
  };
  metrics: SupplierAgentMetrics;
}

export interface SupplierConnectionDetails {
  providerId: string;
  modelPattern: string;
  exactModels: string[];
  dataClasses: Array<"P0" | "P1">;
  gatewayEndpoint: string;
  controlPlaneBaseUrl: string;
  gatewayBearerToken: string;
  limits: SupplierAgentProfile["limits"];
}

export type SupplierAgentEvent = SupplierNodeLogEvent;

export class SupplierAgentError extends Error {
  constructor(
    readonly code: "NOT_CONFIGURED" | "ALREADY_CONFIGURED" | "INVALID_INPUT" | "SESSION_INVALID" | "ORIGIN_REJECTED" | "VAULT_LOCKED" | "VAULT_UNLOCK_FAILED" | "RATE_LIMITED" | "NODE_START_FAILED",
    message: string
  ) {
    super(message);
    this.name = "SupplierAgentError";
  }
}

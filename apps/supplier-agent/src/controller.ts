import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import {
  SupplierNodeRuntime,
  createConfiguredProviderAdapter,
  createSupplierNodeServer,
  listenSupplierNode,
  loadSupplierNodeConfig,
  type SupplierNodeConfig,
  type SupplierNodeLogEvent
} from "@token-streaming/supplier-node/runtime";
import { createSupplierAgentProfile } from "./profile.js";
import { SupplierAgentStore } from "./store.js";
import {
  SupplierAgentError,
  type SupplierAgentMetrics,
  type SupplierAgentProfile,
  type SupplierAgentSecrets,
  type SupplierAgentSetupInput,
  type SupplierAgentStatus,
  type SupplierConnectionDetails
} from "./types.js";
import { decryptSupplierAgentVault, encryptSupplierAgentVault, validatePassphrase } from "./vault.js";
import { SupplierArtifactCheckpointStore } from "./artifact-checkpoint-store.js";
import { SupplierArtifactWorker, type SupplierArtifactWorkerStatus } from "./artifact-worker.js";

export class SupplierAgentController {
  private profile: SupplierAgentProfile | undefined;
  private secrets: SupplierAgentSecrets | undefined;
  private nodeRuntime: SupplierNodeRuntime | undefined;
  private nodeServer: Server | undefined;
  private artifactWorker: SupplierArtifactWorker | undefined;
  private artifactWorkerStatus: SupplierArtifactWorkerStatus = emptyArtifactWorkerStatus();
  private metrics: SupplierAgentMetrics = emptyMetrics();

  constructor(
    readonly store: SupplierAgentStore,
    readonly managementUrl: string
  ) {}

  async initialize(): Promise<void> {
    if (await this.store.exists()) this.profile = await this.store.readProfile();
  }

  async setup(input: SupplierAgentSetupInput): Promise<SupplierConnectionDetails> {
    if (!isRecord(input)) invalid("设置请求必须是对象。");
    assertExactKeys(input, ["profile", "upstreamApiKey", "passphrase"], ["gatewayToken"]);
    validatePassphrase(input.passphrase);
    const prior = this.profile;
    const profile = createSupplierAgentProfile(input.profile, prior);
    const secrets = {
      gatewayToken: normalizeGatewayToken(input.gatewayToken),
      upstreamApiKey: requiredSecret(input.upstreamApiKey, "Provider API Key", 8)
    };
    const config = buildNodeConfig(profile, secrets);
    const vault = await encryptSupplierAgentVault(secrets, input.passphrase);
    await this.stopNode();
    await this.store.write(profile, vault);
    this.profile = profile;
    await this.startNode(config, secrets);
    return connectionDetailsFor(profile, secrets.gatewayToken);
  }

  async unlock(passphrase: string): Promise<void> {
    validatePassphrase(passphrase);
    if (!this.profile) throw new SupplierAgentError("NOT_CONFIGURED", "请先完成供应客户端设置。");
    const secrets = await decryptSupplierAgentVault(await this.store.readVault(), passphrase);
    await this.stopNode();
    await this.startNode(buildNodeConfig(this.profile, secrets), secrets);
  }

  async lock(): Promise<void> {
    await this.stopNode();
  }

  status(): SupplierAgentStatus {
    return {
      configured: Boolean(this.profile),
      unlocked: Boolean(this.secrets),
      nodeStatus: !this.profile ? "not-configured" : !this.nodeRuntime ? "locked" : this.nodeRuntime.readiness().status === "ready" ? "online" : "draining",
      managementUrl: this.managementUrl,
      providerId: this.profile?.providerId ?? null,
      models: [...(this.profile?.allowedModels ?? [])],
      publicGatewayEndpoint: this.profile?.publicGatewayEndpoint ?? null,
      gatewayPort: this.profile?.gatewayPort ?? null,
      artifactWorker: { ...this.artifactWorkerStatus },
      metrics: { ...this.metrics }
    };
  }

  async connectionDetails(passphrase: string): Promise<SupplierConnectionDetails> {
    validatePassphrase(passphrase);
    if (!this.profile) throw new SupplierAgentError("NOT_CONFIGURED", "请先完成供应客户端设置。");
    const verified = await decryptSupplierAgentVault(await this.store.readVault(), passphrase);
    return connectionDetailsFor(this.profile, verified.gatewayToken);
  }

  async doctor(): Promise<{ ok: true; configured: boolean; profilePath: string; vaultPath: string; providerId: string | null; models: string[]; publicGatewayEndpoint: string | null }> {
    if (!this.profile && await this.store.exists()) this.profile = await this.store.readProfile();
    return {
      ok: true,
      configured: Boolean(this.profile),
      profilePath: this.store.paths.profile,
      vaultPath: this.store.paths.vault,
      providerId: this.profile?.providerId ?? null,
      models: [...(this.profile?.allowedModels ?? [])],
      publicGatewayEndpoint: this.profile?.publicGatewayEndpoint ?? null
    };
  }

  async shutdown(): Promise<void> {
    await this.stopNode();
  }

  private async startNode(config: SupplierNodeConfig, secrets: SupplierAgentSecrets): Promise<void> {
    try {
      const runtime = new SupplierNodeRuntime(config, createConfiguredProviderAdapter(config), (event) => this.recordEvent(event));
      const server = createSupplierNodeServer(runtime);
      await listenSupplierNode(server, config.bindHost, config.port);
      this.nodeRuntime = runtime;
      this.nodeServer = server;
      this.secrets = secrets;
      this.metrics = emptyMetrics();
      if (config.limits.maxArtifactBytes > 0) {
        const worker = new SupplierArtifactWorker({
          controlPlaneBaseUrl: this.profile!.controlPlaneBaseUrl,
          workerId: stableWorkerId(this.store.paths.root, config.providerId, secrets.gatewayToken),
          gatewayToken: secrets.gatewayToken,
          providerId: config.providerId,
          allowedModels: [...config.allowedModels],
          maxArtifactBytes: config.limits.maxArtifactBytes,
          runtime,
          checkpointStore: new SupplierArtifactCheckpointStore(this.store.paths.root),
          onStatus: (status) => { this.artifactWorkerStatus = status; }
        });
        this.artifactWorker = worker;
        worker.start();
      }
    } catch (error) {
      this.secrets = undefined;
      const message = error instanceof Error ? error.message : "节点启动失败。";
      throw new SupplierAgentError("NODE_START_FAILED", `供应节点启动失败：${message}`);
    }
  }

  private async stopNode(): Promise<void> {
    const artifactWorker = this.artifactWorker;
    this.artifactWorker = undefined;
    await artifactWorker?.stop();
    this.artifactWorkerStatus = emptyArtifactWorkerStatus();
    const runtime = this.nodeRuntime;
    const server = this.nodeServer;
    this.nodeRuntime = undefined;
    this.nodeServer = undefined;
    this.secrets = undefined;
    if (!server) return;
    runtime?.setDraining();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private recordEvent(event: SupplierNodeLogEvent): void {
    if (event.event === "request.completed") {
      this.metrics.completedJobs += 1;
      this.metrics.totalTokens += event.totalTokens ?? 0;
    } else if (event.event === "request.failed") {
      this.metrics.failedJobs += 1;
      this.metrics.lastErrorCode = event.code ?? "UNKNOWN";
    } else if (event.event === "request.replayed") {
      this.metrics.replayedJobs += 1;
    } else if (event.event === "attestation.completed") {
      this.metrics.attestations += 1;
    } else if (event.event === "attestation.failed") {
      this.metrics.lastErrorCode = event.code ?? "UNKNOWN";
    }
    this.metrics.lastEventAt = new Date().toISOString();
  }
}

function buildNodeConfig(profile: SupplierAgentProfile, secrets: SupplierAgentSecrets): SupplierNodeConfig {
  return loadSupplierNodeConfig({
    SUPPLIER_NODE_BIND_HOST: "127.0.0.1",
    SUPPLIER_NODE_PORT: String(profile.gatewayPort),
    SUPPLIER_NODE_GATEWAY_TOKEN: secrets.gatewayToken,
    SUPPLIER_NODE_PROVIDER_ID: profile.providerId,
    SUPPLIER_NODE_ALLOWED_MODELS: profile.allowedModels.join(","),
    SUPPLIER_NODE_ALLOWED_DATA_CLASSES: profile.allowedDataClasses.join(","),
    SUPPLIER_NODE_REQUESTS_PER_MINUTE: String(profile.limits.requestsPerMinute),
    SUPPLIER_NODE_TOKENS_PER_MINUTE: String(profile.limits.tokensPerMinute),
    SUPPLIER_NODE_CONCURRENCY: String(profile.limits.concurrency),
    SUPPLIER_NODE_MAX_OUTPUT_TOKENS: String(profile.limits.maxOutputTokens),
    SUPPLIER_NODE_MAX_INPUT_BYTES: String(profile.limits.maxInputBytes),
    SUPPLIER_NODE_MAX_ARTIFACT_BYTES: String(profile.limits.maxArtifactBytes),
    SUPPLIER_NODE_ARTIFACT_SEGMENT_BYTES: String(profile.limits.artifactSegmentBytes),
    SUPPLIER_NODE_UPSTREAM_PROTOCOL: profile.upstreamProtocol,
    SUPPLIER_NODE_UPSTREAM_BASE_URL: profile.upstreamBaseUrl,
    SUPPLIER_NODE_UPSTREAM_HOST_ALLOWLIST: profile.upstreamHostAllowlist.join(","),
    SUPPLIER_NODE_UPSTREAM_API_KEY: secrets.upstreamApiKey
  });
}

function connectionDetailsFor(profile: SupplierAgentProfile, gatewayToken: string): SupplierConnectionDetails {
  return {
    providerId: profile.providerId,
    // Marketplace authorizations are exact-model records. When one node
    // exposes several models, the supplier publishes one offer per entry.
    modelPattern: profile.allowedModels[0]!,
    exactModels: [...profile.allowedModels],
    dataClasses: [...profile.allowedDataClasses],
    gatewayEndpoint: profile.publicGatewayEndpoint,
    controlPlaneBaseUrl: profile.controlPlaneBaseUrl,
    gatewayBearerToken: gatewayToken,
    limits: { ...profile.limits }
  };
}

function normalizeGatewayToken(value: unknown): string {
  if (value === undefined || value === "") return randomBytes(32).toString("base64url");
  return requiredSecret(value, "网关令牌", 32);
}

function requiredSecret(value: unknown, label: string, minimum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > 4_096 || value.trim() !== value) {
    invalid(`${label} 长度无效或包含首尾空格。`);
  }
  return value;
}

function emptyMetrics(): SupplierAgentMetrics {
  return { completedJobs: 0, failedJobs: 0, replayedJobs: 0, attestations: 0, totalTokens: 0, lastEventAt: null, lastErrorCode: null };
}

function emptyArtifactWorkerStatus(): SupplierArtifactWorkerStatus {
  return {
    state: "stopped",
    taskId: null,
    completedSegments: 0,
    totalSegments: null,
    processedBytes: 0,
    lastCompletedAt: null,
    lastErrorCode: null
  };
}

function stableWorkerId(root: string, providerId: string, gatewayToken: string): string {
  return `worker-${createHash("sha256").update(`${root}\n${providerId}\n${gatewayToken}`, "utf8").digest("hex").slice(0, 32)}`;
}

function assertExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !(key in value))) invalid("设置字段不完整或包含未知字段。");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new SupplierAgentError("INVALID_INPUT", message);
}

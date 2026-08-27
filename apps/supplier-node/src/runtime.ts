import {
  SUPPLIER_GATEWAY_EXECUTION_EVIDENCE_VERSION,
  SUPPLIER_GATEWAY_PROTOCOL_VERSION,
  type SupplierGatewayAttestationRequest,
  type SupplierGatewayAttestationResponse,
  type SupplierGatewayErrorResponse,
  type SupplierGatewayHealthResponse,
  type SupplierGatewayInferenceRequest,
  type SupplierGatewayInferenceResponse,
  type SupplierGatewayReadinessResponse
} from "@token-streaming/protocol";
import { CapacityGate } from "./capacity.js";
import type { SupplierNodeConfig } from "./config.js";
import { normalizeSupplierNodeError, SupplierNodeError } from "./errors.js";
import type { SupplierProviderAdapter, SupplierProviderResult } from "./provider-adapter.js";
import {
  SupplierArtifactExecutor,
  type SupplierArtifactCheckpointHandler,
  type SupplierArtifactCheckpointState,
  type SupplierArtifactChunk,
  type SupplierArtifactExecutionResult
} from "./artifact-executor.js";
import type { SupplierArtifactAssignment } from "@token-streaming/protocol";
import {
  createExecutionEvidenceSignature,
  NonceReplayGuard,
  sha256Hex,
  type SignedGatewayCall,
  verifySignedGatewayCall
} from "./signature.js";

export interface SupplierNodeLogEvent {
  event: "request.completed" | "request.failed" | "request.replayed" | "attestation.completed" | "attestation.failed";
  requestId?: string;
  model?: string;
  status: number;
  code?: string;
  totalTokens?: number;
  durationMs: number;
}

export type SupplierNodeLogger = (event: SupplierNodeLogEvent) => void;

export interface SupplierNodeResult {
  status: number;
  body: SupplierGatewayInferenceResponse | SupplierGatewayAttestationResponse | SupplierGatewayErrorResponse;
}

interface IdempotencyEntry {
  bodySha256: string;
  expiresAt: number;
  result: Promise<SupplierNodeResult>;
}

export class SupplierNodeRuntime {
  private readonly capacity: CapacityGate;
  private readonly replayGuard = new NonceReplayGuard();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private draining = false;

  constructor(
    readonly config: SupplierNodeConfig,
    private readonly adapter: SupplierProviderAdapter,
    private readonly logger: SupplierNodeLogger = defaultLogger,
    private readonly idempotencyTtlMs = 15 * 60_000,
    private readonly maximumIdempotencyEntries = 1_000
  ) {
    if (adapter.providerId !== config.providerId) {
      throw new Error("Configured provider adapter identity does not match SUPPLIER_NODE_PROVIDER_ID.");
    }
    this.capacity = new CapacityGate(
      config.limits.requestsPerMinute,
      config.limits.tokensPerMinute,
      config.limits.concurrency
    );
  }

  health(): SupplierGatewayHealthResponse {
    return {
      status: this.draining ? "draining" : "ready",
      protocol_version: SUPPLIER_GATEWAY_PROTOCOL_VERSION,
      provider_id: this.config.providerId,
      allowed_models: [...this.config.allowedModels],
      allowed_data_classes: [...this.config.allowedDataClasses],
      limits: {
        requests_per_minute: this.config.limits.requestsPerMinute,
        tokens_per_minute: this.config.limits.tokensPerMinute,
        concurrency: this.config.limits.concurrency,
        max_output_tokens: this.config.limits.maxOutputTokens
      }
    };
  }

  readiness(): SupplierGatewayReadinessResponse {
    const health = this.health();
    return { status: health.status, protocol_version: health.protocol_version };
  }

  setDraining(): void {
    this.draining = true;
  }

  async handleAttestation(call: SignedGatewayCall, nowMs = Date.now()): Promise<SupplierNodeResult> {
    const startedAt = Date.now();
    let requestId: string | undefined;
    try {
      const verified = verifySignedGatewayCall(call, this.config.gatewayToken, this.replayGuard, nowMs);
      requestId = verified.jobId;
      const request = parseAttestationRequest(call.rawBody);
      if (request.request_id !== verified.jobId) {
        throw new SupplierNodeError("SIGNATURE_INVALID", "证明请求标识与签名标识不一致。", 401);
      }
      const response: SupplierGatewayAttestationResponse = {
        ...this.health(),
        request_id: request.request_id,
        challenge: request.challenge
      };
      this.logger({
        event: "attestation.completed",
        requestId,
        status: 200,
        durationMs: Date.now() - startedAt
      });
      return { status: 200, body: response };
    } catch (error) {
      const normalized = normalizeSupplierNodeError(error);
      this.logger({
        event: "attestation.failed",
        ...(requestId ? { requestId } : {}),
        status: normalized.status,
        code: normalized.code,
        durationMs: Date.now() - startedAt
      });
      return errorResult(normalized, requestId);
    }
  }

  async handleInference(call: SignedGatewayCall, nowMs = Date.now()): Promise<SupplierNodeResult> {
    const startedAt = Date.now();
    let requestId: string | undefined;
    let model: string | undefined;
    try {
      if (this.draining) {
        throw new SupplierNodeError("CAPACITY_EXCEEDED", "供应节点正在安全停机。", 503, true);
      }
      const verified = verifySignedGatewayCall(call, this.config.gatewayToken, this.replayGuard, nowMs);
      requestId = verified.jobId;
      const request = parseInferenceRequest(call.rawBody);
      model = request.model;
      if (request.request_id !== verified.jobId) {
        throw new SupplierNodeError("SIGNATURE_INVALID", "请求体任务标识与签名标识不一致。", 401);
      }
      validateRequestAgainstConfig(request, this.config);
      this.pruneIdempotency(nowMs);
      const existing = this.idempotency.get(request.request_id);
      if (existing) {
        if (existing.bodySha256 !== verified.bodySha256) {
          throw new SupplierNodeError("IDEMPOTENCY_CONFLICT", "同一任务标识对应了不同请求体。", 409);
        }
        const result = await existing.result;
        this.logger({
          event: "request.replayed",
          requestId,
          model,
          status: result.status,
          durationMs: Date.now() - startedAt
        });
        return result;
      }
      if (this.idempotency.size >= this.maximumIdempotencyEntries) {
        throw new SupplierNodeError("CAPACITY_EXCEEDED", "节点幂等缓存已满，请稍后重试。", 503, true);
      }
      const result = this.execute(request, startedAt);
      this.idempotency.set(request.request_id, {
        bodySha256: verified.bodySha256,
        expiresAt: nowMs + this.idempotencyTtlMs,
        result
      });
      return await result;
    } catch (error) {
      const normalized = normalizeSupplierNodeError(error);
      this.logger({
        event: "request.failed",
        ...(requestId ? { requestId } : {}),
        ...(model ? { model } : {}),
        status: normalized.status,
        code: normalized.code,
        durationMs: Date.now() - startedAt
      });
      return errorResult(normalized, requestId);
    }
  }

  async executeArtifactTask(
    assignment: SupplierArtifactAssignment,
    chunks: AsyncIterable<SupplierArtifactChunk>,
    checkpoint: SupplierArtifactCheckpointState | undefined,
    onCheckpoint: SupplierArtifactCheckpointHandler,
    signal: AbortSignal
  ): Promise<SupplierArtifactExecutionResult> {
    if (this.draining) throw new SupplierNodeError("CAPACITY_EXCEEDED", "供应节点正在安全停机。", 503, true);
    const executor = new SupplierArtifactExecutor(this.config, async (request, requestSignal) => {
      validateRequestAgainstConfig(request, this.config);
      const release = this.capacity.acquire(Buffer.byteLength(request.input, "utf8") + request.max_output_tokens);
      try {
        const result = await this.adapter.invoke(request, requestSignal);
        validateProviderResult(result, request.model, request.max_output_tokens);
        return result;
      } finally {
        release();
      }
    });
    return executor.execute(assignment, chunks, checkpoint, onCheckpoint, signal);
  }

  private async execute(request: SupplierGatewayInferenceRequest, startedAt: number): Promise<SupplierNodeResult> {
    const inputBytes = Buffer.byteLength(request.input, "utf8");
    const estimatedTokens = inputBytes + request.max_output_tokens;
    const release = this.capacity.acquire(estimatedTokens);
    try {
      const providerResult = await this.adapter.invoke(request, new AbortController().signal);
      validateProviderResult(providerResult, request.model, request.max_output_tokens);
      const evidence = {
        evidence_version: SUPPLIER_GATEWAY_EXECUTION_EVIDENCE_VERSION,
        request_id: request.request_id,
        provider_id: this.config.providerId,
        requested_model: request.model,
        served_model: providerResult.servedModel,
        provider_request_id: providerResult.providerRequestId,
        input_sha256: sha256Hex(request.input),
        output_sha256: sha256Hex(providerResult.output),
        usage: { ...providerResult.usage },
        completed_at: new Date().toISOString(),
        ...(providerResult.receiptRef ? { receipt_ref: providerResult.receiptRef } : {})
      } satisfies SupplierGatewayInferenceResponse["execution_evidence"];
      const response: SupplierGatewayInferenceResponse = {
        output: providerResult.output,
        usage: { ...providerResult.usage },
        execution_evidence: evidence,
        execution_evidence_signature: createExecutionEvidenceSignature(this.config.gatewayToken, evidence)
      };
      this.logger({
        event: "request.completed",
        requestId: request.request_id,
        model: request.model,
        status: 200,
        totalTokens: response.usage.total_tokens,
        durationMs: Date.now() - startedAt
      });
      return { status: 200, body: response };
    } catch (error) {
      const normalized = normalizeSupplierNodeError(error);
      this.logger({
        event: "request.failed",
        requestId: request.request_id,
        model: request.model,
        status: normalized.status,
        code: normalized.code,
        durationMs: Date.now() - startedAt
      });
      return errorResult(normalized, request.request_id);
    } finally {
      release();
    }
  }

  private pruneIdempotency(nowMs: number): void {
    for (const [requestId, entry] of this.idempotency) {
      if (entry.expiresAt < nowMs) this.idempotency.delete(requestId);
    }
  }
}

function parseAttestationRequest(rawBody: string): SupplierGatewayAttestationRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new SupplierNodeError("INVALID_REQUEST", "证明请求体不是有效 JSON。", 400);
  }
  if (!isRecord(parsed)) throw new SupplierNodeError("INVALID_REQUEST", "证明请求体必须是 JSON 对象。", 400);
  const expected = ["protocol_version", "request_id", "challenge"];
  const keys = Object.keys(parsed);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new SupplierNodeError("INVALID_REQUEST", "证明请求包含未知或缺失字段。", 400);
  }
  if (parsed.protocol_version !== SUPPLIER_GATEWAY_PROTOCOL_VERSION) {
    throw new SupplierNodeError("INVALID_REQUEST", "供应网关协议版本不受支持。", 400);
  }
  if (typeof parsed.request_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(parsed.request_id)) {
    throw new SupplierNodeError("INVALID_REQUEST", "证明 request_id 无效。", 400);
  }
  if (typeof parsed.challenge !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(parsed.challenge)) {
    throw new SupplierNodeError("INVALID_REQUEST", "证明 challenge 无效。", 400);
  }
  return parsed as unknown as SupplierGatewayAttestationRequest;
}

function parseInferenceRequest(rawBody: string): SupplierGatewayInferenceRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new SupplierNodeError("INVALID_REQUEST", "请求体不是有效 JSON。", 400);
  }
  if (!isRecord(parsed)) throw new SupplierNodeError("INVALID_REQUEST", "请求体必须是 JSON 对象。", 400);
  const expected = [
    "protocol_version",
    "request_id",
    "model",
    "input",
    "data_class",
    "max_output_tokens",
    "stream"
  ];
  const keys = Object.keys(parsed);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new SupplierNodeError("INVALID_REQUEST", "请求体包含未知或缺失字段。", 400);
  }
  if (parsed.protocol_version !== SUPPLIER_GATEWAY_PROTOCOL_VERSION) {
    throw new SupplierNodeError("INVALID_REQUEST", "供应网关协议版本不受支持。", 400);
  }
  if (typeof parsed.request_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(parsed.request_id)) {
    throw new SupplierNodeError("INVALID_REQUEST", "request_id 无效。", 400);
  }
  if (typeof parsed.model !== "string" || parsed.model.length < 1 || parsed.model.length > 200) {
    throw new SupplierNodeError("INVALID_REQUEST", "model 无效。", 400);
  }
  if (typeof parsed.input !== "string" || parsed.input.length < 1) {
    throw new SupplierNodeError("INVALID_REQUEST", "input 无效。", 400);
  }
  if (parsed.data_class !== "P0" && parsed.data_class !== "P1") {
    throw new SupplierNodeError("INVALID_REQUEST", "data_class 无效。", 400);
  }
  if (!Number.isSafeInteger(parsed.max_output_tokens) || (parsed.max_output_tokens as number) < 1) {
    throw new SupplierNodeError("INVALID_REQUEST", "max_output_tokens 无效。", 400);
  }
  if (parsed.stream !== false) {
    throw new SupplierNodeError("INVALID_REQUEST", "当前节点只接受 stream=false。", 400);
  }
  return parsed as unknown as SupplierGatewayInferenceRequest;
}

function validateRequestAgainstConfig(request: SupplierGatewayInferenceRequest, config: SupplierNodeConfig): void {
  if (!config.allowedModels.includes(request.model)) {
    throw new SupplierNodeError("MODEL_NOT_ALLOWED", "请求模型不在节点许可清单中。", 403);
  }
  if (!config.allowedDataClasses.includes(request.data_class)) {
    throw new SupplierNodeError("DATA_CLASS_NOT_ALLOWED", "请求数据等级不在节点许可范围内。", 403);
  }
  if (Buffer.byteLength(request.input, "utf8") > config.limits.maxInputBytes) {
    throw new SupplierNodeError("INVALID_REQUEST", "请求输入超过节点大小限制。", 413);
  }
  if (request.max_output_tokens > config.limits.maxOutputTokens) {
    throw new SupplierNodeError("CAPACITY_EXCEEDED", "请求输出上限超过节点许可容量。", 409);
  }
}

function validateProviderResult(
  result: SupplierProviderResult,
  requestedModel: string,
  maximumOutputTokens: number
): void {
  if (
    typeof result.output !== "string" ||
    result.output.length < 1 ||
    result.output.length > 200_000 ||
    typeof result.providerRequestId !== "string" ||
    result.providerRequestId.length < 1 ||
    result.providerRequestId.length > 256 ||
    typeof result.servedModel !== "string" ||
    result.servedModel.length < 1 ||
    result.servedModel.length > 200
  ) {
    throw new SupplierNodeError("UPSTREAM_RESPONSE_INVALID", "Provider Adapter 返回了无效结果。", 502);
  }
  if (result.servedModel !== requestedModel) {
    throw new SupplierNodeError("UPSTREAM_MODEL_MISMATCH", "Provider Adapter 返回的实际模型与购买模型不一致。", 502);
  }
  const { input_tokens: input, output_tokens: output, total_tokens: total } = result.usage;
  if (
    !Number.isSafeInteger(input) || input < 1 ||
    !Number.isSafeInteger(output) || output < 0 || output > maximumOutputTokens ||
    !Number.isSafeInteger(total) || total !== input + output
  ) {
    throw new SupplierNodeError("UPSTREAM_RESPONSE_INVALID", "Provider Adapter 返回了无效用量。", 502);
  }
}

function errorResult(error: SupplierNodeError, requestId?: string): SupplierNodeResult {
  return {
    status: error.status,
    body: {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(requestId ? { request_id: requestId } : {})
      }
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultLogger(event: SupplierNodeLogEvent): void {
  process.stdout.write(`${JSON.stringify({ occurredAt: new Date().toISOString(), ...event })}\n`);
}

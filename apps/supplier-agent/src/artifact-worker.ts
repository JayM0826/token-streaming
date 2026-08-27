import { randomBytes } from "node:crypto";
import {
  ARTIFACT_SUPPORTED_MEDIA_TYPES,
  SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION,
  SUPPLIER_GATEWAY_HEADERS,
  createGatewaySignature,
  sha256Hex,
  type SupplierArtifactAssignment,
  type SupplierArtifactCheckpointState,
  type SupplierArtifactProgress,
  type SupplierArtifactTaskCheckpointRequest,
  type SupplierArtifactTaskCompleteRequest,
  type SupplierArtifactTaskFailureRequest,
  type SupplierArtifactWorkerClaimRequest,
  type SupplierArtifactWorkerClaimResponse,
  type SupplierNodeRuntime
} from "@token-streaming/supplier-node/runtime";
import { SupplierArtifactCheckpointStore } from "./artifact-checkpoint-store.js";

export interface SupplierArtifactWorkerStatus {
  state: "stopped" | "polling" | "processing" | "error";
  taskId: string | null;
  completedSegments: number;
  totalSegments: number | null;
  processedBytes: number;
  lastCompletedAt: string | null;
  lastErrorCode: string | null;
}

interface SupplierArtifactWorkerOptions {
  controlPlaneBaseUrl: string;
  workerId: string;
  gatewayToken: string;
  providerId: string;
  allowedModels: string[];
  maxArtifactBytes: number;
  runtime: SupplierNodeRuntime;
  checkpointStore: SupplierArtifactCheckpointStore;
  fetch?: typeof fetch;
  onStatus?: (status: SupplierArtifactWorkerStatus) => void;
}

export class SupplierArtifactWorker {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly abortController = new AbortController();
  private loopPromise: Promise<void> | undefined;
  private statusValue: SupplierArtifactWorkerStatus = emptyStatus();

  constructor(private readonly options: SupplierArtifactWorkerOptions) {
    this.baseUrl = options.controlPlaneBaseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  start(): void {
    if (this.loopPromise) return;
    this.setStatus({ ...this.statusValue, state: "polling" });
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.abortController.abort();
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = undefined;
    this.setStatus({ ...this.statusValue, state: "stopped", taskId: null });
  }

  status(): SupplierArtifactWorkerStatus {
    return { ...this.statusValue };
  }

  async pollOnce(): Promise<number> {
    const requestId = `artifact-claim-${randomId()}`;
    const body: SupplierArtifactWorkerClaimRequest = {
      protocol_version: SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION,
      request_id: requestId,
      worker_id: this.options.workerId,
      provider_id: this.options.providerId,
      allowed_models: [...this.options.allowedModels],
      supported_media_types: [...ARTIFACT_SUPPORTED_MEDIA_TYPES],
      max_artifact_bytes: this.options.maxArtifactBytes
    };
    const result = await this.signedJson<SupplierArtifactWorkerClaimResponse>(
      "POST",
      "/api/v1/agent/artifact-tasks/claim",
      requestId,
      body
    );
    if (
      result.protocol_version !== SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION ||
      result.request_id !== requestId ||
      !Number.isSafeInteger(result.retry_after_ms) || result.retry_after_ms < 0 || result.retry_after_ms > 60_000
    ) throw workerError("CONTROL_RESPONSE_INVALID", false);
    if (!result.task) return result.retry_after_ms;
    await this.processTask(result.task);
    return 250;
  }

  private async loop(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      let waitMs = 5_000;
      try {
        this.setStatus({ ...this.statusValue, state: "polling", taskId: null, lastErrorCode: null });
        waitMs = await this.pollOnce();
      } catch (error) {
        if (this.abortController.signal.aborted) break;
        this.setStatus({ ...this.statusValue, state: "error", taskId: null, lastErrorCode: errorCode(error) });
        waitMs = 5_000;
      }
      await wait(waitMs, this.abortController.signal);
    }
  }

  private async processTask(assignment: SupplierArtifactAssignment): Promise<void> {
    this.setStatus({
      ...this.statusValue,
      state: "processing",
      taskId: assignment.task_id,
      completedSegments: assignment.resume_from_segment,
      totalSegments: null,
      processedBytes: 0,
      lastErrorCode: null
    });
    const stored = await this.options.checkpointStore.read(assignment.task_id, this.options.gatewayToken);
    const checkpoint = stored?.completedSegments === assignment.resume_from_segment ? stored : undefined;
    try {
      const result = await this.options.runtime.executeArtifactTask(
        assignment,
        this.downloadChunks(assignment),
        checkpoint,
        async (nextCheckpoint, progress) => {
          await this.options.checkpointStore.write(assignment.task_id, this.options.gatewayToken, nextCheckpoint);
          await this.sendCheckpoint(assignment, progress);
          this.setStatus({
            ...this.statusValue,
            state: "processing",
            taskId: assignment.task_id,
            completedSegments: progress.completedSegments,
            totalSegments: progress.totalSegments,
            processedBytes: progress.processedBytes,
            lastErrorCode: null
          });
        },
        this.abortController.signal
      );
      const requestId = `${assignment.task_id}:complete:${randomId()}`;
      const body: SupplierArtifactTaskCompleteRequest = {
        protocol_version: SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION,
        request_id: requestId,
        task_id: assignment.task_id,
        lease_token: assignment.lease_token,
        output: result.output,
        usage: result.usage,
        execution_evidence: result.executionEvidence,
        execution_evidence_signature: result.executionEvidenceSignature
      };
      await this.signedJson("POST", `/api/v1/agent/artifact-tasks/${encodeURIComponent(assignment.task_id)}/complete`, requestId, body, 512_000);
      await this.options.checkpointStore.delete(assignment.task_id);
      this.setStatus({
        ...this.statusValue,
        state: "polling",
        taskId: null,
        lastCompletedAt: new Date().toISOString(),
        lastErrorCode: null
      });
    } catch (error) {
      const code = errorCode(error);
      const retryable = isRetryable(error);
      await this.sendFailure(assignment, code, retryable).catch(() => undefined);
      if (!retryable) await this.options.checkpointStore.delete(assignment.task_id).catch(() => undefined);
      this.setStatus({ ...this.statusValue, state: "error", taskId: null, lastErrorCode: code });
      throw error;
    }
  }

  private async *downloadChunks(assignment: SupplierArtifactAssignment): AsyncGenerator<{ partNumber: number; bytes: Uint8Array }> {
    for (const chunk of assignment.artifact.chunks) {
      const requestId = `${assignment.task_id}:chunk:${chunk.part_number}`;
      const response = await this.signedFetch(
        "GET",
        `/api/v1/agent/artifact-tasks/${encodeURIComponent(assignment.task_id)}/chunks/${chunk.part_number}`,
        requestId,
        "",
        { "x-gongsuanyun-lease-token": assignment.lease_token }
      );
      if (!response.ok) throw await responseError(response);
      if (response.headers.get("x-content-sha256") !== chunk.sha256) throw workerError("ARTIFACT_INTEGRITY_FAILED", false);
      const bytes = await readBoundedBytes(response, chunk.size_bytes);
      yield { partNumber: chunk.part_number, bytes };
    }
  }

  private async sendCheckpoint(assignment: SupplierArtifactAssignment, progress: SupplierArtifactProgress): Promise<void> {
    const requestId = `${assignment.task_id}:checkpoint:${randomId()}`;
    const body: SupplierArtifactTaskCheckpointRequest = {
      protocol_version: SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION,
      request_id: requestId,
      task_id: assignment.task_id,
      lease_token: assignment.lease_token,
      completed_segments: progress.completedSegments,
      total_segments: progress.totalSegments,
      processed_bytes: progress.processedBytes,
      usage: progress.usage
    };
    await this.signedJson("POST", `/api/v1/agent/artifact-tasks/${encodeURIComponent(assignment.task_id)}/checkpoint`, requestId, body);
  }

  private async sendFailure(assignment: SupplierArtifactAssignment, code: string, retryable: boolean): Promise<void> {
    const requestId = `${assignment.task_id}:fail:${randomId()}`;
    const body: SupplierArtifactTaskFailureRequest = {
      protocol_version: SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION,
      request_id: requestId,
      task_id: assignment.task_id,
      lease_token: assignment.lease_token,
      code: /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : "ARTIFACT_WORKER_FAILED",
      retryable
    };
    await this.signedJson("POST", `/api/v1/agent/artifact-tasks/${encodeURIComponent(assignment.task_id)}/fail`, requestId, body);
  }

  private async signedJson<T>(
    method: "POST",
    path: string,
    requestId: string,
    body: unknown,
    maximumBytes = 1_000_000
  ): Promise<T> {
    const rawBody = JSON.stringify(body);
    const response = await this.signedFetch(method, path, requestId, rawBody, { "content-type": "application/json" });
    const raw = await readBoundedText(response, maximumBytes);
    if (!response.ok) throw parseResponseError(response.status, raw);
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw workerError("CONTROL_RESPONSE_INVALID", false);
    }
  }

  private async signedFetch(
    method: "GET" | "POST",
    path: string,
    requestId: string,
    rawBody: string,
    extraHeaders: Record<string, string>
  ): Promise<Response> {
    const timestamp = String(Date.now());
    const nonce = randomBytes(18).toString("base64url");
    const bodySha256 = sha256Hex(rawBody);
    const signature = createGatewaySignature(this.options.gatewayToken, { timestamp, nonce, jobId: requestId, bodySha256 });
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.options.gatewayToken}`,
          [SUPPLIER_GATEWAY_HEADERS.jobId]: requestId,
          [SUPPLIER_GATEWAY_HEADERS.timestamp]: timestamp,
          [SUPPLIER_GATEWAY_HEADERS.nonce]: nonce,
          [SUPPLIER_GATEWAY_HEADERS.signature]: signature,
          ...extraHeaders
        },
        ...(method === "POST" ? { body: rawBody } : {}),
        signal: AbortSignal.any([this.abortController.signal, AbortSignal.timeout(60_000)])
      });
    } catch (error) {
      if (this.abortController.signal.aborted) throw workerError("WORKER_STOPPED", true);
      throw workerError("CONTROL_PLANE_UNAVAILABLE", true, error);
    }
  }

  private setStatus(status: SupplierArtifactWorkerStatus): void {
    this.statusValue = status;
    this.options.onStatus?.({ ...status });
  }
}

async function readBoundedBytes(response: Response, expectedBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? -1);
  if (declared >= 0 && declared !== expectedBytes) throw workerError("ARTIFACT_INTEGRITY_FAILED", false);
  if (!response.body) throw workerError("ARTIFACT_INTEGRITY_FAILED", false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > expectedBytes) {
      await reader.cancel();
      throw workerError("ARTIFACT_INTEGRITY_FAILED", false);
    }
    chunks.push(value);
  }
  if (total !== expectedBytes) throw workerError("ARTIFACT_INTEGRITY_FAILED", false);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const bytes = await readBoundedBytesFlexible(response, maximumBytes);
  return new TextDecoder().decode(bytes);
}

async function readBoundedBytesFlexible(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximumBytes) throw workerError("CONTROL_RESPONSE_INVALID", false);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maximumBytes) throw workerError("CONTROL_RESPONSE_INVALID", false);
  return new Uint8Array(buffer);
}

async function responseError(response: Response): Promise<Error> {
  return parseResponseError(response.status, await readBoundedText(response, 64_000));
}

function parseResponseError(status: number, raw: string): Error {
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown; retryable?: unknown } };
    const code = typeof parsed.error?.code === "string" ? parsed.error.code : `CONTROL_HTTP_${status}`;
    return workerError(code, parsed.error?.retryable === true || status >= 500);
  } catch {
    return workerError(`CONTROL_HTTP_${status}`, status >= 500);
  }
}

function workerError(code: string, retryable: boolean, cause?: unknown): Error & { code: string; retryable: boolean } {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code, retryable });
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "ARTIFACT_WORKER_FAILED";
}

function isRetryable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "retryable" in error && error.retryable === true);
}

function randomId(): string {
  return randomBytes(18).toString("base64url");
}

function emptyStatus(): SupplierArtifactWorkerStatus {
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

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds <= 0) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

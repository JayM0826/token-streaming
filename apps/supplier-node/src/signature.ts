import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  createSupplierGatewayExecutionEvidencePayload,
  createSupplierArtifactExecutionEvidencePayload,
  type SupplierArtifactExecutionEvidence,
  createSupplierGatewaySignaturePayload,
  type SupplierGatewayExecutionEvidence
} from "@token-streaming/protocol";
import { SupplierNodeError } from "./errors.js";
import type { PersistentReplayJournal } from "./replay-journal.js";

export interface SignedGatewayCall {
  authorization: string | undefined;
  timestamp: string | undefined;
  nonce: string | undefined;
  jobId: string | undefined;
  signature: string | undefined;
  rawBody: string;
}

export class NonceReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly replayWindowMs = 5 * 60_000,
    private readonly maximumEntries = 10_000,
    private readonly persistentJournal?: PersistentReplayJournal
  ) {}

  verifyAndRecord(nonce: string, timestampMs: number, nowMs: number): void {
    this.prune(nowMs);
    if (Math.abs(nowMs - timestampMs) > this.replayWindowMs) {
      throw new SupplierNodeError("REQUEST_EXPIRED", "请求时间戳已过期。", 401);
    }
    if (this.seen.has(nonce)) {
      throw new SupplierNodeError("REPLAY_DETECTED", "请求 nonce 已经使用。", 409);
    }
    if (this.seen.size >= this.maximumEntries) {
      throw new SupplierNodeError("CAPACITY_EXCEEDED", "重放保护容量已满，请稍后重试。", 503, true);
    }
    this.persistentJournal?.claimNonce(nonce, timestampMs + this.replayWindowMs, nowMs);
    this.seen.set(nonce, timestampMs + this.replayWindowMs);
  }

  private prune(nowMs: number): void {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt < nowMs) this.seen.delete(nonce);
    }
  }
}

export function verifySignedGatewayCall(
  call: SignedGatewayCall,
  gatewayToken: string,
  replayGuard: NonceReplayGuard,
  nowMs = Date.now()
): { jobId: string; bodySha256: string } {
  const bearer = parseBearer(call.authorization);
  if (!safeTextEqual(bearer, gatewayToken)) {
    throw new SupplierNodeError("AUTHENTICATION_FAILED", "网关身份验证失败。", 401);
  }
  const timestamp = requiredPattern(call.timestamp, /^\d{13}$/, "请求时间戳无效。");
  const nonce = requiredPattern(call.nonce, /^[A-Za-z0-9_-]{16,128}$/, "请求 nonce 无效。");
  const jobId = requiredPattern(call.jobId, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/, "任务标识无效。");
  const signature = requiredPattern(call.signature, /^[a-f0-9]{64}$/, "请求签名格式无效。");
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs)) {
    throw new SupplierNodeError("REQUEST_EXPIRED", "请求时间戳无效。", 401);
  }
  const bodySha256 = sha256Hex(call.rawBody);
  const expected = createGatewaySignature(gatewayToken, { timestamp, nonce, jobId, bodySha256 });
  if (!safeTextEqual(signature, expected)) {
    throw new SupplierNodeError("SIGNATURE_INVALID", "请求签名验证失败。", 401);
  }
  replayGuard.verifyAndRecord(nonce, timestampMs, nowMs);
  return { jobId, bodySha256 };
}

export function createGatewaySignature(
  gatewayToken: string,
  input: { timestamp: string; nonce: string; jobId: string; bodySha256: string }
): string {
  return createHmac("sha256", gatewayToken)
    .update(createSupplierGatewaySignaturePayload(input), "utf8")
    .digest("hex");
}

export function createExecutionEvidenceSignature(
  gatewayToken: string,
  evidence: SupplierGatewayExecutionEvidence
): string {
  return createHmac("sha256", gatewayToken)
    .update(createSupplierGatewayExecutionEvidencePayload(evidence), "utf8")
    .digest("hex");
}

export function createArtifactExecutionEvidenceSignature(
  gatewayToken: string,
  evidence: SupplierArtifactExecutionEvidence
): string {
  return createHmac("sha256", gatewayToken)
    .update(createSupplierArtifactExecutionEvidencePayload(evidence), "utf8")
    .digest("hex");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseBearer(value: string | undefined): string {
  if (!value?.startsWith("Bearer ")) {
    throw new SupplierNodeError("AUTHENTICATION_FAILED", "网关身份验证失败。", 401);
  }
  const token = value.slice("Bearer ".length);
  if (!token || token.length > 4_096) {
    throw new SupplierNodeError("AUTHENTICATION_FAILED", "网关身份验证失败。", 401);
  }
  return token;
}

function requiredPattern(value: string | undefined, pattern: RegExp, message: string): string {
  if (!value || !pattern.test(value)) {
    throw new SupplierNodeError("INVALID_REQUEST", message, 400);
  }
  return value;
}

function safeTextEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

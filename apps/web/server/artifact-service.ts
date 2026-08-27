import {
  ARTIFACT_CHUNK_SIZE_BYTES,
  ARTIFACT_MAX_CHUNKS,
  ARTIFACT_MAX_SIZE_BYTES,
  ARTIFACT_PROTOCOL_VERSION,
  ARTIFACT_SUPPORTED_MEDIA_TYPES,
  createArtifactManifestPayload,
  type ArtifactChunkDescriptor,
  type ArtifactSupportedMediaType,
  type ArtifactTaskView,
  type ArtifactView,
  type CompleteArtifactUploadRequest,
  type CreateArtifactTaskRequest,
  type CreateArtifactUploadRequest,
  type MarketplacePrivacyMode
} from "@token-streaming/protocol";
import {
  MarketplaceDomainError,
  assertSupplierProcessingAcknowledged,
  calculateMarketplacePrivacyRetentionMilliseconds,
  estimateArtifactMaximumChargeMicros,
  parseMarketplacePrivacyMode
} from "@token-streaming/marketplace-domain";

import { ensureSchema, getArtifactBucket, getD1 } from "@/db";
import { ApiError } from "./http";
import { getMarketplaceRuntimePolicy } from "./runtime-policy";
import {
  decryptContent,
  createDigestCommitment,
  encryptArtifactChunk,
  encryptContent,
  sha256Bytes,
  sha256Hex,
  type RequestIdentity
} from "./security";
import { enforceTenantRateLimit } from "./rate-limit";

interface ArtifactRow {
  artifact_id: string;
  tenant_id: string;
  file_name: string;
  privacy_mode: MarketplacePrivacyMode;
  media_type: ArtifactSupportedMediaType;
  size_bytes: number;
  chunk_size_bytes: number;
  chunk_count: number;
  uploaded_chunks: number;
  manifest_sha256: string | null;
  status: ArtifactView["status"];
  content_purged_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface ArtifactChunkRow {
  artifact_id: string;
  tenant_id: string;
  part_number: number;
  size_bytes: number;
  plaintext_sha256: string;
  ciphertext_sha256: string;
  storage_key: string;
  iv: string;
  uploaded_at: string;
}

interface ArtifactOfferRow {
  offer_id: string;
  tenant_id: string;
  supplier_tenant_id: string;
  authorization_request_id: string;
  provider_id: string;
  model: string;
  price_micros_per_million_tokens: string;
  concurrency: number;
  max_output_tokens: number;
}

export interface ArtifactTaskRow {
  task_id: string;
  buyer_tenant_id: string;
  supplier_tenant_id: string;
  offer_id: string;
  authorization_request_id: string;
  artifact_id: string;
  file_name?: string;
  idempotency_key: string;
  model: string;
  data_class: "P0" | "P1";
  privacy_mode: MarketplacePrivacyMode;
  instruction_digest: string;
  instruction_ciphertext: string;
  instruction_iv: string;
  content_key_version: number;
  max_output_tokens: number;
  max_total_tokens: number;
  reserved_charge_micros: string;
  status: ArtifactTaskView["status"];
  completed_segments: number;
  total_segments: number | null;
  processed_bytes: number;
  total_bytes?: number;
  attempt: number;
  worker_id: string | null;
  lease_digest: string | null;
  lease_expires_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  charge_micros: string | null;
  output_ciphertext: string | null;
  output_iv: string | null;
  output_expires_at: string | null;
  content_purged_at: string | null;
  error_code: string | null;
  evidence_digest?: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
}

export async function createArtifactUpload(
  identity: RequestIdentity,
  input: CreateArtifactUploadRequest,
  requestId: string
): Promise<{ ok: true; requestId: string; artifact: ArtifactView }> {
  await ensureSchema();
  getArtifactBucket();
  await cleanupExpiredArtifactData();
  assertExactKeys(input, ["fileName", "mediaType", "sizeBytes", "privacyMode"]);
  await enforceTenantRateLimit(identity, "artifact.upload-create", 10, 60 * 60_000);
  const privacyMode = validatePrivacyMode(input.privacyMode);
  const mediaType = validateMediaType(input.mediaType);
  const fileName = privacyMode === "strict"
    ? privateArtifactFileName(mediaType)
    : validateFileName(input.fileName);
  const sizeBytes = integer(input.sizeBytes, "sizeBytes", 1, ARTIFACT_MAX_SIZE_BYTES);
  const chunkCount = Math.ceil(sizeBytes / ARTIFACT_CHUNK_SIZE_BYTES);
  if (chunkCount < 1 || chunkCount > ARTIFACT_MAX_CHUNKS) invalid("文件分块数量超过限制。");
  const policy = getMarketplaceRuntimePolicy();
  const now = new Date().toISOString();
  const db = getD1();
  const reserved = await db.prepare(
    `SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM artifacts
     WHERE tenant_id = ? AND status <> 'deleted' AND expires_at > ?`
  ).bind(identity.tenantId, now).first<{ bytes: number }>();
  if ((reserved?.bytes ?? 0) + sizeBytes > policy.maximumTenantArtifactBytes) {
    throw new ApiError("RESOURCE_QUOTA_EXCEEDED", "当前账号未过期文件的总容量超过试运营配额。", 429, true);
  }
  const expiresAt = new Date(Date.now() + artifactRetentionMilliseconds(privacyMode, policy)).toISOString();
  const artifactId = `artifact-${crypto.randomUUID()}`;
  await db.batch([
    db.prepare(
      `INSERT INTO artifacts (
        artifact_id, tenant_id, file_name, privacy_mode, media_type, size_bytes, chunk_size_bytes,
        chunk_count, uploaded_chunks, status, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'uploading', ?, ?, ?)`
    ).bind(
      artifactId, identity.tenantId, fileName, privacyMode, mediaType, sizeBytes,
      ARTIFACT_CHUNK_SIZE_BYTES, chunkCount, expiresAt, now, now
    ),
    auditInsert(db, identity, "artifact.upload-created", artifactId, {
      mediaType,
      sizeBytes,
      chunkCount,
      privacyMode
    }, now)
  ]);
  const row = await requireOwnedArtifact(identity.tenantId, artifactId);
  return { ok: true, requestId, artifact: mapArtifact(row) };
}

export async function uploadArtifactChunk(
  identity: RequestIdentity,
  artifactId: string,
  partNumberInput: string,
  request: Request,
  requestId: string
): Promise<{
  ok: true;
  requestId: string;
  artifactId: string;
  part: ArtifactChunkDescriptor;
  uploadedChunks: number;
}> {
  await ensureSchema();
  await enforceTenantRateLimit(identity, "artifact.chunk-upload", 200, 60_000);
  assertIdentifier(artifactId, "artifactId");
  const partNumber = integer(Number(partNumberInput), "partNumber", 1, ARTIFACT_MAX_CHUNKS);
  const artifact = await requireOwnedArtifact(identity.tenantId, artifactId);
  if (artifact.status !== "uploading" || artifact.expires_at <= new Date().toISOString()) {
    throw new ApiError("CONFLICT", "文件不再接受分块上传。", 409);
  }
  if (partNumber > artifact.chunk_count) invalid("分块编号超过文件清单范围。");
  const expectedSize = expectedPartSize(artifact, partNumber);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/octet-stream") invalid("文件分块必须使用 application/octet-stream。");
  const declared = Number(request.headers.get("content-length") ?? -1);
  if (Number.isFinite(declared) && declared >= 0 && declared !== expectedSize) invalid("文件分块大小与清单不一致。");
  const expectedSha256 = request.headers.get("x-content-sha256")?.toLowerCase() ?? "";
  assertSha256(expectedSha256, "X-Content-SHA256");

  const db = getD1();
  const existing = await db.prepare(
    "SELECT * FROM artifact_chunks WHERE artifact_id = ? AND tenant_id = ? AND part_number = ?"
  ).bind(artifactId, identity.tenantId, partNumber).first<ArtifactChunkRow>();
  if (existing) {
    if (existing.size_bytes !== expectedSize || existing.plaintext_sha256 !== expectedSha256) {
      throw new ApiError("CONFLICT", "同一分块编号已经对应其他内容。", 409);
    }
    return {
      ok: true,
      requestId,
      artifactId,
      part: { partNumber, sizeBytes: existing.size_bytes, sha256: existing.plaintext_sha256 },
      uploadedChunks: artifact.uploaded_chunks
    };
  }

  const plaintext = await readBoundedBody(request, expectedSize);
  const actualSha256 = await sha256Bytes(plaintext);
  if (actualSha256 !== expectedSha256) {
    throw new ApiError("ARTIFACT_INTEGRITY_FAILED", "文件分块摘要校验失败，请重新上传该分块。", 422);
  }
  const encrypted = await encryptArtifactChunk(plaintext, {
    tenantId: identity.tenantId,
    artifactId,
    partNumber,
    plaintextSha256: actualSha256
  });
  const storageKey = `${identity.tenantId}/${artifactId}/part-${String(partNumber).padStart(4, "0")}`;
  await getArtifactBucket().put(storageKey, encrypted.ciphertext, {
    httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" },
    customMetadata: { artifactId, partNumber: String(partNumber), ciphertextSha256: encrypted.ciphertextSha256 }
  });
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      `INSERT INTO artifact_chunks (
        artifact_id, tenant_id, part_number, size_bytes, plaintext_sha256,
        ciphertext_sha256, storage_key, iv, uploaded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      artifactId, identity.tenantId, partNumber, expectedSize, actualSha256,
      encrypted.ciphertextSha256, storageKey, encrypted.iv, now
    ),
    db.prepare(
      `UPDATE artifacts SET uploaded_chunks = (
        SELECT COUNT(*) FROM artifact_chunks WHERE artifact_id = ? AND tenant_id = ?
      ), updated_at = ? WHERE artifact_id = ? AND tenant_id = ? AND status = 'uploading'`
    ).bind(artifactId, identity.tenantId, now, artifactId, identity.tenantId)
  ]);
  const count = await db.prepare(
    "SELECT COUNT(*) AS count FROM artifact_chunks WHERE artifact_id = ? AND tenant_id = ?"
  ).bind(artifactId, identity.tenantId).first<{ count: number }>();
  return {
    ok: true,
    requestId,
    artifactId,
    part: { partNumber, sizeBytes: expectedSize, sha256: actualSha256 },
    uploadedChunks: count?.count ?? 0
  };
}

export async function completeArtifactUpload(
  identity: RequestIdentity,
  artifactId: string,
  input: CompleteArtifactUploadRequest,
  requestId: string
): Promise<{ ok: true; requestId: string; artifact: ArtifactView }> {
  await ensureSchema();
  await enforceTenantRateLimit(identity, "artifact.upload-complete", 30, 60 * 60_000);
  assertIdentifier(artifactId, "artifactId");
  assertExactKeys(input, ["parts"]);
  const artifact = await requireOwnedArtifact(identity.tenantId, artifactId);
  if (artifact.status === "ready") return { ok: true, requestId, artifact: mapArtifact(artifact) };
  if (artifact.status !== "uploading" || artifact.expires_at <= new Date().toISOString()) {
    throw new ApiError("CONFLICT", "文件上传已经关闭。", 409);
  }
  const declaredParts = validatePartManifest(input.parts, artifact);
  const stored = await getD1().prepare(
    `SELECT * FROM artifact_chunks WHERE artifact_id = ? AND tenant_id = ? ORDER BY part_number ASC`
  ).bind(artifactId, identity.tenantId).all<ArtifactChunkRow>();
  if (stored.results.length !== artifact.chunk_count) {
    throw new ApiError("ARTIFACT_NOT_READY", "仍有文件分块尚未上传。", 409, true);
  }
  for (let index = 0; index < declaredParts.length; index += 1) {
    const declaredPart = declaredParts[index]!;
    const storedPart = stored.results[index]!;
    if (
      storedPart.part_number !== declaredPart.partNumber ||
      storedPart.size_bytes !== declaredPart.sizeBytes ||
      storedPart.plaintext_sha256 !== declaredPart.sha256
    ) throw new ApiError("ARTIFACT_INTEGRITY_FAILED", "文件分块清单与已上传内容不一致。", 422);
  }
  const manifestSha256 = await sha256Hex(createArtifactManifestPayload({
    artifactId,
    fileName: artifact.file_name,
    mediaType: artifact.media_type,
    sizeBytes: artifact.size_bytes,
    chunks: declaredParts
  }));
  const now = new Date().toISOString();
  const db = getD1();
  await db.batch([
    db.prepare(
      `UPDATE artifacts SET status = 'ready', uploaded_chunks = chunk_count,
       manifest_sha256 = ?, updated_at = ? WHERE artifact_id = ? AND tenant_id = ? AND status = 'uploading'`
    ).bind(manifestSha256, now, artifactId, identity.tenantId),
    auditInsert(db, identity, "artifact.upload-completed", artifactId, { manifestSha256 }, now)
  ]);
  return { ok: true, requestId, artifact: mapArtifact(await requireOwnedArtifact(identity.tenantId, artifactId)) };
}

export async function createArtifactTask(
  identity: RequestIdentity,
  input: CreateArtifactTaskRequest,
  idempotencyKey: string,
  requestId: string
): Promise<{ ok: true; requestId: string; task: ArtifactTaskView }> {
  await ensureSchema();
  await cleanupExpiredArtifactData();
  assertExactKeys(input, [
    "artifactId", "model", "instruction", "dataClass", "maxOutputTokens", "maxTotalTokens",
    "supplierProcessingAcknowledged"
  ]);
  assertIdentifier(input.artifactId, "artifactId");
  assertIdempotencyKey(idempotencyKey);
  mapPrivacyDomainError(() => assertSupplierProcessingAcknowledged(input.supplierProcessingAcknowledged));
  await enforceTenantRateLimit(identity, "artifact.task-create", 10, 60 * 60_000);
  const model = boundedText(input.model, "model", 200);
  const instruction = boundedText(input.instruction, "instruction", 8_000);
  if (input.dataClass !== "P0" && input.dataClass !== "P1") invalid("dataClass 只能是 P0 或 P1。");
  const maxOutputTokens = integer(input.maxOutputTokens, "maxOutputTokens", 1, 32_768);
  const maxTotalTokens = integer(input.maxTotalTokens, "maxTotalTokens", maxOutputTokens, 10_000_000);
  const artifact = await requireOwnedArtifact(identity.tenantId, input.artifactId);
  if (artifact.status !== "ready" || !artifact.manifest_sha256 || artifact.expires_at <= new Date().toISOString()) {
    throw new ApiError("ARTIFACT_NOT_READY", "文件尚未完成上传或已经过期。", 409);
  }
  const db = getD1();
  const existing = await db.prepare(
    `SELECT t.*, a.file_name, a.size_bytes AS total_bytes, e.evidence_digest
     FROM artifact_tasks t JOIN artifacts a ON a.artifact_id = t.artifact_id
     LEFT JOIN artifact_task_evidence e ON e.task_id = t.task_id
     WHERE t.buyer_tenant_id = ? AND t.idempotency_key = ?`
  ).bind(identity.tenantId, idempotencyKey).first<ArtifactTaskRow>();
  if (existing) return { ok: true, requestId, task: await mapTask(existing) };

  const activeTasks = await db.prepare(
    `SELECT COUNT(*) AS count FROM artifact_tasks
     WHERE buyer_tenant_id = ? AND status IN ('queued', 'claimed', 'running')`
  ).bind(identity.tenantId).first<{ count: number }>();
  if ((activeTasks?.count ?? 0) >= getMarketplaceRuntimePolicy().maximumActiveArtifactTasksPerTenant) {
    throw new ApiError("RESOURCE_QUOTA_EXCEEDED", "当前账号正在执行的大文件任务数量已达上限。", 429, true);
  }

  const now = new Date().toISOString();
  const classNeedle = `%\"${input.dataClass}\"%`;
  const offer = await db.prepare(
    `SELECT o.*, s.tenant_id AS supplier_tenant_id, ar.gateway_token_digest
     FROM capacity_offers o
     JOIN suppliers s ON s.supplier_id = o.supplier_id AND s.tenant_id = o.tenant_id
     JOIN authorization_requests ar ON ar.request_id = o.authorization_request_id AND ar.status = 'approved'
     JOIN supplier_artifact_workers w ON w.supplier_tenant_id = s.tenant_id
       AND w.provider_id = o.provider_id AND w.expires_at > ?
       AND w.max_artifact_bytes >= ?
       AND w.authorization_request_ids_json LIKE ('%"' || o.authorization_request_id || '"%')
       AND w.allowed_models_json LIKE ?
       AND w.supported_media_types_json LIKE ?
     WHERE o.status = 'active' AND o.model = ? AND o.valid_from <= ? AND o.valid_until > ?
       AND o.data_classes_json LIKE ? AND o.max_output_tokens >= ?
       AND s.status = 'active' AND s.supply_enabled = 1 AND s.tenant_id <> ?
       AND ar.gateway_token_digest IS NOT NULL
     ORDER BY CAST(o.price_micros_per_million_tokens AS INTEGER) ASC, o.created_at ASC LIMIT 1`
  ).bind(
    now, artifact.size_bytes, `%"${model}"%`, `%"${artifact.media_type}"%`,
    model, now, now, classNeedle, maxOutputTokens, identity.tenantId
  ).first<ArtifactOfferRow>();
  if (!offer) throw new ApiError("ARTIFACT_TASK_UNAVAILABLE", "当前没有已启用文件任务能力的匹配供应节点。", 409, true);
  const reservedChargeMicros = estimateArtifactMaximumChargeMicros({
    maxTotalTokens,
    priceMicrosPerMillionTokens: offer.price_micros_per_million_tokens
  });
  const available = await readAvailableBalanceMicros(identity.tenantId);
  if (available < BigInt(reservedChargeMicros)) {
    throw new ApiError("INSUFFICIENT_BALANCE", "可用余额不足以预留本次大文件任务的最高费用。", 402);
  }
  const taskId = `artifact-task-${crypto.randomUUID()}`;
  const instructionCommitment = await createDigestCommitment(await sha256Hex(instruction), {
    purpose: "artifact-instruction",
    tenantId: identity.tenantId,
    resourceId: taskId
  });
  const encryptedInstruction = await encryptContent(instruction, {
    purpose: "artifact-instruction",
    tenantId: identity.tenantId,
    resourceId: taskId
  });
  await db.batch([
    db.prepare(
      `INSERT INTO artifact_tasks (
        task_id, buyer_tenant_id, supplier_tenant_id, offer_id, authorization_request_id,
        artifact_id, idempotency_key, model, data_class, privacy_mode, instruction_digest, digest_version,
        instruction_ciphertext, instruction_iv, content_key_version, max_output_tokens, max_total_tokens,
        reserved_charge_micros, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
    ).bind(
      taskId, identity.tenantId, offer.supplier_tenant_id, offer.offer_id,
      offer.authorization_request_id, artifact.artifact_id, idempotencyKey, model,
      input.dataClass, artifact.privacy_mode, instructionCommitment.digest, instructionCommitment.version,
      encryptedInstruction.ciphertext,
      encryptedInstruction.iv, encryptedInstruction.keyVersion, maxOutputTokens, maxTotalTokens,
      reservedChargeMicros, now, now
    ),
    auditInsert(db, identity, "artifact-task.queued", taskId, {
      artifactId: artifact.artifact_id,
      offerId: offer.offer_id,
      model,
      privacyMode: artifact.privacy_mode,
      maxTotalTokens,
      reservedChargeMicros
    }, now)
  ]);
  const row = await requireTaskForTenant(identity.tenantId, taskId);
  return { ok: true, requestId, task: await mapTask(row) };
}

export async function listArtifacts(identity: RequestIdentity): Promise<ArtifactView[]> {
  await ensureSchema();
  await cleanupExpiredArtifactData();
  const rows = await getD1().prepare(
    "SELECT * FROM artifacts WHERE tenant_id = ? AND status <> 'deleted' ORDER BY created_at DESC LIMIT 20"
  ).bind(identity.tenantId).all<ArtifactRow>();
  return rows.results.map(mapArtifact);
}

/**
 * Traffic-triggered, bounded retention sweep. Artifact metadata and financial
 * history remain for audit, while customer bytes and replayable outputs are
 * physically removed after the retention window. Active tasks pin their input.
 */
export async function cleanupExpiredArtifactData(now = new Date().toISOString()): Promise<void> {
  const db = getD1();
  const policy = getMarketplaceRuntimePolicy();
  const queueCutoff = new Date(Date.parse(now) - policy.artifactQueueTimeoutMinutes * 60_000).toISOString();
  await db.batch([
    db.prepare(
      `UPDATE artifact_tasks SET status = 'queued', lease_digest = NULL, lease_expires_at = NULL,
         error_code = 'LEASE_EXPIRED', updated_at = ?
       WHERE status IN ('claimed', 'running') AND lease_expires_at <= ? AND attempt < ? AND created_at > ?`
    ).bind(now, now, policy.artifactMaximumAttempts, queueCutoff),
    db.prepare(
      `UPDATE artifact_tasks SET status = 'failed', lease_digest = NULL, lease_expires_at = NULL,
         error_code = CASE WHEN attempt >= ? THEN 'MAX_ATTEMPTS_EXCEEDED' ELSE 'QUEUE_TIMEOUT' END,
         instruction_ciphertext = '', instruction_iv = '',
         completed_at = ?, updated_at = ?
       WHERE (status = 'queued' AND created_at <= ?)
          OR (status IN ('claimed', 'running') AND lease_expires_at <= ?
              AND (attempt >= ? OR created_at <= ?))`
    ).bind(policy.artifactMaximumAttempts, now, now, queueCutoff, now, policy.artifactMaximumAttempts, queueCutoff)
  ]);
  const expired = await db.prepare(
    `SELECT a.artifact_id FROM artifacts a
     WHERE a.status <> 'deleted' AND a.expires_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM artifact_tasks t WHERE t.artifact_id = a.artifact_id
           AND t.status IN ('queued', 'claimed', 'running')
       )
     ORDER BY a.expires_at ASC LIMIT 10`
  ).bind(now).all<{ artifact_id: string }>();
  if (expired.results.length > 0) {
    const ids = expired.results.map((row) => row.artifact_id);
    const placeholders = ids.map(() => "?").join(",");
    const chunks = await db.prepare(
      `SELECT storage_key FROM artifact_chunks WHERE artifact_id IN (${placeholders})`
    ).bind(...ids).all<{ storage_key: string }>();
    if (chunks.results.length > 0) {
      await getArtifactBucket().delete(chunks.results.map((row) => row.storage_key));
    }
    await db.batch([
      db.prepare(`DELETE FROM artifact_chunks WHERE artifact_id IN (${placeholders})`).bind(...ids),
      db.prepare(
        `UPDATE artifacts SET status = 'deleted', file_name = 'deleted-artifact', manifest_sha256 = NULL,
           content_purged_at = COALESCE(content_purged_at, ?), updated_at = ?
         WHERE artifact_id IN (${placeholders}) AND status <> 'deleted'`
      ).bind(now, now, ...ids)
    ]);
  }
  await db.prepare(
    `UPDATE artifact_tasks SET output_ciphertext = NULL, output_iv = NULL,
       output_expires_at = NULL, content_purged_at = COALESCE(content_purged_at, ?), updated_at = ?
     WHERE output_expires_at IS NOT NULL AND output_expires_at <= ?`
  ).bind(now, now, now).run();
}

export async function listArtifactTasks(identity: RequestIdentity): Promise<ArtifactTaskView[]> {
  await ensureSchema();
  const rows = await getD1().prepare(
    `SELECT t.*, a.file_name, a.size_bytes AS total_bytes, e.evidence_digest
     FROM artifact_tasks t JOIN artifacts a ON a.artifact_id = t.artifact_id
     LEFT JOIN artifact_task_evidence e ON e.task_id = t.task_id
     WHERE t.buyer_tenant_id = ?
     ORDER BY t.created_at DESC LIMIT 30`
  ).bind(identity.tenantId).all<ArtifactTaskRow>();
  return Promise.all(rows.results.map(mapTask));
}

async function requireOwnedArtifact(tenantId: string, artifactId: string): Promise<ArtifactRow> {
  const row = await getD1().prepare(
    "SELECT * FROM artifacts WHERE artifact_id = ? AND tenant_id = ?"
  ).bind(artifactId, tenantId).first<ArtifactRow>();
  if (!row) throw new ApiError("NOT_FOUND", "文件不存在。", 404);
  return row;
}

async function requireTaskForTenant(tenantId: string, taskId: string): Promise<ArtifactTaskRow> {
  const row = await getD1().prepare(
    `SELECT t.*, a.file_name, a.size_bytes AS total_bytes, e.evidence_digest
     FROM artifact_tasks t JOIN artifacts a ON a.artifact_id = t.artifact_id
     LEFT JOIN artifact_task_evidence e ON e.task_id = t.task_id
     WHERE t.task_id = ? AND t.buyer_tenant_id = ?`
  ).bind(taskId, tenantId).first<ArtifactTaskRow>();
  if (!row) throw new ApiError("NOT_FOUND", "文件任务不存在。", 404);
  return row;
}

function mapArtifact(row: ArtifactRow): ArtifactView {
  const expired = row.expires_at <= new Date().toISOString() && row.status !== "deleted";
  return {
    artifactId: row.artifact_id,
    protocolVersion: ARTIFACT_PROTOCOL_VERSION,
    fileName: row.file_name,
    privacyMode: row.privacy_mode,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    chunkSizeBytes: row.chunk_size_bytes,
    chunkCount: row.chunk_count,
    uploadedChunks: row.uploaded_chunks,
    manifestSha256: row.manifest_sha256,
    status: expired ? "expired" : row.status,
    contentPurgedAt: row.content_purged_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

async function mapTask(row: ArtifactTaskRow): Promise<ArtifactTaskView> {
  const output = row.status === "completed" && row.output_ciphertext && row.output_iv &&
    row.output_expires_at && row.output_expires_at > new Date().toISOString()
    ? await decryptContent(
        row.output_ciphertext,
        row.output_iv,
        row.content_key_version,
        { purpose: "artifact-output", tenantId: row.buyer_tenant_id, resourceId: row.task_id }
      )
    : null;
  return {
    taskId: row.task_id,
    artifactId: row.artifact_id,
    fileName: row.file_name ?? "artifact",
    offerId: row.offer_id,
    model: row.model,
    privacyMode: row.privacy_mode,
    status: row.status,
    progress: {
      completedSegments: row.completed_segments,
      totalSegments: row.total_segments,
      processedBytes: row.processed_bytes,
      totalBytes: row.total_bytes ?? 0,
      attempt: row.attempt,
      updatedAt: row.updated_at
    },
    output,
    totalTokens: row.total_tokens,
    chargeMicros: row.charge_micros,
    errorCode: row.error_code,
    evidenceDigest: row.evidence_digest ?? null,
    contentExpiresAt: row.output_expires_at,
    contentPurgedAt: row.content_purged_at,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

function validatePartManifest(value: unknown, artifact: ArtifactRow): ArtifactChunkDescriptor[] {
  if (!Array.isArray(value) || value.length !== artifact.chunk_count) invalid("文件分块清单数量不正确。");
  const seen = new Set<number>();
  const parts = value.map((entry) => {
    assertExactKeys(entry, ["partNumber", "sizeBytes", "sha256"]);
    const partNumber = integer(entry.partNumber, "partNumber", 1, artifact.chunk_count);
    if (seen.has(partNumber)) invalid("文件分块清单包含重复编号。");
    seen.add(partNumber);
    const sizeBytes = integer(entry.sizeBytes, "sizeBytes", 1, ARTIFACT_CHUNK_SIZE_BYTES);
    if (sizeBytes !== expectedPartSize(artifact, partNumber)) invalid("文件分块清单大小不正确。");
    assertSha256(entry.sha256, "sha256");
    return { partNumber, sizeBytes, sha256: entry.sha256 };
  });
  return parts.sort((left, right) => left.partNumber - right.partNumber);
}

function expectedPartSize(artifact: ArtifactRow, partNumber: number): number {
  return partNumber < artifact.chunk_count
    ? artifact.chunk_size_bytes
    : artifact.size_bytes - artifact.chunk_size_bytes * (artifact.chunk_count - 1);
}

async function readBoundedBody(request: Request, expectedSize: number): Promise<ArrayBuffer> {
  if (!request.body) invalid("文件分块正文不能为空。");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > expectedSize) {
      await reader.cancel();
      invalid("文件分块大小与清单不一致。");
    }
    chunks.push(value);
  }
  if (total !== expectedSize) invalid("文件分块大小与清单不一致。");
  const merged = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

async function readAvailableBalanceMicros(tenantId: string): Promise<bigint> {
  const row = await getD1().prepare(
    `SELECT
      COALESCE((SELECT SUM(CASE WHEN direction = 'credit' THEN CAST(amount_micros AS INTEGER) ELSE -CAST(amount_micros AS INTEGER) END)
        FROM ledger_entries WHERE tenant_id = ?), 0) AS balance,
      COALESCE((SELECT SUM(CAST(reserved_charge_micros AS INTEGER)) FROM artifact_tasks
        WHERE buyer_tenant_id = ? AND status IN ('queued', 'claimed', 'running')), 0) AS reserved`
  ).bind(tenantId, tenantId).first<{ balance: number; reserved: number }>();
  return BigInt(row?.balance ?? 0) - BigInt(row?.reserved ?? 0);
}

function auditInsert(
  db: D1Database,
  identity: RequestIdentity,
  action: string,
  resourceId: string,
  details: Readonly<Record<string, unknown>>,
  occurredAt: string
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit_events (
      audit_id, tenant_id, actor_id, action, resource_type, resource_id, details_json, occurred_at
    ) VALUES (?, ?, ?, ?, 'artifact', ?, ?, ?)`
  ).bind(
    `audit-${crypto.randomUUID()}`,
    identity.tenantId,
    identity.actorId,
    action,
    resourceId,
    JSON.stringify(details),
    occurredAt
  );
}

function validateFileName(value: unknown): string {
  const name = boundedText(value, "fileName", 180).normalize("NFC");
  if (name === "." || name === ".." || /[\\/\u0000-\u001f\u007f]/.test(name)) invalid("文件名包含不允许的字符。");
  return name;
}

function validatePrivacyMode(value: unknown): MarketplacePrivacyMode {
  return mapPrivacyDomainError(() => parseMarketplacePrivacyMode(value));
}

function privateArtifactFileName(mediaType: ArtifactSupportedMediaType): string {
  const extension: Record<ArtifactSupportedMediaType, string> = {
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "text/tab-separated-values": "tsv",
    "application/json": "json",
    "application/x-ndjson": "ndjson",
    "application/xml": "xml",
    "text/xml": "xml"
  };
  return `private-artifact.${extension[mediaType]}`;
}

function artifactRetentionMilliseconds(
  privacyMode: MarketplacePrivacyMode,
  policy: ReturnType<typeof getMarketplaceRuntimePolicy>
): number {
  return mapPrivacyDomainError(() => calculateMarketplacePrivacyRetentionMilliseconds(privacyMode, policy).artifact);
}

function mapPrivacyDomainError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof MarketplaceDomainError)) throw error;
    const code = error.code === "PRIVACY_ACKNOWLEDGEMENT_REQUIRED"
      ? "PRIVACY_ACKNOWLEDGEMENT_REQUIRED"
      : "INVALID_REQUEST";
    const message = code === "PRIVACY_ACKNOWLEDGEMENT_REQUIRED"
      ? "提交前必须确认内容会发送给匹配供应节点及其上游 Provider 执行。"
      : "privacyMode 或留存策略无效。";
    throw new ApiError(code, message, 400);
  }
}

function validateMediaType(value: unknown): ArtifactSupportedMediaType {
  if (typeof value !== "string" || !(ARTIFACT_SUPPORTED_MEDIA_TYPES as readonly string[]).includes(value)) {
    throw new ApiError("ARTIFACT_TYPE_UNSUPPORTED", "当前仅支持纯文本、Markdown、CSV、JSON、NDJSON 和 XML 文件。", 415);
  }
  return value as ArtifactSupportedMediaType;
}

function assertExactKeys(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("请求必须是对象。");
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) invalid("请求字段不完整或包含未知字段。");
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(value)) invalid(`${label} 无效。`);
}

function assertIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/.test(value)) invalid("Idempotency-Key 无效。");
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") invalid(`${label} 必须是字符串。`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum || /\u0000/.test(normalized)) invalid(`${label} 长度或内容无效。`);
  return normalized;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${label} 必须是 ${minimum} 到 ${maximum} 的整数。`);
  }
  return value as number;
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid(`${label} 必须是小写 SHA-256。`);
}

function invalid(message: string): never {
  throw new ApiError("INVALID_REQUEST", message, 400);
}

import {
  SUPPLIER_ARTIFACT_EXECUTION_EVIDENCE_VERSION,
  SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION,
  createSupplierArtifactExecutionEvidencePayload,
  type SupplierArtifactAssignment,
  type SupplierArtifactTaskCheckpointRequest,
  type SupplierArtifactTaskCompleteRequest,
  type SupplierArtifactTaskFailureRequest,
  type SupplierArtifactWorkerClaimRequest,
  type SupplierArtifactWorkerClaimResponse,
  type SupplierGatewayUsage
} from "@token-streaming/protocol";
import {
  MarketplaceDomainError,
  calculateMarketplacePrivacyRetentionMilliseconds,
  calculateSettlement,
  verifySupplierArtifactEvidence
} from "@token-streaming/marketplace-domain";

import { ensureSchema, getArtifactBucket, getD1 } from "@/db";
import type { AgentAuthorizationIdentity } from "./agent-auth";
import { cleanupExpiredArtifactData, type ArtifactTaskRow } from "./artifact-service";
import { ApiError } from "./http";
import { getMarketplaceRuntimePolicy } from "./runtime-policy";
import { COMPLETE_ARTIFACT_TASK_SQL } from "./financial-invariants";
import {
  decryptArtifactChunk,
  decryptContent,
  createDigestCommitment,
  encryptContent,
  sha256Bytes,
  sha256Hex
} from "./security";

interface WorkerTaskRow extends ArtifactTaskRow {
  artifact_file_name: string;
  artifact_media_type: SupplierArtifactAssignment["artifact"]["media_type"];
  artifact_size_bytes: number;
  artifact_manifest_sha256: string;
  provider_id: string;
  price_micros_per_million_tokens: string;
}

interface ChunkRow {
  artifact_id: string;
  tenant_id: string;
  part_number: number;
  size_bytes: number;
  plaintext_sha256: string;
  ciphertext_sha256: string;
  storage_key: string;
  iv: string;
}

export async function claimArtifactTask(
  identity: AgentAuthorizationIdentity,
  input: SupplierArtifactWorkerClaimRequest
): Promise<SupplierArtifactWorkerClaimResponse> {
  await ensureSchema();
  assertExactKeys(input, [
    "protocol_version", "request_id", "worker_id", "provider_id", "allowed_models",
    "supported_media_types", "max_artifact_bytes"
  ]);
  assertWorkerEnvelope(identity, input.protocol_version, input.request_id);
  const workerId = identifier(input.worker_id, "worker_id");
  const providerId = identifier(input.provider_id, "provider_id");
  const allowedModels = exactModels(input.allowed_models);
  const supportedMediaTypes = supportedTypes(input.supported_media_types);
  const maxArtifactBytes = integer(input.max_artifact_bytes, "max_artifact_bytes", 1, 256 * 1024 * 1024);
  const authorized = identity.authorizations.filter((item) =>
    item.providerId === providerId && allowedModels.includes(item.modelPattern)
  );
  if (authorized.length === 0) throw new ApiError("AUTHORIZATION_REQUIRED", "Agent 声明的 Provider 或模型未获授权。", 403);
  const db = getD1();
  const now = new Date().toISOString();
  const heartbeatExpiresAt = new Date(Date.now() + 2 * 60_000).toISOString();
  const heartbeat = await db.prepare(agentHeartbeatUpsertSql(authorized.length)).bind(
    identity.supplierTenantId, workerId, providerId,
    JSON.stringify(authorized.map((item) => item.requestId).sort()),
    JSON.stringify([...allowedModels].sort()),
    JSON.stringify([...supportedMediaTypes].sort()),
    maxArtifactBytes, now, heartbeatExpiresAt,
    identity.supplierTenantId,
    identity.supplierId,
    now,
    ...authorized.flatMap((item) => [item.requestId, item.authorizationRevision]),
    authorized.length
  ).run();
  if ((heartbeat.meta.changes ?? 0) !== 1) {
    throw new ApiError("CONFLICT", "Agent 授权在能力登记期间发生变化。", 409, true);
  }
  const policy = getMarketplaceRuntimePolicy();
  const maximumAttempts = policy.artifactMaximumAttempts;
  await db.batch([
    db.prepare(
      `UPDATE artifact_tasks SET status = 'cancelled', lease_digest = NULL, lease_expires_at = NULL,
       execution_deadline_at = NULL,
       instruction_ciphertext = '', instruction_iv = '',
       error_code = CASE WHEN error_code = 'AUTHORIZATION_REVOKED_PENDING'
         THEN 'AUTHORIZATION_REVOKED' ELSE 'USER_CANCELLED' END,
       completed_at = ?, updated_at = ?
       WHERE supplier_tenant_id = ? AND cancellation_requested_at IS NOT NULL
         AND status IN ('claimed', 'running')
         AND (lease_expires_at < ? OR execution_deadline_at IS NULL OR execution_deadline_at <= ?)`
    ).bind(now, now, identity.supplierTenantId, now, now),
    db.prepare(
      `UPDATE artifact_tasks SET status = 'queued', lease_digest = NULL, lease_expires_at = NULL,
       worker_id = CASE
         WHEN execution_deadline_at IS NULL OR execution_deadline_at <= ? THEN NULL
         ELSE worker_id
       END,
       execution_deadline_at = NULL,
       error_code = CASE
         WHEN execution_deadline_at IS NULL OR execution_deadline_at <= ?
           THEN 'EXECUTION_DEADLINE_EXCEEDED'
         ELSE 'LEASE_EXPIRED'
       END, updated_at = ?
       WHERE supplier_tenant_id = ? AND status IN ('claimed', 'running')
         AND cancellation_requested_at IS NULL
         AND (lease_expires_at < ? OR execution_deadline_at IS NULL OR execution_deadline_at <= ?) AND attempt < ?`
    ).bind(now, now, now, identity.supplierTenantId, now, now, maximumAttempts),
    db.prepare(
      `UPDATE artifact_tasks SET status = 'failed', lease_digest = NULL, lease_expires_at = NULL,
       execution_deadline_at = NULL,
       instruction_ciphertext = '', instruction_iv = '',
       error_code = 'LEASE_EXPIRED', completed_at = ?, updated_at = ?
       WHERE supplier_tenant_id = ? AND status IN ('claimed', 'running')
         AND cancellation_requested_at IS NULL
         AND (lease_expires_at < ? OR execution_deadline_at IS NULL OR execution_deadline_at <= ?) AND attempt >= ?`
    ).bind(now, now, identity.supplierTenantId, now, now, maximumAttempts)
  ]);
  const candidates = await db.prepare(
      `SELECT t.*, a.file_name AS artifact_file_name, a.media_type AS artifact_media_type,
      a.size_bytes AS artifact_size_bytes, a.manifest_sha256 AS artifact_manifest_sha256,
      o.provider_id, o.price_micros_per_million_tokens
     FROM artifact_tasks t
     JOIN artifacts a ON a.artifact_id = t.artifact_id
       AND a.tenant_id = t.buyer_tenant_id AND a.status = 'ready'
     JOIN capacity_offers o ON o.offer_id = t.offer_id
       AND o.tenant_id = t.supplier_tenant_id
       AND o.authorization_request_id = t.authorization_request_id
       AND o.status = 'active' AND o.valid_until > ?
     WHERE t.supplier_tenant_id = ? AND t.status = 'queued'
     ORDER BY t.created_at ASC LIMIT 20`
  ).bind(now, identity.supplierTenantId).all<WorkerTaskRow>();
  const authorizationIds = new Set(authorized.map((item) => item.requestId));
  const candidate = candidates.results.find((row) =>
    row.provider_id === providerId && allowedModels.includes(row.model) &&
    supportedMediaTypes.includes(row.artifact_media_type) && row.artifact_size_bytes <= maxArtifactBytes &&
    authorizationIds.has(row.authorization_request_id)
  );
  if (!candidate) {
    return {
      protocol_version: SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION,
      request_id: input.request_id,
      task: null,
      retry_after_ms: 5_000
    };
  }
  const candidateAuthorization = authorized.find((item) =>
    item.requestId === candidate.authorization_request_id
  )!;

  const resumeFromSegment = candidate.worker_id === workerId ? candidate.completed_segments : 0;
  const leaseToken = randomToken();
  const leaseDigest = await sha256Hex(leaseToken);
  const executionDeadlineAt = new Date(
    Date.now() + policy.artifactMaximumExecutionMinutes * 60_000
  ).toISOString();
  const leaseExpiresAt = new Date(Math.min(
    Date.now() + policy.artifactLeaseMinutes * 60_000,
    Date.parse(executionDeadlineAt)
  )).toISOString();
  const claimed = await db.prepare(
    `UPDATE artifact_tasks SET status = 'claimed', worker_id = ?, lease_digest = ?, lease_expires_at = ?,
      execution_deadline_at = ?,
      attempt = attempt + 1, completed_segments = ?, total_segments = CASE WHEN ? = 0 THEN NULL ELSE total_segments END,
      processed_bytes = CASE WHEN ? = 0 THEN 0 ELSE processed_bytes END,
      input_tokens = CASE WHEN ? = 0 THEN NULL ELSE input_tokens END,
      output_tokens = CASE WHEN ? = 0 THEN NULL ELSE output_tokens END,
      total_tokens = CASE WHEN ? = 0 THEN NULL ELSE total_tokens END,
      started_at = COALESCE(started_at, ?), updated_at = ?, error_code = NULL
     WHERE task_id = ? AND supplier_tenant_id = ?
       AND authorization_request_id = ? AND status = 'queued'
       AND cancellation_requested_at IS NULL
       AND EXISTS (
         SELECT 1 FROM capacity_offers o
         JOIN suppliers s ON s.supplier_id = o.supplier_id AND s.tenant_id = o.tenant_id
         JOIN authorization_requests ar ON ar.request_id = o.authorization_request_id
           AND ar.authorization_revision = ?
         WHERE o.offer_id = artifact_tasks.offer_id
           AND o.authorization_request_id = artifact_tasks.authorization_request_id
           AND o.tenant_id = artifact_tasks.supplier_tenant_id AND o.status = 'active'
           AND o.valid_from <= ? AND o.valid_until > ? AND ar.status = 'approved'
           AND ar.valid_until > ? AND ar.tenant_id = o.tenant_id
           AND ar.supplier_id = o.supplier_id AND ar.provider_id = o.provider_id
           AND s.status = 'active' AND s.supply_enabled = 1
           AND (
             (SELECT COUNT(*) FROM inference_jobs
               WHERE offer_id = artifact_tasks.offer_id AND status IN ('reserved', 'running'))
             + (SELECT COUNT(*) FROM artifact_tasks active_tasks
             WHERE active_tasks.offer_id = artifact_tasks.offer_id
                 AND active_tasks.status IN ('claimed', 'running'))
           ) < o.concurrency
       ) AND EXISTS (
         SELECT 1 FROM supplier_artifact_workers w
         WHERE w.supplier_tenant_id = ? AND w.worker_id = ? AND w.provider_id = ?
           AND w.expires_at > ?
           AND w.authorization_request_ids_json LIKE ('%' || '"' || artifact_tasks.authorization_request_id || '"' || '%')
       )`
  ).bind(
    workerId, leaseDigest, leaseExpiresAt, executionDeadlineAt, resumeFromSegment,
    resumeFromSegment, resumeFromSegment, resumeFromSegment, resumeFromSegment, resumeFromSegment,
    now, now, candidate.task_id, identity.supplierTenantId,
    candidate.authorization_request_id, candidateAuthorization.authorizationRevision,
    now, now, now,
    identity.supplierTenantId, workerId, providerId, now
  ).run();
  if ((claimed.meta.changes ?? 0) !== 1) {
    return {
      protocol_version: SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION,
      request_id: input.request_id,
      task: null,
      retry_after_ms: 1_000
    };
  }
  const chunks = await db.prepare(
    `SELECT * FROM artifact_chunks WHERE artifact_id = ? AND tenant_id = ?
     AND upload_status = 'ready' ORDER BY part_number ASC`
  ).bind(candidate.artifact_id, candidate.buyer_tenant_id).all<ChunkRow>();
  if (chunks.results.length === 0) throw new ApiError("ARTIFACT_INTEGRITY_FAILED", "文件任务缺少已验证分块。", 500);
  const instruction = await decryptContent(
    candidate.instruction_ciphertext,
    candidate.instruction_iv,
    candidate.content_key_version,
    {
      purpose: "artifact-instruction",
      tenantId: candidate.buyer_tenant_id,
      resourceId: candidate.task_id
    }
  );
  const assignment: SupplierArtifactAssignment = {
    protocol_version: SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION,
    task_id: candidate.task_id,
    lease_token: leaseToken,
    lease_expires_at: leaseExpiresAt,
    attempt: candidate.attempt + 1,
    resume_from_segment: resumeFromSegment,
    privacy_mode: candidate.privacy_mode,
    model: candidate.model,
    instruction,
    data_class: candidate.data_class,
    max_output_tokens: candidate.max_output_tokens,
    max_total_tokens: candidate.max_total_tokens,
    artifact: {
      artifact_id: candidate.artifact_id,
      file_name: candidate.artifact_file_name,
      media_type: candidate.artifact_media_type,
      size_bytes: candidate.artifact_size_bytes,
      manifest_sha256: candidate.artifact_manifest_sha256,
      chunks: chunks.results.map((chunk) => ({
        part_number: chunk.part_number,
        size_bytes: chunk.size_bytes,
        sha256: chunk.plaintext_sha256
      }))
    }
  };
  return {
    protocol_version: SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION,
    request_id: input.request_id,
    task: assignment,
    retry_after_ms: 0
  };
}

export async function readArtifactTaskChunk(
  identity: AgentAuthorizationIdentity,
  taskId: string,
  partNumberInput: string,
  leaseToken: string | null
): Promise<Response> {
  await ensureSchema();
  const partNumber = integer(Number(partNumberInput), "partNumber", 1, 100_000);
  const task = await requireLeasedTask(identity, taskId, leaseToken);
  const chunk = await getD1().prepare(
    `SELECT c.* FROM artifact_chunks c
     WHERE c.artifact_id = ? AND c.tenant_id = ? AND c.part_number = ?
       AND c.upload_status = 'ready'`
  ).bind(task.artifact_id, task.buyer_tenant_id, partNumber).first<ChunkRow>();
  if (!chunk) throw new ApiError("NOT_FOUND", "文件分块不存在。", 404);
  const object = await getArtifactBucket().get(chunk.storage_key);
  if (!object) throw new ApiError("ARTIFACT_STORAGE_UNAVAILABLE", "文件分块对象不可用。", 503, true);
  const ciphertext = await object.arrayBuffer();
  if (await sha256Bytes(ciphertext) !== chunk.ciphertext_sha256) {
    throw new ApiError("ARTIFACT_INTEGRITY_FAILED", "文件密文摘要校验失败。", 500);
  }
  const plaintext = await decryptArtifactChunk(ciphertext, chunk.iv, {
    tenantId: chunk.tenant_id,
    artifactId: chunk.artifact_id,
    partNumber: chunk.part_number,
    plaintextSha256: chunk.plaintext_sha256
  });
  if (plaintext.byteLength !== chunk.size_bytes || await sha256Bytes(plaintext) !== chunk.plaintext_sha256) {
    throw new ApiError("ARTIFACT_INTEGRITY_FAILED", "文件明文摘要校验失败。", 500);
  }
  return new Response(plaintext, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/octet-stream",
      "content-length": String(plaintext.byteLength),
      "x-content-sha256": chunk.plaintext_sha256,
      "x-content-type-options": "nosniff"
    }
  });
}

export async function checkpointArtifactTask(
  identity: AgentAuthorizationIdentity,
  input: SupplierArtifactTaskCheckpointRequest
): Promise<{ ok: true; leaseExpiresAt: string }> {
  await ensureSchema();
  assertExactKeys(input, [
    "protocol_version", "request_id", "task_id", "lease_token", "completed_segments",
    "total_segments", "processed_bytes", "usage"
  ]);
  assertWorkerEnvelope(identity, input.protocol_version, input.request_id);
  const task = await requireLeasedTask(identity, input.task_id, input.lease_token);
  const completedSegments = integer(input.completed_segments, "completed_segments", 0, 100_000);
  const totalSegments = integer(input.total_segments, "total_segments", 1, 100_000);
  const processedBytes = integer(input.processed_bytes, "processed_bytes", 0, task.artifact_size_bytes);
  const usage = validateUsage(input.usage, task.max_total_tokens);
  if (
    completedSegments > totalSegments || completedSegments < task.completed_segments ||
    processedBytes < task.processed_bytes || usage.input_tokens < (task.input_tokens ?? 0) ||
    usage.output_tokens < (task.output_tokens ?? 0) || usage.total_tokens < (task.total_tokens ?? 0)
  ) throw new ApiError("CONFLICT", "任务检查点不能倒退或超出任务边界。", 409);
  const now = new Date().toISOString();
  if (!task.execution_deadline_at) throw invalidLease();
  const leaseExpiresAt = new Date(Math.min(
    Date.now() + getMarketplaceRuntimePolicy().artifactLeaseMinutes * 60_000,
    Date.parse(task.execution_deadline_at)
  )).toISOString();
  const db = getD1();
  const leaseDigest = await sha256Hex(input.lease_token);
  const results = await db.batch([
    db.prepare(
      `UPDATE artifact_tasks SET status = 'running', completed_segments = ?, total_segments = ?,
        processed_bytes = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?,
        lease_expires_at = ?, updated_at = ?
       WHERE task_id = ? AND supplier_tenant_id = ? AND lease_digest = ?
         AND status IN ('claimed', 'running') AND cancellation_requested_at IS NULL
          AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND execution_deadline_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND completed_segments <= ? AND processed_bytes <= ?
          AND COALESCE(input_tokens, 0) <= ? AND COALESCE(output_tokens, 0) <= ?
          AND COALESCE(total_tokens, 0) <= ? AND (total_segments IS NULL OR total_segments = ?)`
    ).bind(
      completedSegments, totalSegments, processedBytes,
      usage.input_tokens, usage.output_tokens, usage.total_tokens,
      leaseExpiresAt, now, task.task_id, identity.supplierTenantId, leaseDigest,
      completedSegments, processedBytes, usage.input_tokens, usage.output_tokens,
      usage.total_tokens, totalSegments
    ),
    db.prepare(
      `INSERT INTO artifact_task_checkpoints (
        checkpoint_id, task_id, attempt, completed_segments, total_segments, processed_bytes,
        input_tokens, output_tokens, total_tokens, occurred_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM artifact_tasks WHERE task_id = ? AND supplier_tenant_id = ?
            AND lease_digest = ? AND status = 'running' AND updated_at = ?
            AND completed_segments = ? AND total_segments = ? AND processed_bytes = ?
            AND input_tokens = ? AND output_tokens = ? AND total_tokens = ?
        )`
    ).bind(
      `artifact-checkpoint-${crypto.randomUUID()}`, task.task_id, task.attempt,
      completedSegments, totalSegments, processedBytes,
      usage.input_tokens, usage.output_tokens, usage.total_tokens, now,
      task.task_id, identity.supplierTenantId, leaseDigest, now,
      completedSegments, totalSegments, processedBytes,
      usage.input_tokens, usage.output_tokens, usage.total_tokens
    )
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw invalidLease();
  }
  return { ok: true, leaseExpiresAt };
}

export async function completeArtifactTask(
  identity: AgentAuthorizationIdentity,
  input: SupplierArtifactTaskCompleteRequest
): Promise<{ ok: true; taskId: string; status: "completed"; chargeMicros: string }> {
  await ensureSchema();
  assertExactKeys(input, [
    "protocol_version", "request_id", "task_id", "lease_token", "output", "usage",
    "execution_evidence", "execution_evidence_signature"
  ]);
  assertWorkerEnvelope(identity, input.protocol_version, input.request_id);
  const task = await requireLeasedTask(identity, input.task_id, input.lease_token);
  const output = boundedText(input.output, "output", 200_000);
  const usage = validateUsage(input.usage, task.max_total_tokens);
  if (task.processed_bytes !== task.artifact_size_bytes || task.completed_segments < 1) {
    throw new ApiError("ARTIFACT_INTEGRITY_FAILED", "任务尚未通过覆盖完整文件的最终检查点。", 409);
  }
  if (task.total_segments !== task.completed_segments) {
    throw new ApiError("ARTIFACT_INTEGRITY_FAILED", "任务分段尚未全部完成。", 409);
  }
  if (usage.total_tokens !== task.total_tokens) {
    throw new ApiError("ARTIFACT_INTEGRITY_FAILED", "最终用量与最近检查点不一致。", 409);
  }
  const evidence = input.execution_evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) evidenceFailure();
  if (evidence.evidence_version !== SUPPLIER_ARTIFACT_EXECUTION_EVIDENCE_VERSION) evidenceFailure();
  if (!/^[a-f0-9]{64}$/.test(input.execution_evidence_signature)) evidenceFailure();
  const payload = createSupplierArtifactExecutionEvidencePayload(evidence);
  const signatureMatches = await verifyHmac(identity.gatewayToken, payload, input.execution_evidence_signature);
  if (!signatureMatches) evidenceFailure();
  const outputSha256 = await sha256Hex(output);
  let verified;
  try {
    verified = verifySupplierArtifactEvidence({
      taskId: task.task_id,
      providerId: task.provider_id,
      requestedModel: task.model,
      artifactId: task.artifact_id,
      artifactManifestSha256: task.artifact_manifest_sha256,
      outputSha256,
      usage,
      requestStartedAt: task.started_at ?? task.created_at,
      verifiedAt: new Date().toISOString()
    }, evidence);
  } catch (error) {
    if (error instanceof MarketplaceDomainError) evidenceFailure();
    throw error;
  }
  const policy = getMarketplaceRuntimePolicy();
  const settlement = calculateSettlement({
    totalTokens: usage.total_tokens,
    priceMicrosPerMillionTokens: task.price_micros_per_million_tokens,
    platformFeeBps: policy.platformFeeBps
  });
  if (BigInt(settlement.buyerChargeMicros) > BigInt(task.reserved_charge_micros)) {
    throw new ApiError("ARTIFACT_INTEGRITY_FAILED", "最终费用超过任务预留上限。", 409);
  }
  const now = new Date().toISOString();
  const outputEncrypted = await encryptContent(output, {
    purpose: "artifact-output",
    tenantId: task.buyer_tenant_id,
    resourceId: task.task_id
  });
  const retention = calculateMarketplacePrivacyRetentionMilliseconds(task.privacy_mode, policy);
  const outputExpiresAt = new Date(Date.now() + retention.output).toISOString();
  const standardArtifactExpiresAt = new Date(
    Date.now() + policy.standardArtifactRetentionHours * 60 * 60_000
  ).toISOString();
  const evidenceDigest = await sha256Hex(`${payload}\n${input.execution_evidence_signature}`);
  const [manifestCommitment, contentCommitment, outputCommitment] = await Promise.all([
    createDigestCommitment(verified.artifactManifestSha256, {
      purpose: "artifact-manifest",
      tenantId: task.buyer_tenant_id,
      resourceId: task.task_id
    }),
    createDigestCommitment(verified.artifactContentSha256, {
      purpose: "artifact-content",
      tenantId: task.buyer_tenant_id,
      resourceId: task.task_id
    }),
    createDigestCommitment(verified.outputSha256, {
      purpose: "artifact-output",
      tenantId: task.buyer_tenant_id,
      resourceId: task.task_id
    })
  ]);
  const db = getD1();
  const leaseDigest = await sha256Hex(input.lease_token);
  const statements = [
    db.prepare(COMPLETE_ARTIFACT_TASK_SQL).bind(
      usage.input_tokens, usage.output_tokens, usage.total_tokens, settlement.buyerChargeMicros,
      outputEncrypted.ciphertext, outputEncrypted.iv, outputEncrypted.keyVersion, outputExpiresAt,
      now, now, task.task_id, identity.supplierTenantId, leaseDigest,
      task.attempt, task.completed_segments, task.total_segments, task.processed_bytes,
      task.input_tokens, task.output_tokens, task.total_tokens,
      settlement.buyerChargeMicros,
      task.buyer_tenant_id, task.buyer_tenant_id,
      task.buyer_tenant_id, task.task_id, settlement.buyerChargeMicros
    ),
    db.prepare(
      `INSERT INTO artifact_task_evidence (
        evidence_id, task_id, provider_id, requested_model, served_model, artifact_id,
        artifact_manifest_sha256, artifact_content_sha256, output_sha256, digest_version,
        provider_request_ids_sha256, segments_completed, input_tokens, output_tokens,
        total_tokens, evidence_digest, buyer_charge_micros, supplier_credit_micros,
        platform_fee_micros, completed_at, recorded_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM artifact_tasks
         WHERE task_id = ? AND supplier_tenant_id = ? AND status = 'completed'
           AND completed_at = ? AND charge_micros = ?
       )`
    ).bind(
      `artifact-evidence-${crypto.randomUUID()}`, task.task_id, verified.providerId,
      verified.requestedModel, verified.servedModel, verified.artifactId,
      manifestCommitment.digest, contentCommitment.digest, outputCommitment.digest,
      manifestCommitment.version,
      verified.providerRequestIdsSha256, verified.segmentsCompleted,
      usage.input_tokens, usage.output_tokens, usage.total_tokens, evidenceDigest,
      settlement.buyerChargeMicros, settlement.supplierCreditMicros, settlement.platformFeeMicros,
      verified.completedAt, now,
      task.task_id, identity.supplierTenantId, now, settlement.buyerChargeMicros
    ),
    guardedLedgerInsert(task.buyer_tenant_id, `buyer-${task.buyer_tenant_id}`, task.task_id, "inference-debit", "debit", settlement.buyerChargeMicros, now, evidenceDigest),
    guardedLedgerInsert(task.supplier_tenant_id, `supplier-${task.supplier_tenant_id}`, task.task_id, "supplier-credit", "credit", settlement.supplierCreditMicros, now, evidenceDigest),
    db.prepare(
      `INSERT INTO usage_records (
        usage_id, job_id, buyer_tenant_id, supplier_tenant_id, offer_id, provider_request_id,
        input_tokens, output_tokens, total_tokens, receipt_ref, occurred_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM artifact_task_evidence WHERE task_id = ? AND evidence_digest = ?)`
    ).bind(
      `usage-${crypto.randomUUID()}`, task.task_id, task.buyer_tenant_id, task.supplier_tenant_id,
      task.offer_id, verified.providerRequestIdsSha256, usage.input_tokens, usage.output_tokens,
      usage.total_tokens, evidenceDigest, now, task.task_id, evidenceDigest
    ),
    db.prepare(
      `INSERT INTO audit_events (
        audit_id, tenant_id, actor_id, action, resource_type, resource_id, details_json, occurred_at
      ) SELECT ?, ?, ?, 'artifact-task.completed', 'artifact-task', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM artifact_task_evidence WHERE task_id = ? AND evidence_digest = ?)`
    ).bind(
      `audit-${crypto.randomUUID()}`, task.buyer_tenant_id, `agent-${identity.credentialDigest.slice(0, 24)}`,
      task.task_id, JSON.stringify({ evidenceDigest, totalTokens: usage.total_tokens, chargeMicros: settlement.buyerChargeMicros }), now,
      task.task_id, evidenceDigest
    ),
    db.prepare(
      `UPDATE artifacts SET expires_at = CASE
         WHEN ? = 'strict' THEN ?
         WHEN expires_at < ? THEN ?
         ELSE expires_at END,
       updated_at = ?
       WHERE artifact_id = ?
         AND EXISTS (SELECT 1 FROM artifact_task_evidence WHERE task_id = ? AND evidence_digest = ?)`
    ).bind(
      task.privacy_mode, now, standardArtifactExpiresAt, standardArtifactExpiresAt,
      now, task.artifact_id, task.task_id, evidenceDigest
    )
  ];
  if (settlement.platformFeeMicros !== "0") {
    statements.push(guardedLedgerInsert("platform", "platform-fees", task.task_id, "platform-fee", "credit", settlement.platformFeeMicros, now, evidenceDigest));
  }
  await db.batch(statements);
  const recorded = await db.prepare(
    `SELECT t.status, t.cancellation_requested_at, t.error_code, e.evidence_digest FROM artifact_tasks t
     LEFT JOIN artifact_task_evidence e ON e.task_id = t.task_id WHERE t.task_id = ?`
  ).bind(task.task_id).first<{
    status: string;
    cancellation_requested_at: string | null;
    error_code: string | null;
    evidence_digest: string | null;
  }>();
  if (recorded?.cancellation_requested_at || recorded?.status === "cancelled") {
    throw new ApiError("ARTIFACT_TASK_CANCELLED", artifactCancellationMessage(recorded.error_code, "结果未结算。"), 409);
  }
  if (recorded?.status !== "completed" || recorded.evidence_digest !== evidenceDigest) {
    throw new ApiError("INSUFFICIENT_BALANCE", "预留已失效或可用余额不足，平台未写入任何结算记录。", 409);
  }
  if (task.privacy_mode === "strict") await cleanupExpiredArtifactData(now);
  return { ok: true, taskId: task.task_id, status: "completed", chargeMicros: settlement.buyerChargeMicros };
}

export async function failArtifactTask(
  identity: AgentAuthorizationIdentity,
  input: SupplierArtifactTaskFailureRequest
): Promise<{ ok: true; taskId: string; status: "queued" | "failed" }> {
  await ensureSchema();
  assertExactKeys(input, ["protocol_version", "request_id", "task_id", "lease_token", "code", "retryable"]);
  assertWorkerEnvelope(identity, input.protocol_version, input.request_id);
  const task = await requireLeasedTask(identity, input.task_id, input.lease_token);
  if (typeof input.code !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(input.code)) invalid("任务失败代码无效。");
  if (typeof input.retryable !== "boolean") invalid("retryable 必须是布尔值。");
  const retry = input.retryable && task.attempt < getMarketplaceRuntimePolicy().artifactMaximumAttempts;
  const status = retry ? "queued" : "failed";
  const now = new Date().toISOString();
  const updated = await getD1().prepare(
    `UPDATE artifact_tasks SET status = ?, lease_digest = NULL, lease_expires_at = NULL,
      execution_deadline_at = NULL,
      error_code = ?,
      instruction_ciphertext = CASE WHEN ? = 1 THEN '' ELSE instruction_ciphertext END,
      instruction_iv = CASE WHEN ? = 1 THEN '' ELSE instruction_iv END,
      updated_at = ?, completed_at = ?
     WHERE task_id = ? AND supplier_tenant_id = ? AND lease_digest = ?
       AND status IN ('claimed', 'running') AND cancellation_requested_at IS NULL
       AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       AND execution_deadline_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  ).bind(
    status, input.code, retry ? 0 : 1, retry ? 0 : 1, now, retry ? null : now,
    task.task_id, identity.supplierTenantId, await sha256Hex(input.lease_token)
  ).run();
  if ((updated.meta.changes ?? 0) !== 1) throw invalidLease();
  if (!retry && task.privacy_mode === "strict") {
    await getD1().prepare(
      "UPDATE artifacts SET expires_at = ?, updated_at = ? WHERE artifact_id = ?"
    ).bind(now, now, task.artifact_id).run();
    await cleanupExpiredArtifactData(now);
  }
  return { ok: true, taskId: task.task_id, status };
}

async function requireLeasedTask(
  identity: AgentAuthorizationIdentity,
  taskIdInput: string,
  leaseToken: string | null
): Promise<WorkerTaskRow> {
  const taskId = identifier(taskIdInput, "task_id");
  if (!leaseToken || leaseToken.length < 32 || leaseToken.length > 256) throw invalidLease();
  const leaseDigest = await sha256Hex(leaseToken);
  const task = await getD1().prepare(
    `SELECT t.*, a.file_name AS artifact_file_name, a.media_type AS artifact_media_type,
      a.size_bytes AS artifact_size_bytes, a.manifest_sha256 AS artifact_manifest_sha256,
      o.provider_id, o.price_micros_per_million_tokens
     FROM artifact_tasks t
     JOIN artifacts a ON a.artifact_id = t.artifact_id AND a.tenant_id = t.buyer_tenant_id
     JOIN capacity_offers o ON o.offer_id = t.offer_id
       AND o.tenant_id = t.supplier_tenant_id
       AND o.authorization_request_id = t.authorization_request_id
     WHERE t.task_id = ? AND t.supplier_tenant_id = ? AND t.lease_digest = ?
       AND t.lease_expires_at > ? AND t.execution_deadline_at > ?
       AND t.status IN ('claimed', 'running')
       AND t.cancellation_requested_at IS NULL`
  ).bind(
    taskId, identity.supplierTenantId, leaseDigest,
    new Date().toISOString(), new Date().toISOString()
  ).first<WorkerTaskRow>();
  if (!task) {
    const terminal = await getD1().prepare(
      `SELECT status, cancellation_requested_at, privacy_mode, artifact_id, lease_digest, error_code
       FROM artifact_tasks WHERE task_id = ? AND supplier_tenant_id = ?`
    ).bind(taskId, identity.supplierTenantId).first<{
      status: string;
      cancellation_requested_at: string | null;
      privacy_mode: "standard" | "strict";
      artifact_id: string;
      lease_digest: string | null;
      error_code: string | null;
    }>();
    if (terminal?.cancellation_requested_at && terminal.lease_digest === leaseDigest) {
      const now = new Date().toISOString();
      await getD1().batch([
        getD1().prepare(
          `UPDATE artifact_tasks SET status = 'cancelled', lease_digest = NULL, lease_expires_at = NULL,
             execution_deadline_at = NULL,
             error_code = CASE WHEN error_code = 'AUTHORIZATION_REVOKED_PENDING'
               THEN 'AUTHORIZATION_REVOKED' ELSE 'USER_CANCELLED' END,
             completed_at = COALESCE(completed_at, ?), updated_at = ?
           WHERE task_id = ? AND supplier_tenant_id = ? AND lease_digest = ?
             AND cancellation_requested_at IS NOT NULL AND status IN ('claimed', 'running')`
        ).bind(now, now, taskId, identity.supplierTenantId, leaseDigest),
        getD1().prepare(
          `UPDATE artifacts SET expires_at = ?, updated_at = ?
           WHERE artifact_id = ? AND privacy_mode = 'strict'
             AND EXISTS (SELECT 1 FROM artifact_tasks WHERE task_id = ? AND status = 'cancelled')`
        ).bind(now, now, terminal.artifact_id, taskId)
      ]);
      if (terminal.privacy_mode === "strict") await cleanupExpiredArtifactData(now);
      throw new ApiError("ARTIFACT_TASK_CANCELLED", artifactCancellationMessage(terminal.error_code, "平台不会接收或结算后续结果。"), 409);
    }
    if (terminal?.status === "cancelled") {
      throw new ApiError("ARTIFACT_TASK_CANCELLED", artifactCancellationMessage(terminal.error_code, "平台不会接收或结算后续结果。"), 409);
    }
    throw invalidLease();
  }
  if (!identity.authorizations.some((item) => item.requestId === task.authorization_request_id)) throw invalidLease();
  return task;
}

function assertWorkerEnvelope(
  identity: AgentAuthorizationIdentity,
  protocolVersion: unknown,
  requestId: unknown
): void {
  if (protocolVersion !== SUPPLIER_ARTIFACT_WORKER_PROTOCOL_VERSION) invalid("Agent 文件任务协议版本不受支持。");
  if (requestId !== identity.signedJobId) throw new ApiError("AUTHENTICATION_REQUIRED", "Agent 请求标识与签名不一致。", 401);
}

function artifactCancellationMessage(errorCode: string | null, consequence: string): string {
  return errorCode?.startsWith("AUTHORIZATION_REVOKED")
    ? `供应授权已撤销；${consequence}`
    : `文件任务已由购买方取消；${consequence}`;
}

function agentHeartbeatUpsertSql(authorizationCount: number): string {
  if (!Number.isInteger(authorizationCount) || authorizationCount < 1 || authorizationCount > 100) {
    throw new RangeError("Agent heartbeat authorization count is out of bounds");
  }
  const revisions = Array.from(
    { length: authorizationCount },
    () => "(request_id = ? AND authorization_revision = ?)"
  ).join(" OR ");
  return `INSERT INTO supplier_artifact_workers (
      supplier_tenant_id, worker_id, provider_id, authorization_request_ids_json,
      allowed_models_json, supported_media_types_json, max_artifact_bytes, last_seen_at, expires_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (
        SELECT COUNT(*) FROM authorization_requests
        WHERE tenant_id = ? AND supplier_id = ? AND status = 'approved' AND valid_until > ?
          AND (${revisions})
      ) = ?
    ON CONFLICT (supplier_tenant_id, worker_id) DO UPDATE SET
      provider_id = excluded.provider_id,
      authorization_request_ids_json = excluded.authorization_request_ids_json,
      allowed_models_json = excluded.allowed_models_json,
      supported_media_types_json = excluded.supported_media_types_json,
      max_artifact_bytes = excluded.max_artifact_bytes,
      last_seen_at = excluded.last_seen_at,
      expires_at = excluded.expires_at`;
}

function validateUsage(value: unknown, maximumTotalTokens: number): SupplierGatewayUsage {
  assertExactKeys(value, ["input_tokens", "output_tokens", "total_tokens"]);
  const input = integer(value.input_tokens, "usage.input_tokens", 0, maximumTotalTokens);
  const output = integer(value.output_tokens, "usage.output_tokens", 0, maximumTotalTokens);
  const total = integer(value.total_tokens, "usage.total_tokens", 0, maximumTotalTokens);
  if (total !== input + output) invalid("Agent 文件任务用量字段不一致。");
  return { input_tokens: input, output_tokens: output, total_tokens: total };
}

async function verifyHmac(token: string, payload: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  return crypto.subtle.verify("HMAC", key, hexToArrayBuffer(signature), new TextEncoder().encode(payload));
}

function guardedLedgerInsert(
  tenantId: string,
  accountId: string,
  taskId: string,
  entryType: string,
  direction: "debit" | "credit",
  amountMicros: string,
  createdAt: string,
  evidenceDigest: string
): D1PreparedStatement {
  return getD1().prepare(
    `INSERT OR IGNORE INTO ledger_entries (
      entry_id, tenant_id, account_id, job_id, entry_type, direction, amount_micros, currency, created_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, 'CNY', ?
      WHERE EXISTS (SELECT 1 FROM artifact_task_evidence WHERE task_id = ? AND evidence_digest = ?)`
  ).bind(
    `ledger-${crypto.randomUUID()}`, tenantId, accountId, taskId, entryType, direction, amountMicros, createdAt,
    taskId, evidenceDigest
  );
}

function exactModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) invalid("allowed_models 数量无效。");
  const models = value.map((item) => {
    if (typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(item)) invalid("allowed_models 包含无效精确模型。");
    return item;
  });
  if (new Set(models).size !== models.length) invalid("allowed_models 不能重复。");
  return models;
}

function supportedTypes(value: unknown): SupplierArtifactAssignment["artifact"]["media_type"][] {
  const allowed = new Set([
    "text/plain", "text/markdown", "text/csv", "text/tab-separated-values",
    "application/json", "application/x-ndjson", "application/xml", "text/xml"
  ]);
  if (!Array.isArray(value) || value.length < 1 || value.length > allowed.size || value.some((item) => !allowed.has(String(item)))) {
    invalid("supported_media_types 无效。");
  }
  return [...new Set(value)] as SupplierArtifactAssignment["artifact"]["media_type"][];
}

function assertExactKeys(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Agent 请求必须是对象。");
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) invalid("Agent 请求字段不完整或包含未知字段。");
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(value)) invalid(`${label} 无效。`);
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /\u0000/.test(value)) invalid(`${label} 无效。`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid(`${label} 超出边界。`);
  return value as number;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hexToArrayBuffer(value: string): ArrayBuffer {
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes.buffer;
}

function invalidLease(): ApiError {
  return new ApiError("ARTIFACT_LEASE_INVALID", "文件任务租约无效或已经过期。", 409, true);
}

function evidenceFailure(): never {
  throw new ApiError("SERVICE_EVIDENCE_FAILED", "文件任务执行凭证无效，平台不会结算。", 422);
}

function invalid(message: string): never {
  throw new ApiError("INVALID_REQUEST", message, 400);
}

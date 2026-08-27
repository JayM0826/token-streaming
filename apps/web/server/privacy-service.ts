import type {
  PurgeMarketplaceContentRequest,
  PurgeMarketplaceContentResponse,
  PurgeableMarketplaceResource
} from "@token-streaming/protocol";

import { ensureSchema, getArtifactBucket, getD1 } from "@/db";
import { ApiError } from "./http";
import {
  CLAIM_ARTIFACT_PURGE_SQL,
  DELETE_ARTIFACT_CHUNK_GENERATION_SQL,
  FINALIZE_ARTIFACT_PURGE_SQL,
  SELECT_ARTIFACT_PURGE_GENERATIONS_SQL,
  TOMBSTONE_ARTIFACT_CHUNK_GENERATION_SQL,
  enqueueArtifactObjectDeletion
} from "./artifact-storage-invariants";
import { enforceTenantRateLimit } from "./rate-limit";
import type { RequestIdentity } from "./security";
import {
  CANCEL_QUEUED_ARTIFACT_TASK_FOR_PURGE_SQL,
  IDEMPOTENT_CONTENT_PURGE_AUDIT_SQL,
  SELECT_ARTIFACT_TASK_PURGE_STATE_SQL
} from "./privacy-invariants";

interface PurgeRow {
  resource_id: string;
  artifact_id?: string;
  status: string;
  content_purged_at: string | null;
  full_content_purged_at?: string | null;
}

export async function purgeMarketplaceContent(
  identity: RequestIdentity,
  input: PurgeMarketplaceContentRequest,
  requestId: string
): Promise<PurgeMarketplaceContentResponse> {
  await ensureSchema();
  assertExactKeys(input, ["resourceType", "resourceId"]);
  const resourceType = purgeableResource(input.resourceType);
  const resourceId = identifier(input.resourceId);
  await enforceTenantRateLimit(identity, "privacy.content-purge", 30, 60 * 60_000);
  const purgedAt = resourceType === "inference-job"
    ? await purgeInferenceOutput(identity, resourceId)
    : resourceType === "artifact"
      ? await purgeArtifact(identity, resourceId)
      : await purgeArtifactTask(identity, resourceId);
  return { ok: true, requestId, resourceType, resourceId, purgedAt };
}

async function purgeInferenceOutput(identity: RequestIdentity, jobId: string): Promise<string> {
  const db = getD1();
  const row = await db.prepare(
    `SELECT job_id AS resource_id, status, content_purged_at
     FROM inference_jobs WHERE job_id = ? AND buyer_tenant_id = ?`
  ).bind(jobId, identity.tenantId).first<PurgeRow>();
  if (!row) notFound();
  if (row.content_purged_at) return row.content_purged_at;
  if (row.status === "reserved" || row.status === "running") {
    throw new ApiError("CONFLICT", "同步推理仍在执行，完成后才能清除结果。", 409, true);
  }
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      `UPDATE inference_jobs SET output_ciphertext = NULL, output_iv = NULL,
         output_expires_at = NULL, content_purged_at = ?
       WHERE job_id = ? AND buyer_tenant_id = ? AND content_purged_at IS NULL`
    ).bind(now, jobId, identity.tenantId),
    auditInsert(identity, "privacy.inference-content-purged", "inference-job", jobId, now)
  ]);
  return now;
}

async function purgeArtifact(identity: RequestIdentity, artifactId: string): Promise<string> {
  const db = getD1();
  const row = await db.prepare(
    `SELECT artifact_id AS resource_id, status, content_purged_at
     FROM artifacts WHERE artifact_id = ? AND tenant_id = ?`
  ).bind(artifactId, identity.tenantId).first<PurgeRow>();
  if (!row) notFound();
  if (row.content_purged_at && row.status === "deleted") {
    await idempotentAuditInsert(
      identity,
      "privacy.artifact-content-purged",
      "artifact",
      artifactId,
      row.content_purged_at
    ).run();
    return row.content_purged_at;
  }
  const active = await db.prepare(
    `SELECT COUNT(*) AS count FROM artifact_tasks
     WHERE artifact_id = ? AND buyer_tenant_id = ? AND status IN ('queued', 'claimed', 'running')`
  ).bind(artifactId, identity.tenantId).first<{ count: number }>();
  if ((active?.count ?? 0) > 0) {
    throw new ApiError("CONFLICT", "文件仍被执行中的任务使用，请清除对应任务。", 409, true);
  }
  return deleteArtifactBytes(identity, artifactId, undefined);
}

async function purgeArtifactTask(identity: RequestIdentity, taskId: string): Promise<string> {
  const db = getD1();
  const row = await db.prepare(SELECT_ARTIFACT_TASK_PURGE_STATE_SQL)
    .bind(taskId, identity.tenantId).first<PurgeRow>();
  if (!row?.artifact_id) notFound();
  if (row.full_content_purged_at) {
    await db.batch([
      idempotentAuditInsert(
        identity,
        "privacy.artifact-content-purged",
        "artifact",
        row.artifact_id,
        row.full_content_purged_at
      ),
      idempotentAuditInsert(
        identity,
        "privacy.artifact-task-content-purged",
        "artifact-task",
        taskId,
        row.full_content_purged_at
      )
    ]);
    return row.full_content_purged_at;
  }
  if (row.status === "claimed" || row.status === "running") {
    throw new ApiError(
      "CONFLICT",
      "任务已由供应节点领取；请先取消并等待节点确认或租约到期后再清除内容。",
      409,
      true
    );
  }
  const otherActive = await db.prepare(
    `SELECT COUNT(*) AS count FROM artifact_tasks
     WHERE artifact_id = ? AND buyer_tenant_id = ? AND task_id <> ?
       AND status IN ('queued', 'claimed', 'running')`
  ).bind(row.artifact_id, identity.tenantId, taskId).first<{ count: number }>();
  if ((otherActive?.count ?? 0) > 0) {
    throw new ApiError("CONFLICT", "同一文件仍被其他任务使用，暂时不能物理清除。", 409, true);
  }
  const now = new Date().toISOString();
  if (row.status === "queued") {
    const prepared = await db.batch([
      db.prepare(CANCEL_QUEUED_ARTIFACT_TASK_FOR_PURGE_SQL)
        .bind(now, now, now, taskId, identity.tenantId),
      db.prepare(
        `UPDATE artifacts SET expires_at = ?, updated_at = ?
         WHERE artifact_id = ? AND tenant_id = ? AND EXISTS (
           SELECT 1 FROM artifact_tasks WHERE task_id = ? AND buyer_tenant_id = ?
             AND status = 'cancelled' AND error_code = 'USER_CONTENT_PURGED'
         )`
      ).bind(now, now, row.artifact_id, identity.tenantId, taskId, identity.tenantId)
    ]);
    if ((prepared[0]?.meta.changes ?? 0) !== 1) {
      throw new ApiError(
        "CONFLICT",
        "任务状态已变化；如任务已被领取，请先完成两阶段取消。",
        409,
        true
      );
    }
  } else {
    await db.batch([
      db.prepare(
        `UPDATE artifact_tasks SET instruction_ciphertext = '', instruction_iv = '',
           output_ciphertext = NULL, output_iv = NULL, output_expires_at = NULL, updated_at = ?
         WHERE task_id = ? AND buyer_tenant_id = ?
           AND status IN ('completed', 'failed', 'cancelled')`
      ).bind(now, taskId, identity.tenantId),
      db.prepare(
        "UPDATE artifacts SET expires_at = ?, updated_at = ? WHERE artifact_id = ? AND tenant_id = ?"
      ).bind(now, now, row.artifact_id, identity.tenantId)
    ]);
  }
  return deleteArtifactBytes(identity, row.artifact_id, taskId);
}

async function deleteArtifactBytes(
  identity: RequestIdentity,
  artifactId: string,
  taskId: string | undefined
): Promise<string> {
  const db = getD1();
  const tombstonedAt = new Date().toISOString();
  const claimed = await db.prepare(CLAIM_ARTIFACT_PURGE_SQL)
    .bind(tombstonedAt, tombstonedAt, tombstonedAt, artifactId, identity.tenantId).run();
  if ((claimed.meta.changes ?? 0) !== 1) {
    throw new ApiError(
      "CONFLICT",
      "文件刚被新的任务使用，未执行物理清除；请先取消所有活跃任务。",
      409,
      true
    );
  }
  const chunks = await db.prepare(SELECT_ARTIFACT_PURGE_GENERATIONS_SQL)
    .bind(artifactId, identity.tenantId).all<{
    part_number: number;
    storage_key: string;
    uploaded_at: string;
  }>();
  if (chunks.results.length > 0) {
    const retainUntil = new Date(Date.parse(tombstonedAt) + 24 * 60 * 60_000).toISOString();
    await db.batch(chunks.results.flatMap((chunk) => [
      enqueueArtifactObjectDeletion(db, {
        artifactId,
        tenantId: identity.tenantId,
        storageKey: chunk.storage_key
      }, tombstonedAt, tombstonedAt, retainUntil),
      db.prepare(TOMBSTONE_ARTIFACT_CHUNK_GENERATION_SQL).bind(
        artifactId, identity.tenantId, chunk.part_number,
        chunk.storage_key, chunk.uploaded_at
      )
    ]));
  }
  try {
    if (chunks.results.length > 0) {
      await getArtifactBucket().delete(chunks.results.map((chunk) => chunk.storage_key));
    }
  } catch {
    throw new ApiError("ARTIFACT_STORAGE_UNAVAILABLE", "加密文件正在等待物理清除，请稍后重试。", 503, true);
  }
  const now = new Date().toISOString();
  await db.batch([
    ...chunks.results.map((chunk) => db.prepare(DELETE_ARTIFACT_CHUNK_GENERATION_SQL)
      .bind(artifactId, identity.tenantId, chunk.part_number, chunk.storage_key, chunk.uploaded_at)),
    db.prepare(FINALIZE_ARTIFACT_PURGE_SQL).bind(now, now, artifactId, identity.tenantId)
  ]);
  const final = await db.prepare(
    "SELECT status, content_purged_at FROM artifacts WHERE artifact_id = ? AND tenant_id = ?"
  ).bind(artifactId, identity.tenantId).first<{ status: string; content_purged_at: string | null }>();
  if (final?.status !== "deleted") {
    throw new ApiError(
      "ARTIFACT_STORAGE_UNAVAILABLE",
      "加密文件正在有界分批物理清除，请稍后重试。",
      503,
      true
    );
  }
  const statements: D1PreparedStatement[] = [
    idempotentAuditInsert(
      identity,
      "privacy.artifact-content-purged",
      "artifact",
      artifactId,
      final.content_purged_at ?? now
    )
  ];
  if (taskId) {
    statements.push(
      db.prepare(
        `UPDATE artifact_tasks SET content_purged_at = COALESCE(content_purged_at, ?), updated_at = ?
         WHERE task_id = ? AND buyer_tenant_id = ?`
      ).bind(now, now, taskId, identity.tenantId),
      idempotentAuditInsert(
        identity,
        "privacy.artifact-task-content-purged",
        "artifact-task",
        taskId,
        final.content_purged_at ?? now
      )
    );
  }
  if (statements.length > 0) await db.batch(statements);
  return final?.content_purged_at ?? now;
}

function idempotentAuditInsert(
  identity: RequestIdentity,
  action: string,
  resourceType: string,
  resourceId: string,
  occurredAt: string
): D1PreparedStatement {
  return getD1().prepare(IDEMPOTENT_CONTENT_PURGE_AUDIT_SQL).bind(
    `audit-${action}-${resourceId}`,
    identity.tenantId,
    identity.actorId,
    action,
    resourceType,
    resourceId,
    occurredAt,
    identity.tenantId,
    action,
    resourceType,
    resourceId
  );
}

function auditInsert(
  identity: RequestIdentity,
  action: string,
  resourceType: string,
  resourceId: string,
  occurredAt: string
): D1PreparedStatement {
  return getD1().prepare(
    `INSERT INTO audit_events (
      audit_id, tenant_id, actor_id, action, resource_type, resource_id, details_json, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`
  ).bind(
    `audit-${crypto.randomUUID()}`, identity.tenantId, identity.actorId,
    action, resourceType, resourceId, occurredAt
  );
}

function purgeableResource(value: unknown): PurgeableMarketplaceResource {
  if (value !== "inference-job" && value !== "artifact" && value !== "artifact-task") {
    throw new ApiError("INVALID_REQUEST", "resourceType 无效。", 400);
  }
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(value)) {
    throw new ApiError("INVALID_REQUEST", "resourceId 无效。", 400);
  }
  return value;
}

function assertExactKeys(value: unknown, allowed: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "请求正文必须是对象。", 400);
  }
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new ApiError("INVALID_REQUEST", "请求字段不完整或包含未知字段。", 400);
  }
}

function notFound(): never {
  throw new ApiError("NOT_FOUND", "内容资源不存在。", 404);
}

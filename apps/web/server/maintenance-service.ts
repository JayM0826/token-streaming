import { ensureSchema, getD1, getRuntimeEnv } from "@/db";
import { cleanupExpiredArtifactData } from "./artifact-service";
import { ApiError } from "./http";
import { getMarketplaceRuntimePolicy } from "./runtime-policy";
import {
  assertRuntimeCryptographicConfiguration,
  createCredentialLookupDigest,
  sha256Hex
} from "./security";
import { enforceScopeRateLimit } from "./rate-limit";
import {
  EXPIRE_PENDING_AUTHORIZATIONS_SQL,
  PENDING_AUTHORIZATION_MAX_AGE_MILLISECONDS
} from "./authorization-invariants";

export interface MarketplaceMaintenanceResult {
  ok: true;
  executedAt: string;
  staleInferenceReservations: number;
  expiredInferenceOutputs: number;
  expiredPendingAuthorizations: number;
  expiredCredentials: number;
  scrubbedIdentityRows: number;
  expiredRateLimits: number;
  expiredAgentNonces: number;
  expiredWorkerHeartbeats: number;
  artifactDeletionBacklog: number;
  overdueArtifactDeletions: number;
  oldestArtifactDeletionDueAt: string | null;
  artifactDeletionRetentionBreaches: number;
  unclaimedExpiredArtifacts: number;
  oldestUnclaimedArtifactExpiresAt: string | null;
  unclaimedArtifactRetentionBreaches: number;
  pendingArtifactTombstones: number;
  oldestArtifactPurgeStartedAt: string | null;
  artifactTombstoneRetentionBreaches: number;
  cryptographicConfiguration: "valid";
}

export async function requireMaintenanceAuthorization(request: Request): Promise<void> {
  const edgeAddress = request.headers.get("cf-connecting-ip")?.trim() || "edge-address-unavailable";
  const preAuthScope = await createCredentialLookupDigest(`maintenance-edge:${edgeAddress}`);
  await enforceScopeRateLimit(
    `maintenance-auth-${preAuthScope.digest.slice(0, 48)}`,
    "maintenance.authentication",
    30,
    5 * 60_000
  );
  const configured = getRuntimeEnv().MARKETPLACE_MAINTENANCE_KEY;
  const authorization = request.headers.get("authorization");
  if (!configured || !authorization?.startsWith("Bearer ")) unauthorized();
  const candidate = authorization.slice("Bearer ".length);
  if (candidate.length < 43 || candidate.length > 512) unauthorized();
  const [expectedDigest, candidateDigest] = await Promise.all([
    sha256Hex(configured),
    sha256Hex(candidate)
  ]);
  if (!constantTimeEqual(expectedDigest, candidateDigest)) unauthorized();
}

export async function runMarketplaceMaintenance(
  now = new Date().toISOString()
): Promise<MarketplaceMaintenanceResult> {
  await assertRuntimeCryptographicConfiguration();
  await ensureSchema();
  const db = getD1();
  const legacyReservationCutoff = new Date(
    Date.parse(now) - getMarketplaceRuntimePolicy().inferenceReservationTimeoutSeconds * 1_000
  ).toISOString();
  const pendingAuthorizationCutoff = new Date(
    Date.parse(now) - PENDING_AUTHORIZATION_MAX_AGE_MILLISECONDS
  ).toISOString();
  const results = await db.batch([
    db.prepare(
      `UPDATE inference_jobs SET status = 'failed', reservation_expires_at = NULL,
         error_code = 'EXECUTION_TIMEOUT', completed_at = ?
       WHERE status IN ('reserved', 'running') AND (
         reservation_expires_at <= ? OR (reservation_expires_at IS NULL AND created_at <= ?)
       )`
    ).bind(now, now, legacyReservationCutoff),
    db.prepare(
      `UPDATE inference_jobs SET output_ciphertext = NULL, output_iv = NULL,
         output_expires_at = NULL, content_purged_at = COALESCE(content_purged_at, ?)
       WHERE output_expires_at IS NOT NULL AND output_expires_at <= ?`
    ).bind(now, now),
    db.prepare(EXPIRE_PENDING_AUTHORIZATIONS_SQL)
      .bind(now, pendingAuthorizationCutoff, now),
    db.prepare(
      `UPDATE authorization_requests SET encrypted_gateway_token = '', gateway_token_iv = '',
         gateway_token_digest = NULL, updated_at = ?
       WHERE valid_until <= ? AND (
         encrypted_gateway_token <> '' OR gateway_token_iv <> '' OR gateway_token_digest IS NOT NULL
      )`
    ).bind(now, now),
    db.prepare(
      `UPDATE users SET email = 'redacted@identity.invalid', display_name = '平台成员', updated_at = ?
       WHERE email <> 'redacted@identity.invalid' OR display_name <> '平台成员'`
    ).bind(now),
    db.prepare("DELETE FROM api_rate_limits WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM agent_request_nonces WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM supplier_artifact_workers WHERE expires_at <= ?").bind(now)
  ]);
  await cleanupExpiredArtifactData(now);
  const deletionQueue = await db.prepare(
    `SELECT COUNT(*) AS backlog,
       COALESCE(SUM(CASE WHEN next_attempt_at <= ? THEN 1 ELSE 0 END), 0) AS overdue,
       MIN(next_attempt_at) AS oldest_due_at,
       COALESCE(SUM(CASE WHEN retain_until <= ? THEN 1 ELSE 0 END), 0) AS retention_breaches
     FROM artifact_object_deletions`
  ).bind(now, now).first<{
    backlog: number;
    overdue: number;
    oldest_due_at: string | null;
    retention_breaches: number;
  }>();
  const unclaimedRetentionCutoff = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString();
  const unclaimedExpired = await db.prepare(
    `SELECT COUNT(*) AS backlog, MIN(a.expires_at) AS oldest_expires_at,
       COALESCE(SUM(CASE WHEN a.expires_at <= ? THEN 1 ELSE 0 END), 0) AS retention_breaches
     FROM artifacts a
     WHERE a.status <> 'deleted' AND a.content_purged_at IS NULL AND a.expires_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM artifact_tasks t WHERE t.artifact_id = a.artifact_id
           AND t.status IN ('queued', 'claimed', 'running')
       )`
  ).bind(unclaimedRetentionCutoff, now).first<{
    backlog: number;
    oldest_expires_at: string | null;
    retention_breaches: number;
  }>();
  const pendingTombstones = await db.prepare(
    `SELECT COUNT(*) AS backlog, MIN(a.content_purged_at) AS oldest_purge_started_at,
       COALESCE(SUM(CASE WHEN a.content_purged_at <= ? THEN 1 ELSE 0 END), 0) AS retention_breaches
     FROM artifact_chunks c JOIN artifacts a
       ON a.artifact_id = c.artifact_id AND a.tenant_id = c.tenant_id
     WHERE a.status <> 'deleted' AND a.content_purged_at IS NOT NULL
       AND c.upload_status IN ('pending', 'ready')`
  ).bind(unclaimedRetentionCutoff).first<{
    backlog: number;
    oldest_purge_started_at: string | null;
    retention_breaches: number;
  }>();
  return {
    ok: true,
    executedAt: now,
    staleInferenceReservations: results[0]?.meta.changes ?? 0,
    expiredInferenceOutputs: results[1]?.meta.changes ?? 0,
    expiredPendingAuthorizations: results[2]?.meta.changes ?? 0,
    expiredCredentials: results[3]?.meta.changes ?? 0,
    scrubbedIdentityRows: results[4]?.meta.changes ?? 0,
    expiredRateLimits: results[5]?.meta.changes ?? 0,
    expiredAgentNonces: results[6]?.meta.changes ?? 0,
    expiredWorkerHeartbeats: results[7]?.meta.changes ?? 0,
    artifactDeletionBacklog: deletionQueue?.backlog ?? 0,
    overdueArtifactDeletions: deletionQueue?.overdue ?? 0,
    oldestArtifactDeletionDueAt: deletionQueue?.oldest_due_at ?? null,
    artifactDeletionRetentionBreaches: deletionQueue?.retention_breaches ?? 0,
    unclaimedExpiredArtifacts: unclaimedExpired?.backlog ?? 0,
    oldestUnclaimedArtifactExpiresAt: unclaimedExpired?.oldest_expires_at ?? null,
    unclaimedArtifactRetentionBreaches: unclaimedExpired?.retention_breaches ?? 0,
    pendingArtifactTombstones: pendingTombstones?.backlog ?? 0,
    oldestArtifactPurgeStartedAt: pendingTombstones?.oldest_purge_started_at ?? null,
    artifactTombstoneRetentionBreaches: pendingTombstones?.retention_breaches ?? 0,
    cryptographicConfiguration: "valid"
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function unauthorized(): never {
  throw new ApiError("AUTHENTICATION_REQUIRED", "维护任务凭据无效。", 401);
}

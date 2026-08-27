import { ensureSchema, getD1, getRuntimeEnv } from "@/db";
import { cleanupExpiredArtifactData } from "./artifact-service";
import { ApiError } from "./http";
import { getMarketplaceRuntimePolicy } from "./runtime-policy";
import {
  assertCredentialEncryptionKeyCanary,
  assertRuntimeCryptographicConfiguration,
  createCredentialEncryptionKeyCanary,
  createCredentialLookupDigest,
  createCredentialLookupKeyCanary,
  decryptCredential,
  encryptCredential,
  getCredentialKeyringInventory,
  LEGACY_CREDENTIAL_KEY_ID,
  LEGACY_CREDENTIAL_LOOKUP_KEY_ID,
  sha256Hex
} from "./security";
import { enforceScopeRateLimit } from "./rate-limit";
import {
  EXPIRE_PENDING_AUTHORIZATIONS_SQL,
  PENDING_AUTHORIZATION_MAX_AGE_MILLISECONDS
} from "./authorization-invariants";
import {
  COUNT_INVALID_AUTHORIZATION_CREDENTIAL_REFERENCES_SQL,
  REWRAP_AUTHORIZATION_CREDENTIAL_SQL
} from "./credential-rotation-invariants";

export interface MarketplaceMaintenanceResult {
  ok: true;
  executedAt: string;
  staleInferenceReservations: number;
  expiredInferenceOutputs: number;
  expiredPendingAuthorizations: number;
  expiredCredentials: number;
  rotatedCredentialEncryptions: number;
  credentialEncryptionRotationBacklog: number;
  legacyCredentialContentReferences: number;
  credentialLookupRotationBacklog: number;
  credentialActiveKeyId: string;
  credentialReadableKeyCount: number;
  credentialLookupActiveKeyId: string;
  credentialLookupReadableKeyCount: number;
  credentialLookupSeparated: boolean;
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
  cryptographicCanaries: "valid";
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
  const cryptographicConfiguration = await assertRuntimeCryptographicConfiguration();
  await ensureSchema();
  const db = getD1();
  const keyringInventory = await getCredentialKeyringInventory();
  await ensureCredentialKeyCanaries(keyringInventory, now);
  const legacyCredentialContentReferences = await assertReferencedCredentialKeysAvailable(
    keyringInventory
  );
  const rotatedCredentialEncryptions = await rotateCredentialEncryptions(
    keyringInventory.credentialActiveKeyId,
    now
  );
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
  const rotationBacklog = await db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN encrypted_gateway_token <> '' AND credential_key_id <> ? THEN 1 ELSE 0 END), 0)
         AS credential_backlog,
       COALESCE(SUM(CASE WHEN gateway_token_digest IS NOT NULL AND (
         gateway_token_digest_version <> ? OR gateway_token_lookup_key_id <> ?
       ) THEN 1 ELSE 0 END), 0) AS lookup_backlog
     FROM authorization_requests`
  ).bind(
    keyringInventory.credentialActiveKeyId,
    keyringInventory.credentialLookupActiveKeyId === LEGACY_CREDENTIAL_LOOKUP_KEY_ID ? 2 : 3,
    keyringInventory.credentialLookupActiveKeyId
  ).first<{ credential_backlog: number; lookup_backlog: number }>();
  return {
    ok: true,
    executedAt: now,
    staleInferenceReservations: results[0]?.meta.changes ?? 0,
    expiredInferenceOutputs: results[1]?.meta.changes ?? 0,
    expiredPendingAuthorizations: results[2]?.meta.changes ?? 0,
    expiredCredentials: results[3]?.meta.changes ?? 0,
    rotatedCredentialEncryptions,
    credentialEncryptionRotationBacklog: rotationBacklog?.credential_backlog ?? 0,
    legacyCredentialContentReferences,
    credentialLookupRotationBacklog: rotationBacklog?.lookup_backlog ?? 0,
    credentialActiveKeyId: cryptographicConfiguration.credentialActiveKeyId,
    credentialReadableKeyCount: cryptographicConfiguration.credentialReadableKeyCount,
    credentialLookupActiveKeyId: cryptographicConfiguration.credentialLookupActiveKeyId,
    credentialLookupReadableKeyCount: cryptographicConfiguration.credentialLookupReadableKeyCount,
    credentialLookupSeparated: cryptographicConfiguration.credentialLookupSeparated,
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
    cryptographicConfiguration: "valid",
    cryptographicCanaries: "valid"
  };
}

interface CredentialKeyringInventoryView {
  credentialActiveKeyId: string;
  credentialKeyIds: readonly string[];
  credentialLookupActiveKeyId: string;
  credentialLookupKeyIds: readonly string[];
}

interface CryptographicKeyCanaryRow {
  format_version: number;
  ciphertext: string;
  iv: string | null;
}

async function ensureCredentialKeyCanaries(
  inventory: CredentialKeyringInventoryView,
  now: string
): Promise<void> {
  for (const keyId of inventory.credentialKeyIds) {
    let row = await readKeyCanary("credential-encryption", keyId);
    if (!row) {
      const canary = await createCredentialEncryptionKeyCanary(keyId);
      await insertKeyCanary(
        "credential-encryption",
        keyId,
        canary.formatVersion,
        canary.ciphertext,
        canary.iv,
        now
      );
      row = await readKeyCanary("credential-encryption", keyId);
    }
    if (!row?.iv || row.format_version !== 1) invalidCryptographicCanary();
    try {
      await assertCredentialEncryptionKeyCanary(keyId, {
        ciphertext: row.ciphertext,
        iv: row.iv,
        formatVersion: 1
      });
    } catch {
      invalidCryptographicCanary();
    }
  }
  for (const keyId of inventory.credentialLookupKeyIds) {
    const expected = await createCredentialLookupKeyCanary(keyId);
    let row = await readKeyCanary("credential-lookup", keyId);
    if (!row) {
      await insertKeyCanary("credential-lookup", keyId, 1, expected, null, now);
      row = await readKeyCanary("credential-lookup", keyId);
    }
    if (
      !row || row.iv !== null || row.format_version !== 1 ||
      !constantTimeEqual(expected, row.ciphertext)
    ) invalidCryptographicCanary();
  }
}

async function readKeyCanary(
  domain: "credential-encryption" | "credential-lookup",
  keyId: string
): Promise<CryptographicKeyCanaryRow | null> {
  return getD1().prepare(
    `SELECT format_version, ciphertext, iv FROM cryptographic_key_canaries
     WHERE domain = ? AND key_id = ?`
  ).bind(domain, keyId).first<CryptographicKeyCanaryRow>();
}

async function insertKeyCanary(
  domain: "credential-encryption" | "credential-lookup",
  keyId: string,
  formatVersion: number,
  ciphertext: string,
  iv: string | null,
  now: string
): Promise<void> {
  await getD1().prepare(
    `INSERT OR IGNORE INTO cryptographic_key_canaries (
       canary_id, domain, key_id, format_version, ciphertext, iv, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(`canary:${domain}:${keyId}`, domain, keyId, formatVersion, ciphertext, iv, now).run();
}

async function assertReferencedCredentialKeysAvailable(
  inventory: CredentialKeyringInventoryView
): Promise<number> {
  const db = getD1();
  const [credentialReferences, lookupReferences, legacyContentReferences, invalidReferences] = await Promise.all([
    db.prepare(
      `SELECT credential_key_id AS key_id, COUNT(*) AS reference_count
       FROM authorization_requests WHERE encrypted_gateway_token <> ''
       GROUP BY credential_key_id`
    ).all<{ key_id: string; reference_count: number }>(),
    db.prepare(
       `SELECT gateway_token_lookup_key_id AS key_id, COUNT(*) AS reference_count
       FROM authorization_requests
       WHERE gateway_token_digest IS NOT NULL AND gateway_token_digest_version IN (2, 3)
       GROUP BY gateway_token_lookup_key_id`
    ).all<{ key_id: string; reference_count: number }>(),
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM inference_jobs
          WHERE content_key_version = 1 AND output_ciphertext IS NOT NULL) +
         (SELECT COUNT(*) FROM artifact_tasks
          WHERE content_key_version = 1 AND (
            instruction_ciphertext <> '' OR output_ciphertext IS NOT NULL
          )) AS reference_count`
    ).first<{ reference_count: number }>(),
    db.prepare(COUNT_INVALID_AUTHORIZATION_CREDENTIAL_REFERENCES_SQL).bind(
      LEGACY_CREDENTIAL_KEY_ID,
      LEGACY_CREDENTIAL_KEY_ID,
      LEGACY_CREDENTIAL_LOOKUP_KEY_ID,
      LEGACY_CREDENTIAL_LOOKUP_KEY_ID
    ).first<{ reference_count: number }>()
  ]);
  const credentialIds = new Set(inventory.credentialKeyIds);
  const lookupIds = new Set(inventory.credentialLookupKeyIds);
  if (
    credentialReferences.results.some((row) => !credentialIds.has(row.key_id)) ||
    lookupReferences.results.some((row) => !lookupIds.has(row.key_id)) ||
    ((legacyContentReferences?.reference_count ?? 0) > 0 && !credentialIds.has(LEGACY_CREDENTIAL_KEY_ID)) ||
    (invalidReferences?.reference_count ?? 0) > 0
  ) {
    throw new ApiError(
      "INTERNAL_ERROR",
      "生产密钥环缺少仍被持久化数据引用的凭据密钥。",
      503,
      true
    );
  }
  return legacyContentReferences?.reference_count ?? 0;
}

async function rotateCredentialEncryptions(activeKeyId: string, now: string): Promise<number> {
  const db = getD1();
  const rows = await db.prepare(
    `SELECT request_id, tenant_id, encrypted_gateway_token, gateway_token_iv,
       encryption_key_version, credential_key_id
     FROM authorization_requests
     WHERE encrypted_gateway_token <> '' AND credential_key_id <> ?
     ORDER BY updated_at ASC LIMIT 4`
  ).bind(activeKeyId).all<{
    request_id: string;
    tenant_id: string;
    encrypted_gateway_token: string;
    gateway_token_iv: string;
    encryption_key_version: number;
    credential_key_id: string;
  }>();
  if (rows.results.length === 0) return 0;
  const replacements = await Promise.all(rows.results.map(async (row) => {
    const context = { tenantId: row.tenant_id, authorizationRequestId: row.request_id };
    const plaintext = await decryptCredential(
      row.encrypted_gateway_token,
      row.gateway_token_iv,
      row.encryption_key_version,
      row.credential_key_id,
      context
    );
    return { row, encrypted: await encryptCredential(plaintext, context) };
  }));
  const updated = await db.batch(replacements.map(({ row, encrypted }) => db.prepare(
    REWRAP_AUTHORIZATION_CREDENTIAL_SQL
  ).bind(
    encrypted.ciphertext,
    encrypted.iv,
    encrypted.keyVersion,
    encrypted.keyId,
    now,
    row.request_id,
    row.encrypted_gateway_token,
    row.gateway_token_iv,
    row.encryption_key_version,
    row.credential_key_id
  )));
  return updated.reduce((count, result) => count + (result.meta.changes ?? 0), 0);
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

function invalidCryptographicCanary(): never {
  throw new ApiError(
    "INTERNAL_ERROR",
    "生产密钥材料与已登记的密钥 canary 不一致。",
    503,
    true
  );
}

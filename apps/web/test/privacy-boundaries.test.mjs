import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("customer content views remain buyer-only", async () => {
  const marketplace = await source("server/marketplace-service.ts");
  const artifacts = await source("server/artifact-service.ts");

  assert.match(marketplace, /FROM inference_jobs j[\s\S]*?WHERE j\.buyer_tenant_id = \?[\s\S]*?ORDER BY j\.created_at DESC LIMIT 30/);
  assert.doesNotMatch(marketplace, /WHERE j\.buyer_tenant_id = \? OR j\.supplier_tenant_id = \?/);
  assert.match(artifacts, /export async function listArtifactTasks[\s\S]*?WHERE t\.buyer_tenant_id = \?/);
  assert.match(artifacts, /WHERE t\.task_id = \? AND t\.buyer_tenant_id = \?/);
  assert.doesNotMatch(artifacts, /WHERE \(t\.buyer_tenant_id = \? OR t\.supplier_tenant_id = \?\)/);
});

test("active content purge is tenant-bound and leaves immutable evidence outside its deletes", async () => {
  const privacy = await source("server/privacy-service.ts");
  const privacyInvariants = await source("server/privacy-invariants.ts");
  const storageInvariants = await source("server/artifact-storage-invariants.ts");

  assert.match(privacy, /FROM inference_jobs WHERE job_id = \? AND buyer_tenant_id = \?/);
  assert.match(privacy, /FROM artifacts WHERE artifact_id = \? AND tenant_id = \?/);
  assert.match(privacy, /SELECT_ARTIFACT_TASK_PURGE_STATE_SQL/);
  assert.match(privacyInvariants, /JOIN artifacts a ON a\.artifact_id = t\.artifact_id AND a\.tenant_id = t\.buyer_tenant_id/);
  assert.match(privacyInvariants, /full_content_purged_at/);
  assert.match(privacyInvariants, /a\.status = 'deleted'/);
  assert.match(privacyInvariants, /NOT EXISTS \([\s\S]*?FROM artifact_chunks/);
  assert.match(
    privacy,
    /if \(row\.full_content_purged_at\) \{[\s\S]*?idempotentAuditInsert\([\s\S]*?return row\.full_content_purged_at/
  );
  assert.match(privacy, /IDEMPOTENT_CONTENT_PURGE_AUDIT_SQL/);
  assert.match(privacyInvariants, /INSERT OR IGNORE INTO audit_events[\s\S]*?WHERE NOT EXISTS/);
  assert.match(privacy, /DELETE_ARTIFACT_CHUNK_GENERATION_SQL/);
  assert.match(storageInvariants, /DELETE FROM artifact_chunks WHERE artifact_id = \? AND tenant_id = \?/);
  assert.doesNotMatch(privacy, /DELETE FROM (ledger_entries|usage_records|service_evidence|artifact_task_evidence|audit_events)/);
});

test("replayable content uses a separate key and record-bound authenticated encryption", async () => {
  const security = await source("server/security.ts");

  assert.match(security, /MARKETPLACE_CREDENTIAL_KEY/);
  assert.match(security, /MARKETPLACE_CREDENTIAL_KEYRING/);
  assert.match(security, /MARKETPLACE_CREDENTIAL_LOOKUP_KEYRING/);
  assert.match(security, /MARKETPLACE_CONTENT_KEY/);
  assert.match(security, /MARKETPLACE_ARTIFACT_KEY/);
  assert.match(security, /MARKETPLACE_COMMITMENT_KEY/);
  assert.match(security, /"gongsuanyun\.content\.v2"[\s\S]*?context\.purpose[\s\S]*?context\.tenantId[\s\S]*?context\.resourceId/);
  assert.match(security, /"gongsuanyun\.credential\.v2"[\s\S]*?context\.tenantId[\s\S]*?context\.authorizationRequestId/);
  assert.match(security, /AES-GCM/);
  assert.match(security, /"gongsuanyun\.digest-commitment\.v2"[\s\S]*?context\.purpose[\s\S]*?context\.tenantId[\s\S]*?context\.resourceId[\s\S]*?sha256Digest/);
  assert.match(security, /crypto\.subtle\.sign\("HMAC", await commitmentKey\(\), payload\)/);
});

test("persisted content digests are keyed commitments and raw file manifests are cleared", async () => {
  const marketplace = await source("server/marketplace-service.ts");
  const artifacts = await source("server/artifact-service.ts");
  const worker = await source("server/artifact-worker-service.ts");
  const privacy = await source("server/privacy-service.ts");
  const financial = await source("server/financial-invariants.ts");
  const storage = await source("server/artifact-storage-invariants.ts");

  assert.match(financial, /prompt_digest, digest_version[\s\S]*?reserved_charge_micros/);
  assert.match(marketplace, /inputCommitment\.digest,[\s\S]*?inputCommitment\.version,[\s\S]*?input\.maxOutputTokens/);
  assert.match(marketplace, /inputCommitment\.digest,[\s\S]*?outputCommitment\.digest,[\s\S]*?inputCommitment\.version/);
  assert.match(artifacts, /instructionCommitment\.digest, instructionCommitment\.version/);
  assert.match(artifacts, /manifestCommitment: manifestCommitment\.digest/);
  assert.doesNotMatch(artifacts, /artifact\.upload-completed[\s\S]{0,200}\{ manifestSha256 \}/);
  assert.match(worker, /manifestCommitment\.digest, contentCommitment\.digest, outputCommitment\.digest/);
  assert.match(storage, /file_name = 'deleted-artifact', manifest_sha256 = NULL/);
  assert.match(artifacts, /FINALIZE_ARTIFACT_PURGE_SQL/);
  assert.match(privacy, /FINALIZE_ARTIFACT_PURGE_SQL/);
});

test("authenticated browser mutations enforce same-origin CSRF checks", async () => {
  const routes = await routeFiles(path.join(webRoot, "app", "api", "v1"));
  const customerMutations = [];
  for (const route of routes) {
    const normalized = route.replaceAll("\\", "/");
    if (normalized.includes("/agent/")) continue;
    if (normalized.endsWith("/maintenance/route.ts")) continue;
    const body = await readFile(route, "utf8");
    if (/export async function (POST|PUT|PATCH|DELETE)\(/.test(body)) customerMutations.push([normalized, body]);
  }
  assert.ok(customerMutations.length >= 8);
  for (const [route, body] of customerMutations) {
    assert.match(body, /assertSameOrigin\(request\)/, `missing same-origin guard in ${route}`);
    assert.match(body, /requireIdentity\(\)/, `missing authenticated identity in ${route}`);
  }
});

test("machine maintenance route uses a separate constant-time bearer boundary", async () => {
  const route = await source("app/api/internal/maintenance/route.ts");
  const maintenance = await source("server/maintenance-service.ts");

  assert.match(route, /requireMaintenanceAuthorization\(request\)/);
  assert.match(route, /requestId/);
  assert.doesNotMatch(route, /requireIdentity\(\)/);
  assert.match(maintenance, /MARKETPLACE_MAINTENANCE_KEY/);
  assert.match(maintenance, /constantTimeEqual\(expectedDigest, candidateDigest\)/);
  assert.match(maintenance, /maintenance\.authentication/);
  assert.match(maintenance, /cleanupExpiredArtifactData\(now\)/);
  assert.match(maintenance, /assertRuntimeCryptographicConfiguration\(\)/);
  assert.match(maintenance, /assertAppliedCredentialKeyringManifestState\(\)/);
  assert.match(maintenance, /assertCredentialKeyCanaries\(keyringInventory\)/);
  assert.doesNotMatch(
    maintenance.slice(
      maintenance.indexOf("export async function requireMaintenanceAuthorization"),
      maintenance.indexOf("export async function runMarketplaceMaintenance")
    ),
    /createCredentialLookupDigest/
  );
  assert.match(maintenance, /legacyCredentialContentReferences = await assertReferencedCredentialKeysAvailable\([\s\S]*?keyringInventory[\s\S]*?\)/);
  assert.match(maintenance, /legacyCredentialContentReferences,/);
  assert.match(maintenance, /rotateCredentialEncryptions/);
  assert.match(maintenance, /content_key_version = 1/);
  assert.match(maintenance, /artifactDeletionRetentionBreaches/);
  assert.match(maintenance, /unclaimedExpiredArtifacts/);
  assert.match(maintenance, /unclaimedArtifactRetentionBreaches/);
  assert.match(maintenance, /a\.content_purged_at IS NULL/);
  assert.match(maintenance, /pendingArtifactTombstones/);
  assert.match(maintenance, /artifactTombstoneRetentionBreaches/);
});

test("cryptographic preflight is maintenance-authenticated and strictly read-only", async () => {
  const route = await source("app/api/internal/cryptography/preflight/route.ts");
  const preflight = await source("server/cryptographic-preflight-service.ts");

  assert.match(route, /requireCryptographicPreflightAuthorization\(request\)/);
  assert.match(route, /runCryptographicPreflight\(\)/);
  assert.doesNotMatch(route, /requireIdentity\(\)/);
  assert.match(preflight, /minimumReaderVersion: MARKETPLACE_CRYPTO_READER_VERSION/);
  assert.match(preflight, /runtimeRetirementEligible/);
  assert.match(preflight, /safeToDestroy: false/);
  assert.match(preflight, /invalidPersistedReferences/);
  assert.match(preflight, /CRYPTOGRAPHIC_PREFLIGHT_SCHEMA_CAPABILITIES_SQL/);
  assert.match(preflight, /input\.schema\.keyringStates/);
  assert.match(preflight, /input\.schema\.bootstrapEligibility/);
  assert.match(preflight, /const canary = await inspectCanary/);
  const readiness = preflight.slice(
    preflight.indexOf("const readyForApply"),
    preflight.indexOf("return {", preflight.indexOf("const readyForApply"))
  );
  assert.doesNotMatch(readiness, /baselineEligibility/);
  assert.doesNotMatch(preflight, /ensureSchema\(/);
  assert.doesNotMatch(preflight, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i);
  const maintenance = await source("server/maintenance-service.ts");
  const readOnlyAuth = maintenance.slice(
    maintenance.indexOf("export async function requireCryptographicPreflightAuthorization"),
    maintenance.indexOf("async function assertMaintenanceBearer")
  );
  assert.doesNotMatch(readOnlyAuth, /enforceScopeRateLimit|ensureSchema|getD1/);
  assert.match(maintenance, /gongsuanyun\.maintenance-preflight\.v1/);
});

test("slot activation and canary registration use explicit monotonic lifecycle actions", async () => {
  const applyRoute = await source("app/api/internal/cryptography/manifest/apply/route.ts");
  const registerRoute = await source("app/api/internal/cryptography/keys/register/route.ts");
  const baselineRoute = await source("app/api/internal/cryptography/keys/baseline/route.ts");
  const lifecycle = await source("server/cryptographic-key-lifecycle-service.ts");
  const security = await source("server/security.ts");

  for (const route of [applyRoute, registerRoute, baselineRoute]) {
    assert.match(route, /requireMaintenanceAuthorization\(request\)/);
    assert.doesNotMatch(route, /requireIdentity\(\)/);
  }
  assert.match(lifecycle, /cryptographic_keyring_states\.generation < excluded\.generation/);
  assert.doesNotMatch(
    lifecycle,
    /configurationState === "current"\) \{\s*return lifecycleResult/
  );
  assert.match(lifecycle, /readLifecycleEventByCommand\(input\.commandId\)/);
  assert.match(lifecycle, /WHERE command_id = \?/);
  assert.match(lifecycle, /domain\.baselineEligibility !== "eligible"/);
  assert.match(lifecycle, /consumeBaselineEligibilitySql/);
  assert.match(
    lifecycle,
    /INSERT INTO cryptographic_keyring_states[\s\S]*?WHERE NOT EXISTS \([\s\S]*?command_id = \?/
  );
  assert.match(
    lifecycle,
    /INSERT INTO cryptographic_key_canaries[\s\S]*?KEY_REGISTERED'[\s\S]*?command_id = \?/
  );
  assert.equal((lifecycle.match(/if \(!raced\) throw error;/g) ?? []).length, 3);
  assert.match(
    lifecycle,
    /catch \(error\) \{[\s\S]*?readLifecycleEventByCommand\(input\.commandId\)[\s\S]*?assertMatchingEvent/
  );
  assert.match(lifecycle, /key\.state !== "staged"/);
  assert.match(lifecycle, /key\.liveReferences !== 0/);
  assert.match(lifecycle, /backupReference/);
  assert.match(lifecycle, /event_type = 'KEY_REGISTERED'/);
  assert.match(lifecycle, /gongsuanyun\.key-baseline\.v1/);
  assert.match(lifecycle, /createRuntimeKeyCustodyVerifier/);
  assert.match(lifecycle, /SELECT event_id, key_id, generation, event_type/);
  assert.match(lifecycle, /event\.event_id !== eventId/);
  assert.match(lifecycle, /isFreshLegacyConfiguration/);
  assert.match(lifecycle, /isFreshManifestConfiguration/);
  assert.match(lifecycle, /domain\.configurationState === "unapplied"/);
  assert.match(lifecycle, /key\.liveReferences !== 0/);
  assert.match(security, /assertPersistedKeyringManifestState/);
  assert.match(security, /row\.generation !== keyring\.configurationGeneration/);
  assert.match(security, /if \(row\) \{[\s\S]*?"CRYPTO_CONFIG_ROLLBACK"[\s\S]*?不能移除 manifest/);
});

test("artifact retention sweeps use small resumable transitions", async () => {
  const cleanup = await source("server/artifact-service.ts");
  const privacy = await source("server/privacy-service.ts");
  const storage = await source("server/artifact-storage-invariants.ts");
  const retentionCleanup = cleanup.slice(
    cleanup.indexOf("export async function cleanupExpiredArtifactData"),
    cleanup.indexOf("export async function listArtifactTasks")
  );

  assert.match(storage, /ARTIFACT_PURGE_GENERATION_BATCH_SIZE = 4/);
  assert.match(retentionCleanup, /ORDER BY a\.expires_at ASC LIMIT 1/);
  assert.match(retentionCleanup, /LIMIT \$\{ARTIFACT_PURGE_GENERATION_BATCH_SIZE\}/);
  assert.match(privacy, /SELECT_ARTIFACT_PURGE_GENERATIONS_SQL/);
  assert.doesNotMatch(retentionCleanup, /LIMIT (?:10|20|50)/);
});

test("an exhausted absolute artifact deadline starts a fresh resumable attempt", async () => {
  const trafficSweep = await source("server/artifact-service.ts");
  const claimSweep = await source("server/artifact-worker-service.ts");
  for (const implementation of [trafficSweep, claimSweep]) {
    assert.match(implementation, /EXECUTION_DEADLINE_EXCEEDED/);
    assert.match(
      implementation,
      /worker_id = CASE[\s\S]*?execution_deadline_at IS NULL OR execution_deadline_at <= \? THEN NULL[\s\S]*?ELSE worker_id/
    );
  }
});

test("pages and JSON responses deny framing, sniffing, referrers, and caching", async () => {
  const nextConfig = await source("next.config.ts");
  const http = await source("server/http.ts");

  for (const header of [
    "Content-Security-Policy",
    "Cross-Origin-Opener-Policy",
    "Cross-Origin-Resource-Policy",
    "Permissions-Policy",
    "Referrer-Policy",
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options"
  ]) assert.match(nextConfig, new RegExp(header));
  assert.match(http, /headers\.set\("cache-control", "no-store"\)/);
  assert.match(http, /headers\.set\("x-frame-options", "DENY"\)/);
  assert.match(http, /headers\.set\("referrer-policy", "no-referrer"\)/);
});

test("market database does not duplicate login email or display name", async () => {
  const marketplace = await source("server/marketplace-service.ts");
  const ensureUser = marketplace.slice(marketplace.indexOf("async function ensureUser"), marketplace.indexOf("async function requireSupplierRow"));

  assert.match(ensureUser, /redacted@identity\.invalid/);
  assert.doesNotMatch(ensureUser, /identity\.user\.(email|displayName)/);
});

test("privacy migration upgrades legacy rows without rewriting them", async () => {
  const migration = await source("drizzle/0004_redundant_shen.sql");
  const commitmentMigration = await source("drizzle/0005_deep_blade.sql");
  const invariantMigration = await source("drizzle/0006_silky_menace.sql");
  const indexMigration = await source("drizzle/0007_narrow_ezekiel.sql");
  const keyringMigration = await source("drizzle/0011_fixed_triathlon.sql");

  assert.match(migration, /CREATE TABLE `api_rate_limits`/);
  assert.match(migration, /ALTER TABLE `inference_jobs` ADD `privacy_mode` text DEFAULT 'standard' NOT NULL/);
  assert.match(migration, /ALTER TABLE `artifact_tasks` ADD `content_key_version` integer DEFAULT 1 NOT NULL/);
  assert.match(migration, /ALTER TABLE `artifacts` ADD `content_purged_at` text/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM/);
  assert.match(commitmentMigration, /ALTER TABLE `inference_jobs` ADD `digest_version` integer DEFAULT 1 NOT NULL/);
  assert.match(commitmentMigration, /ALTER TABLE `artifact_task_evidence` ADD `digest_version` integer DEFAULT 1 NOT NULL/);
  assert.doesNotMatch(commitmentMigration, /DROP TABLE|DELETE FROM/);
  assert.match(invariantMigration, /reserved_charge_micros/);
  assert.match(invariantMigration, /reservation_expires_at/);
  assert.match(invariantMigration, /upload_status/);
  assert.match(invariantMigration, /review_command_id/);
  assert.match(invariantMigration, /schema_version/);
  assert.doesNotMatch(invariantMigration, /DROP TABLE|DELETE FROM/);
  assert.match(indexMigration, /idx_authorization_requests_credential_status/);
  assert.match(indexMigration, /idx_agent_request_nonces_expires/);
  assert.match(keyringMigration, /credential_key_id/);
  assert.match(keyringMigration, /gateway_token_lookup_key_id/);
  assert.match(keyringMigration, /CREATE TABLE `cryptographic_key_canaries`/);
  assert.doesNotMatch(keyringMigration, /DROP TABLE|DELETE FROM/);
});

test("runtime schema bootstrap covers every additive D1 column migration and tolerates isolate races", async () => {
  const runtimeSchema = await source("db/index.ts");
  const migrationFiles = (await readdir(path.join(webRoot, "drizzle")))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const migrationStatements = [];
  for (const file of migrationFiles) {
    const sql = await source(`drizzle/${file}`);
    migrationStatements.push(...[...sql.matchAll(/ALTER TABLE[\s\S]*?;/g)].map((match) => normalizeSql(match[0])));
  }

  const runtimeStatements = [...runtimeSchema.matchAll(/sql: ("(?:[^"\\]|\\.)*")/g)]
    .map((match) => normalizeSql(JSON.parse(match[1])));
  assert.equal(migrationStatements.length, 30);
  assert.deepEqual(new Set(runtimeStatements), new Set(migrationStatements));
  assert.match(runtimeSchema, /if \(await columnExists\(db, migration\.table, migration\.column\)\) continue/);
  assert.match(runtimeSchema, /catch \(error\)[\s\S]*?if \(!await columnExists\(db, migration\.table, migration\.column\)\) throw error/);
});

test("gateway, credential, review, upload, and cancellation boundaries fail closed", async () => {
  const marketplace = await source("server/marketplace-service.ts");
  const agentAuth = await source("server/agent-auth.ts");
  const artifacts = await source("server/artifact-service.ts");
  const worker = await source("server/artifact-worker-service.ts");
  const reviewInvariants = await source("server/review-invariants.ts");

  assert.match(marketplace, /fetch\(endpoint,[\s\S]*?redirect: "error"/);
  assert.match(marketplace, /review_command_id = \?/);
  assert.match(marketplace, /request\.tenant_id === identity\.tenantId[\s\S]*?REVIEWER_CONFLICT/);
  assert.match(marketplace, /WHERE ar\.status = 'pending' AND ar\.tenant_id <> \?/);
  assert.match(marketplace, /guardedReviewEventInsert/);
  assert.match(reviewInvariants, /request_id = \? AND tenant_id <> \?/);
  assert.match(reviewInvariants, /MAX_AGENT_AUTHORIZATIONS_PER_TOKEN|authorization_count|SELECT COUNT\(\*\) FROM authorization_requests existing/);
  assert.match(marketplace, /schemaVersion: row\.schema_version/);
  assert.match(agentAuth, /ar\.valid_until > \?/);
  assert.match(agentAuth, /createCredentialLookupDigests\(gatewayToken\)/);
  assert.match(agentAuth, /gateway_token_lookup_key_id/);
  assert.match(agentAuth, /MAX_AGENT_AUTHORIZATIONS_PER_TOKEN \+ 1/);
  assert.doesNotMatch(marketplace, /digest_version \?\? 1\) >= 2/);
  assert.doesNotMatch(artifacts, /digest_version \?\? 1\) >= 2/);
  assert.match(artifacts, /upload_status = 'pending'/);
  assert.match(artifacts, /upload_status = 'ready'/);
  assert.match(artifacts, /part-.*crypto\.randomUUID\(\)/);
  assert.match(artifacts, /content_purged_at IS NULL AND expires_at > \?/);
  assert.match(artifacts, /artifact-task\.cancel-target/);
  assert.match(worker, /cancellation_requested_at IS NULL/);
  assert.match(worker, /ARTIFACT_TASK_CANCELLED/);
  assert.match(worker, /a\.tenant_id = t\.buyer_tenant_id/);
  assert.match(worker, /o\.tenant_id = t\.supplier_tenant_id/);
});

async function source(relativePath) {
  return readFile(path.join(webRoot, ...relativePath.split("/")), "utf8");
}

async function routeFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await routeFiles(target));
    else if (entry.name === "route.ts") files.push(target);
  }
  return files;
}

function normalizeSql(value) {
  return value.replace(/;$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

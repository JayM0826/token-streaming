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

  assert.match(privacy, /FROM inference_jobs WHERE job_id = \? AND buyer_tenant_id = \?/);
  assert.match(privacy, /FROM artifacts WHERE artifact_id = \? AND tenant_id = \?/);
  assert.match(privacy, /FROM artifact_tasks WHERE task_id = \? AND buyer_tenant_id = \?/);
  assert.match(privacy, /DELETE FROM artifact_chunks WHERE artifact_id = \? AND tenant_id = \?/);
  assert.doesNotMatch(privacy, /DELETE FROM (ledger_entries|usage_records|service_evidence|artifact_task_evidence|audit_events)/);
});

test("replayable content uses a separate key and record-bound authenticated encryption", async () => {
  const security = await source("server/security.ts");

  assert.match(security, /MARKETPLACE_CREDENTIAL_KEY/);
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

  assert.match(marketplace, /prompt_digest, digest_version[\s\S]*?inputCommitment\.digest[\s\S]*?inputCommitment\.version/);
  assert.match(marketplace, /inputCommitment\.digest,[\s\S]*?outputCommitment\.digest,[\s\S]*?inputCommitment\.version/);
  assert.match(artifacts, /instructionCommitment\.digest, instructionCommitment\.version/);
  assert.match(worker, /manifestCommitment\.digest, contentCommitment\.digest, outputCommitment\.digest/);
  assert.match(artifacts, /file_name = 'deleted-artifact', manifest_sha256 = NULL/);
  assert.match(privacy, /file_name = 'deleted-artifact', manifest_sha256 = NULL/);
});

test("authenticated browser mutations enforce same-origin CSRF checks", async () => {
  const routes = await routeFiles(path.join(webRoot, "app", "api", "v1"));
  const customerMutations = [];
  for (const route of routes) {
    const normalized = route.replaceAll("\\", "/");
    if (normalized.includes("/agent/")) continue;
    const body = await readFile(route, "utf8");
    if (/export async function (POST|PUT|PATCH|DELETE)\(/.test(body)) customerMutations.push([normalized, body]);
  }
  assert.ok(customerMutations.length >= 8);
  for (const [route, body] of customerMutations) {
    assert.match(body, /assertSameOrigin\(request\)/, `missing same-origin guard in ${route}`);
    assert.match(body, /requireIdentity\(\)/, `missing authenticated identity in ${route}`);
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

  assert.match(migration, /CREATE TABLE `api_rate_limits`/);
  assert.match(migration, /ALTER TABLE `inference_jobs` ADD `privacy_mode` text DEFAULT 'standard' NOT NULL/);
  assert.match(migration, /ALTER TABLE `artifact_tasks` ADD `content_key_version` integer DEFAULT 1 NOT NULL/);
  assert.match(migration, /ALTER TABLE `artifacts` ADD `content_purged_at` text/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM/);
  assert.match(commitmentMigration, /ALTER TABLE `inference_jobs` ADD `digest_version` integer DEFAULT 1 NOT NULL/);
  assert.match(commitmentMigration, /ALTER TABLE `artifact_task_evidence` ADD `digest_version` integer DEFAULT 1 NOT NULL/);
  assert.doesNotMatch(commitmentMigration, /DROP TABLE|DELETE FROM/);
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
  assert.equal(migrationStatements.length, 13);
  assert.deepEqual(new Set(runtimeStatements), new Set(migrationStatements));
  assert.match(runtimeSchema, /if \(await columnExists\(db, migration\.table, migration\.column\)\) continue/);
  assert.match(runtimeSchema, /catch \(error\)[\s\S]*?if \(!await columnExists\(db, migration\.table, migration\.column\)\) throw error/);
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

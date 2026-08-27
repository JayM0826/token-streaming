import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execute = promisify(execFile);
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wranglerEntrypoint = path.join(webRoot, "node_modules", "wrangler", "bin", "wrangler.js");

// Wrangler starts a fresh local Worker runtime for every migration and query.
// Cold starts on Windows CI can push the complete upgrade rehearsal beyond one
// minute even though each individual invocation remains bounded to 30 seconds.
test("D1 migrations preserve legacy rows and install runtime safeguards", { timeout: 180_000 }, async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "gongsuanyun-migration-test-"));
  const stateRoot = path.join(tempRoot, "state");
  const configPath = path.join(tempRoot, "wrangler.jsonc");
  const workerPath = path.join(tempRoot, "worker.mjs");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        name: "gongsuanyun-migration-test",
        main: workerPath,
        compatibility_date: "2026-08-26",
        d1_databases: [{
          binding: "DB",
          database_name: "gongsuanyun-migration-test",
          database_id: "00000000-0000-0000-0000-000000000001"
        }]
      }),
      "utf8"
    );
    await writeFile(workerPath, "export default {};\n", "utf8");

    const migrations = (await readdir(path.join(webRoot, "drizzle")))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    assert.deepEqual(
      migrations.map((name) => name.slice(0, 4)),
      ["0000", "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011"]
    );
    const migrationSources = await Promise.all(migrations.map((name) => readMigration(name)));
    const expectedTables = migrationSources
      .flatMap((sql) => [...sql.matchAll(/CREATE TABLE `([^`]+)`/g)].map((match) => match[1]))
      .sort();
    assert.equal(expectedTables.length, 21);

    for (const migration of migrations.slice(0, 4)) {
      await runWrangler(configPath, stateRoot, ["--file", path.join(webRoot, "drizzle", migration)]);
    }

    await runWrangler(configPath, stateRoot, ["--command", legacyFixtures]);

    for (const migration of migrations.slice(4, -1)) {
      await runWrangler(configPath, stateRoot, ["--file", path.join(webRoot, "drizzle", migration)]);
    }
    await runWrangler(configPath, stateRoot, ["--command", preKeyringAuthorizationFixtures]);
    await runWrangler(configPath, stateRoot, [
      "--file",
      path.join(webRoot, "drizzle", migrations.at(-1))
    ]);

    const rows = await query(configPath, stateRoot, `
      SELECT 'inference' AS kind, privacy_mode, content_key_version, content_purged_at, digest_version
        FROM inference_jobs WHERE job_id = 'legacy-inference'
      UNION ALL
      SELECT 'artifact-task' AS kind, privacy_mode, content_key_version, content_purged_at, digest_version
        FROM artifact_tasks WHERE task_id = 'legacy-task'
      UNION ALL
      SELECT 'artifact' AS kind, privacy_mode, NULL AS content_key_version, content_purged_at, NULL AS digest_version
        FROM artifacts WHERE artifact_id = 'legacy-artifact'
      ORDER BY kind;
    `);
    assert.deepEqual(rows, [
      { kind: "artifact", privacy_mode: "standard", content_key_version: null, content_purged_at: null, digest_version: null },
      { kind: "artifact-task", privacy_mode: "standard", content_key_version: 1, content_purged_at: null, digest_version: 1 },
      { kind: "inference", privacy_mode: "standard", content_key_version: 1, content_purged_at: null, digest_version: 1 }
    ]);

    const controls = await query(configPath, stateRoot, `
      SELECT type, name FROM sqlite_master
      WHERE (type = 'table' AND name = 'api_rate_limits')
         OR (type = 'index' AND name IN ('idx_api_rate_limits_bucket', 'idx_api_rate_limits_expires'))
      ORDER BY type, name;
    `);
    assert.deepEqual(controls, [
      { type: "index", name: "idx_api_rate_limits_bucket" },
      { type: "index", name: "idx_api_rate_limits_expires" },
      { type: "table", name: "api_rate_limits" }
    ]);

    const installedTables = await query(configPath, stateRoot, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;");
    assert.deepEqual(
      installedTables.map((entry) => entry.name).filter((name) => expectedTables.includes(name)),
      expectedTables
    );

    const evidenceColumns = await query(configPath, stateRoot, "PRAGMA table_info(service_evidence);");
    const digestVersion = evidenceColumns.find((column) => column.name === "digest_version");
    assert.deepEqual(
      digestVersion && { type: digestVersion.type, notnull: digestVersion.notnull, default: digestVersion.dflt_value },
      { type: "INTEGER", notnull: 1, default: "1" }
    );

    const inferenceColumns = await query(configPath, stateRoot, "PRAGMA table_info(inference_jobs);");
    assertColumn(inferenceColumns, "reserved_charge_micros", { type: "TEXT", notnull: 1, default: "'0'" });
    assertColumn(inferenceColumns, "reservation_expires_at", { type: "TEXT", notnull: 0, default: null });
    const artifactChunkColumns = await query(configPath, stateRoot, "PRAGMA table_info(artifact_chunks);");
    assertColumn(artifactChunkColumns, "upload_status", { type: "TEXT", notnull: 1, default: "'ready'" });
    const taskColumns = await query(configPath, stateRoot, "PRAGMA table_info(artifact_tasks);");
    assertColumn(taskColumns, "cancellation_requested_at", { type: "TEXT", notnull: 0, default: null });
    assertColumn(taskColumns, "execution_deadline_at", { type: "TEXT", notnull: 0, default: null });
    const eventColumns = await query(configPath, stateRoot, "PRAGMA table_info(marketplace_events);");
    assertColumn(eventColumns, "schema_version", { type: "INTEGER", notnull: 1, default: "1" });
    const authorizationColumns = await query(configPath, stateRoot, "PRAGMA table_info(authorization_requests);");
    assertColumn(authorizationColumns, "credential_key_id", {
      type: "TEXT", notnull: 1, default: "'legacy-credential-v2'"
    });
    assertColumn(authorizationColumns, "gateway_token_lookup_key_id", {
      type: "TEXT", notnull: 1, default: "'legacy-commitment-v2'"
    });
    assert.deepEqual(await query(configPath, stateRoot, `
      SELECT request_id, encrypted_gateway_token, gateway_token_iv,
        gateway_token_digest, gateway_token_digest_version, encryption_key_version,
        credential_key_id, gateway_token_lookup_key_id
      FROM authorization_requests
      WHERE request_id IN ('legacy-authorization-v1', 'legacy-authorization-v2')
      ORDER BY request_id;
    `), [
      {
        request_id: "legacy-authorization-v1",
        encrypted_gateway_token: "legacy-ciphertext-v1",
        gateway_token_iv: "legacy-iv-v1",
        gateway_token_digest: "legacy-raw-digest-v1",
        gateway_token_digest_version: 1,
        encryption_key_version: 1,
        credential_key_id: "legacy-credential-v2",
        gateway_token_lookup_key_id: "legacy-commitment-v2"
      },
      {
        request_id: "legacy-authorization-v2",
        encrypted_gateway_token: "legacy-ciphertext-v2",
        gateway_token_iv: "legacy-iv-v2",
        gateway_token_digest: "legacy-keyed-digest-v2",
        gateway_token_digest_version: 2,
        encryption_key_version: 2,
        credential_key_id: "legacy-credential-v2",
        gateway_token_lookup_key_id: "legacy-commitment-v2"
      }
    ]);
    assert.deepEqual(await query(configPath, stateRoot, `
      SELECT request_id, encrypted_gateway_token, gateway_token_iv, gateway_token_digest,
        credential_key_id, gateway_token_lookup_key_id
      FROM authorization_requests WHERE request_id = 'legacy-authorization-scrubbed';
    `), [{
      request_id: "legacy-authorization-scrubbed",
      encrypted_gateway_token: "",
      gateway_token_iv: "",
      gateway_token_digest: null,
      credential_key_id: "legacy-credential-v2",
      gateway_token_lookup_key_id: "legacy-commitment-v2"
    }]);
    const canaryColumns = await query(configPath, stateRoot, "PRAGMA table_info(cryptographic_key_canaries);");
    assertColumn(canaryColumns, "format_version", { type: "INTEGER", notnull: 1, default: null });
    assert.deepEqual(await query(configPath, stateRoot, `
      SELECT event_id, schema_version, payload_json FROM marketplace_events
      WHERE event_id = 'legacy-event';
    `), [{ event_id: "legacy-event", schema_version: 1, payload_json: "{\"legacy\":true}" }]);
    assert.deepEqual(await query(configPath, stateRoot, `
      SELECT status, reservation_expires_at, error_code FROM inference_jobs
      WHERE job_id = 'legacy-running';
    `), [{ status: "failed", reservation_expires_at: null, error_code: "EXECUTION_MIGRATED" }]);
    assert.deepEqual(await query(configPath, stateRoot, `
      SELECT status, lease_digest, lease_expires_at, execution_deadline_at, error_code,
        instruction_ciphertext, instruction_iv,
        completed_at IS NOT NULL AS has_completed_at
      FROM artifact_tasks WHERE task_id = 'legacy-running-task';
    `), [{
      status: "failed",
      lease_digest: null,
      lease_expires_at: null,
      execution_deadline_at: null,
      error_code: "EXECUTION_MIGRATED",
      instruction_ciphertext: "",
      instruction_iv: "",
      has_completed_at: 1
    }]);
    assert.deepEqual(await query(configPath, stateRoot, `
      SELECT email, display_name FROM users WHERE user_id = 'legacy-user';
    `), [{ email: "redacted@identity.invalid", display_name: "平台成员" }]);

    const hardeningIndexes = await query(configPath, stateRoot, `
      SELECT name FROM sqlite_master WHERE type = 'index'
        AND name IN (
          'idx_authorization_requests_credential_status',
          'idx_authorization_requests_lookup_status',
          'idx_agent_request_nonces_expires',
          'idx_cryptographic_key_canaries_domain_key'
        )
      ORDER BY name;
    `);
    assert.deepEqual(hardeningIndexes, [
      { name: "idx_agent_request_nonces_expires" },
      { name: "idx_authorization_requests_credential_status" },
      { name: "idx_authorization_requests_lookup_status" },
      { name: "idx_cryptographic_key_canaries_domain_key" }
    ]);
    assert.deepEqual(await query(configPath, stateRoot, `
      SELECT name, "unique" AS is_unique, partial
      FROM pragma_index_list('cryptographic_key_canaries')
      WHERE name = 'idx_cryptographic_key_canaries_domain_key';
    `), [{ name: "idx_cryptographic_key_canaries_domain_key", is_unique: 1, partial: 0 }]);
    assert.deepEqual(await query(configPath, stateRoot, `
      SELECT name FROM pragma_index_info('idx_cryptographic_key_canaries_domain_key') ORDER BY seqno;
    `), [{ name: "domain" }, { name: "key_id" }]);

    const deletionColumns = await query(configPath, stateRoot, "PRAGMA table_info(artifact_object_deletions);");
    assertColumn(deletionColumns, "storage_key", { type: "TEXT", notnull: 1, default: null });
    assertColumn(deletionColumns, "attempts", { type: "INTEGER", notnull: 1, default: "0" });
    const deletionIndexes = await query(configPath, stateRoot, `
      SELECT name FROM sqlite_master WHERE type = 'index'
        AND name IN ('idx_artifact_object_deletions_due', 'idx_artifact_object_deletions_artifact')
      ORDER BY name;
    `);
    assert.deepEqual(deletionIndexes, [
      { name: "idx_artifact_object_deletions_artifact" },
      { name: "idx_artifact_object_deletions_due" }
    ]);

    assert.deepEqual(await query(configPath, stateRoot, `
      SELECT name, "unique" AS is_unique, partial
      FROM pragma_index_list('ledger_entries')
      WHERE name = 'idx_ledger_entries_job_effect';
    `), [{ name: "idx_ledger_entries_job_effect", is_unique: 1, partial: 1 }]);
    assert.deepEqual(await query(configPath, stateRoot, `
      SELECT name FROM pragma_index_info('idx_ledger_entries_job_effect') ORDER BY seqno;
    `), [{ name: "job_id" }, { name: "entry_type" }]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function runWrangler(configPath, stateRoot, operation) {
  return execute(
    process.execPath,
    [
      wranglerEntrypoint,
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      stateRoot,
      "--config",
      configPath,
      ...operation
    ],
    { cwd: webRoot, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 30_000, windowsHide: true }
  );
}

async function query(configPath, stateRoot, sql) {
  const { stdout } = await runWrangler(configPath, stateRoot, ["--command", sql, "--json"]);
  const result = JSON.parse(stdout);
  assert.equal(result[0]?.success, true);
  return result[0].results;
}

async function readMigration(name) {
  return readFile(path.join(webRoot, "drizzle", name), "utf8");
}

function assertColumn(columns, name, expected) {
  const column = columns.find((entry) => entry.name === name);
  assert.deepEqual(
    column && { type: column.type, notnull: column.notnull, default: column.dflt_value },
    expected
  );
}

const legacyFixtures = `
  INSERT INTO users (user_id, email, display_name, created_at, updated_at)
  VALUES ('legacy-user', 'legacy@example.test', 'Legacy User',
    '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
  INSERT INTO marketplace_events (
    event_id, tenant_id, actor_id, causation_id, aggregate_type, aggregate_id,
    aggregate_version, event_type, payload_json, occurred_at
  ) VALUES (
    'legacy-event', 'legacy-tenant', 'legacy-actor', 'legacy-cause', 'supplier', 'legacy-supplier',
    1, 'LegacyFixture', '{"legacy":true}', '2026-08-25T00:00:00.000Z'
  );
  INSERT INTO inference_jobs (
    job_id, buyer_tenant_id, supplier_tenant_id, offer_id, idempotency_key, model,
    data_class, prompt_digest, max_output_tokens, status, created_at
  ) VALUES (
    'legacy-inference', 'buyer-legacy', 'supplier-legacy', 'offer-legacy', 'inference-idempotency', 'model-legacy',
    'standard', 'raw-sha256-legacy', 64, 'completed', '2026-08-25T00:00:00.000Z'
  );
  INSERT INTO inference_jobs (
    job_id, buyer_tenant_id, supplier_tenant_id, offer_id, idempotency_key, model,
    data_class, prompt_digest, max_output_tokens, status, created_at
  ) VALUES (
    'legacy-running', 'buyer-legacy', 'supplier-legacy', 'offer-legacy', 'running-idempotency', 'model-legacy',
    'standard', 'raw-sha256-running', 64, 'running', '2026-08-25T00:00:00.000Z'
  );
  INSERT INTO artifacts (
    artifact_id, tenant_id, file_name, media_type, size_bytes, chunk_size_bytes, chunk_count,
    manifest_sha256, status, expires_at, created_at, updated_at
  ) VALUES (
    'legacy-artifact', 'buyer-legacy', 'legacy.txt', 'text/plain', 6, 4194304, 1,
    'raw-manifest-legacy', 'ready', '2026-08-27T00:00:00.000Z', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z'
  );
  INSERT INTO artifact_tasks (
    task_id, buyer_tenant_id, supplier_tenant_id, offer_id, authorization_request_id, artifact_id,
    idempotency_key, model, data_class, instruction_digest, instruction_ciphertext, instruction_iv,
    max_output_tokens, max_total_tokens, reserved_charge_micros, status, created_at, updated_at
  ) VALUES (
    'legacy-task', 'buyer-legacy', 'supplier-legacy', 'offer-legacy', 'authorization-legacy', 'legacy-artifact',
    'artifact-idempotency', 'model-legacy', 'standard', 'raw-instruction-legacy', 'ciphertext-legacy', 'iv-legacy',
    64, 256, '1000', 'completed', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z'
  );
  INSERT INTO artifact_tasks (
    task_id, buyer_tenant_id, supplier_tenant_id, offer_id, authorization_request_id, artifact_id,
    idempotency_key, model, data_class, instruction_digest, instruction_ciphertext, instruction_iv,
    max_output_tokens, max_total_tokens, reserved_charge_micros, status, worker_id, lease_digest,
    lease_expires_at, started_at, created_at, updated_at
  ) VALUES (
    'legacy-running-task', 'buyer-legacy', 'supplier-legacy', 'offer-legacy', 'authorization-legacy', 'legacy-artifact',
    'running-artifact-idempotency', 'model-legacy', 'standard', 'raw-running-instruction', 'ciphertext-running', 'iv-running',
    64, 256, '1000', 'running', 'legacy-worker', 'legacy-lease', '2026-08-26T00:00:00.000Z',
    '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z'
  );
  INSERT INTO authorization_requests (
    request_id, tenant_id, supplier_id, provider_id, source_type, metering_mode,
    evidence_ref, model_pattern, region_code, data_classes_json,
    requests_per_minute, tokens_per_minute, concurrency, max_output_tokens,
    valid_until, gateway_endpoint, encrypted_gateway_token, gateway_token_iv,
    gateway_token_digest, encryption_key_version, status, created_at, updated_at
  ) VALUES (
    'legacy-authorization-v1', 'legacy-supplier-tenant', 'legacy-supplier', 'legacy-provider',
    'personal-api-key', 'provider-reported', 'legacy-evidence-v1', 'legacy-model', 'CN', '["P0"]',
    10, 1000, 1, 64, '2099-01-01T00:00:00.000Z', 'https://gateway.example.test/v3',
    'legacy-ciphertext-v1', 'legacy-iv-v1', 'legacy-raw-digest-v1', 1, 'approved',
    '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z'
  );
`;

const preKeyringAuthorizationFixtures = `
  INSERT INTO authorization_requests (
    request_id, tenant_id, supplier_id, provider_id, source_type, metering_mode,
    evidence_ref, model_pattern, region_code, data_classes_json,
    requests_per_minute, tokens_per_minute, concurrency, max_output_tokens,
    valid_until, gateway_endpoint, encrypted_gateway_token, gateway_token_iv,
    gateway_token_digest, gateway_token_digest_version, encryption_key_version,
    status, created_at, updated_at
  ) VALUES (
    'legacy-authorization-v2', 'legacy-supplier-tenant', 'legacy-supplier', 'legacy-provider',
    'personal-api-key', 'provider-reported', 'legacy-evidence-v2', 'legacy-model', 'CN', '["P0"]',
    10, 1000, 1, 64, '2099-01-01T00:00:00.000Z', 'https://gateway.example.test/v3',
    'legacy-ciphertext-v2', 'legacy-iv-v2', 'legacy-keyed-digest-v2', 2, 2,
    'approved', '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z'
  );
  INSERT INTO authorization_requests (
    request_id, tenant_id, supplier_id, provider_id, source_type, metering_mode,
    evidence_ref, model_pattern, region_code, data_classes_json,
    requests_per_minute, tokens_per_minute, concurrency, max_output_tokens,
    valid_until, gateway_endpoint, encrypted_gateway_token, gateway_token_iv,
    gateway_token_digest, gateway_token_digest_version, encryption_key_version,
    status, created_at, updated_at
  ) VALUES (
    'legacy-authorization-scrubbed', 'legacy-supplier-tenant', 'legacy-supplier', 'legacy-provider',
    'personal-api-key', 'provider-reported', 'legacy-evidence-scrubbed', 'legacy-model', 'CN', '["P0"]',
    10, 1000, 1, 64, '2026-08-26T00:00:00.000Z', 'https://gateway.example.test/v3',
    '', '', NULL, 2, 2, 'rejected',
    '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z'
  );
`;

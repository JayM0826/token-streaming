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
test("D1 migrations preserve legacy content rows and install privacy controls", { timeout: 180_000 }, async () => {
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
    assert.deepEqual(migrations.map((name) => name.slice(0, 4)), ["0000", "0001", "0002", "0003", "0004", "0005"]);
    const migrationSources = await Promise.all(migrations.map((name) => readMigration(name)));
    const expectedTables = migrationSources
      .flatMap((sql) => [...sql.matchAll(/CREATE TABLE `([^`]+)`/g)].map((match) => match[1]))
      .sort();
    assert.equal(expectedTables.length, 19);

    for (const migration of migrations.slice(0, 4)) {
      await runWrangler(configPath, stateRoot, ["--file", path.join(webRoot, "drizzle", migration)]);
    }

    await runWrangler(configPath, stateRoot, ["--command", legacyFixtures]);

    for (const migration of migrations.slice(4)) {
      await runWrangler(configPath, stateRoot, ["--file", path.join(webRoot, "drizzle", migration)]);
    }

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

const legacyFixtures = `
  INSERT INTO inference_jobs (
    job_id, buyer_tenant_id, supplier_tenant_id, offer_id, idempotency_key, model,
    data_class, prompt_digest, max_output_tokens, status, created_at
  ) VALUES (
    'legacy-inference', 'buyer-legacy', 'supplier-legacy', 'offer-legacy', 'inference-idempotency', 'model-legacy',
    'standard', 'raw-sha256-legacy', 64, 'completed', '2026-08-25T00:00:00.000Z'
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
`;

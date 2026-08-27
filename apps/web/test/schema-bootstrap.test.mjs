import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("fresh runtime schema accepts retryable deleting chunks", async () => {
  const source = await readFile(path.join(webRoot, "db", "index.ts"), "utf8");
  const match = source.match(/`(CREATE TABLE IF NOT EXISTS artifact_chunks \([\s\S]*?\n  \))`,/);
  assert.ok(match?.[1], "artifact_chunks runtime CREATE TABLE statement must remain discoverable");
  const db = new DatabaseSync(":memory:");
  db.exec(match[1]);
  assert.doesNotThrow(() => db.prepare(
    `INSERT INTO artifact_chunks (
      artifact_id, tenant_id, part_number, size_bytes, plaintext_sha256,
      ciphertext_sha256, storage_key, iv, upload_status, uploaded_at
    ) VALUES ('artifact', 'tenant', 1, 1, 'plain', 'cipher', 'key', 'iv', 'deleting', '2099-01-01')`
  ).run());
});

test("runtime installs indexes that depend on additive columns only after column migration", async () => {
  const source = await readFile(path.join(webRoot, "db", "index.ts"), "utf8");
  const migrateAt = source.indexOf("await ensureRuntimeColumns(db)");
  const postIndexAt = source.indexOf("POST_COLUMN_SCHEMA_STATEMENTS.map");
  assert.ok(migrateAt >= 0 && postIndexAt > migrateAt);
  assert.equal(
    (source.match(/CREATE INDEX IF NOT EXISTS idx_authorization_requests_credential_status/g) ?? []).length,
    1
  );
  assert.match(source, /const POST_COLUMN_SCHEMA_STATEMENTS = \[[\s\S]*idx_authorization_requests_credential_status/);
});

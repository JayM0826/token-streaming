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
    2
  );
  assert.match(source, /const POST_COLUMN_SCHEMA_STATEMENTS = \[[\s\S]*idx_authorization_requests_credential_status/);
});

test("fresh runtime schema includes credential key ids and persistent canaries", async () => {
  const source = await readFile(path.join(webRoot, "db", "index.ts"), "utf8");
  const authorization = source.match(
    /const AUTHORIZATION_REQUESTS_SCHEMA_SQL = `(CREATE TABLE IF NOT EXISTS authorization_requests \([\s\S]*?\n  \))`;/
  );
  const canaries = source.match(
    /`(CREATE TABLE IF NOT EXISTS cryptographic_key_canaries \([\s\S]*?\n  \))`,/
  );
  assert.ok(authorization?.[1]);
  assert.ok(canaries?.[1]);
  const db = new DatabaseSync(":memory:");
  db.exec(authorization[1]);
  db.exec(canaries[1]);

  const authorizationColumns = db.prepare("PRAGMA table_info(authorization_requests)").all();
  assert.equal(authorizationColumns.find((column) => column.name === "credential_key_id")?.dflt_value,
    "'legacy-credential-v2'");
  assert.equal(authorizationColumns.find((column) => column.name === "gateway_token_lookup_key_id")?.dflt_value,
    "'legacy-commitment-v2'");
  assert.deepEqual(
    db.prepare("PRAGMA table_info(cryptographic_key_canaries)").all().map((column) => column.name),
    ["canary_id", "domain", "key_id", "format_version", "ciphertext", "iv", "created_at"]
  );
});

test("runtime upgrades the legacy authorization status constraint before installing indexes", async () => {
  const source = await readFile(path.join(webRoot, "db", "index.ts"), "utf8");
  const columnsAt = source.indexOf("await ensureRuntimeColumns(db)");
  const lifecycleAt = source.indexOf("await ensureAuthorizationLifecycleStatusConstraint(db)");
  const postIndexesAt = source.indexOf("POST_COLUMN_SCHEMA_STATEMENTS.map");
  assert.ok(columnsAt >= 0 && lifecycleAt > columnsAt && postIndexesAt > lifecycleAt);
  assert.match(source, /ALTER TABLE authorization_requests RENAME TO authorization_requests_lifecycle_legacy/);
  assert.match(source, /FROM authorization_requests_lifecycle_legacy/);

  const authorization = source.match(
    /const AUTHORIZATION_REQUESTS_SCHEMA_SQL = `(CREATE TABLE IF NOT EXISTS authorization_requests \([\s\S]*?\n  \))`;/
  );
  assert.ok(authorization?.[1]);
  const statusConstraint = authorization[1].match(/status TEXT NOT NULL (CHECK \(status IN \([^\n]+\)\))/);
  assert.ok(statusConstraint?.[1]);
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE lifecycle_status (status TEXT NOT NULL ${statusConstraint[1]})`);
  for (const status of ["pending", "approved", "rejected", "withdrawn", "revoked"]) {
    assert.doesNotThrow(() => db.prepare("INSERT INTO lifecycle_status VALUES (?)").run(status));
  }
});

test("fresh runtime schema includes one-way bootstrap provenance and global lifecycle commands", async () => {
  const source = await readFile(path.join(webRoot, "db", "index.ts"), "utf8");
  const state = source.match(
    /`(CREATE TABLE IF NOT EXISTS cryptographic_keyring_states \([\s\S]*?\n  \))`,/
  );
  const events = source.match(
    /`(CREATE TABLE IF NOT EXISTS cryptographic_key_lifecycle_events \([\s\S]*?\n  \))`,/
  );
  const eligibility = source.match(
    /`(CREATE TABLE IF NOT EXISTS cryptographic_key_bootstrap_eligibility \([\s\S]*?\n  \))`,/
  );
  const globalCommandIndex = source.match(
    /"(CREATE UNIQUE INDEX IF NOT EXISTS idx_cryptographic_key_lifecycle_command_global[^\"]+)"/
  );
  assert.ok(state?.[1]);
  assert.ok(events?.[1]);
  assert.ok(eligibility?.[1]);
  assert.ok(globalCommandIndex?.[1]);
  const db = new DatabaseSync(":memory:");
  db.exec(state[1]);
  db.exec(events[1]);
  db.exec(eligibility[1]);
  db.exec(
    "CREATE UNIQUE INDEX idx_cryptographic_key_lifecycle_command ON cryptographic_key_lifecycle_events (domain, command_id)"
  );
  db.exec(globalCommandIndex[1]);
  assert.deepEqual(
    db.prepare("PRAGMA table_info(cryptographic_keyring_states)").all().map((column) => column.name),
    [
      "domain", "generation", "manifest_hash", "active_key_id",
      "minimum_reader_version", "applied_at", "command_id"
    ]
  );
  assert.throws(() => db.prepare(
    `INSERT INTO cryptographic_keyring_states (
      domain, generation, manifest_hash, active_key_id, applied_at, command_id
    ) VALUES ('invalid-domain', 1, ?, 'key', '2099-01-01', 'command-1')`
  ).run("a".repeat(64)));
  assert.throws(() => db.prepare(
    `INSERT INTO cryptographic_keyring_states (
      domain, generation, manifest_hash, active_key_id, applied_at, command_id
    ) VALUES ('credential-encryption', 0, ?, 'key', '2099-01-01', 'command-1')`
  ).run("a".repeat(64)));
  db.prepare(
    `INSERT INTO cryptographic_key_lifecycle_events (
      event_id, domain, key_id, event_type, generation, manifest_hash,
      backup_reference, command_id, occurred_at
    ) VALUES (?, ?, ?, 'MANIFEST_APPLIED', 1, ?, NULL, 'global-command', '2099-01-01')`
  ).run("event-one", "credential-encryption", "key-one", "a".repeat(64));
  assert.throws(() => db.prepare(
    `INSERT INTO cryptographic_key_lifecycle_events (
      event_id, domain, key_id, event_type, generation, manifest_hash,
      backup_reference, command_id, occurred_at
    ) VALUES (?, ?, ?, 'MANIFEST_APPLIED', 1, ?, NULL, 'global-command', '2099-01-01')`
  ).run("event-two", "credential-lookup", "key-two", "b".repeat(64)));
  assert.match(source, /INSERT OR IGNORE INTO cryptographic_key_bootstrap_eligibility/);
  assert.throws(() => db.prepare(
    `INSERT INTO cryptographic_key_bootstrap_eligibility (
      domain, provenance, eligible_at, consumed_at, consumed_command_id
    ) VALUES ('credential-encryption', 'migration-empty-history-v1', '2099-01-01', NULL, 'command')`
  ).run());
});

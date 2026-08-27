import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  baselineReadableKeyCanarySql,
  baselineReadableKeyEventSql,
  consumeBaselineEligibilitySql
} from "../server/cryptographic-key-lifecycle-invariants.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = "2026-08-28T00:00:00.000Z";
const verifier = "a".repeat(64);
const baselineHash = "b".repeat(64);

test("fresh reference-free legacy keys can be baselined exactly once with an append-only event", () => {
  const db = lifecycleDatabase();
  const first = runBaseline(db, "credential-encryption", "legacy-credential-v2", "baseline-command-one");
  assert.deepEqual(first, { canaryChanges: 1, eventChanges: 1, eligibilityChanges: 1 });
  assert.deepEqual({ ...db.prepare(
    "SELECT domain, key_id, event_type, generation, backup_reference FROM cryptographic_key_lifecycle_events"
  ).get() }, {
    domain: "credential-encryption",
    key_id: "legacy-credential-v2",
    event_type: "KEY_REGISTERED",
    generation: 1,
    backup_reference: "kms:production/legacy-credential-v2"
  });

  const replay = runBaseline(db, "credential-encryption", "legacy-credential-v2", "baseline-command-one");
  assert.deepEqual(replay, { canaryChanges: 0, eventChanges: 0, eligibilityChanges: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cryptographic_key_canaries").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cryptographic_key_lifecycle_events").get().count, 1);
  assert.deepEqual({ ...db.prepare(
    "SELECT consumed_at, consumed_command_id FROM cryptographic_key_bootstrap_eligibility WHERE domain = 'credential-encryption'"
  ).get() }, { consumed_at: now, consumed_command_id: "baseline-command-one" });
});

test("legacy baseline SQL refuses manifests, credentials, lookup digests, and replayable legacy content", () => {
  const cases = [
    ["persisted manifest state", "credential-encryption", (db) => db.prepare(
      "INSERT INTO cryptographic_keyring_states (domain) VALUES ('credential-encryption')"
    ).run()],
    ["credential ciphertext", "credential-encryption", (db) => db.prepare(
      "INSERT INTO authorization_requests (encrypted_gateway_token) VALUES ('ciphertext')"
    ).run()],
    ["legacy inference output", "credential-encryption", (db) => db.prepare(
      "INSERT INTO inference_jobs (content_key_version, output_ciphertext) VALUES (1, 'ciphertext')"
    ).run()],
    ["legacy artifact content", "credential-encryption", (db) => db.prepare(
      "INSERT INTO artifact_tasks (content_key_version, instruction_ciphertext) VALUES (1, 'ciphertext')"
    ).run()],
    ["credential lookup digest", "credential-lookup", (db) => db.prepare(
      "INSERT INTO authorization_requests (gateway_token_digest) VALUES ('digest')"
    ).run()],
    ["scrubbed durable authorization history", "credential-encryption", (db) => db.prepare(
      "INSERT INTO authorization_requests (encrypted_gateway_token, gateway_token_digest) VALUES ('', NULL)"
    ).run()],
    ["prior lifecycle history", "credential-encryption", (db) => db.prepare(
      `INSERT INTO cryptographic_key_lifecycle_events (
        event_id, domain, key_id, event_type, generation, manifest_hash,
        backup_reference, command_id, occurred_at
      ) VALUES ('old-apply', 'credential-encryption', 'old-key', 'MANIFEST_APPLIED', 1, ?, NULL, 'old-command', ?)`
    ).run("c".repeat(64), now)]
  ];

  for (const [label, domain, arrange] of cases) {
    const db = lifecycleDatabase();
    arrange(db);
    const result = insertBaselineCanary(db, domain, `key-${label.replaceAll(" ", "-")}`, "command-blocked");
    assert.equal(result.changes, 0, label);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cryptographic_key_canaries").get().count, 0);
  }
});

test("missing fresh-bootstrap provenance and a consumed domain both fail closed", () => {
  const missing = lifecycleDatabase({ eligible: false });
  assert.equal(
    insertBaselineCanary(missing, "credential-encryption", "credential-key", "missing-eligibility").changes,
    0
  );

  const consumed = lifecycleDatabase();
  assert.deepEqual(
    runBaseline(consumed, "credential-encryption", "credential-key", "consume-once"),
    { canaryChanges: 1, eventChanges: 1, eligibilityChanges: 1 }
  );
  assert.equal(
    insertBaselineCanary(consumed, "credential-encryption", "replacement-key", "second-command").changes,
    0
  );
});

test("one command id cannot cross domains and a serialized loser leaves no orphan canary", () => {
  const db = lifecycleDatabase();
  assert.deepEqual(runBaseline(db, "credential-encryption", "credential-key", "shared-command"), {
    canaryChanges: 1,
    eventChanges: 1,
    eligibilityChanges: 1
  });
  assert.deepEqual(runBaseline(db, "credential-lookup", "lookup-key", "shared-command"), {
    canaryChanges: 0,
    eventChanges: 0,
    eligibilityChanges: 0
  });
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM cryptographic_key_canaries WHERE domain = 'credential-lookup'"
  ).get().count, 0);
  assert.equal(db.prepare(
    "SELECT consumed_at FROM cryptographic_key_bootstrap_eligibility WHERE domain = 'credential-lookup'"
  ).get().consumed_at, null);
});

test("migration provenance is granted only when complete durable history is empty", async () => {
  const migration = await readFile(path.join(webRoot, "drizzle", "0015_sour_cerebro.sql"), "utf8");
  const seed = migration.match(
    /(INSERT INTO `cryptographic_key_bootstrap_eligibility` \([\s\S]*?\);)--> statement-breakpoint/
  )?.[1];
  assert.ok(seed);

  const fresh = lifecycleDatabase({ eligible: false });
  fresh.exec(seed);
  assert.equal(fresh.prepare("SELECT COUNT(*) AS count FROM cryptographic_key_bootstrap_eligibility").get().count, 2);

  const restored = lifecycleDatabase({ eligible: false });
  restored.prepare("INSERT INTO users (id) VALUES ('historical-user')").run();
  restored.exec(seed);
  assert.equal(restored.prepare(
    "SELECT COUNT(*) AS count FROM cryptographic_key_bootstrap_eligibility"
  ).get().count, 0);
});

function runBaseline(db, domain, keyId, commandId) {
  db.exec("BEGIN");
  try {
    const canaryId = `canary:${domain}:${keyId}`;
    const eventId = `crypto-baseline:${domain}:${commandId}`;
    const canary = insertBaselineCanary(db, domain, keyId, commandId);
    const event = db.prepare(baselineReadableKeyEventSql(domain)).run(
      eventId, domain, keyId, 1, baselineHash, `kms:production/${keyId}`, commandId, now,
      domain,
      canaryId, domain, keyId, 1, verifier, null,
      domain,
      domain, canaryId,
      domain, commandId
    );
    const eligibility = db.prepare(consumeBaselineEligibilitySql(domain)).run(
      now, commandId, domain, domain,
      canaryId, domain, keyId, 1, verifier, null,
      domain, canaryId,
      eventId, domain, keyId, commandId,
      domain, eventId
    );
    db.exec("COMMIT");
    return {
      canaryChanges: canary.changes,
      eventChanges: event.changes,
      eligibilityChanges: eligibility.changes
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function insertBaselineCanary(db, domain, keyId, commandId) {
  return db.prepare(baselineReadableKeyCanarySql(domain)).run(
    `canary:${domain}:${keyId}`,
    domain,
    keyId,
    1,
    verifier,
    null,
    now,
    domain,
    domain,
    domain,
    domain,
    commandId
  );
}

function lifecycleDatabase({ eligible = true } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT);
    CREATE TABLE suppliers (id TEXT);
    CREATE TABLE authorization_requests (
      encrypted_gateway_token TEXT NOT NULL DEFAULT '',
      gateway_token_digest TEXT
    );
    CREATE TABLE capacity_offers (id TEXT);
    CREATE TABLE marketplace_events (id TEXT);
    CREATE TABLE inference_jobs (
      content_key_version INTEGER,
      output_ciphertext TEXT
    );
    CREATE TABLE usage_records (id TEXT);
    CREATE TABLE service_evidence (id TEXT);
    CREATE TABLE ledger_entries (id TEXT);
    CREATE TABLE audit_events (id TEXT);
    CREATE TABLE idempotency_keys (id TEXT);
    CREATE TABLE artifacts (id TEXT);
    CREATE TABLE artifact_chunks (id TEXT);
    CREATE TABLE artifact_object_deletions (id TEXT);
    CREATE TABLE supplier_artifact_workers (id TEXT);
    CREATE TABLE artifact_tasks (
      content_key_version INTEGER,
      instruction_ciphertext TEXT NOT NULL DEFAULT '',
      output_ciphertext TEXT
    );
    CREATE TABLE artifact_task_checkpoints (id TEXT);
    CREATE TABLE artifact_task_evidence (id TEXT);
    CREATE TABLE agent_request_nonces (id TEXT);
    CREATE TABLE cryptographic_keyring_states (domain TEXT PRIMARY KEY);
    CREATE TABLE cryptographic_key_bootstrap_eligibility (
      domain TEXT PRIMARY KEY,
      provenance TEXT NOT NULL,
      eligible_at TEXT NOT NULL,
      consumed_at TEXT,
      consumed_command_id TEXT
    );
    CREATE TABLE cryptographic_key_canaries (
      canary_id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      key_id TEXT NOT NULL,
      format_version INTEGER NOT NULL,
      ciphertext TEXT NOT NULL,
      iv TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (domain, key_id)
    );
    CREATE TABLE cryptographic_key_lifecycle_events (
      event_id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      key_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      generation INTEGER NOT NULL,
      manifest_hash TEXT NOT NULL,
      backup_reference TEXT,
      command_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      UNIQUE (command_id)
    );
    CREATE UNIQUE INDEX key_registered_once
      ON cryptographic_key_lifecycle_events (domain, key_id, event_type)
      WHERE event_type = 'KEY_REGISTERED';
  `);
  if (eligible) {
    db.prepare(
      `INSERT INTO cryptographic_key_bootstrap_eligibility (
        domain, provenance, eligible_at, consumed_at, consumed_command_id
      ) VALUES (?, 'migration-empty-history-v1', ?, NULL, NULL),
               (?, 'migration-empty-history-v1', ?, NULL, NULL)`
    ).run("credential-encryption", now, "credential-lookup", now);
  }
  return db;
}

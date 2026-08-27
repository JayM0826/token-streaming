import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AVAILABLE_BALANCE_SQL,
  COMPLETE_ARTIFACT_TASK_SQL,
  COMPLETE_INFERENCE_JOB_SQL,
  RESERVE_ARTIFACT_TASK_SQL,
  RESERVE_INFERENCE_JOB_SQL
} from "../server/financial-invariants.ts";
import {
  ARTIFACT_PURGE_GENERATION_BATCH_SIZE,
  CLAIM_ARTIFACT_PURGE_SQL,
  DELETE_ARTIFACT_CHUNK_GENERATION_SQL,
  ENQUEUE_ARTIFACT_OBJECT_DELETION_SQL,
  FINALIZE_ARTIFACT_PURGE_SQL,
  SELECT_ARTIFACT_PURGE_GENERATIONS_SQL,
  TOMBSTONE_ARTIFACT_CHUNK_GENERATION_SQL
} from "../server/artifact-storage-invariants.ts";
import {
  CANCEL_QUEUED_ARTIFACT_TASK_FOR_PURGE_SQL,
  IDEMPOTENT_CONTENT_PURGE_AUDIT_SQL,
  SELECT_ARTIFACT_TASK_PURGE_STATE_SQL
} from "../server/privacy-invariants.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = "2026-08-27T00:00:00.000Z";
const future = "2099-01-01T00:00:00.000Z";

test("atomic reservations prevent cross-workload overspend and enforce task quota", async () => {
  const db = await marketplaceDatabase();
  seedCapacity(db, 100n);

  assert.equal(reserveInference(db, "job-one", "idem-one", "80").changes, 1);
  assert.equal(reserveInference(db, "job-two", "idem-two", "80").changes, 0);
  assert.equal(reserveArtifact(db, "task-one", "artifact-idem-one", "30", 3).changes, 0);
  assert.equal(available(db), 20n);

  db.prepare("UPDATE inference_jobs SET status = 'failed', reservation_expires_at = NULL WHERE job_id = ?")
    .run("job-one");
  assert.equal(reserveArtifact(db, "task-one", "artifact-idem-one", "30", 1).changes, 1);
  assert.equal(reserveArtifact(db, "task-two", "artifact-idem-two", "10", 1).changes, 0);
  assert.equal(available(db), 70n);
});

test("completion gates reject expired, cancelled, or unbacked settlements", async () => {
  const db = await marketplaceDatabase();
  seedCapacity(db, 100n);
  assert.equal(reserveInference(db, "job-complete", "idem-complete", "80").changes, 1);
  db.prepare("UPDATE inference_jobs SET status = 'running' WHERE job_id = ?").run("job-complete");
  insertArtifactTask(db, "other-task", "30", "queued");

  assert.equal(completeInference(db, "job-complete", "80").changes, 0);
  assert.equal(db.prepare("SELECT status FROM inference_jobs WHERE job_id = ?").get("job-complete").status, "running");
  assert.equal(completeInference(db, "job-complete", "70").changes, 1);

  db.prepare("UPDATE artifact_tasks SET status = 'cancelled' WHERE task_id = ?").run("other-task");
  insertArtifactTask(db, "artifact-complete", "50", "running");
  db.prepare(
    `UPDATE artifact_tasks SET lease_digest = 'lease', lease_expires_at = ?,
       execution_deadline_at = ?, cancellation_requested_at = ? WHERE task_id = ?`
  ).run(future, future, now, "artifact-complete");
  assert.equal(completeArtifact(db, "artifact-complete", "20").changes, 0);
  assert.equal(db.prepare("SELECT status FROM artifact_tasks WHERE task_id = ?").get("artifact-complete").status, "running");
});

test("artifact completion cannot overwrite a newer checkpoint snapshot", async () => {
  const db = await marketplaceDatabase();
  seedCapacity(db, 100n);
  insertArtifactTask(db, "snapshot-task", "50", "running");
  db.prepare(
    `UPDATE artifact_tasks SET lease_digest = 'lease', lease_expires_at = ?, execution_deadline_at = ?, attempt = 1,
       completed_segments = 2, total_segments = 2, processed_bytes = 1,
       input_tokens = 12, output_tokens = 10, total_tokens = 22 WHERE task_id = ?`
  ).run(future, future, "snapshot-task");

  const stale = { attempt: 1, completedSegments: 1, totalSegments: 1, processedBytes: 1,
    inputTokens: 10, outputTokens: 10, totalTokens: 20 };
  assert.equal(completeArtifact(db, "snapshot-task", "20", stale).changes, 0);
  assert.equal(db.prepare("SELECT total_tokens FROM artifact_tasks WHERE task_id = ?").get("snapshot-task").total_tokens, 22);

  const current = { attempt: 1, completedSegments: 2, totalSegments: 2, processedBytes: 1,
    inputTokens: 12, outputTokens: 10, totalTokens: 22 };
  assert.equal(completeArtifact(db, "snapshot-task", "22", current).changes, 1);
});

test("content purge cannot cancel leased work or evade a valid settlement", async () => {
  const db = await marketplaceDatabase();
  seedCapacity(db, 100n);
  insertArtifactTask(db, "running-purge", "50", "running");
  db.prepare(
    `UPDATE artifact_tasks SET lease_digest = 'lease', lease_expires_at = ?, execution_deadline_at = ?,
       attempt = 1, completed_segments = 1, total_segments = 1, processed_bytes = 1,
       input_tokens = 10, output_tokens = 10, total_tokens = 20 WHERE task_id = ?`
  ).run(future, future, "running-purge");

  assert.equal(db.prepare(CANCEL_QUEUED_ARTIFACT_TASK_FOR_PURGE_SQL)
    .run(now, now, now, "running-purge", "buyer-tenant").changes, 0);
  assert.deepEqual({ ...db.prepare(
    "SELECT status, lease_digest, reserved_charge_micros FROM artifact_tasks WHERE task_id = 'running-purge'"
  ).get() }, { status: "running", lease_digest: "lease", reserved_charge_micros: "50" });
  assert.equal(completeArtifact(db, "running-purge", "20", {
    attempt: 1,
    completedSegments: 1,
    totalSegments: 1,
    processedBytes: 1,
    inputTokens: 10,
    outputTokens: 10,
    totalTokens: 20
  }).changes, 1);
});

test("queued content purge cancels atomically before any lease exists", async () => {
  const db = await marketplaceDatabase();
  seedCapacity(db, 100n);
  insertArtifactTask(db, "queued-purge", "50", "queued");

  assert.equal(db.prepare(CANCEL_QUEUED_ARTIFACT_TASK_FOR_PURGE_SQL)
    .run(now, now, now, "queued-purge", "buyer-tenant").changes, 1);
  assert.deepEqual({ ...db.prepare(
    "SELECT status, cancellation_requested_at, error_code FROM artifact_tasks WHERE task_id = 'queued-purge'"
  ).get() }, { status: "cancelled", cancellation_requested_at: now, error_code: "USER_CONTENT_PURGED" });
});

test("expired task output never masquerades as a complete artifact-task purge", async () => {
  const db = await marketplaceDatabase();
  seedCapacity(db, 100n);
  insertArtifactTask(db, "expired-output", "10", "completed");
  db.prepare(
    `UPDATE artifact_tasks SET output_ciphertext = NULL, output_iv = NULL,
       output_expires_at = NULL, content_purged_at = ? WHERE task_id = 'expired-output'`
  ).run(now);
  db.prepare(
    `INSERT INTO artifact_chunks (
      artifact_id, tenant_id, part_number, size_bytes, plaintext_sha256,
      ciphertext_sha256, storage_key, iv, upload_status, uploaded_at
    ) VALUES ('artifact-one', 'buyer-tenant', 1, 1, 'plain', 'cipher', 'key-expired-output',
      'iv', 'ready', ?)`
  ).run(now);

  const purgeState = () => db.prepare(SELECT_ARTIFACT_TASK_PURGE_STATE_SQL)
    .get("expired-output", "buyer-tenant");
  assert.equal(purgeState().content_purged_at, now);
  assert.equal(purgeState().artifact_status, "ready");
  assert.equal(purgeState().full_content_purged_at, null);

  db.prepare(
    `UPDATE artifact_tasks SET instruction_ciphertext = '', instruction_iv = ''
     WHERE task_id = 'expired-output'`
  ).run();
  assert.equal(db.prepare(CLAIM_ARTIFACT_PURGE_SQL)
    .run(now, now, now, "artifact-one", "buyer-tenant").changes, 1);
  assert.equal(db.prepare(TOMBSTONE_ARTIFACT_CHUNK_GENERATION_SQL).run(
    "artifact-one", "buyer-tenant", 1, "key-expired-output", now
  ).changes, 1);
  assert.equal(db.prepare(DELETE_ARTIFACT_CHUNK_GENERATION_SQL).run(
    "artifact-one", "buyer-tenant", 1, "key-expired-output", now
  ).changes, 1);
  assert.equal(db.prepare(FINALIZE_ARTIFACT_PURGE_SQL)
    .run(now, now, "artifact-one", "buyer-tenant").changes, 1);

  assert.equal(purgeState().artifact_status, "deleted");
  assert.equal(purgeState().full_content_purged_at, now);
});

test("a retry backfills a missed purge audit exactly once after finalization", async () => {
  const db = await marketplaceDatabase();
  seedCapacity(db, 100n);
  db.prepare(
    "UPDATE artifacts SET status = 'deleted', content_purged_at = ? WHERE artifact_id = 'artifact-one'"
  ).run(now);
  const audit = db.prepare(IDEMPOTENT_CONTENT_PURGE_AUDIT_SQL);
  const values = [
    "audit-privacy.artifact-content-purged-artifact-one",
    "buyer-tenant",
    "buyer-user",
    "privacy.artifact-content-purged",
    "artifact",
    "artifact-one",
    now,
    "buyer-tenant",
    "privacy.artifact-content-purged",
    "artifact",
    "artifact-one"
  ];

  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM audit_events WHERE resource_id = 'artifact-one'"
  ).get().count, 0, "physical finalization may precede a failed audit batch");
  assert.equal(audit.run(...values).changes, 1, "the next retry must backfill the missing audit");
  assert.equal(audit.run(...values).changes, 0, "later retries must stay idempotent");
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM audit_events WHERE resource_id = 'artifact-one'"
  ).get().count, 1);
});

test("artifact purge claim and task reservation are mutually exclusive", async () => {
  const reservedFirst = await marketplaceDatabase();
  seedCapacity(reservedFirst, 100n);
  assert.equal(reserveArtifact(reservedFirst, "reservation-winner", "reservation-winner-idem", "10", 3).changes, 1);
  assert.equal(reservedFirst.prepare(CLAIM_ARTIFACT_PURGE_SQL)
    .run(now, now, now, "artifact-one", "buyer-tenant").changes, 0);
  assert.equal(reservedFirst.prepare(
    "SELECT content_purged_at FROM artifacts WHERE artifact_id = 'artifact-one'"
  ).get().content_purged_at, null);

  const purgeFirst = await marketplaceDatabase();
  seedCapacity(purgeFirst, 100n);
  assert.equal(purgeFirst.prepare(CLAIM_ARTIFACT_PURGE_SQL)
    .run(now, now, now, "artifact-one", "buyer-tenant").changes, 1);
  assert.equal(reserveArtifact(purgeFirst, "purge-winner", "purge-winner-idem", "10", 3).changes, 0);
  assert.equal(purgeFirst.prepare(
    "SELECT content_purged_at FROM artifacts WHERE artifact_id = 'artifact-one'"
  ).get().content_purged_at, now);
});

test("purge cannot delete a newer retry generation after an object-store race", async () => {
  const db = await marketplaceDatabase();
  seedCapacity(db, 100n);
  db.prepare(
    `INSERT INTO artifact_chunks (
      artifact_id, tenant_id, part_number, size_bytes, plaintext_sha256,
      ciphertext_sha256, storage_key, iv, upload_status, uploaded_at
    ) VALUES ('artifact-one', 'buyer-tenant', 1, 1, 'plain', 'cipher', 'key-one', 'iv', 'pending', ?)`
  ).run(now);
  const retryAt = "2098-12-31T23:59:00.000Z";
  db.prepare(
    "UPDATE artifact_chunks SET upload_status = 'deleting', uploaded_at = ? WHERE artifact_id = 'artifact-one'"
  ).run(retryAt);

  assert.equal(db.prepare(DELETE_ARTIFACT_CHUNK_GENERATION_SQL)
    .run("artifact-one", "buyer-tenant", 1, "key-one", now).changes, 0);
  assert.equal(db.prepare("SELECT upload_status FROM artifact_chunks WHERE artifact_id = 'artifact-one'").get().upload_status, "deleting");
  assert.equal(db.prepare(DELETE_ARTIFACT_CHUNK_GENERATION_SQL)
    .run("artifact-one", "buyer-tenant", 1, "key-one", retryAt).changes, 1);
});

test("purge tombstone makes a ready object generation eligible for durable deletion retries", async () => {
  const db = await marketplaceDatabase();
  seedCapacity(db, 100n);
  db.prepare(
    `INSERT INTO artifact_chunks (
      artifact_id, tenant_id, part_number, size_bytes, plaintext_sha256,
      ciphertext_sha256, storage_key, iv, upload_status, uploaded_at
    ) VALUES ('artifact-one', 'buyer-tenant', 1, 1, 'plain', 'cipher', 'key-ready', 'iv', 'ready', ?)`
  ).run(now);
  db.prepare(
    `INSERT INTO artifact_object_deletions (
      storage_key, artifact_id, tenant_id, next_attempt_at, retain_until,
      attempts, created_at, updated_at
    ) VALUES ('key-ready', 'artifact-one', 'buyer-tenant', ?, ?, 0, ?, ?)`
  ).run(now, future, now, now);
  const dueCount = () => db.prepare(
    `SELECT COUNT(*) AS count FROM artifact_object_deletions q
     WHERE q.next_attempt_at <= ? AND NOT EXISTS (
       SELECT 1 FROM artifact_chunks c WHERE c.storage_key = q.storage_key
         AND c.upload_status IN ('pending', 'ready')
     )`
  ).get(now).count;

  assert.equal(dueCount(), 0);
  assert.equal(db.prepare(TOMBSTONE_ARTIFACT_CHUNK_GENERATION_SQL)
    .run('artifact-one', 'buyer-tenant', 1, 'key-ready', now).changes, 1);
  assert.equal(dueCount(), 1);
  assert.equal(db.prepare(DELETE_ARTIFACT_CHUNK_GENERATION_SQL)
    .run('artifact-one', 'buyer-tenant', 1, 'key-ready', now).changes, 1);
});

test("re-enqueuing an object deletion cannot slide its retention deadline", async () => {
  const db = await marketplaceDatabase();
  const originalDeadline = "2026-08-28T00:00:00.000Z";
  const laterDeadline = "2026-08-29T00:00:00.000Z";
  const insert = db.prepare(ENQUEUE_ARTIFACT_OBJECT_DELETION_SQL);

  assert.equal(insert.run(
    "key-fixed-deadline", "artifact-one", "buyer-tenant",
    now, originalDeadline, now, now
  ).changes, 1);
  assert.equal(insert.run(
    "key-fixed-deadline", "artifact-one", "buyer-tenant",
    future, laterDeadline, future, future
  ).changes, 1);
  assert.deepEqual({ ...db.prepare(
    `SELECT next_attempt_at, retain_until FROM artifact_object_deletions
     WHERE storage_key = 'key-fixed-deadline'`
  ).get() }, { next_attempt_at: now, retain_until: originalDeadline });
});

test("a 64-generation artifact purge is resumable within a conservative D1 statement budget", async () => {
  const db = await marketplaceDatabase();
  seedCapacity(db, 100n);
  db.prepare(
    "UPDATE artifacts SET chunk_count = 64, uploaded_chunks = 64, content_purged_at = ? WHERE artifact_id = 'artifact-one'"
  ).run(now);
  const insert = db.prepare(
    `INSERT INTO artifact_chunks (
      artifact_id, tenant_id, part_number, size_bytes, plaintext_sha256,
      ciphertext_sha256, storage_key, iv, upload_status, uploaded_at
    ) VALUES ('artifact-one', 'buyer-tenant', ?, 1, ?, ?, ?, 'iv', 'ready', ?)`
  );
  for (let partNumber = 1; partNumber <= 64; partNumber += 1) {
    insert.run(partNumber, `plain-${partNumber}`, `cipher-${partNumber}`, `key-${partNumber}`, now);
  }

  let transitions = 0;
  while (true) {
    const selected = db.prepare(SELECT_ARTIFACT_PURGE_GENERATIONS_SQL)
      .all("artifact-one", "buyer-tenant");
    if (selected.length === 0) break;
    transitions += 1;
    assert.ok(selected.length <= ARTIFACT_PURGE_GENERATION_BATCH_SIZE);
    assert.ok(selected.length * 3 + 1 <= 13, "one purge transition must remain tightly bounded");
    for (const chunk of selected) {
      assert.equal(db.prepare(TOMBSTONE_ARTIFACT_CHUNK_GENERATION_SQL).run(
        "artifact-one", "buyer-tenant", chunk.part_number, chunk.storage_key, chunk.uploaded_at
      ).changes, 1);
      assert.equal(db.prepare(DELETE_ARTIFACT_CHUNK_GENERATION_SQL).run(
        "artifact-one", "buyer-tenant", chunk.part_number, chunk.storage_key, chunk.uploaded_at
      ).changes, 1);
    }
    const finalized = db.prepare(FINALIZE_ARTIFACT_PURGE_SQL)
      .run(now, now, "artifact-one", "buyer-tenant");
    assert.equal(finalized.changes, transitions === 16 ? 1 : 0);
  }
  assert.equal(transitions, 16);
  assert.equal(db.prepare("SELECT status FROM artifacts WHERE artifact_id = 'artifact-one'").get().status, "deleted");
});

test("settlement ledger effects are idempotent per job and effect type", async () => {
  const db = await marketplaceDatabase();
  seedCapacity(db, 100n);
  const statement = db.prepare(
    `INSERT OR IGNORE INTO ledger_entries (
      entry_id, tenant_id, account_id, job_id, entry_type, direction, amount_micros, currency, created_at
    ) VALUES (?, 'buyer-tenant', 'buyer-buyer-tenant', 'job-idempotent', ?, 'debit', '10', 'CNY', ?)`
  );
  assert.equal(statement.run("entry-one", "inference-debit", now).changes, 1);
  assert.equal(statement.run("entry-two", "inference-debit", now).changes, 0);
  assert.equal(statement.run("entry-three", "supplier-credit", now).changes, 1);
});

function reserveInference(db, jobId, idempotencyKey, amount) {
  return db.prepare(RESERVE_INFERENCE_JOB_SQL).run(
    jobId, "buyer-tenant", "supplier-tenant", "offer-one", idempotencyKey, "model-one",
    "P0", "strict", `digest-${jobId}`, 2, 100, amount, future, now,
    "buyer-tenant", "buyer-tenant", "buyer-tenant", amount,
    "offer-one", now, now, now,
    "offer-one", "offer-one", 2
  );
}

function reserveArtifact(db, taskId, idempotencyKey, amount, maximumActiveTasks) {
  return db.prepare(RESERVE_ARTIFACT_TASK_SQL).run(
    taskId, "buyer-tenant", "supplier-tenant", "offer-one", "authorization-one",
    "artifact-one", idempotencyKey, "model-one", "P0", "standard", `digest-${taskId}`,
    2, "cipher", "iv", 2, 100, 1_000, amount, now, now,
    "artifact-one", "buyer-tenant", now,
    "offer-one", now, now, now,
    "buyer-tenant", maximumActiveTasks,
    "buyer-tenant", "buyer-tenant", "buyer-tenant", amount
  );
}

function completeInference(db, jobId, amount) {
  return db.prepare(COMPLETE_INFERENCE_JOB_SQL).run(
    "provider-request", 10, 10, 20, amount, "cipher", "iv", 2, future, now,
    jobId, amount,
    "buyer-tenant", "buyer-tenant", jobId, "buyer-tenant", amount
  );
}

function completeArtifact(db, taskId, amount, snapshot = {
  attempt: 0,
  completedSegments: 0,
  totalSegments: null,
  processedBytes: 0,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null
}) {
  return db.prepare(COMPLETE_ARTIFACT_TASK_SQL).run(
    snapshot.inputTokens ?? 10, snapshot.outputTokens ?? 10, snapshot.totalTokens ?? 20,
    amount, "cipher", "iv", 2, future, now, now,
    taskId, "supplier-tenant", "lease",
    snapshot.attempt, snapshot.completedSegments, snapshot.totalSegments, snapshot.processedBytes,
    snapshot.inputTokens, snapshot.outputTokens, snapshot.totalTokens, amount,
    "buyer-tenant", "buyer-tenant", "buyer-tenant", taskId, amount
  );
}

function available(db) {
  const row = db.prepare(AVAILABLE_BALANCE_SQL).get("buyer-tenant", "buyer-tenant", "buyer-tenant");
  return BigInt(row.available);
}

function insertArtifactTask(db, taskId, amount, status) {
  db.prepare(
    `INSERT INTO artifact_tasks (
      task_id, buyer_tenant_id, supplier_tenant_id, offer_id, authorization_request_id,
      artifact_id, idempotency_key, model, data_class, privacy_mode, instruction_digest,
      digest_version, instruction_ciphertext, instruction_iv, content_key_version,
      max_output_tokens, max_total_tokens, reserved_charge_micros, status, created_at, updated_at
    ) VALUES (?, 'buyer-tenant', 'supplier-tenant', 'offer-one', 'authorization-one',
      'artifact-one', ?, 'model-one', 'P0', 'standard', 'digest', 2, 'cipher', 'iv', 2,
      100, 1000, ?, ?, ?, ?)`
  ).run(taskId, `idem-${taskId}`, amount, status, now, now);
}

function seedCapacity(db, credit) {
  db.prepare(
    `INSERT INTO suppliers (
      supplier_id, tenant_id, user_id, kind, legal_name, display_name, country_code,
      tax_residence_country_code, status, supply_enabled, version, created_at, updated_at
    ) VALUES ('supplier-one', 'supplier-tenant', 'user-one', 'individual', 'legal', 'supplier',
      'CN', 'CN', 'active', 1, 1, ?, ?)`
  ).run(now, now);
  db.prepare(
    `INSERT INTO authorization_requests (
      request_id, tenant_id, supplier_id, provider_id, source_type, metering_mode, evidence_ref,
      model_pattern, region_code, data_classes_json, requests_per_minute, tokens_per_minute,
      concurrency, max_output_tokens, valid_until, gateway_endpoint, encrypted_gateway_token,
      gateway_token_iv, gateway_token_digest, gateway_token_digest_version,
      encryption_key_version, status, created_at, updated_at
    ) VALUES ('authorization-one', 'supplier-tenant', 'supplier-one', 'provider-one',
      'commercial-account', 'provider-report', 'evidence', 'model-one', 'CN', '["P0"]',
      10, 10000, 2, 100, ?, 'https://node.example.com/v3/inference', 'cipher', 'iv',
      'digest', 2, 2, 'approved', ?, ?)`
  ).run(future, now, now);
  db.prepare(
    `INSERT INTO capacity_offers (
      offer_id, tenant_id, supplier_id, authorization_request_id, provider_id, source_type,
      model, region_code, data_classes_json, requests_per_minute, tokens_per_minute, concurrency,
      max_output_tokens, currency, price_micros_per_million_tokens, status, valid_from,
      valid_until, version, created_at, updated_at
    ) VALUES ('offer-one', 'supplier-tenant', 'supplier-one', 'authorization-one', 'provider-one',
      'commercial-account', 'model-one', 'CN', '["P0"]', 10, 10000, 2, 100,
      'CNY', '1000', 'active', ?, ?, 1, ?, ?)`
  ).run(now, future, now, now);
  db.prepare(
    `INSERT INTO artifacts (
      artifact_id, tenant_id, file_name, privacy_mode, media_type, size_bytes, chunk_size_bytes,
      chunk_count, uploaded_chunks, manifest_sha256, status, expires_at, created_at, updated_at
    ) VALUES ('artifact-one', 'buyer-tenant', 'file.txt', 'standard', 'text/plain', 1, 1,
      1, 1, 'manifest', 'ready', ?, ?, ?)`
  ).run(future, now, now);
  db.prepare(
    `INSERT INTO ledger_entries (
      entry_id, tenant_id, account_id, job_id, entry_type, direction, amount_micros, currency, created_at
    ) VALUES ('credit-one', 'buyer-tenant', 'buyer-buyer-tenant', NULL,
      'promotional-credit', 'credit', ?, 'CNY', ?)`
  ).run(String(credit), now);
}

async function marketplaceDatabase() {
  const db = new DatabaseSync(":memory:");
  const files = (await readdir(path.join(webRoot, "drizzle")))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const file of files) {
    const sql = await readFile(path.join(webRoot, "drizzle", file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
      db.exec(statement);
    }
  }
  return db;
}

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  ACTIVATE_REVIEWED_SUPPLIER_SQL,
  APPROVE_AUTHORIZATION_REQUEST_SQL,
  BIND_AUTHORIZATION_REVIEW_COMMAND_SQL,
  CLAIM_AUTHORIZATION_REVIEW_TARGET_SQL,
  REJECT_AUTHORIZATION_REQUEST_SQL,
  claimAuthorizationReviewTargetWithLookupLimitSql
} from "../server/review-invariants.ts";
import { MAX_AGENT_AUTHORIZATIONS_PER_TOKEN } from "../server/agent-auth-invariants.ts";

const now = "2026-08-28T00:00:00.000Z";

test("one admin command cannot review two authorization requests", () => {
  const db = reviewDatabase();
  seedRequest(db, "request-one");
  seedRequest(db, "request-two");

  assert.equal(reject(db, "admin-a", "shared-command", "request-one", "operation-one"), 1);
  assert.equal(reject(db, "admin-a", "shared-command", "request-two", "operation-two"), 0);

  assert.deepEqual(statuses(db), [
    { request_id: "request-one", status: "rejected", review_command_id: "shared-command" },
    { request_id: "request-two", status: "pending", review_command_id: null }
  ]);
  assert.deepEqual(db.prepare(
    "SELECT resource_id FROM idempotency_keys WHERE tenant_id = 'admin-a' AND operation = 'authorization.review'"
  ).all().map((row) => ({ ...row })), [{ resource_id: "request-one:reject" }]);
});

test("a global target claim serializes different administrator tenants", () => {
  const db = reviewDatabase();
  seedRequest(db, "request-one");

  assert.equal(approve(db, "admin-a", "approve-command", "request-one", "operation-approve"), 1);
  assert.equal(reject(db, "admin-b", "reject-command", "request-one", "operation-reject"), 0);

  assert.deepEqual(statuses(db), [
    { request_id: "request-one", status: "approved", review_command_id: "approve-command" }
  ]);
  assert.deepEqual(db.prepare(
    "SELECT tenant_id, idempotency_key, resource_id FROM idempotency_keys WHERE operation = 'authorization.review-target'"
  ).all().map((row) => ({ ...row })), [{ tenant_id: "platform", idempotency_key: "request-one", resource_id: "operation-approve" }]);
  assert.deepEqual({ ...db.prepare(
    "SELECT status, version FROM suppliers WHERE supplier_id = 'supplier-one'"
  ).get() }, { status: "active", version: 2 });
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM idempotency_keys WHERE tenant_id = 'admin-b' AND operation = 'authorization.review'"
  ).get().count, 0);
});

test("an administrator cannot claim an authorization from their own supplier tenant", () => {
  const db = reviewDatabase();
  seedRequest(db, "request-one");

  assert.equal(approve(db, "supplier-tenant", "self-approve", "request-one", "operation-self"), 0);
  assert.deepEqual(statuses(db), [
    { request_id: "request-one", status: "pending", review_command_id: null }
  ]);
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM idempotency_keys WHERE idempotency_key = 'self-approve' OR resource_id = 'operation-self'"
  ).get().count, 0);
  assert.deepEqual({ ...db.prepare(
    "SELECT status, version FROM suppliers WHERE supplier_id = 'supplier-one'"
  ).get() }, { status: "pending", version: 1 });
});

test("the approval claim atomically refuses a 101st valid authorization for one token", () => {
  const db = reviewDatabase();
  seedRequest(db, "request-limit");
  seedApprovedCredentialRows(db, MAX_AGENT_AUTHORIZATIONS_PER_TOKEN);

  assert.equal(approveWithLookupLimit(
    db, "admin-a", "limit-command", "request-limit", "operation-limit"
  ), 0);
  assert.deepEqual(statuses(db).find((row) => row.request_id === "request-limit"), {
    request_id: "request-limit",
    status: "pending",
    review_command_id: null
  });
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM idempotency_keys WHERE idempotency_key = 'request-limit' OR resource_id = 'operation-limit'"
  ).get().count, 0);
});

test("the approval claim admits the bounded 100th valid authorization", () => {
  const db = reviewDatabase();
  seedRequest(db, "request-boundary");
  seedApprovedCredentialRows(db, MAX_AGENT_AUTHORIZATIONS_PER_TOKEN - 1);

  assert.equal(approveWithLookupLimit(
    db, "admin-a", "boundary-command", "request-boundary", "operation-boundary"
  ), 1);
  assert.deepEqual(statuses(db).find((row) => row.request_id === "request-boundary"), {
    request_id: "request-boundary",
    status: "approved",
    review_command_id: "boundary-command"
  });
});

function reject(db, reviewerTenantId, commandId, requestId, operationToken) {
  const binding = `${requestId}:reject`;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(CLAIM_AUTHORIZATION_REVIEW_TARGET_SQL).run(
      requestId, operationToken, now, requestId, reviewerTenantId,
      reviewerTenantId, commandId, binding
    );
    db.prepare(BIND_AUTHORIZATION_REVIEW_COMMAND_SQL).run(
      reviewerTenantId, commandId, binding, now, requestId, operationToken
    );
    const result = db.prepare(REJECT_AUTHORIZATION_REQUEST_SQL).run(
      "rejected", "admin-actor", commandId, now, now, requestId,
      requestId, operationToken, reviewerTenantId, commandId, binding
    );
    db.exec("COMMIT");
    return result.changes;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function approve(db, reviewerTenantId, commandId, requestId, operationToken) {
  const binding = `${requestId}:approve`;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(CLAIM_AUTHORIZATION_REVIEW_TARGET_SQL).run(
      requestId, operationToken, now, requestId, reviewerTenantId,
      reviewerTenantId, commandId, binding
    );
    db.prepare(BIND_AUTHORIZATION_REVIEW_COMMAND_SQL).run(
      reviewerTenantId, commandId, binding, now, requestId, operationToken
    );
    const result = db.prepare(APPROVE_AUTHORIZATION_REQUEST_SQL).run(
      "approved", "admin-actor", commandId, now, now, requestId,
      "supplier-one", "supplier-tenant", 1,
      requestId, operationToken, reviewerTenantId, commandId, binding
    );
    db.prepare(ACTIVATE_REVIEWED_SUPPLIER_SQL).run(
      2, now, "supplier-one", "supplier-tenant", 1,
      requestId, commandId, requestId, operationToken
    );
    db.exec("COMMIT");
    return result.changes;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function approveWithLookupLimit(db, reviewerTenantId, commandId, requestId, operationToken) {
  const binding = `${requestId}:approve`;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(claimAuthorizationReviewTargetWithLookupLimitSql(1)).run(
      requestId, operationToken, now, requestId, reviewerTenantId,
      now, "legacy-raw-not-used",
      2, "legacy-commitment-v2", "shared-lookup-digest",
      MAX_AGENT_AUTHORIZATIONS_PER_TOKEN,
      reviewerTenantId, commandId, binding
    );
    db.prepare(BIND_AUTHORIZATION_REVIEW_COMMAND_SQL).run(
      reviewerTenantId, commandId, binding, now, requestId, operationToken
    );
    const result = db.prepare(APPROVE_AUTHORIZATION_REQUEST_SQL).run(
      "approved", "admin-actor", commandId, now, now, requestId,
      "supplier-one", "supplier-tenant", 1,
      requestId, operationToken, reviewerTenantId, commandId, binding
    );
    db.prepare(ACTIVATE_REVIEWED_SUPPLIER_SQL).run(
      2, now, "supplier-one", "supplier-tenant", 1,
      requestId, commandId, requestId, operationToken
    );
    db.exec("COMMIT");
    return result.changes;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function statuses(db) {
  return db.prepare(
    "SELECT request_id, status, review_command_id FROM authorization_requests ORDER BY request_id"
  ).all().map((row) => ({ ...row }));
}

function seedRequest(db, requestId) {
  db.prepare(
    `INSERT INTO authorization_requests (
      request_id, supplier_id, tenant_id, status, encrypted_gateway_token, gateway_token_iv
    ) VALUES (?, 'supplier-one', 'supplier-tenant', 'pending', 'ciphertext', 'iv')`
  ).run(requestId);
}

function seedApprovedCredentialRows(db, count) {
  const insert = db.prepare(
    `INSERT INTO authorization_requests (
      request_id, supplier_id, tenant_id, status, encrypted_gateway_token, gateway_token_iv,
      valid_until, gateway_token_digest, gateway_token_digest_version,
      gateway_token_lookup_key_id
    ) VALUES (?, 'supplier-one', 'supplier-tenant', 'approved', 'ciphertext', 'iv',
      '2099-01-01T00:00:00.000Z', 'shared-lookup-digest', 2, 'legacy-commitment-v2')`
  );
  for (let index = 0; index < count; index += 1) insert.run(`approved-${index}`);
}

function reviewDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE idempotency_keys (
      tenant_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_idempotency_keys_scope
      ON idempotency_keys (tenant_id, operation, idempotency_key);
    CREATE TABLE suppliers (
      supplier_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE authorization_requests (
      request_id TEXT PRIMARY KEY,
      supplier_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL,
      review_note TEXT,
      reviewed_by TEXT,
      review_command_id TEXT,
      reviewed_at TEXT,
      updated_at TEXT,
      encrypted_gateway_token TEXT NOT NULL,
      gateway_token_iv TEXT NOT NULL,
      valid_until TEXT NOT NULL DEFAULT '2099-01-01T00:00:00.000Z',
      gateway_token_digest TEXT,
      gateway_token_digest_version INTEGER NOT NULL DEFAULT 1,
      gateway_token_lookup_key_id TEXT NOT NULL DEFAULT 'legacy-commitment-v2'
    );
    INSERT INTO suppliers (supplier_id, tenant_id, status, version, updated_at)
      VALUES ('supplier-one', 'supplier-tenant', 'pending', 1, '${now}');
  `);
  return db;
}

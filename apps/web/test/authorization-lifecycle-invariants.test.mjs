import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BIND_CAPACITY_OFFER_COMMAND_SQL,
  BIND_AUTHORIZATION_LIFECYCLE_COMMAND_SQL,
  CANCEL_LEASED_ARTIFACTS_FOR_REVOKED_AUTHORIZATION_SQL,
  CLAIM_AUTHORIZATION_LIFECYCLE_TARGET_SQL,
  CREATE_CAPACITY_OFFER_WITH_AUTHORIZATION_CAS_SQL,
  DELETE_AGENT_HEARTBEAT_AFTER_AUTHORIZATION_REVOCATION_SQL,
  DELETE_AGENT_HEARTBEAT_AFTER_CREDENTIAL_ROTATION_SQL,
  FAIL_QUEUED_ARTIFACTS_FOR_REVOKED_AUTHORIZATION_SQL,
  FAIL_RESERVED_INFERENCE_AFTER_CREDENTIAL_ROTATION_SQL,
  FAIL_RESERVED_INFERENCE_FOR_REVOKED_AUTHORIZATION_SQL,
  REVOKE_ACTIVE_AUTHORIZATION_SQL,
  UPDATE_SUPPLIER_AFTER_AUTHORIZATION_REVOCATION_SQL,
  WITHDRAW_PENDING_AUTHORIZATION_SQL,
  authorizationCredentialRotationCommandBinding,
  capacityOfferCommandBinding,
  claimAuthorizationCredentialRotationTargetSql,
  rotateAuthorizationCredentialSql
} from "../server/authorization-lifecycle-invariants.ts";

const now = "2026-08-28T00:00:00.000Z";
const future = "2099-01-01T00:00:00.000Z";
const tenantId = "supplier-tenant";
const supplierId = "supplier-one";
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a supplier withdraws one exact pending revision and credential material is scrubbed", () => {
  const db = lifecycleDatabase();
  seedSupplier(db);
  seedAuthorization(db, { requestId: "pending-one", status: "pending" });

  assert.equal(withdraw(db, "pending-one", "withdraw-command", "supplier-requested"), 1);
  assert.deepEqual({ ...db.prepare(
    `SELECT status, authorization_revision, encrypted_gateway_token, gateway_token_iv,
      gateway_token_digest, revoked_at, revocation_reason_code
     FROM authorization_requests WHERE request_id = 'pending-one'`
  ).get() }, {
    status: "withdrawn",
    authorization_revision: 2,
    encrypted_gateway_token: "",
    gateway_token_iv: "",
    gateway_token_digest: null,
    revoked_at: now,
    revocation_reason_code: "supplier-requested"
  });
});

test("lifecycle commands are tenant-scoped, payload-bound, and cannot claim two targets", () => {
  const db = lifecycleDatabase();
  seedSupplier(db);
  seedAuthorization(db, { requestId: "pending-one", status: "pending" });
  seedAuthorization(db, { requestId: "pending-two", status: "pending" });

  assert.equal(withdraw(db, "pending-one", "shared-command", "supplier-requested"), 1);
  assert.equal(claimLifecycle(db, {
    requestId: "pending-two",
    status: "pending",
    revision: 1,
    commandId: "shared-command",
    operation: "authorization.withdraw",
    binding: "pending-two:supplier-requested",
    operationToken: "second-operation"
  }), 0);
  assert.equal(claimLifecycle(db, {
    requestId: "pending-two",
    status: "pending",
    revision: 1,
    commandId: "foreign-command",
    operation: "authorization.withdraw",
    binding: "pending-two:supplier-requested",
    operationToken: "foreign-operation",
    actorTenantId: "foreign-tenant"
  }), 0);
  assert.equal(db.prepare(
    "SELECT status FROM authorization_requests WHERE request_id = 'pending-two'"
  ).get().status, "pending");
});

test("revocation stops new work, drains only unstarted work, clears heartbeat, and disables last supply", () => {
  const db = lifecycleDatabase();
  seedSupplier(db);
  seedAuthorization(db, { requestId: "active-one", status: "approved" });
  seedRevocationWork(db);

  const transition = revoke(db, "active-one", "revoke-command", "credential-compromised");
  assert.equal(transition.changes, 1);
  assert.equal(db.prepare(UPDATE_SUPPLIER_AFTER_AUTHORIZATION_REVOCATION_SQL).run(
    2, now, now, supplierId, tenantId, 1,
    "active-one", tenantId, supplierId, 2
  ).changes, 1);
  db.prepare(FAIL_RESERVED_INFERENCE_FOR_REVOKED_AUTHORIZATION_SQL).run(
    now, "active-one", "active-one", "active-one", "active-one", 2
  );
  db.prepare(FAIL_QUEUED_ARTIFACTS_FOR_REVOKED_AUTHORIZATION_SQL).run(
    now, now, "active-one", "active-one", 2
  );
  db.prepare(CANCEL_LEASED_ARTIFACTS_FOR_REVOKED_AUTHORIZATION_SQL).run(
    now, now, "active-one", "active-one", 2
  );
  db.prepare(DELETE_AGENT_HEARTBEAT_AFTER_AUTHORIZATION_REVOCATION_SQL).run(
    tenantId, "active-one", tenantId, supplierId, 2
  );

  assert.deepEqual({ ...db.prepare(
    `SELECT status, authorization_revision, encrypted_gateway_token, gateway_token_iv,
      gateway_token_digest FROM authorization_requests WHERE request_id = 'active-one'`
  ).get() }, {
    status: "revoked",
    authorization_revision: 2,
    encrypted_gateway_token: "",
    gateway_token_iv: "",
    gateway_token_digest: null
  });
  assert.deepEqual(db.prepare(
    "SELECT job_id, status, error_code FROM inference_jobs ORDER BY job_id"
  ).all().map((row) => ({ ...row })), [
    { job_id: "legacy-reserved", status: "failed", error_code: "AUTHORIZATION_REVOKED" },
    { job_id: "other-reserved", status: "reserved", error_code: null },
    { job_id: "reserved", status: "failed", error_code: "AUTHORIZATION_REVOKED" },
    { job_id: "running", status: "running", error_code: null }
  ]);
  assert.deepEqual(db.prepare(
    `SELECT task_id, status, cancellation_requested_at, instruction_ciphertext, error_code
     FROM artifact_tasks ORDER BY task_id`
  ).all().map((row) => ({ ...row })), [
    { task_id: "claimed", status: "claimed", cancellation_requested_at: now,
      instruction_ciphertext: "", error_code: "AUTHORIZATION_REVOKED_PENDING" },
    { task_id: "other-queued", status: "queued", cancellation_requested_at: null,
      instruction_ciphertext: "cipher", error_code: null },
    { task_id: "queued", status: "failed", cancellation_requested_at: null,
      instruction_ciphertext: "", error_code: "AUTHORIZATION_REVOKED" }
  ]);
  assert.deepEqual({ ...db.prepare(
    "SELECT version, supply_enabled FROM suppliers WHERE supplier_id = 'supplier-one'"
  ).get() }, { version: 2, supply_enabled: 0 });
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM supplier_artifact_workers WHERE supplier_tenant_id = ?"
  ).get(tenantId).count, 0);
});

test("revoking one authorization preserves supply when another current authorization remains", () => {
  const db = lifecycleDatabase();
  seedSupplier(db);
  seedAuthorization(db, { requestId: "active-one", status: "approved" });
  seedAuthorization(db, { requestId: "active-two", status: "approved", digest: "other-digest" });

  assert.equal(revoke(db, "active-one", "revoke-one", "provider-revoked").changes, 1);
  assert.equal(db.prepare(UPDATE_SUPPLIER_AFTER_AUTHORIZATION_REVOCATION_SQL).run(
    2, now, now, supplierId, tenantId, 1,
    "active-one", tenantId, supplierId, 2
  ).changes, 1);
  assert.equal(db.prepare(
    "SELECT supply_enabled FROM suppliers WHERE supplier_id = 'supplier-one'"
  ).get().supply_enabled, 1);
});

test("gateway token replacement advances the authorization CAS and clears the old heartbeat", () => {
  const db = lifecycleDatabase();
  seedSupplier(db);
  seedAuthorization(db, { requestId: "active-one", status: "approved" });
  const inference = db.prepare(
    `INSERT INTO inference_jobs (
      job_id, offer_id, authorization_request_id, authorization_revision,
      status, reservation_expires_at, error_code
    ) VALUES (?, 'offer-active', ?, ?, ?, ?, NULL)`
  );
  inference.run("old-reserved", "active-one", 1, "reserved", future);
  inference.run("old-running", "active-one", 1, "running", future);
  inference.run("new-reserved", "active-one", 2, "reserved", future);
  inference.run("other-reserved", "active-two", 1, "reserved", future);
  inference.run("legacy-reserved", null, null, "reserved", future);
  inference.run("legacy-running", null, null, "running", future);
  db.prepare(
    "INSERT INTO capacity_offers (offer_id, authorization_request_id) VALUES ('offer-active', 'active-one')"
  ).run();
  db.prepare(
    "INSERT INTO supplier_artifact_workers (supplier_tenant_id, heartbeat_id) VALUES (?, 'heartbeat-one')"
  ).run(tenantId);

  const rotation = rotate(db, {
    requestId: "active-one",
    commandId: "rotate-command",
    newDigest: "new-keyed-digest",
    legacyDigest: "new-legacy-digest"
  });
  assert.equal(rotation.claimChanges, 1);
  assert.equal(rotation.updateChanges, 1);
  assert.equal(db.prepare(FAIL_RESERVED_INFERENCE_AFTER_CREDENTIAL_ROTATION_SQL).run(
    now, "active-one", 1,
    "active-one", "active-one", 1,
    "active-one", tenantId, supplierId, 2, "new-keyed-digest"
  ).changes, 2);
  assert.equal(db.prepare(DELETE_AGENT_HEARTBEAT_AFTER_CREDENTIAL_ROTATION_SQL).run(
    tenantId, "active-one", tenantId, supplierId, 2, "new-keyed-digest"
  ).changes, 1);
  assert.deepEqual({ ...db.prepare(
    `SELECT encrypted_gateway_token, gateway_token_iv, credential_key_id,
      gateway_token_digest, gateway_token_digest_version, gateway_token_lookup_key_id,
      encryption_key_version, authorization_revision, credential_rotated_at
     FROM authorization_requests WHERE request_id = 'active-one'`
  ).get() }, {
    encrypted_gateway_token: "cipher-new",
    gateway_token_iv: "iv-new",
    credential_key_id: "credential-key-new",
    gateway_token_digest: "new-keyed-digest",
    gateway_token_digest_version: 3,
    gateway_token_lookup_key_id: "lookup-key-new",
    encryption_key_version: 3,
    authorization_revision: 2,
    credential_rotated_at: now
  });
  assert.deepEqual(db.prepare(
    `SELECT job_id, authorization_request_id, authorization_revision, status, error_code
     FROM inference_jobs ORDER BY job_id`
  ).all().map((row) => ({ ...row })), [
    { job_id: "legacy-reserved", authorization_request_id: "active-one", authorization_revision: 1,
      status: "failed", error_code: "GATEWAY_CREDENTIAL_ROTATED" },
    { job_id: "legacy-running", authorization_request_id: null, authorization_revision: null,
      status: "running", error_code: null },
    { job_id: "new-reserved", authorization_request_id: "active-one", authorization_revision: 2,
      status: "reserved", error_code: null },
    { job_id: "old-reserved", authorization_request_id: "active-one", authorization_revision: 1,
      status: "failed", error_code: "GATEWAY_CREDENTIAL_ROTATED" },
    { job_id: "old-running", authorization_request_id: "active-one", authorization_revision: 1,
      status: "running", error_code: null },
    { job_id: "other-reserved", authorization_request_id: "active-two", authorization_revision: 1,
      status: "reserved", error_code: null }
  ]);
});

test("rotation command binding is stable across keyed lookup-ring changes", () => {
  const legacyDigest = "stable-legacy-sha256";
  const beforeRingChange = authorizationCredentialRotationCommandBinding(
    "active-one", "scheduled", legacyDigest
  );
  const afterRingChange = authorizationCredentialRotationCommandBinding(
    "active-one", "scheduled", legacyDigest
  );
  assert.notEqual("keyed-digest-old-ring", "keyed-digest-new-ring");
  assert.equal(beforeRingChange, afterRingChange);

  const db = lifecycleDatabase();
  seedSupplier(db);
  seedAuthorization(db, { requestId: "active-one", status: "approved" });
  assert.equal(rotate(db, {
    requestId: "active-one",
    commandId: "stable-rotation-command",
    newDigest: "keyed-digest-old-ring",
    legacyDigest
  }).updateChanges, 1);
  assert.equal(db.prepare(
    `SELECT resource_id FROM idempotency_keys
     WHERE tenant_id = ? AND operation = 'authorization.rotate-credential'
       AND idempotency_key = 'stable-rotation-command'`
  ).get(tenantId).resource_id, afterRingChange);
});

test("offer publication atomically rejects a revoke or rotation after preflight", () => {
  const revoked = lifecycleDatabase();
  seedSupplier(revoked);
  seedAuthorization(revoked, { requestId: "active-one", status: "approved" });
  assert.equal(revoke(revoked, "active-one", "revoke-before-offer", "credential-compromised").changes, 1);
  assert.equal(insertCapacityOffer(revoked, "offer-after-revoke", "offer-revoke-command", 1).changes, 0);
  assert.equal(revoked.prepare(
    "SELECT COUNT(*) AS count FROM capacity_offers WHERE status = 'active'"
  ).get().count, 0);

  const rotated = lifecycleDatabase();
  seedSupplier(rotated);
  seedAuthorization(rotated, { requestId: "active-one", status: "approved" });
  assert.equal(rotate(rotated, {
    requestId: "active-one",
    commandId: "rotate-before-offer",
    newDigest: "new-keyed-digest",
    legacyDigest: "new-legacy-digest"
  }).updateChanges, 1);
  assert.equal(insertCapacityOffer(rotated, "offer-after-rotate", "offer-rotate-command", 1).changes, 0);

  assert.equal(insertCapacityOffer(rotated, "offer-current", "offer-current-command", 2).changes, 1);
});

test("offer commands bind canonical payloads and reject a raced payload change", () => {
  const payload = {
    authorizationRequestId: "active-one",
    model: "model-one",
    dataClasses: ["P0", "P1"],
    limits: {
      requestsPerMinute: 10,
      tokensPerMinute: 10_000,
      concurrency: 2,
      maxOutputTokens: 100
    },
    priceMicrosPerMillionTokens: "1000",
    validUntil: future
  };
  const canonical = capacityOfferCommandBinding(payload);
  assert.equal(canonical, capacityOfferCommandBinding({
    ...payload,
    model: "  model-one  ",
    dataClasses: ["P1", "P0"],
    validUntil: "2099-01-01T00:00:00Z"
  }));
  const changed = capacityOfferCommandBinding({ ...payload, model: "model-two" });
  assert.notEqual(canonical, changed);

  const db = lifecycleDatabase();
  seedSupplier(db);
  seedAuthorization(db, { requestId: "active-one", status: "approved" });
  const winner = publishCapacityOfferCommand(
    db, "offer-winner", "shared-offer-command", 1, canonical
  );
  assert.deepEqual(winner, { offerChanges: 1, bindingChanges: 1, committedBinding: canonical });
  const samePayloadReplay = publishCapacityOfferCommand(
    db, "offer-same-replay", "shared-offer-command", 1, canonical
  );
  assert.deepEqual(samePayloadReplay, { offerChanges: 0, bindingChanges: 0, committedBinding: canonical });
  const changedPayloadRace = publishCapacityOfferCommand(
    db, "offer-changed-race", "shared-offer-command", 1, changed
  );
  assert.deepEqual(changedPayloadRace, { offerChanges: 0, bindingChanges: 0, committedBinding: canonical });
  assert.notEqual(changedPayloadRace.committedBinding, changed);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM capacity_offers").get().count, 1);
});

test("rotation target claim refuses stale ciphertext without orphaning the lifecycle revision", () => {
  const db = lifecycleDatabase();
  seedSupplier(db);
  seedAuthorization(db, { requestId: "active-one", status: "approved" });
  db.prepare(
    `UPDATE authorization_requests SET encrypted_gateway_token = 'rewrapped-cipher',
      gateway_token_iv = 'rewrapped-iv', credential_key_id = 'rewrap-key', encryption_key_version = 4
     WHERE request_id = 'active-one'`
  ).run();

  const rotation = rotate(db, {
    requestId: "active-one",
    commandId: "stale-rotate",
    newDigest: "new-keyed-digest",
    legacyDigest: "new-legacy-digest",
    onlyClaim: true
  });
  assert.equal(rotation.claimChanges, 0);
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM idempotency_keys WHERE operation = 'authorization.lifecycle-target'"
  ).get().count, 0);
});

test("rotation rejects cross-principal token reuse and the 101st authorization atomically", () => {
  const crossPrincipal = lifecycleDatabase();
  seedSupplier(crossPrincipal);
  seedAuthorization(crossPrincipal, { requestId: "active-one", status: "approved" });
  seedAuthorization(crossPrincipal, {
    requestId: "foreign-active",
    status: "approved",
    tenant: "foreign-tenant",
    supplier: "foreign-supplier",
    digest: "new-keyed-digest",
    lookupKey: "lookup-key-new"
  });
  assert.equal(rotate(crossPrincipal, {
    requestId: "active-one",
    commandId: "cross-principal",
    newDigest: "new-keyed-digest",
    legacyDigest: "new-legacy-digest",
    onlyClaim: true
  }).claimChanges, 0);

  const capped = lifecycleDatabase();
  seedSupplier(capped);
  seedAuthorization(capped, { requestId: "active-one", status: "approved" });
  for (let index = 0; index < 100; index += 1) {
    seedAuthorization(capped, {
      requestId: `same-principal-${index}`,
      status: "approved",
      digest: "new-keyed-digest",
      lookupKey: "lookup-key-new"
    });
  }
  assert.equal(rotate(capped, {
    requestId: "active-one",
    commandId: "over-cap",
    newDigest: "new-keyed-digest",
    legacyDigest: "new-legacy-digest",
    onlyClaim: true
  }).claimChanges, 0);
});

test("service postconditions require the winning command and lifecycle audits are append-once", async () => {
  const source = await readFile(path.join(webRoot, "server", "marketplace-service.ts"), "utf8");
  assert.equal((source.match(/AS command_bound/g) ?? []).length, 3);
  assert.equal((source.match(/command_bound !== 1/g) ?? []).length, 3);
  assert.match(source, /INSERT OR IGNORE INTO audit_events[\s\S]*?audit-authorization-lifecycle-/);
  assert.match(source, /prepare\(CREATE_CAPACITY_OFFER_WITH_AUTHORIZATION_CAS_SQL\)/);
  assert.match(source, /rotateAuthorizationCredentialSql[\s\S]*?FAIL_RESERVED_INFERENCE_AFTER_CREDENTIAL_ROTATION_SQL[\s\S]*?DELETE_AGENT_HEARTBEAT_AFTER_CREDENTIAL_ROTATION_SQL/);
  assert.match(source, /authorizationCredentialRotationCommandBinding\([\s\S]*?legacyCredentialDigest/);
  assert.match(source, /if \(prior !== binding\)[\s\S]*?new ApiError\("CONFLICT"[\s\S]*?409\)/);
  assert.match(source, /BIND_CAPACITY_OFFER_COMMAND_SQL[\s\S]*?input\.commandId, binding/);
  assert.match(source, /if \(committedOffer !== binding\)[\s\S]*?new ApiError\("CONFLICT"[\s\S]*?409\)/);
  assert.match(source, /guardedCapacityOfferEventInsert\(db, event, offerId, identity\.tenantId\)/);
  assert.match(source, /guardedCapacityOfferAuditInsert\(db, identity, offerId/);
});

function withdraw(db, requestId, commandId, reasonCode) {
  const binding = `${requestId}:${reasonCode}`;
  const operationToken = `withdraw-op-${requestId}`;
  const targetKey = `${requestId}:1`;
  db.exec("BEGIN IMMEDIATE");
  try {
    claimLifecycle(db, {
      requestId,
      status: "pending",
      revision: 1,
      commandId,
      operation: "authorization.withdraw",
      binding,
      operationToken
    });
    bindLifecycleCommand(db, "authorization.withdraw", commandId, binding, targetKey, operationToken);
    const result = db.prepare(WITHDRAW_PENDING_AUTHORIZATION_SQL).run(
      now, reasonCode, now, requestId, tenantId, supplierId, 1,
      targetKey, operationToken, tenantId, commandId, binding
    );
    db.exec("COMMIT");
    return result.changes;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function revoke(db, requestId, commandId, reasonCode) {
  const binding = `${requestId}:${reasonCode}`;
  const operationToken = `revoke-op-${requestId}`;
  const targetKey = `${requestId}:1`;
  db.exec("BEGIN IMMEDIATE");
  try {
    claimLifecycle(db, {
      requestId,
      status: "approved",
      revision: 1,
      commandId,
      operation: "authorization.revoke",
      binding,
      operationToken
    });
    bindLifecycleCommand(db, "authorization.revoke", commandId, binding, targetKey, operationToken);
    const result = db.prepare(REVOKE_ACTIVE_AUTHORIZATION_SQL).run(
      now, reasonCode, now, requestId, tenantId, supplierId, now, 1,
      supplierId, tenantId, 1, targetKey, operationToken, tenantId, commandId, binding
    );
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function claimLifecycle(db, {
  requestId,
  status,
  revision,
  commandId,
  operation,
  binding,
  operationToken,
  actorTenantId = tenantId
}) {
  return db.prepare(CLAIM_AUTHORIZATION_LIFECYCLE_TARGET_SQL).run(
    `${requestId}:${revision}`, operationToken, now,
    requestId, actorTenantId, supplierId, status, revision, 1,
    actorTenantId, operation, commandId, binding
  ).changes;
}

function bindLifecycleCommand(db, operation, commandId, binding, targetKey, operationToken) {
  return db.prepare(BIND_AUTHORIZATION_LIFECYCLE_COMMAND_SQL).run(
    tenantId, operation, commandId, binding, now, targetKey, operationToken
  ).changes;
}

function rotate(db, {
  requestId,
  commandId,
  newDigest,
  legacyDigest,
  onlyClaim = false
}) {
  const binding = authorizationCredentialRotationCommandBinding(
    requestId, "scheduled", legacyDigest
  );
  const operationToken = `rotate-op-${requestId}`;
  const targetKey = `${requestId}:1`;
  const lookup = [3, "lookup-key-new", newDigest];
  const claim = db.prepare(claimAuthorizationCredentialRotationTargetSql(1, 100)).run(
    targetKey, operationToken, now,
    requestId, tenantId, supplierId, now, 1,
    "cipher-old", "iv-old", "credential-key-old", 2, 1,
    requestId, now, legacyDigest, ...lookup, tenantId, supplierId,
    requestId, now, legacyDigest, ...lookup,
    tenantId, "authorization.rotate-credential", commandId, binding
  );
  if (onlyClaim || claim.changes !== 1) return { claimChanges: claim.changes, updateChanges: 0 };
  bindLifecycleCommand(
    db, "authorization.rotate-credential", commandId, binding, targetKey, operationToken
  );
  const update = db.prepare(rotateAuthorizationCredentialSql(1, 100)).run(
    "cipher-new", "iv-new", "credential-key-new", newDigest, 3, "lookup-key-new", 3,
    now, now, requestId, tenantId, supplierId, now, 1,
    "cipher-old", "iv-old", "credential-key-old", 2,
    requestId, now, legacyDigest, ...lookup, tenantId, supplierId,
    requestId, now, legacyDigest, ...lookup,
    targetKey, operationToken, tenantId, commandId, binding
  );
  return { claimChanges: claim.changes, updateChanges: update.changes };
}

function seedSupplier(db) {
  db.prepare(
    `INSERT INTO suppliers (supplier_id, tenant_id, status, supply_enabled, version, updated_at)
     VALUES (?, ?, 'active', 1, 1, ?)`
  ).run(supplierId, tenantId, now);
}

function insertCapacityOffer(db, offerId, commandId, authorizationRevision) {
  return db.prepare(CREATE_CAPACITY_OFFER_WITH_AUTHORIZATION_CAS_SQL).run(
    offerId, tenantId, supplierId, "active-one", "provider-one", "commercial-account",
    "model-one", "CN", '["P0"]', 10, 10_000, 2, 100, "1000",
    now, future, now, now,
    "active-one", tenantId, supplierId, authorizationRevision, now, future, 1,
    tenantId, commandId
  );
}

function publishCapacityOfferCommand(db, offerId, commandId, authorizationRevision, binding) {
  const offer = insertCapacityOffer(db, offerId, commandId, authorizationRevision);
  const command = db.prepare(BIND_CAPACITY_OFFER_COMMAND_SQL).run(
    tenantId, commandId, binding, now, offerId, tenantId, supplierId
  );
  const committed = db.prepare(
    `SELECT resource_id FROM idempotency_keys
     WHERE tenant_id = ? AND operation = 'offer.create' AND idempotency_key = ?`
  ).get(tenantId, commandId);
  return {
    offerChanges: offer.changes,
    bindingChanges: command.changes,
    committedBinding: committed?.resource_id ?? null
  };
}

function seedAuthorization(db, {
  requestId,
  status,
  tenant = tenantId,
  supplier = supplierId,
  revision = 1,
  digest = "old-keyed-digest",
  lookupKey = "lookup-key-old"
}) {
  db.prepare(
    `INSERT INTO authorization_requests (
      request_id, tenant_id, supplier_id, provider_id, status, valid_until,
      authorization_revision, encrypted_gateway_token, gateway_token_iv,
      credential_key_id, gateway_token_digest, gateway_token_digest_version,
      gateway_token_lookup_key_id, encryption_key_version, updated_at
    ) VALUES (?, ?, ?, 'provider-one', ?, ?, ?, 'cipher-old', 'iv-old',
      'credential-key-old', ?, 3, ?, 2, ?)`
  ).run(requestId, tenant, supplier, status, future, revision, digest, lookupKey, now);
}

function seedRevocationWork(db) {
  db.prepare(
    `INSERT INTO capacity_offers (offer_id, authorization_request_id)
     VALUES ('offer-active', 'active-one'), ('offer-other', 'other-authorization')`
  ).run();
  const job = db.prepare(
    `INSERT INTO inference_jobs (
      job_id, offer_id, authorization_request_id, status, reservation_expires_at, error_code
    ) VALUES (?, ?, ?, ?, ?, NULL)`
  );
  job.run("reserved", "offer-active", "active-one", "reserved", future);
  job.run("running", "offer-active", "active-one", "running", future);
  job.run("legacy-reserved", "offer-active", null, "reserved", future);
  job.run("other-reserved", "offer-other", "other-authorization", "reserved", future);
  const task = db.prepare(
    `INSERT INTO artifact_tasks (
      task_id, authorization_request_id, status, instruction_ciphertext, instruction_iv,
      lease_digest, lease_expires_at, execution_deadline_at, updated_at
    ) VALUES (?, ?, ?, 'cipher', 'iv', ?, ?, ?, ?)`
  );
  task.run("queued", "active-one", "queued", null, null, null, now);
  task.run("claimed", "active-one", "claimed", "lease", future, future, now);
  task.run("other-queued", "other-authorization", "queued", null, null, null, now);
  db.prepare(
    "INSERT INTO supplier_artifact_workers (supplier_tenant_id, heartbeat_id) VALUES (?, 'heartbeat-one')"
  ).run(tenantId);
}

function lifecycleDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE idempotency_keys (
      tenant_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, operation, idempotency_key)
    );
    CREATE TABLE suppliers (
      supplier_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL,
      supply_enabled INTEGER NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE authorization_requests (
      request_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      status TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      authorization_revision INTEGER NOT NULL,
      encrypted_gateway_token TEXT NOT NULL,
      gateway_token_iv TEXT NOT NULL,
      credential_key_id TEXT NOT NULL,
      gateway_token_digest TEXT,
      gateway_token_digest_version INTEGER NOT NULL,
      gateway_token_lookup_key_id TEXT NOT NULL,
      encryption_key_version INTEGER NOT NULL,
      credential_rotated_at TEXT,
      revoked_at TEXT,
      revocation_reason_code TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE capacity_offers (
      offer_id TEXT PRIMARY KEY,
      tenant_id TEXT,
      supplier_id TEXT,
      authorization_request_id TEXT NOT NULL,
      provider_id TEXT,
      source_type TEXT,
      model TEXT,
      region_code TEXT,
      data_classes_json TEXT,
      requests_per_minute INTEGER,
      tokens_per_minute INTEGER,
      concurrency INTEGER,
      max_output_tokens INTEGER,
      currency TEXT,
      price_micros_per_million_tokens TEXT,
      status TEXT,
      valid_from TEXT,
      valid_until TEXT,
      version INTEGER,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE inference_jobs (
      job_id TEXT PRIMARY KEY,
      offer_id TEXT NOT NULL,
      authorization_request_id TEXT,
      authorization_revision INTEGER,
      status TEXT NOT NULL,
      reservation_expires_at TEXT,
      error_code TEXT,
      completed_at TEXT
    );
    CREATE TABLE artifact_tasks (
      task_id TEXT PRIMARY KEY,
      authorization_request_id TEXT NOT NULL,
      status TEXT NOT NULL,
      instruction_ciphertext TEXT NOT NULL,
      instruction_iv TEXT NOT NULL,
      lease_digest TEXT,
      lease_expires_at TEXT,
      execution_deadline_at TEXT,
      cancellation_requested_at TEXT,
      error_code TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE supplier_artifact_workers (
      supplier_tenant_id TEXT PRIMARY KEY,
      heartbeat_id TEXT NOT NULL
    );
  `);
  return db;
}

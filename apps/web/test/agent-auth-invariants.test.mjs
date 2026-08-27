import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  MAX_AGENT_AUTHORIZATIONS_PER_TOKEN,
  MAX_AGENT_NONCE_NAMESPACES,
  claimAgentNonceNamespacesSql,
  migrateAgentLookupNamespacesSql
} from "../server/agent-auth-invariants.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expiresAt = "2099-01-01T00:05:00.000Z";

test("deployment transition rejects a nonce already stored in the legacy digest namespace", () => {
  const db = nonceDatabase();
  db.prepare(
    "INSERT INTO agent_request_nonces (credential_digest, nonce, expires_at) VALUES (?, ?, ?)"
  ).run("legacy-sha", "same-nonce", expiresAt);

  assert.equal(claimNamespaces(db, ["hmac-v2", "legacy-sha"], "same-nonce"), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_request_nonces").get().count, 1);
});

test("fresh nonce occupies both namespaces and any replay is rejected", () => {
  const db = nonceDatabase();

  assert.equal(claimNamespaces(db, ["hmac-v2", "legacy-sha"], "fresh-nonce"), 2);
  assert.equal(claimNamespaces(db, ["hmac-v2", "legacy-sha"], "fresh-nonce"), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_request_nonces").get().count, 2);
});

test("a key rotation cannot replay a nonce accepted under the prior lookup key", () => {
  const db = nonceDatabase();
  assert.equal(claimNamespaces(db, ["lookup-k1", "legacy-sha"], "rotation-nonce"), 2);
  assert.equal(claimNamespaces(
    db,
    ["lookup-k2", "lookup-k1", "legacy-sha"],
    "rotation-nonce"
  ), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_request_nonces").get().count, 2);
});

test("agent authentication preserves legacy token syntax but migrates every verified legacy row", async () => {
  const source = await readFile(path.join(webRoot, "server", "agent-auth.ts"), "utf8");

  assert.match(source, /token\.length < 32 \|\| token\.length > 4096 \|\| token\.trim\(\) !== token/);
  assert.match(source, /createCredentialLookupDigests\(gatewayToken\)/);
  assert.match(source, /gateway_token_lookup_key_id/);
  assert.match(source, /claimAgentNonceNamespacesSql\(nonceNamespaces\.length\)/);
  assert.match(source, /MAX_AGENT_AUTHORIZATIONS_PER_TOKEN \+ 1/);
  assert.match(source, /migrateEveryReadableLookupNamespace/);
  assert.doesNotMatch(source, /isStrongGatewayToken/);
  assert.match(source, /\(inserted\.meta\.changes \?\? 0\) !== nonceNamespaces\.length/);
  assert.equal((source.match(/"Agent 身份验证失败。"/g) ?? []).length, 1);
});

test("artifact claim rechecks the current authorization generation and heartbeat at the final write", async () => {
  const agentAuth = await readFile(path.join(webRoot, "server", "agent-auth.ts"), "utf8");
  const worker = await readFile(path.join(webRoot, "server", "artifact-worker-service.ts"), "utf8");
  const artifact = await readFile(path.join(webRoot, "server", "artifact-service.ts"), "utf8");

  assert.match(agentAuth, /authorizationRevision: row\.authorization_revision/);
  assert.match(agentAuth, /ar\.request_id = \? AND ar\.authorization_revision = \?/);
  assert.match(worker, /candidateAuthorization\.authorizationRevision/);
  assert.match(worker, /ar\.authorization_revision = \?/);
  assert.match(worker, /SELECT 1 FROM supplier_artifact_workers w/);
  assert.match(worker, /w\.expires_at > \?/);
  assert.match(worker, /error_code = CASE WHEN error_code = 'AUTHORIZATION_REVOKED_PENDING'[\s\S]*?'AUTHORIZATION_REVOKED'/);
  assert.match(artifact, /error_code = CASE WHEN error_code = 'AUTHORIZATION_REVOKED_PENDING'[\s\S]*?'AUTHORIZATION_REVOKED'/);
});

test("verified lookup migration drains rows beyond the bounded Agent response", () => {
  const db = lookupDatabase();
  const insert = db.prepare(
    `INSERT INTO authorization_requests (
      request_id, gateway_token_digest, gateway_token_digest_version,
      gateway_token_lookup_key_id, updated_at
    ) VALUES (?, ?, ?, ?, ?)`
  );
  for (let index = 0; index < MAX_AGENT_AUTHORIZATIONS_PER_TOKEN + 5; index += 1) {
    insert.run(`request-${index}`, "old-keyed", 3, "lookup-old", expiresAt);
  }
  insert.run("legacy-request", "legacy-raw", 1, "legacy-commitment-v2", expiresAt);

  const result = db.prepare(migrateAgentLookupNamespacesSql(2)).run(
    "active-keyed", 3, "lookup-active", expiresAt,
    3, "lookup-active", "active-keyed",
    "legacy-raw",
    3, "lookup-active", "active-keyed",
    3, "lookup-old", "old-keyed"
  );

  assert.equal(result.changes, MAX_AGENT_AUTHORIZATIONS_PER_TOKEN + 6);
  assert.deepEqual({ ...db.prepare(
    `SELECT COUNT(*) AS count, MIN(gateway_token_digest_version) AS min_version,
       MAX(gateway_token_digest_version) AS max_version,
       MIN(gateway_token_lookup_key_id) AS min_key, MAX(gateway_token_lookup_key_id) AS max_key
     FROM authorization_requests WHERE gateway_token_digest = 'active-keyed'`
  ).get() }, {
    count: MAX_AGENT_AUTHORIZATIONS_PER_TOKEN + 6,
    min_version: 3,
    max_version: 3,
    min_key: "lookup-active",
    max_key: "lookup-active"
  });
});

test("nonce namespace claims are bounded", () => {
  assert.throws(() => claimAgentNonceNamespacesSql(0), RangeError);
  assert.throws(() => claimAgentNonceNamespacesSql(MAX_AGENT_NONCE_NAMESPACES + 1), RangeError);
  assert.throws(() => migrateAgentLookupNamespacesSql(0), RangeError);
  assert.throws(() => migrateAgentLookupNamespacesSql(MAX_AGENT_NONCE_NAMESPACES), RangeError);
});

function claimNamespaces(db, namespaces, nonce) {
  return db.prepare(claimAgentNonceNamespacesSql(namespaces.length)).run(
    ...namespaces,
    nonce,
    expiresAt,
    nonce
  ).changes;
}

function nonceDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE agent_request_nonces (
      credential_digest TEXT NOT NULL,
      nonce TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_agent_request_nonces_unique
      ON agent_request_nonces (credential_digest, nonce);
  `);
  return db;
}

function lookupDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE authorization_requests (
      request_id TEXT PRIMARY KEY,
      gateway_token_digest TEXT,
      gateway_token_digest_version INTEGER NOT NULL,
      gateway_token_lookup_key_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

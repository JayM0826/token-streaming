import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  COUNT_INVALID_AUTHORIZATION_CREDENTIAL_REFERENCES_SQL,
  REWRAP_AUTHORIZATION_CREDENTIAL_SQL
} from "../server/credential-rotation-invariants.ts";

const now = "2026-08-28T00:00:00.000Z";

test("credential rewrap updates one exact live ciphertext generation", () => {
  const db = credentialDatabase();
  seedCredential(db);

  const result = rewrap(db);
  assert.equal(result.changes, 1);
  assert.deepEqual({ ...db.prepare(
    `SELECT encrypted_gateway_token, gateway_token_iv, encryption_key_version, credential_key_id
     FROM authorization_requests WHERE request_id = 'request-one'`
  ).get() }, {
    encrypted_gateway_token: "cipher-new",
    gateway_token_iv: "iv-new",
    encryption_key_version: 3,
    credential_key_id: "key-new"
  });
});

test("credential rewrap cannot resurrect material cleared after its read", () => {
  const db = credentialDatabase();
  seedCredential(db);
  db.prepare(
    `UPDATE authorization_requests SET encrypted_gateway_token = '', gateway_token_iv = '',
       updated_at = ? WHERE request_id = 'request-one'`
  ).run(now);

  assert.equal(rewrap(db).changes, 0);
  assert.deepEqual({ ...db.prepare(
    `SELECT encrypted_gateway_token, gateway_token_iv, credential_key_id
     FROM authorization_requests WHERE request_id = 'request-one'`
  ).get() }, {
    encrypted_gateway_token: "",
    gateway_token_iv: "",
    credential_key_id: "key-old"
  });
});

test("persisted credential references reject unknown or mismatched format and key ids", () => {
  const db = credentialDatabase();
  const insert = db.prepare(
    `INSERT INTO authorization_requests (
      request_id, encrypted_gateway_token, gateway_token_iv, encryption_key_version,
      credential_key_id, gateway_token_digest, gateway_token_digest_version,
      gateway_token_lookup_key_id, updated_at
    ) VALUES (?, 'cipher', 'iv', ?, ?, 'digest', ?, ?, ?)`
  );
  insert.run("valid-v1", 1, "legacy-credential-v2", 1, "legacy-commitment-v2", now);
  insert.run("valid-v2", 2, "legacy-credential-v2", 2, "legacy-commitment-v2", now);
  insert.run("valid-v3", 3, "credential-new", 3, "lookup-new", now);
  insert.run("invalid", 3, "legacy-credential-v2", 4, "lookup-new", now);

  assert.equal(invalidReferenceCount(db), 1);
  db.prepare(
    `UPDATE authorization_requests SET credential_key_id = 'credential-new',
       gateway_token_digest_version = 3 WHERE request_id = 'invalid'`
  ).run();
  assert.equal(invalidReferenceCount(db), 0);
});

function rewrap(db) {
  return db.prepare(REWRAP_AUTHORIZATION_CREDENTIAL_SQL).run(
    "cipher-new", "iv-new", 3, "key-new", now,
    "request-one", "cipher-old", "iv-old", 2, "key-old"
  );
}

function invalidReferenceCount(db) {
  return db.prepare(COUNT_INVALID_AUTHORIZATION_CREDENTIAL_REFERENCES_SQL).get(
    "legacy-credential-v2",
    "legacy-credential-v2",
    "legacy-commitment-v2",
    "legacy-commitment-v2"
  ).reference_count;
}

function seedCredential(db) {
  db.prepare(
    `INSERT INTO authorization_requests (
       request_id, encrypted_gateway_token, gateway_token_iv,
       encryption_key_version, credential_key_id, updated_at
     ) VALUES ('request-one', 'cipher-old', 'iv-old', 2, 'key-old', ?)`
  ).run(now);
}

function credentialDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE authorization_requests (
      request_id TEXT PRIMARY KEY,
      encrypted_gateway_token TEXT NOT NULL,
      gateway_token_iv TEXT NOT NULL,
      encryption_key_version INTEGER NOT NULL,
      credential_key_id TEXT NOT NULL,
      gateway_token_digest TEXT,
      gateway_token_digest_version INTEGER NOT NULL DEFAULT 1,
      gateway_token_lookup_key_id TEXT NOT NULL DEFAULT 'legacy-commitment-v2',
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

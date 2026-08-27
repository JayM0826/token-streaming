import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  EXPIRE_PENDING_AUTHORIZATIONS_SQL,
  isAuthorizationValidityAllowed
} from "../server/authorization-invariants.ts";

const now = Date.parse("2026-08-28T00:00:00.000Z");

test("authorization validity is future-bounded and rejects effectively permanent credentials", () => {
  assert.equal(isAuthorizationValidityAllowed("2026-08-28T00:01:01.000Z", now), true);
  assert.equal(isAuthorizationValidityAllowed("2026-11-26T00:00:00.000Z", now), true);
  assert.equal(isAuthorizationValidityAllowed("2026-11-26T00:00:00.001Z", now), false);
  assert.equal(isAuthorizationValidityAllowed("9999-12-31T23:59:59.999Z", now), false);
  assert.equal(isAuthorizationValidityAllowed("2026-08-28T00:00:30.000Z", now), false);
});

test("abandoned pending authorization is rejected and its credential material is scrubbed", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE authorization_requests (
      request_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      review_note TEXT,
      encrypted_gateway_token TEXT NOT NULL,
      gateway_token_iv TEXT NOT NULL,
      gateway_token_digest TEXT,
      valid_until TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO authorization_requests VALUES (
      'old-pending', 'pending', NULL, 'ciphertext', 'iv', 'digest',
      '2026-10-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO authorization_requests VALUES (
      'fresh-pending', 'pending', NULL, 'ciphertext', 'iv', 'digest',
      '2026-10-01T00:00:00.000Z', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'
    );
  `);

  assert.equal(db.prepare(EXPIRE_PENDING_AUTHORIZATIONS_SQL).run(
    "2026-08-28T00:00:00.000Z",
    "2026-08-21T00:00:00.000Z",
    "2026-08-28T00:00:00.000Z"
  ).changes, 1);
  assert.deepEqual({ ...db.prepare(
    `SELECT status, review_note, encrypted_gateway_token, gateway_token_iv, gateway_token_digest
     FROM authorization_requests WHERE request_id = 'old-pending'`
  ).get() }, {
    status: "rejected",
    review_note: "PENDING_REVIEW_EXPIRED",
    encrypted_gateway_token: "",
    gateway_token_iv: "",
    gateway_token_digest: null
  });
  assert.equal(db.prepare(
    "SELECT status FROM authorization_requests WHERE request_id = 'fresh-pending'"
  ).get().status, "pending");
});

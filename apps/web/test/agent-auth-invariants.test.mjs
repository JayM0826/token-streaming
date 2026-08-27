import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { INSERT_AGENT_NONCE_SQL } from "../server/agent-auth-invariants.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expiresAt = "2099-01-01T00:05:00.000Z";

test("deployment transition rejects a nonce already stored in the legacy digest namespace", () => {
  const db = nonceDatabase();
  db.prepare(INSERT_AGENT_NONCE_SQL).run("legacy-sha", "same-nonce", expiresAt);

  const results = insertBothNamespaces(db, "hmac-v2", "legacy-sha", "same-nonce");
  assert.deepEqual(results, [1, 0]);
  assert.equal(results.every((changes) => changes === 1), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_request_nonces").get().count, 2);
});

test("fresh nonce occupies both namespaces and any replay is rejected", () => {
  const db = nonceDatabase();

  assert.deepEqual(insertBothNamespaces(db, "hmac-v2", "legacy-sha", "fresh-nonce"), [1, 1]);
  assert.deepEqual(insertBothNamespaces(db, "hmac-v2", "legacy-sha", "fresh-nonce"), [0, 0]);
});

test("agent authentication preserves legacy token syntax but migrates every verified legacy row", async () => {
  const source = await readFile(path.join(webRoot, "server", "agent-auth.ts"), "utf8");

  assert.match(source, /token\.length < 32 \|\| token\.length > 4096 \|\| token\.trim\(\) !== token/);
  assert.match(source, /filter\(\(row\) => row\.gateway_token_digest_version === 1\)/);
  assert.doesNotMatch(source, /isStrongGatewayToken/);
  assert.match(source, /inserted\.some\(\(result\) => \(result\.meta\.changes \?\? 0\) !== 1\)/);
  assert.equal((source.match(/"Agent 身份验证失败。"/g) ?? []).length, 1);
});

function insertBothNamespaces(db, hmacDigest, legacyDigest, nonce) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const results = [hmacDigest, legacyDigest].map((digest) =>
      db.prepare(INSERT_AGENT_NONCE_SQL).run(digest, nonce, expiresAt).changes
    );
    db.exec("COMMIT");
    return results;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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

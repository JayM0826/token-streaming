import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  CRYPTOGRAPHIC_PREFLIGHT_SCHEMA_CAPABILITIES_SQL,
  resolveCryptographicPreflightSchemaCapabilities
} from "../server/cryptographic-preflight-invariants.ts";

test("read-only preflight treats pre-upgrade state and bootstrap tables as unavailable", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE cryptographic_key_canaries (domain TEXT, key_id TEXT)");
  const before = db.prepare("SELECT total_changes() AS changes").get().changes;
  const rows = db.prepare(CRYPTOGRAPHIC_PREFLIGHT_SCHEMA_CAPABILITIES_SQL).all();
  const after = db.prepare("SELECT total_changes() AS changes").get().changes;

  assert.deepEqual(resolveCryptographicPreflightSchemaCapabilities(rows), {
    keyringStates: false,
    bootstrapEligibility: false
  });
  assert.equal(after, before);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name),
    ["cryptographic_key_canaries"]
  );
});

test("read-only preflight detects upgraded state and bootstrap tables without mutation", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE cryptographic_keyring_states (domain TEXT PRIMARY KEY);
    CREATE TABLE cryptographic_key_bootstrap_eligibility (domain TEXT PRIMARY KEY);
  `);
  const before = db.prepare("SELECT total_changes() AS changes").get().changes;
  const rows = db.prepare(CRYPTOGRAPHIC_PREFLIGHT_SCHEMA_CAPABILITIES_SQL).all();
  const after = db.prepare("SELECT total_changes() AS changes").get().changes;

  assert.deepEqual(resolveCryptographicPreflightSchemaCapabilities(rows), {
    keyringStates: true,
    bootstrapEligibility: true
  });
  assert.equal(after, before);
});

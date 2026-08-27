import assert from "node:assert/strict";
import test from "node:test";

import {
  KeyringConfigurationError,
  MAX_VERSIONED_KEYRING_KEYS,
  resolveLegacyKeyAliasEnabled,
  resolveVersionedKeyring
} from "../server/keyring.ts";

const encodedKey = (byte) => Buffer.alloc(32, byte).toString("base64");

test("a single legacy secret remains the active readable key", () => {
  const ring = resolveVersionedKeyring({
    legacyKey: encodedKey(1),
    legacyKeyId: "legacy-credential-v2"
  });

  assert.equal(ring.activeKeyId, "legacy-credential-v2");
  assert.deepEqual(ring.keyIds, ["legacy-credential-v2"]);
  assert.equal(ring.keyBytes("legacy-credential-v2").byteLength, 32);
});

test("legacy single secrets preserve the prior unpadded base64 representation", () => {
  const unpadded = encodedKey(7).replace(/=$/, "");
  const ring = resolveVersionedKeyring({
    legacyKey: unpadded,
    legacyKeyId: "legacy-credential-v2"
  });
  assert.equal(ring.keyBytes("legacy-credential-v2")[0], 7);
  assert.throws(() => resolveVersionedKeyring({
    serialized: JSON.stringify({ active: "new", keys: { new: unpadded } }),
    legacyKeyId: "legacy"
  }), KeyringConfigurationError);
});

test("a new active key merges the old secret as verify-only legacy material", () => {
  const ring = resolveVersionedKeyring({
    serialized: JSON.stringify({
      active: "rotation-2026-08",
      keys: { "rotation-2026-08": encodedKey(2) }
    }),
    legacyKey: encodedKey(1),
    legacyKeyId: "legacy-credential-v2"
  });

  assert.equal(ring.activeKeyId, "rotation-2026-08");
  assert.deepEqual(ring.keyIds, ["rotation-2026-08", "legacy-credential-v2"]);
  const copy = ring.keyBytes("rotation-2026-08");
  copy[0] = 255;
  assert.equal(ring.keyBytes("rotation-2026-08")[0], 2);
});

test("unknown ids and malformed or ambiguous keyrings fail closed", () => {
  const ring = resolveVersionedKeyring({
    legacyKey: encodedKey(1),
    legacyKeyId: "legacy-credential-v2"
  });
  assert.throws(() => ring.keyBytes("missing"), KeyringConfigurationError);
  assert.throws(() => resolveVersionedKeyring({
    serialized: JSON.stringify({ active: "new", keys: { new: encodedKey(2) }, extra: true }),
    legacyKeyId: "legacy"
  }), KeyringConfigurationError);
  assert.throws(() => resolveVersionedKeyring({
    serialized: JSON.stringify({ active: "new", keys: { new: encodedKey(1), old: encodedKey(1) } }),
    legacyKeyId: "legacy"
  }), KeyringConfigurationError);
  assert.throws(() => resolveVersionedKeyring({
    serialized: JSON.stringify({ active: "new", keys: { new: "not-base64" } }),
    legacyKeyId: "legacy"
  }), KeyringConfigurationError);
});

test("keyrings have a strict bounded cardinality", () => {
  const keys = Object.fromEntries(
    Array.from({ length: MAX_VERSIONED_KEYRING_KEYS + 1 }, (_, index) => [
      `key-${index}`,
      encodedKey(index + 1)
    ])
  );
  assert.throws(() => resolveVersionedKeyring({
    serialized: JSON.stringify({ active: "key-0", keys }),
    legacyKeyId: "legacy"
  }), KeyringConfigurationError);
});

test("the legacy lookup alias is explicit and fails closed on ambiguous flags", () => {
  assert.equal(resolveLegacyKeyAliasEnabled(undefined), true);
  assert.equal(resolveLegacyKeyAliasEnabled("true"), true);
  assert.equal(resolveLegacyKeyAliasEnabled("false"), false);
  assert.throws(() => resolveLegacyKeyAliasEnabled("TRUE"), KeyringConfigurationError);
  assert.throws(() => resolveLegacyKeyAliasEnabled("0"), KeyringConfigurationError);
});

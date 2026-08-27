import assert from "node:assert/strict";
import test from "node:test";

import {
  assertVersionedKeyringVerifiers,
  createKeyCustodyVerifier,
  KEYRING_MANIFEST_SCHEMA,
  KeyringConfigurationError,
  MAX_VERSIONED_KEYRING_KEYS,
  resolveLegacyKeyAliasEnabled,
  resolveVersionedKeyring as resolveRawVersionedKeyring
} from "../server/keyring.ts";

const encodedKey = (byte) => Buffer.alloc(32, byte).toString("base64");
const resolveVersionedKeyring = (input) => resolveRawVersionedKeyring({
  domain: "credential-encryption",
  ...input
});

async function slotManifest({
  active = "legacy-credential-v2",
  generation = 1,
  composite = true,
  legacyAlias = true,
  keys = []
} = {}) {
  const entries = await Promise.all(keys.map(async ({ keyId, slot, state, byte }) => [
    keyId,
    {
      slot,
      state,
      verifier: await createKeyCustodyVerifier(
        "credential-encryption",
        keyId,
        new Uint8Array(Buffer.alloc(32, byte))
      )
    }
  ]));
  return JSON.stringify({
    schema: KEYRING_MANIFEST_SCHEMA,
    generation,
    active,
    sources: { composite, legacyAlias },
    keys: Object.fromEntries(entries)
  });
}

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

test("slot manifests add a staged key without exposing it to operational callers", async () => {
  const manifest = await slotManifest({
    keys: [{ keyId: "next-credential", slot: "01", state: "staged", byte: 2 }]
  });
  const ring = resolveVersionedKeyring({
    slotManifest: manifest,
    slotKeys: [encodedKey(2)],
    legacyKey: encodedKey(1),
    legacyKeyId: "legacy-credential-v2"
  });

  assert.equal(ring.configurationGeneration, 1);
  assert.deepEqual(ring.keyIds, ["legacy-credential-v2"]);
  assert.deepEqual(ring.stagedKeyIds, ["next-credential"]);
  assert.equal(ring.keyMetadata("next-credential").slot, "01");
  assert.throws(() => ring.keyBytes("next-credential"), KeyringConfigurationError);
  assert.equal(ring.verificationKeyBytes("next-credential")[0], 2);
  await assertVersionedKeyringVerifiers(ring);
});

test("a readable slot can become active while compatibility sources remain untouched", async () => {
  const manifest = await slotManifest({
    active: "next-credential",
    generation: 2,
    keys: [{ keyId: "next-credential", slot: "02", state: "readable", byte: 2 }]
  });
  const ring = resolveVersionedKeyring({
    serialized: JSON.stringify({
      active: "composite-current",
      keys: { "composite-current": encodedKey(3) }
    }),
    slotManifest: manifest,
    slotKeys: [undefined, encodedKey(2)],
    legacyKey: encodedKey(1),
    legacyKeyId: "legacy-credential-v2"
  });

  assert.equal(ring.activeKeyId, "next-credential");
  assert.deepEqual(ring.keyIds, ["next-credential", "composite-current", "legacy-credential-v2"]);
  await assertVersionedKeyringVerifiers(ring);
});

test("slot verifiers bind the domain, key id, and exact secret material", async () => {
  const manifest = await slotManifest({
    active: "next-credential",
    composite: false,
    legacyAlias: false,
    keys: [{ keyId: "next-credential", slot: "01", state: "readable", byte: 2 }]
  });
  const wrongMaterial = resolveVersionedKeyring({
    slotManifest: manifest,
    slotKeys: [encodedKey(9)],
    legacyKey: encodedKey(1),
    legacyKeyId: "legacy-credential-v2"
  });
  await assert.rejects(
    () => assertVersionedKeyringVerifiers(wrongMaterial),
    KeyringConfigurationError
  );
});

test("manifests fail closed for active staged keys, reused slots, and source-policy conflicts", async () => {
  const stagedActive = await slotManifest({
    active: "next-credential",
    keys: [{ keyId: "next-credential", slot: "01", state: "staged", byte: 2 }]
  });
  assert.throws(() => resolveVersionedKeyring({
    slotManifest: stagedActive,
    slotKeys: [encodedKey(2)],
    legacyKey: encodedKey(1),
    legacyKeyId: "legacy-credential-v2"
  }), KeyringConfigurationError);

  const verifier = "a".repeat(64);
  const duplicateSlot = JSON.stringify({
    schema: KEYRING_MANIFEST_SCHEMA,
    generation: 1,
    active: "legacy-credential-v2",
    sources: { composite: false, legacyAlias: true },
    keys: {
      one: { slot: "01", state: "staged", verifier },
      two: { slot: "01", state: "staged", verifier }
    }
  });
  assert.throws(() => resolveVersionedKeyring({
    slotManifest: duplicateSlot,
    slotKeys: [encodedKey(2)],
    legacyKey: encodedKey(1),
    legacyKeyId: "legacy-credential-v2"
  }), KeyringConfigurationError);

  const conflictingPolicy = await slotManifest({ legacyAlias: false });
  assert.throws(() => resolveVersionedKeyring({
    slotManifest: conflictingPolicy,
    legacyKey: encodedKey(1),
    legacyKeyId: "legacy-credential-v2",
    legacyAliasEnabled: true
  }), KeyringConfigurationError);
});

test("disabled compatibility sources are not parsed or exposed", async () => {
  const manifest = await slotManifest({
    active: "slot-only",
    composite: false,
    legacyAlias: false,
    keys: [{ keyId: "slot-only", slot: "01", state: "readable", byte: 4 }]
  });
  const ring = resolveVersionedKeyring({
    serialized: "not-json-and-intentionally-retained-write-only",
    slotManifest: manifest,
    slotKeys: [encodedKey(4)],
    legacyKey: "not-base64-and-intentionally-retained-write-only",
    legacyKeyId: "legacy-credential-v2"
  });

  assert.deepEqual(ring.keyIds, ["slot-only"]);
  assert.equal(ring.keyBytes("slot-only")[0], 4);
  await assertVersionedKeyringVerifiers(ring);
});

test("slot and compatibility sources share one eight-key capacity bound", async () => {
  const keys = Array.from({ length: MAX_VERSIONED_KEYRING_KEYS }, (_, index) => ({
    keyId: `slot-${index + 1}`,
    slot: String(index + 1).padStart(2, "0"),
    state: index === 0 ? "readable" : "staged",
    byte: index + 1
  }));
  const manifest = await slotManifest({ active: "slot-1", keys });
  assert.throws(() => resolveVersionedKeyring({
    slotManifest: manifest,
    slotKeys: keys.map((entry) => encodedKey(entry.byte)),
    legacyKey: encodedKey(20),
    legacyKeyId: "legacy-credential-v2"
  }), KeyringConfigurationError);
});

test("canonical manifest identity is independent of JSON key insertion order", async () => {
  const first = await slotManifest({
    keys: [
      { keyId: "z-key", slot: "02", state: "staged", byte: 2 },
      { keyId: "a-key", slot: "01", state: "staged", byte: 1 }
    ]
  });
  const second = await slotManifest({
    keys: [
      { keyId: "a-key", slot: "01", state: "staged", byte: 1 },
      { keyId: "z-key", slot: "02", state: "staged", byte: 2 }
    ]
  });
  const input = {
    slotKeys: [encodedKey(1), encodedKey(2)],
    legacyKey: encodedKey(3),
    legacyKeyId: "legacy-credential-v2"
  };
  assert.equal(
    resolveVersionedKeyring({ ...input, slotManifest: first }).canonicalManifest,
    resolveVersionedKeyring({ ...input, slotManifest: second }).canonicalManifest
  );
});

export const MAX_VERSIONED_KEYRING_KEYS = 8;
export const KEYRING_MANIFEST_SCHEMA = "gongsuanyun.keyring-manifest.v1";

const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const BASE64_256_BIT_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const LEGACY_UNPADDED_256_BIT_KEY_PATTERN = /^[A-Za-z0-9+/]{43}$/;
const VERIFIER_PATTERN = /^[a-f0-9]{64}$/;

export type VersionedKeyringDomain = "credential-encryption" | "credential-lookup";
export type VersionedKeyState = "staged" | "readable";
export type VersionedKeySource = "composite" | "legacy-alias" | "slot";

export class KeyringConfigurationError extends Error {
  readonly reason: "invalid" | "capacity";

  constructor(message: string, reason: "invalid" | "capacity" = "invalid") {
    super(message);
    this.name = "KeyringConfigurationError";
    this.reason = reason;
  }
}

export interface VersionedKeyMetadata {
  keyId: string;
  source: VersionedKeySource;
  state: VersionedKeyState;
  slot: string | null;
  expectedVerifier: string | null;
}

export interface ResolvedVersionedKeyring {
  domain: VersionedKeyringDomain;
  activeKeyId: string;
  /** Active followed by every other operationally readable key. */
  keyIds: readonly string[];
  /** Staged slot keys are verifier-visible but cannot encrypt, decrypt, or sign. */
  stagedKeyIds: readonly string[];
  allKeyIds: readonly string[];
  configurationGeneration: number | null;
  canonicalManifest: string | null;
  slotKeyCount: number;
  keyBytes(keyId: string): Uint8Array<ArrayBuffer>;
  verificationKeyBytes(keyId: string): Uint8Array<ArrayBuffer>;
  keyMetadata(keyId: string): VersionedKeyMetadata;
}

export interface ResolveVersionedKeyringInput {
  domain: VersionedKeyringDomain;
  serialized?: string;
  slotManifest?: string;
  /** Index zero is slot 01. Slots are write-only runtime secrets. */
  slotKeys?: readonly (string | undefined)[];
  legacyKey?: string;
  legacyKeyId: string;
  developmentKey?: string;
  /** When supplied, it must agree with manifest.sources.legacyAlias. */
  legacyAliasEnabled?: boolean;
}

export function resolveLegacyKeyAliasEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  invalid("legacy key alias flag is invalid");
}

/**
 * Resolves a bounded keyring without exporting encoded material in errors or
 * status. A manifest can add independently replaceable secret slots while the
 * prior composite and single-key secrets remain untouched and readable.
 */
export function resolveVersionedKeyring(
  input: ResolveVersionedKeyringInput
): ResolvedVersionedKeyring {
  validateKeyId(input.legacyKeyId);
  const manifest = input.slotManifest ? parseSlotManifest(input.slotManifest) : null;
  if (
    manifest && input.legacyAliasEnabled !== undefined &&
    manifest.sources.legacyAlias !== input.legacyAliasEnabled
  ) {
    invalid("legacy alias policy conflicts with keyring manifest");
  }

  const includeComposite = manifest?.sources.composite ?? true;
  const includeLegacyAlias = manifest?.sources.legacyAlias ?? (input.legacyAliasEnabled ?? true);
  const parsed = includeComposite && input.serialized ? parseKeyringJson(input.serialized) : null;
  const legacyKey = includeLegacyAlias
    ? normalizeLegacyKey(input.legacyKey ?? input.developmentKey)
    : undefined;
  const encoded = new Map<string, string>();
  const metadata = new Map<string, VersionedKeyMetadata>();

  for (const [keyId, material] of parsed?.keys ?? []) {
    mergeEncodedKey(encoded, keyId, material);
    metadata.set(keyId, readableMetadata(keyId, "composite"));
  }
  if (legacyKey) {
    mergeEncodedKey(encoded, input.legacyKeyId, legacyKey);
    if (!metadata.has(input.legacyKeyId)) {
      metadata.set(input.legacyKeyId, readableMetadata(input.legacyKeyId, "legacy-alias"));
    }
  }

  if (manifest) {
    const slots = input.slotKeys ?? [];
    for (const [keyId, entry] of manifest.keys) {
      const slotValue = slots[Number(entry.slot) - 1];
      if (!slotValue) invalid("configured key slot is unavailable");
      mergeEncodedKey(encoded, keyId, slotValue);
      const previous = metadata.get(keyId);
      metadata.set(keyId, {
        keyId,
        source: "slot",
        state: previous?.state === "readable" ? "readable" : entry.state,
        slot: entry.slot,
        expectedVerifier: entry.verifier
      });
    }
  }

  if (encoded.size === 0) invalid("no key material is configured");
  if (encoded.size > MAX_VERSIONED_KEYRING_KEYS) capacityExceeded();

  const activeKeyId = manifest?.active ?? parsed?.active ?? input.legacyKeyId;
  validateKeyId(activeKeyId);
  const activeMetadata = metadata.get(activeKeyId);
  if (!activeMetadata || activeMetadata.state !== "readable") {
    invalid("active key id is not readable");
  }

  const decoded = new Map<string, Uint8Array<ArrayBuffer>>();
  const materialOwners = new Map<string, string>();
  for (const [keyId, value] of encoded) {
    validateKeyId(keyId);
    const bytes = decodeKey(value);
    const fingerprint = bytesToHex(bytes);
    const owner = materialOwners.get(fingerprint);
    if (owner && owner !== keyId) invalid("duplicate key material is assigned to multiple ids");
    materialOwners.set(fingerprint, keyId);
    decoded.set(keyId, bytes);
  }

  const readableIds = [...metadata.values()]
    .filter((entry) => entry.state === "readable")
    .map((entry) => entry.keyId);
  const keyIds = [activeKeyId, ...readableIds.filter((keyId) => keyId !== activeKeyId).sort()];
  const stagedKeyIds = [...metadata.values()]
    .filter((entry) => entry.state === "staged")
    .map((entry) => entry.keyId)
    .sort();
  const allKeyIds = [...keyIds, ...stagedKeyIds];

  return {
    domain: input.domain,
    activeKeyId,
    keyIds,
    stagedKeyIds,
    allKeyIds,
    configurationGeneration: manifest?.generation ?? null,
    canonicalManifest: manifest?.canonical ?? null,
    slotKeyCount: manifest?.keys.size ?? 0,
    keyBytes(keyId: string): Uint8Array<ArrayBuffer> {
      const entry = requireMetadata(metadata, keyId);
      if (entry.state !== "readable") invalid("staged key material is not operationally readable");
      return requireKeyBytes(decoded, keyId);
    },
    verificationKeyBytes(keyId: string): Uint8Array<ArrayBuffer> {
      requireMetadata(metadata, keyId);
      return requireKeyBytes(decoded, keyId);
    },
    keyMetadata(keyId: string): VersionedKeyMetadata {
      return { ...requireMetadata(metadata, keyId) };
    }
  };
}

export async function createKeyCustodyVerifier(
  domain: VersionedKeyringDomain,
  keyId: string,
  keyBytes: Uint8Array<ArrayBuffer>
): Promise<string> {
  validateKeyId(keyId);
  if (keyBytes.byteLength !== 32) invalid("key material is not 256 bits");
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const payload = new TextEncoder().encode(
    `gongsuanyun.key-custody.v1\n${domain}\n${keyId}`
  );
  const verifier = await crypto.subtle.sign("HMAC", key, payload);
  return bytesToHex(new Uint8Array(verifier));
}

export async function assertVersionedKeyringVerifiers(
  keyring: ResolvedVersionedKeyring
): Promise<void> {
  for (const keyId of keyring.allKeyIds) {
    const expected = keyring.keyMetadata(keyId).expectedVerifier;
    if (!expected) continue;
    const actual = await createKeyCustodyVerifier(
      keyring.domain,
      keyId,
      keyring.verificationKeyBytes(keyId)
    );
    if (!constantTimeEqual(expected, actual)) invalid("key slot verifier does not match material");
  }
}

function readableMetadata(keyId: string, source: VersionedKeySource): VersionedKeyMetadata {
  return { keyId, source, state: "readable", slot: null, expectedVerifier: null };
}

function mergeEncodedKey(encoded: Map<string, string>, keyId: string, material: string): void {
  validateKeyId(keyId);
  const existing = encoded.get(keyId);
  if (existing && normalizeLegacyKey(existing) !== normalizeLegacyKey(material)) {
    invalid("key id conflicts across keyring sources");
  }
  encoded.set(keyId, material);
}

function normalizeLegacyKey(value: string | undefined): string | undefined {
  if (!value || BASE64_256_BIT_KEY_PATTERN.test(value)) return value;
  // The previous single-secret reader delegated directly to atob(), which
  // accepted a 32-byte standard-base64 value without its trailing padding.
  // Preserve that deployed representation while keeping new JSON rings strict.
  if (LEGACY_UNPADDED_256_BIT_KEY_PATTERN.test(value)) return `${value}=`;
  return value;
}

function parseKeyringJson(serialized: string): {
  active: string;
  keys: ReadonlyMap<string, string>;
} {
  if (serialized.length < 2 || serialized.length > 8_192) invalid("keyring JSON size is invalid");
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    invalid("keyring JSON is invalid");
  }
  if (!isRecord(value) || !hasExactKeys(value, ["active", "keys"])) {
    invalid("keyring JSON shape is invalid");
  }
  if (typeof value.active !== "string") invalid("active key id is invalid");
  validateKeyId(value.active);
  if (!isRecord(value.keys)) invalid("keyring keys are invalid");
  const entries = Object.entries(value.keys);
  if (entries.length < 1 || entries.length > MAX_VERSIONED_KEYRING_KEYS) {
    if (entries.length > MAX_VERSIONED_KEYRING_KEYS) capacityExceeded();
    invalid("keyring key count is invalid");
  }
  for (const [keyId, encoded] of entries) {
    validateKeyId(keyId);
    if (typeof encoded !== "string") invalid("encoded key material is invalid");
  }
  return { active: value.active, keys: new Map(entries as Array<[string, string]>) };
}

interface ParsedSlotManifest {
  active: string;
  generation: number;
  sources: { composite: boolean; legacyAlias: boolean };
  keys: ReadonlyMap<string, { slot: string; state: VersionedKeyState; verifier: string }>;
  canonical: string;
}

function parseSlotManifest(serialized: string): ParsedSlotManifest {
  if (serialized.length < 2 || serialized.length > 8_192) invalid("key slot manifest size is invalid");
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    invalid("key slot manifest JSON is invalid");
  }
  if (!isRecord(value) || !hasExactKeys(value, ["schema", "generation", "active", "sources", "keys"])) {
    invalid("key slot manifest shape is invalid");
  }
  if (value.schema !== KEYRING_MANIFEST_SCHEMA) invalid("key slot manifest schema is invalid");
  if (typeof value.active !== "string") invalid("active key id is invalid");
  validateKeyId(value.active);
  if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1) {
    invalid("key slot manifest generation is invalid");
  }
  if (!isRecord(value.sources) || !hasExactKeys(value.sources, ["composite", "legacyAlias"])) {
    invalid("key slot manifest sources are invalid");
  }
  if (typeof value.sources.composite !== "boolean" || typeof value.sources.legacyAlias !== "boolean") {
    invalid("key slot manifest source flags are invalid");
  }
  if (!isRecord(value.keys)) invalid("key slot manifest keys are invalid");
  const entries = Object.entries(value.keys);
  if (entries.length > MAX_VERSIONED_KEYRING_KEYS) capacityExceeded();
  const keys = new Map<string, { slot: string; state: VersionedKeyState; verifier: string }>();
  const usedSlots = new Set<string>();
  for (const [keyId, entry] of entries) {
    validateKeyId(keyId);
    if (!isRecord(entry) || !hasExactKeys(entry, ["slot", "state", "verifier"])) {
      invalid("key slot manifest entry shape is invalid");
    }
    if (typeof entry.slot !== "string" || !/^(0[1-8])$/.test(entry.slot)) {
      invalid("key slot number is invalid");
    }
    if (usedSlots.has(entry.slot)) invalid("key slot is assigned more than once");
    if (entry.state !== "staged" && entry.state !== "readable") {
      invalid("key slot state is invalid");
    }
    if (typeof entry.verifier !== "string" || !VERIFIER_PATTERN.test(entry.verifier)) {
      invalid("key slot verifier is invalid");
    }
    usedSlots.add(entry.slot);
    keys.set(keyId, { slot: entry.slot, state: entry.state, verifier: entry.verifier });
  }
  const sortedKeys = Object.fromEntries([...keys.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const sources = {
    composite: value.sources.composite,
    legacyAlias: value.sources.legacyAlias
  };
  const canonical = JSON.stringify({
    schema: KEYRING_MANIFEST_SCHEMA,
    generation: value.generation,
    active: value.active,
    sources,
    keys: sortedKeys
  });
  return { active: value.active, generation: value.generation, sources, keys, canonical };
}

function decodeKey(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64_256_BIT_KEY_PATTERN.test(value)) invalid("key material is not canonical base64");
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    invalid("key material is not valid base64");
  }
  if (binary.length !== 32) invalid("key material is not 256 bits");
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function requireMetadata(
  metadata: ReadonlyMap<string, VersionedKeyMetadata>,
  keyId: string
): VersionedKeyMetadata {
  validateKeyId(keyId);
  const entry = metadata.get(keyId);
  if (!entry) invalid("referenced key id is unavailable");
  return entry;
}

function requireKeyBytes(
  decoded: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
  keyId: string
): Uint8Array<ArrayBuffer> {
  const value = decoded.get(keyId);
  if (!value) invalid("referenced key id is unavailable");
  return value.slice();
}

function validateKeyId(value: string): void {
  if (!KEY_ID_PATTERN.test(value)) invalid("key id is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function invalid(message: string): never {
  throw new KeyringConfigurationError(message);
}

function capacityExceeded(): never {
  throw new KeyringConfigurationError("keyring capacity is exhausted", "capacity");
}

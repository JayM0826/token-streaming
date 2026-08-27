export const MAX_VERSIONED_KEYRING_KEYS = 8;

const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const BASE64_256_BIT_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const LEGACY_UNPADDED_256_BIT_KEY_PATTERN = /^[A-Za-z0-9+/]{43}$/;

export class KeyringConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyringConfigurationError";
  }
}

export interface ResolvedVersionedKeyring {
  activeKeyId: string;
  keyIds: readonly string[];
  keyBytes(keyId: string): Uint8Array<ArrayBuffer>;
}

export interface ResolveVersionedKeyringInput {
  serialized?: string;
  legacyKey?: string;
  legacyKeyId: string;
  developmentKey?: string;
}

export function resolveLegacyKeyAliasEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  invalid("legacy key alias flag is invalid");
}

/**
 * Resolves a bounded keyring without ever returning encoded key material in an
 * error or status value. A legacy single-key secret is merged under a stable
 * identifier so deployments can add a new active key before draining old rows.
 */
export function resolveVersionedKeyring(
  input: ResolveVersionedKeyringInput
): ResolvedVersionedKeyring {
  validateKeyId(input.legacyKeyId);
  const legacyKey = normalizeLegacyKey(input.legacyKey ?? input.developmentKey);
  const parsed = input.serialized ? parseKeyringJson(input.serialized) : null;
  const encoded = new Map<string, string>(parsed?.keys ?? []);

  if (legacyKey) {
    const existing = encoded.get(input.legacyKeyId);
    if (existing && existing !== legacyKey) invalid("legacy key id conflicts with the keyring");
    encoded.set(input.legacyKeyId, legacyKey);
  }
  if (encoded.size === 0) invalid("no key material is configured");
  if (encoded.size > MAX_VERSIONED_KEYRING_KEYS) invalid("keyring is too large");

  const activeKeyId = parsed?.active ?? input.legacyKeyId;
  validateKeyId(activeKeyId);
  if (!encoded.has(activeKeyId)) invalid("active key id is unavailable");

  const decoded = new Map<string, Uint8Array<ArrayBuffer>>();
  const materialFingerprints = new Set<string>();
  for (const [keyId, value] of encoded) {
    validateKeyId(keyId);
    const bytes = decodeKey(value);
    const fingerprint = bytesToHex(bytes);
    if (materialFingerprints.has(fingerprint)) invalid("duplicate key material is assigned to multiple ids");
    materialFingerprints.add(fingerprint);
    decoded.set(keyId, bytes);
  }

  const keyIds = [activeKeyId, ...[...decoded.keys()].filter((keyId) => keyId !== activeKeyId).sort()];
  return {
    activeKeyId,
    keyIds,
    keyBytes(keyId: string): Uint8Array<ArrayBuffer> {
      validateKeyId(keyId);
      const value = decoded.get(keyId);
      if (!value) invalid("referenced key id is unavailable");
      return value.slice();
    }
  };
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
    invalid("keyring key count is invalid");
  }
  for (const [keyId, encoded] of entries) {
    validateKeyId(keyId);
    if (typeof encoded !== "string") invalid("encoded key material is invalid");
  }
  return { active: value.active, keys: new Map(entries as Array<[string, string]>) };
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

function invalid(message: string): never {
  throw new KeyringConfigurationError(message);
}

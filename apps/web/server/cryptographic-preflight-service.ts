import { getD1 } from "@/db";
import type { VersionedKeyMetadata, VersionedKeyringDomain } from "./keyring";
import { COUNT_INVALID_AUTHORIZATION_CREDENTIAL_REFERENCES_SQL } from "./credential-rotation-invariants";
import {
  CRYPTOGRAPHIC_PREFLIGHT_SCHEMA_CAPABILITIES_SQL,
  resolveCryptographicPreflightSchemaCapabilities,
  type CryptographicPreflightSchemaCapabilities
} from "./cryptographic-preflight-invariants";
import {
  assertCredentialEncryptionKeyCanary,
  assertRuntimeCryptographicConfiguration,
  createCredentialLookupKeyCanary,
  getCredentialKeyringInventory,
  LEGACY_CREDENTIAL_KEY_ID,
  LEGACY_CREDENTIAL_LOOKUP_KEY_ID,
  MARKETPLACE_CRYPTO_READER_VERSION,
  sha256Hex
} from "./security";

type CanaryStatus = "valid" | "missing" | "invalid";

export interface CryptographicKeyPreflightView {
  keyId: string;
  source: VersionedKeyMetadata["source"];
  slot: string | null;
  state: VersionedKeyMetadata["state"];
  active: boolean;
  verifier: "valid" | "not-applicable";
  canary: CanaryStatus;
  liveReferences: number;
  legacyContentReferences: number;
  latestValidUntil: string | null;
  runtimeRetirementEligible: boolean;
  /** Destruction additionally depends on external backup retention and approval. */
  safeToDestroy: false;
}

export interface CryptographicDomainPreflightView {
  domain: VersionedKeyringDomain;
  generation: number | null;
  manifestHash: string | null;
  persistedGeneration: number | null;
  persistedMinimumReaderVersion: number | null;
  baselineEligibility: "eligible" | "consumed" | "unavailable";
  configurationState: "legacy" | "unapplied" | "current" | "forward" | "rollback" | "conflict";
  activeKeyId: string;
  unknownReferencedKeyIds: readonly string[];
  keys: readonly CryptographicKeyPreflightView[];
}

export interface CryptographicPreflightResult {
  ok: true;
  ready: boolean;
  readyForApply: boolean;
  checkedAt: string;
  minimumReaderVersion: number;
  stagingRequired: boolean;
  invalidPersistedReferences: number;
  domains: readonly CryptographicDomainPreflightView[];
}

interface CanaryRow {
  format_version: number;
  ciphertext: string;
  iv: string | null;
}

interface ReferenceRow {
  key_id: string;
  reference_count: number;
  latest_valid_until: string | null;
}

/**
 * Performs no schema bootstrap, canary insertion, rewrap, cleanup, nonce claim,
 * or other mutation. It is safe to use while diagnosing a broken key rollout.
 */
export async function runCryptographicPreflight(
  now = new Date().toISOString()
): Promise<CryptographicPreflightResult> {
  await assertRuntimeCryptographicConfiguration();
  const inventory = await getCredentialKeyringInventory();
  const db = getD1();
  const [schemaRows, credentialReferences, lookupReferences, legacyContent, invalidReferences] = await Promise.all([
    db.prepare(CRYPTOGRAPHIC_PREFLIGHT_SCHEMA_CAPABILITIES_SQL).all<{ name: string }>(),
    db.prepare(
      `SELECT credential_key_id AS key_id, COUNT(*) AS reference_count,
         MAX(valid_until) AS latest_valid_until
       FROM authorization_requests WHERE encrypted_gateway_token <> ''
       GROUP BY credential_key_id`
    ).all<ReferenceRow>(),
    db.prepare(
      `SELECT gateway_token_lookup_key_id AS key_id, COUNT(*) AS reference_count,
         MAX(valid_until) AS latest_valid_until
       FROM authorization_requests WHERE gateway_token_digest IS NOT NULL
       GROUP BY gateway_token_lookup_key_id`
    ).all<ReferenceRow>(),
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM inference_jobs
          WHERE content_key_version = 1 AND output_ciphertext IS NOT NULL) +
         (SELECT COUNT(*) FROM artifact_tasks
          WHERE content_key_version = 1 AND (
            instruction_ciphertext <> '' OR output_ciphertext IS NOT NULL
          )) AS reference_count`
    ).first<{ reference_count: number }>(),
    db.prepare(COUNT_INVALID_AUTHORIZATION_CREDENTIAL_REFERENCES_SQL).bind(
      LEGACY_CREDENTIAL_KEY_ID,
      LEGACY_CREDENTIAL_KEY_ID,
      LEGACY_CREDENTIAL_LOOKUP_KEY_ID,
      LEGACY_CREDENTIAL_LOOKUP_KEY_ID
    ).first<{ reference_count: number }>()
  ]);
  const schema = resolveCryptographicPreflightSchemaCapabilities(schemaRows.results);
  const legacyContentReferences = legacyContent?.reference_count ?? 0;
  const credentials = await buildDomainView({
    domain: "credential-encryption",
    activeKeyId: inventory.credentialActiveKeyId,
    generation: inventory.credentialConfigurationGeneration,
    canonicalManifest: inventory.credentialCanonicalManifest,
    metadata: inventory.credentialKeyMetadata,
    references: credentialReferences.results,
    legacyContentReferences,
    schema
  });
  const lookups = await buildDomainView({
    domain: "credential-lookup",
    activeKeyId: inventory.credentialLookupActiveKeyId,
    generation: inventory.credentialLookupConfigurationGeneration,
    canonicalManifest: inventory.credentialLookupCanonicalManifest,
    metadata: inventory.credentialLookupKeyMetadata,
    references: lookupReferences.results,
    legacyContentReferences: 0,
    schema
  });
  const domains = [credentials, lookups] as const;
  const stagingRequired = domains.some((domain) => domain.keys.some(
    (key) => key.state === "staged" && key.canary !== "valid"
  ));
  const invalidPersistedReferences = invalidReferences?.reference_count ?? 0;
  const readyForApply = invalidPersistedReferences === 0 && domains.every((domain) =>
    domain.configurationState !== "rollback" && domain.configurationState !== "conflict" &&
    (domain.persistedMinimumReaderVersion ?? MARKETPLACE_CRYPTO_READER_VERSION) <=
      MARKETPLACE_CRYPTO_READER_VERSION &&
    domain.unknownReferencedKeyIds.length === 0 && domain.keys.every((key) =>
      key.liveReferences === 0 || key.state === "readable"
    ) && domain.keys.filter((key) => key.state === "readable").every((key) => key.canary === "valid")
  );
  const ready = readyForApply && domains.every((domain) =>
    domain.configurationState === "legacy" || domain.configurationState === "current"
  );
  return {
    ok: true,
    ready,
    readyForApply,
    checkedAt: now,
    minimumReaderVersion: MARKETPLACE_CRYPTO_READER_VERSION,
    stagingRequired,
    invalidPersistedReferences,
    domains
  };
}

async function buildDomainView(input: {
  domain: VersionedKeyringDomain;
  activeKeyId: string;
  generation: number | null;
  canonicalManifest: string | null;
  metadata: readonly VersionedKeyMetadata[];
  references: readonly ReferenceRow[];
  legacyContentReferences: number;
  schema: CryptographicPreflightSchemaCapabilities;
}): Promise<CryptographicDomainPreflightView> {
  const manifestHash = input.canonicalManifest ? await sha256Hex(input.canonicalManifest) : null;
  const persisted = input.schema.keyringStates
    ? await getD1().prepare(
        `SELECT generation, manifest_hash, minimum_reader_version
         FROM cryptographic_keyring_states WHERE domain = ?`
      ).bind(input.domain).first<{
        generation: number;
        manifest_hash: string;
        minimum_reader_version: number;
      }>()
    : null;
  const baseline = input.schema.bootstrapEligibility
    ? await getD1().prepare(
        `SELECT consumed_at FROM cryptographic_key_bootstrap_eligibility WHERE domain = ?`
      ).bind(input.domain).first<{ consumed_at: string | null }>()
    : null;
  const configurationState = resolveConfigurationState(
    input.generation,
    manifestHash,
    persisted?.generation ?? null,
    persisted?.manifest_hash ?? null
  );
  const references = new Map(input.references.map((row) => [row.key_id, row]));
  const configuredIds = new Set(input.metadata.map((entry) => entry.keyId));
  const unknownReferencedKeyIds = input.references
    .filter((row) => !configuredIds.has(row.key_id) && row.reference_count > 0)
    .map((row) => row.key_id)
    .sort();
  if (
    input.domain === "credential-encryption" && input.legacyContentReferences > 0 &&
    !configuredIds.has(LEGACY_CREDENTIAL_KEY_ID)
  ) {
    unknownReferencedKeyIds.push(LEGACY_CREDENTIAL_KEY_ID);
  }
  const keys = await Promise.all(input.metadata.map(async (entry) => {
    const reference = references.get(entry.keyId);
    const legacyContentReferences =
      input.domain === "credential-encryption" && entry.keyId === LEGACY_CREDENTIAL_KEY_ID
        ? input.legacyContentReferences
        : 0;
    const liveReferences = (reference?.reference_count ?? 0) + legacyContentReferences;
    const canary = await inspectCanary(input.domain, entry.keyId);
    return {
      keyId: entry.keyId,
      source: entry.source,
      slot: entry.slot,
      state: entry.state,
      active: entry.keyId === input.activeKeyId,
      verifier: entry.expectedVerifier ? "valid" as const : "not-applicable" as const,
      canary,
      liveReferences,
      legacyContentReferences,
      latestValidUntil: reference?.latest_valid_until ?? null,
      runtimeRetirementEligible:
        entry.state === "readable" && entry.keyId !== input.activeKeyId && liveReferences === 0,
      safeToDestroy: false as const
    };
  }));
  return {
    domain: input.domain,
    generation: input.generation,
    manifestHash,
    persistedGeneration: persisted?.generation ?? null,
    persistedMinimumReaderVersion: persisted?.minimum_reader_version ?? null,
    baselineEligibility: baseline ? (baseline.consumed_at ? "consumed" : "eligible") : "unavailable",
    configurationState,
    activeKeyId: input.activeKeyId,
    unknownReferencedKeyIds: [...new Set(unknownReferencedKeyIds)].sort(),
    keys
  };
}

function resolveConfigurationState(
  generation: number | null,
  manifestHash: string | null,
  persistedGeneration: number | null,
  persistedHash: string | null
): CryptographicDomainPreflightView["configurationState"] {
  if (generation === null || manifestHash === null) {
    return persistedGeneration === null && persistedHash === null ? "legacy" : "rollback";
  }
  if (persistedGeneration === null || persistedHash === null) return "unapplied";
  if (generation < persistedGeneration) return "rollback";
  if (generation > persistedGeneration) return "forward";
  return constantTimeEqual(manifestHash, persistedHash) ? "current" : "conflict";
}

async function inspectCanary(
  domain: VersionedKeyringDomain,
  keyId: string
): Promise<CanaryStatus> {
  const row = await getD1().prepare(
    `SELECT format_version, ciphertext, iv FROM cryptographic_key_canaries
     WHERE domain = ? AND key_id = ?`
  ).bind(domain, keyId).first<CanaryRow>();
  if (!row) return "missing";
  if (row.format_version !== 1) return "invalid";
  try {
    if (domain === "credential-encryption") {
      if (!row.iv) return "invalid";
      await assertCredentialEncryptionKeyCanary(keyId, {
        ciphertext: row.ciphertext,
        iv: row.iv,
        formatVersion: 1
      });
      return "valid";
    }
    if (row.iv !== null) return "invalid";
    const expected = await createCredentialLookupKeyCanary(keyId);
    return constantTimeEqual(expected, row.ciphertext) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

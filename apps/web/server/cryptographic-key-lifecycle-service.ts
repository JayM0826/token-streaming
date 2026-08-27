import { getD1 } from "@/db";
import type { VersionedKeyringDomain } from "./keyring";
import {
  baselineReadableKeyCanarySql,
  baselineReadableKeyEventSql,
  consumeBaselineEligibilitySql
} from "./cryptographic-key-lifecycle-invariants";
import { runCryptographicPreflight } from "./cryptographic-preflight-service";
import { ApiError } from "./http";
import {
  createCredentialEncryptionKeyCanary,
  createCredentialLookupKeyCanary,
  createRuntimeKeyCustodyVerifier,
  sha256Hex
} from "./security";

const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const BACKUP_REFERENCE_PATTERN = /^(?:kms|hsm|vault):[A-Za-z0-9][A-Za-z0-9._-]{1,63}\/[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;
const MATERIAL_VERIFIER_PATTERN = /^[a-f0-9]{64}$/;
const LEGACY_BASELINE_GENERATION = 1;

export interface ApplyKeyringManifestInput {
  domain: VersionedKeyringDomain;
  generation: number;
  commandId: string;
}

export interface RegisterStagedKeyInput extends ApplyKeyringManifestInput {
  keyId: string;
  backupReference: string;
}

export interface BaselineReadableKeyInput extends RegisterStagedKeyInput {
  materialVerifier: string;
}

export interface CryptographicLifecycleResult {
  ok: true;
  domain: VersionedKeyringDomain;
  generation: number;
  keyId: string;
  state: "manifest-applied" | "key-registered" | "key-baselined";
  idempotent: boolean;
  occurredAt: string;
}

interface LifecycleEventRow {
  event_id: string;
  key_id: string;
  generation: number;
  event_type: string;
  manifest_hash: string;
  backup_reference: string | null;
  occurred_at: string;
}

export async function applyKeyringManifest(
  input: ApplyKeyringManifestInput,
  now = new Date().toISOString()
): Promise<CryptographicLifecycleResult> {
  assertApplyInput(input, ["domain", "generation", "commandId"]);
  const eventId = `crypto-manifest:${input.domain}:${input.commandId}`;
  const existing = await readLifecycleEventByCommand(input.commandId);
  if (existing) {
    assertMatchingEvent(
      existing,
      eventId,
      existing.key_id,
      input.generation,
      "MANIFEST_APPLIED",
      undefined,
      null
    );
    return lifecycleResult(input, existing.key_id, "manifest-applied", true, existing.occurred_at);
  }
  const preflight = await runCryptographicPreflight(now);
  const domain = preflight.domains.find((entry) => entry.domain === input.domain);
  if (!domain || domain.generation !== input.generation || !domain.manifestHash) invalidRequest();
  if (domain.configurationState === "rollback") cryptoConfigurationRollback();
  if (
    !preflight.readyForApply || domain.configurationState === "conflict"
  ) cryptoConfigurationConflict();
  const db = getD1();
  const statements = [
    db.prepare(
      `INSERT INTO cryptographic_keyring_states (
         domain, generation, manifest_hash, active_key_id, applied_at, command_id
       ) SELECT ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM cryptographic_key_lifecycle_events WHERE command_id = ?
       )
       ON CONFLICT(domain) DO UPDATE SET
         generation = excluded.generation,
         manifest_hash = excluded.manifest_hash,
         active_key_id = excluded.active_key_id,
         applied_at = excluded.applied_at,
         command_id = excluded.command_id
       WHERE cryptographic_keyring_states.generation < excluded.generation`
    ).bind(
      input.domain,
      input.generation,
      domain.manifestHash,
      domain.activeKeyId,
      now,
      input.commandId,
      input.commandId
    ),
    db.prepare(
      `INSERT INTO cryptographic_key_lifecycle_events (
         event_id, domain, key_id, event_type, generation, manifest_hash,
         backup_reference, command_id, occurred_at
       ) SELECT ?, ?, ?, 'MANIFEST_APPLIED', ?, ?, NULL, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM cryptographic_keyring_states
         WHERE domain = ? AND generation = ? AND manifest_hash = ?
        ) AND NOT EXISTS (
          SELECT 1 FROM cryptographic_key_lifecycle_events WHERE event_id = ?
        ) AND NOT EXISTS (
          SELECT 1 FROM cryptographic_key_lifecycle_events WHERE command_id = ?
        )`
    ).bind(
      eventId,
      input.domain,
      domain.activeKeyId,
      input.generation,
      domain.manifestHash,
      input.commandId,
      now,
      input.domain,
      input.generation,
      domain.manifestHash,
      eventId,
      input.commandId
    )
  ];
  let results: Awaited<ReturnType<typeof db.batch>>;
  try {
    results = await db.batch(statements);
  } catch (error) {
    const raced = await readLifecycleEventByCommand(input.commandId);
    if (!raced) throw error;
    assertMatchingEvent(
      raced,
      eventId,
      domain.activeKeyId,
      input.generation,
      "MANIFEST_APPLIED",
      domain.manifestHash,
      null
    );
    return lifecycleResult(input, domain.activeKeyId, "manifest-applied", true, raced.occurred_at);
  }
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    const raced = await readLifecycleEventByCommand(input.commandId);
    if (raced) {
      assertMatchingEvent(
        raced,
        eventId,
        domain.activeKeyId,
        input.generation,
        "MANIFEST_APPLIED",
        domain.manifestHash,
        null
      );
      return lifecycleResult(input, domain.activeKeyId, "manifest-applied", true, raced.occurred_at);
    }
    cryptoConfigurationConflict();
  }
  return lifecycleResult(input, domain.activeKeyId, "manifest-applied", false, now);
}

export async function registerStagedKey(
  input: RegisterStagedKeyInput,
  now = new Date().toISOString()
): Promise<CryptographicLifecycleResult> {
  assertApplyInput(input, ["domain", "generation", "commandId", "keyId", "backupReference"]);
  if (!KEY_ID_PATTERN.test(input.keyId) || !BACKUP_REFERENCE_PATTERN.test(input.backupReference)) {
    invalidRequest();
  }
  const eventId = `crypto-register:${input.domain}:${input.commandId}`;
  const existing = await readLifecycleEventByCommand(input.commandId);
  if (existing) {
    assertMatchingEvent(
      existing,
      eventId,
      input.keyId,
      input.generation,
      "KEY_REGISTERED",
      undefined,
      input.backupReference
    );
    return lifecycleResult(input, input.keyId, "key-registered", true, existing.occurred_at);
  }
  const preflight = await runCryptographicPreflight(now);
  const domain = preflight.domains.find((entry) => entry.domain === input.domain);
  const key = domain?.keys.find((entry) => entry.keyId === input.keyId);
  if (
    !domain || !key || domain.generation !== input.generation ||
    !domain.manifestHash ||
    domain.configurationState !== "current" || key.source !== "slot" ||
    key.state !== "staged" || key.active || key.verifier !== "valid" ||
    key.liveReferences !== 0
  ) cryptoConfigurationConflict();
  const manifestHash = domain.manifestHash;
  if (key.canary === "invalid") cryptoCanaryConflict();
  if (key.canary === "valid") cryptoKeyAlreadyRegistered();

  const canary = input.domain === "credential-encryption"
    ? await createCredentialEncryptionKeyCanary(input.keyId)
    : {
        ciphertext: await createCredentialLookupKeyCanary(input.keyId),
        iv: null,
        formatVersion: 1 as const
      };
  const db = getD1();
  const statements = [
    db.prepare(
      `INSERT INTO cryptographic_key_canaries (
         canary_id, domain, key_id, format_version, ciphertext, iv, created_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM cryptographic_keyring_states
         WHERE domain = ? AND generation = ? AND manifest_hash = ?
       ) AND NOT EXISTS (
         SELECT 1 FROM cryptographic_key_canaries WHERE domain = ? AND key_id = ?
       ) AND NOT EXISTS (
         SELECT 1 FROM cryptographic_key_lifecycle_events
         WHERE domain = ? AND key_id = ? AND event_type = 'KEY_REGISTERED'
       ) AND NOT EXISTS (
         SELECT 1 FROM cryptographic_key_lifecycle_events WHERE command_id = ?
       )`
    ).bind(
      `canary:${input.domain}:${input.keyId}`,
      input.domain,
      input.keyId,
      canary.formatVersion,
      canary.ciphertext,
      canary.iv,
      now,
      input.domain,
      input.generation,
      manifestHash,
      input.domain,
      input.keyId,
      input.domain,
      input.keyId,
      input.commandId
    ),
    db.prepare(
      `INSERT INTO cryptographic_key_lifecycle_events (
         event_id, domain, key_id, event_type, generation, manifest_hash,
         backup_reference, command_id, occurred_at
       ) SELECT ?, ?, ?, 'KEY_REGISTERED', ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM cryptographic_key_canaries WHERE domain = ? AND key_id = ?
       ) AND NOT EXISTS (
         SELECT 1 FROM cryptographic_key_lifecycle_events
         WHERE domain = ? AND key_id = ? AND event_type = 'KEY_REGISTERED'
       ) AND NOT EXISTS (
         SELECT 1 FROM cryptographic_key_lifecycle_events WHERE command_id = ?
       )`
    ).bind(
      eventId,
      input.domain,
      input.keyId,
      input.generation,
      manifestHash,
      input.backupReference,
      input.commandId,
      now,
      input.domain,
      input.keyId,
      input.domain,
      input.keyId,
      input.commandId
    )
  ];
  let results: Awaited<ReturnType<typeof db.batch>>;
  try {
    results = await db.batch(statements);
  } catch (error) {
    const raced = await readLifecycleEventByCommand(input.commandId);
    if (!raced) throw error;
    assertMatchingEvent(
      raced,
      eventId,
      input.keyId,
      input.generation,
      "KEY_REGISTERED",
      manifestHash,
      input.backupReference
    );
    return lifecycleResult(input, input.keyId, "key-registered", true, raced.occurred_at);
  }
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    const raced = await readLifecycleEventByCommand(input.commandId);
    if (raced) {
      assertMatchingEvent(
        raced,
        eventId,
        input.keyId,
        input.generation,
        "KEY_REGISTERED",
        manifestHash,
        input.backupReference
      );
      return lifecycleResult(input, input.keyId, "key-registered", true, raced.occurred_at);
    }
    cryptoKeyAlreadyRegistered();
  }
  return lifecycleResult(input, input.keyId, "key-registered", false, now);
}

/**
 * Establishes the first canary for a configured readable key only on a
 * reference-free database that has never applied a slot manifest. This covers
 * both compatibility readers and a new slot-only installation. It is an
 * explicit, recovery-verifier-bound bootstrap and cannot repair a missing
 * canary on an existing or restored deployment.
 */
export async function baselineReadableKey(
  input: BaselineReadableKeyInput,
  now = new Date().toISOString()
): Promise<CryptographicLifecycleResult> {
  assertApplyInput(input, [
    "domain", "generation", "commandId", "keyId", "backupReference", "materialVerifier"
  ]);
  if (
    !KEY_ID_PATTERN.test(input.keyId) ||
    !BACKUP_REFERENCE_PATTERN.test(input.backupReference) ||
    !MATERIAL_VERIFIER_PATTERN.test(input.materialVerifier)
  ) invalidRequest();

  const baselineHash = await sha256Hex(JSON.stringify({
    schema: "gongsuanyun.key-baseline.v1",
    domain: input.domain,
    generation: input.generation,
    keyId: input.keyId,
    materialVerifier: input.materialVerifier,
    backupReference: input.backupReference
  }));
  const eventId = `crypto-baseline:${input.domain}:${input.commandId}`;
  const existing = await readLifecycleEventByCommand(input.commandId);
  if (existing) {
    assertMatchingEvent(
      existing,
      eventId,
      input.keyId,
      input.generation,
      "KEY_REGISTERED",
      baselineHash,
      input.backupReference
    );
    return lifecycleResult(input, input.keyId, "key-baselined", true, existing.occurred_at);
  }

  const preflight = await runCryptographicPreflight(now);
  const domain = preflight.domains.find((entry) => entry.domain === input.domain);
  const key = domain?.keys.find((entry) => entry.keyId === input.keyId);
  if (!domain || !key || domain.baselineEligibility !== "eligible") cryptoConfigurationConflict();
  if (domain.keys.some((entry) => entry.canary === "invalid")) cryptoCanaryConflict();
  const isFreshLegacyConfiguration =
    domain.configurationState === "legacy" && domain.generation === null &&
    domain.manifestHash === null && input.generation === LEGACY_BASELINE_GENERATION;
  const isFreshManifestConfiguration =
    domain.configurationState === "unapplied" && domain.generation === input.generation &&
    domain.manifestHash !== null;
  if (
    (!isFreshLegacyConfiguration && !isFreshManifestConfiguration) ||
    domain.persistedGeneration !== null ||
    key.state !== "readable" || key.canary !== "missing" ||
    key.liveReferences !== 0 || key.legacyContentReferences !== 0 ||
    domain.unknownReferencedKeyIds.length !== 0 ||
    domain.keys.some((entry) => entry.liveReferences !== 0) ||
    preflight.invalidPersistedReferences !== 0
  ) cryptoConfigurationConflict();

  const actualVerifier = await createRuntimeKeyCustodyVerifier(input.domain, input.keyId);
  if (!constantTimeEqual(actualVerifier, input.materialVerifier)) cryptoConfigurationConflict();

  const canary = input.domain === "credential-encryption"
    ? await createCredentialEncryptionKeyCanary(input.keyId)
    : {
        ciphertext: await createCredentialLookupKeyCanary(input.keyId),
        iv: null,
        formatVersion: 1 as const
      };
  const canaryId = `canary:${input.domain}:${input.keyId}`;
  const db = getD1();
  const statements = [
    db.prepare(baselineReadableKeyCanarySql(input.domain)).bind(
      canaryId,
      input.domain,
      input.keyId,
      canary.formatVersion,
      canary.ciphertext,
      canary.iv,
      now,
      input.domain,
      input.domain,
      input.domain,
      input.domain,
      input.commandId
    ),
    db.prepare(baselineReadableKeyEventSql(input.domain)).bind(
      eventId,
      input.domain,
      input.keyId,
      input.generation,
      baselineHash,
      input.backupReference,
      input.commandId,
      now,
      input.domain,
      canaryId,
      input.domain,
      input.keyId,
      canary.formatVersion,
      canary.ciphertext,
      canary.iv,
      input.domain,
      input.domain,
      canaryId,
      input.domain,
      input.commandId,
    ),
    db.prepare(consumeBaselineEligibilitySql(input.domain)).bind(
      now,
      input.commandId,
      input.domain,
      input.domain,
      canaryId,
      input.domain,
      input.keyId,
      canary.formatVersion,
      canary.ciphertext,
      canary.iv,
      input.domain,
      canaryId,
      eventId,
      input.domain,
      input.keyId,
      input.commandId,
      input.domain,
      eventId
    )
  ];
  let results: Awaited<ReturnType<typeof db.batch>>;
  try {
    results = await db.batch(statements);
  } catch (error) {
    const raced = await readLifecycleEventByCommand(input.commandId);
    if (!raced) throw error;
    assertMatchingEvent(
      raced,
      eventId,
      input.keyId,
      input.generation,
      "KEY_REGISTERED",
      baselineHash,
      input.backupReference
    );
    return lifecycleResult(input, input.keyId, "key-baselined", true, raced.occurred_at);
  }
  if (
    (results[0]?.meta.changes ?? 0) !== 1 ||
    (results[1]?.meta.changes ?? 0) !== 1 ||
    (results[2]?.meta.changes ?? 0) !== 1
  ) {
    const raced = await readLifecycleEventByCommand(input.commandId);
    if (raced) {
      assertMatchingEvent(
        raced,
        eventId,
        input.keyId,
        input.generation,
        "KEY_REGISTERED",
        baselineHash,
        input.backupReference
      );
      return lifecycleResult(input, input.keyId, "key-baselined", true, raced.occurred_at);
    }
    cryptoConfigurationConflict();
  }
  return lifecycleResult(input, input.keyId, "key-baselined", false, now);
}

function assertApplyInput(
  input: ApplyKeyringManifestInput,
  exactKeys: readonly string[]
): void {
  if (
    !isRecord(input) || !hasExactKeys(input, exactKeys) ||
    (input.domain !== "credential-encryption" && input.domain !== "credential-lookup") ||
    !Number.isSafeInteger(input.generation) || input.generation < 1 ||
    !COMMAND_ID_PATTERN.test(input.commandId)
  ) invalidRequest();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

async function readLifecycleEventByCommand(
  commandId: string
): Promise<LifecycleEventRow | null> {
  return getD1().prepare(
    `SELECT event_id, key_id, generation, event_type, manifest_hash, backup_reference, occurred_at
     FROM cryptographic_key_lifecycle_events WHERE command_id = ?`
  ).bind(commandId).first<LifecycleEventRow>();
}

function assertMatchingEvent(
  event: LifecycleEventRow,
  eventId: string,
  keyId: string,
  generation: number,
  eventType: string,
  manifestHash: string | undefined,
  backupReference: string | null
): void {
  if (
    event.event_id !== eventId || event.key_id !== keyId ||
    event.generation !== generation || event.event_type !== eventType ||
    (manifestHash !== undefined && event.manifest_hash !== manifestHash) ||
    event.backup_reference !== backupReference
  ) {
    cryptoConfigurationConflict();
  }
}

function lifecycleResult(
  input: ApplyKeyringManifestInput,
  keyId: string,
  state: CryptographicLifecycleResult["state"],
  idempotent: boolean,
  occurredAt: string
): CryptographicLifecycleResult {
  return {
    ok: true,
    domain: input.domain,
    generation: input.generation,
    keyId,
    state,
    idempotent,
    occurredAt
  };
}

function invalidRequest(): never {
  throw new ApiError("INVALID_REQUEST", "密钥生命周期请求无效。", 400);
}

function cryptoConfigurationConflict(): never {
  throw new ApiError("CRYPTO_CONFIG_INVALID", "密钥 manifest 未通过单调配置或引用门禁。", 409);
}

function cryptoConfigurationRollback(): never {
  throw new ApiError("CRYPTO_CONFIG_ROLLBACK", "密钥 manifest generation 不允许回退。", 409);
}

function cryptoCanaryConflict(): never {
  throw new ApiError("CRYPTO_CANARY_MISMATCH", "密钥 canary 与当前材料不一致。", 503, true);
}

function cryptoKeyAlreadyRegistered(): never {
  throw new ApiError("CRYPTO_CONFIG_INVALID", "密钥 ID 已登记且不可复用。", 409);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

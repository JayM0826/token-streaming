import type { VersionedKeyringDomain } from "./keyring";

export const CRYPTOGRAPHIC_BOOTSTRAP_PROVENANCE = "migration-empty-history-v1";

/**
 * A configured readable key may be trusted exactly once only while its domain
 * has no persisted keyring state and no encrypted or lookup references. This
 * is a deliberate fresh-database bootstrap, not an automatic TOFU path.
 */
export function baselineReadableKeyCanarySql(domain: VersionedKeyringDomain): string {
  return `
    INSERT INTO cryptographic_key_canaries (
      canary_id, domain, key_id, format_version, ciphertext, iv, created_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM cryptographic_key_bootstrap_eligibility
      WHERE domain = ? AND provenance = '${CRYPTOGRAPHIC_BOOTSTRAP_PROVENANCE}'
        AND consumed_at IS NULL AND consumed_command_id IS NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM cryptographic_keyring_states WHERE domain = ?
    ) AND NOT EXISTS (
      SELECT 1 FROM cryptographic_key_canaries WHERE domain = ?
    ) AND NOT EXISTS (
      SELECT 1 FROM cryptographic_key_lifecycle_events
      WHERE domain = ?
    ) AND NOT EXISTS (
      SELECT 1 FROM cryptographic_key_lifecycle_events
      WHERE command_id = ?
    ) AND ${freshDatabaseHistoryPredicate()}
      AND ${zeroReferencePredicate(domain)}`;
}

export function baselineReadableKeyEventSql(domain: VersionedKeyringDomain): string {
  return `
    INSERT INTO cryptographic_key_lifecycle_events (
      event_id, domain, key_id, event_type, generation, manifest_hash,
      backup_reference, command_id, occurred_at
    ) SELECT ?, ?, ?, 'KEY_REGISTERED', ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM cryptographic_key_bootstrap_eligibility
      WHERE domain = ? AND provenance = '${CRYPTOGRAPHIC_BOOTSTRAP_PROVENANCE}'
        AND consumed_at IS NULL AND consumed_command_id IS NULL
    ) AND EXISTS (
      SELECT 1 FROM cryptographic_key_canaries
      WHERE canary_id = ? AND domain = ? AND key_id = ?
        AND format_version = ? AND ciphertext = ? AND iv IS ?
    ) AND NOT EXISTS (
      SELECT 1 FROM cryptographic_keyring_states WHERE domain = ?
    ) AND NOT EXISTS (
      SELECT 1 FROM cryptographic_key_canaries
      WHERE domain = ? AND canary_id <> ?
    ) AND NOT EXISTS (
      SELECT 1 FROM cryptographic_key_lifecycle_events
      WHERE domain = ?
    ) AND NOT EXISTS (
      SELECT 1 FROM cryptographic_key_lifecycle_events
      WHERE command_id = ?
    ) AND ${freshDatabaseHistoryPredicate()}
      AND ${zeroReferencePredicate(domain)}`;
}

export function consumeBaselineEligibilitySql(domain: VersionedKeyringDomain): string {
  return `
    UPDATE cryptographic_key_bootstrap_eligibility
    SET consumed_at = ?, consumed_command_id = ?
    WHERE domain = ? AND provenance = '${CRYPTOGRAPHIC_BOOTSTRAP_PROVENANCE}'
      AND consumed_at IS NULL AND consumed_command_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM cryptographic_keyring_states WHERE domain = ?
      ) AND EXISTS (
        SELECT 1 FROM cryptographic_key_canaries
        WHERE canary_id = ? AND domain = ? AND key_id = ?
          AND format_version = ? AND ciphertext = ? AND iv IS ?
      ) AND NOT EXISTS (
        SELECT 1 FROM cryptographic_key_canaries
        WHERE domain = ? AND canary_id <> ?
      ) AND EXISTS (
        SELECT 1 FROM cryptographic_key_lifecycle_events
        WHERE event_id = ? AND domain = ? AND key_id = ?
          AND event_type = 'KEY_REGISTERED' AND command_id = ?
      ) AND NOT EXISTS (
        SELECT 1 FROM cryptographic_key_lifecycle_events
        WHERE domain = ? AND event_id <> ?
      ) AND ${freshDatabaseHistoryPredicate()}
      AND ${zeroReferencePredicate(domain)}`;
}

/**
 * Durable business/history rows make a database ineligible even after live
 * ciphertext or lookup references have been scrubbed. Operational rate-limit
 * buckets are deliberately excluded because baseline authentication creates
 * one before the lifecycle transaction starts.
 */
export function freshDatabaseHistoryPredicate(): string {
  return [
    "users",
    "suppliers",
    "authorization_requests",
    "capacity_offers",
    "marketplace_events",
    "inference_jobs",
    "usage_records",
    "service_evidence",
    "ledger_entries",
    "audit_events",
    "idempotency_keys",
    "artifacts",
    "artifact_chunks",
    "artifact_object_deletions",
    "supplier_artifact_workers",
    "artifact_tasks",
    "artifact_task_checkpoints",
    "artifact_task_evidence",
    "agent_request_nonces"
  ].map((table) => `NOT EXISTS (SELECT 1 FROM ${table})`).join(" AND ");
}

function zeroReferencePredicate(domain: VersionedKeyringDomain): string {
  if (domain === "credential-lookup") {
    return `NOT EXISTS (
      SELECT 1 FROM authorization_requests WHERE gateway_token_digest IS NOT NULL
    )`;
  }
  return `NOT EXISTS (
      SELECT 1 FROM authorization_requests WHERE encrypted_gateway_token <> ''
    ) AND NOT EXISTS (
      SELECT 1 FROM inference_jobs
      WHERE content_key_version = 1 AND output_ciphertext IS NOT NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM artifact_tasks
      WHERE content_key_version = 1 AND (
        instruction_ciphertext <> '' OR output_ciphertext IS NOT NULL
      )
    )`;
}

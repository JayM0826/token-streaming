export const MAX_AGENT_NONCE_NAMESPACES = 9;
export const MAX_AGENT_AUTHORIZATIONS_PER_TOKEN = 100;

/**
 * Claims every readable digest namespace in one statement. This prevents the
 * same signed request from becoming replayable merely because the active
 * lookup key changed during the five-minute timestamp window.
 */
export function claimAgentNonceNamespacesSql(namespaceCount: number): string {
  if (!Number.isInteger(namespaceCount) || namespaceCount < 1 || namespaceCount > MAX_AGENT_NONCE_NAMESPACES) {
    throw new RangeError("agent nonce namespace count is out of bounds");
  }
  const values = Array.from({ length: namespaceCount }, () => "(?)").join(", ");
  return `WITH requested_namespaces(credential_digest) AS (VALUES ${values})
    INSERT OR IGNORE INTO agent_request_nonces (credential_digest, nonce, expires_at)
    SELECT credential_digest, ?, ? FROM requested_namespaces
    WHERE NOT EXISTS (
      SELECT 1 FROM agent_request_nonces existing
      WHERE existing.nonce = ? AND existing.credential_digest IN (
        SELECT credential_digest FROM requested_namespaces
      )
    )`;
}

/**
 * Migrates every row in the readable raw/keyed lookup namespaces after the
 * signed token has been verified. Per-row CAS still protects the authorizations
 * returned to the caller; this sweep prevents rows beyond the response cap or
 * non-active rows from pinning a retired lookup key forever.
 */
export function migrateAgentLookupNamespacesSql(keyedNamespaceCount: number): string {
  if (
    !Number.isInteger(keyedNamespaceCount) || keyedNamespaceCount < 1 ||
    keyedNamespaceCount >= MAX_AGENT_NONCE_NAMESPACES
  ) {
    throw new RangeError("agent lookup namespace count is out of bounds");
  }
  const keyedConditions = Array.from(
    { length: keyedNamespaceCount },
    () => "(gateway_token_digest_version = ? AND gateway_token_lookup_key_id = ? AND gateway_token_digest = ?)"
  ).join(" OR ");
  return `UPDATE authorization_requests SET gateway_token_digest = ?,
      gateway_token_digest_version = ?, gateway_token_lookup_key_id = ?, updated_at = ?
    WHERE NOT (
      gateway_token_digest_version = ? AND gateway_token_lookup_key_id = ? AND gateway_token_digest = ?
    ) AND (
      (gateway_token_digest_version = 1 AND gateway_token_digest = ?) OR ${keyedConditions}
    )`;
}

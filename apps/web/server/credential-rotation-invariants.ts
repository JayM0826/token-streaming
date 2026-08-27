/**
 * Rewraps only the exact ciphertext generation that was read. Expiry, rejection,
 * revocation, or another rotation can clear/change the row first; this CAS must
 * then lose instead of restoring credential material.
 */
export const REWRAP_AUTHORIZATION_CREDENTIAL_SQL = `
  UPDATE authorization_requests SET encrypted_gateway_token = ?, gateway_token_iv = ?,
    encryption_key_version = ?, credential_key_id = ?, updated_at = ?
  WHERE request_id = ? AND encrypted_gateway_token = ? AND gateway_token_iv = ?
    AND encryption_key_version = ? AND credential_key_id = ?`;

export const COUNT_INVALID_AUTHORIZATION_CREDENTIAL_REFERENCES_SQL = `
  SELECT COUNT(*) AS reference_count FROM authorization_requests
  WHERE (
    encrypted_gateway_token <> '' AND NOT (
      (encryption_key_version IN (1, 2) AND credential_key_id = ?) OR
      (encryption_key_version = 3 AND credential_key_id <> ?)
    )
  ) OR (
    gateway_token_digest IS NOT NULL AND NOT (
      (gateway_token_digest_version IN (1, 2) AND gateway_token_lookup_key_id = ?) OR
      (gateway_token_digest_version = 3 AND gateway_token_lookup_key_id <> ?)
    )
  )`;

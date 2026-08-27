export const INSERT_AGENT_NONCE_SQL = `
  INSERT OR IGNORE INTO agent_request_nonces (credential_digest, nonce, expires_at)
  VALUES (?, ?, ?)`;

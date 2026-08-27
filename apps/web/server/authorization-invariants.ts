export const AUTHORIZATION_MAX_VALIDITY_MILLISECONDS = 90 * 24 * 60 * 60_000;
export const PENDING_AUTHORIZATION_MAX_AGE_MILLISECONDS = 7 * 24 * 60 * 60_000;

export function isAuthorizationValidityAllowed(value: string, nowMilliseconds: number): boolean {
  const timestamp = Date.parse(value);
  return value.endsWith("Z") && Number.isFinite(timestamp) &&
    timestamp > nowMilliseconds + 60_000 &&
    timestamp <= nowMilliseconds + AUTHORIZATION_MAX_VALIDITY_MILLISECONDS;
}

export const EXPIRE_PENDING_AUTHORIZATIONS_SQL = `
  UPDATE authorization_requests SET status = 'rejected',
    review_note = COALESCE(review_note, 'PENDING_REVIEW_EXPIRED'),
    encrypted_gateway_token = '', gateway_token_iv = '', gateway_token_digest = NULL,
    updated_at = ?
  WHERE status = 'pending' AND (created_at <= ? OR valid_until <= ?)`;

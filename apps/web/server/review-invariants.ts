/**
 * SQLite write-side gates for admin review. The global target claim makes the
 * review decision single-writer even when different administrator tenants race,
 * while the reviewer-scoped command binding prevents one command from being
 * reused for another request or decision.
 */

export const CLAIM_AUTHORIZATION_REVIEW_TARGET_SQL = `
  INSERT OR IGNORE INTO idempotency_keys (
    tenant_id, operation, idempotency_key, resource_id, created_at
  ) SELECT 'platform', 'authorization.review-target', ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM authorization_requests
      WHERE request_id = ? AND status = 'pending' AND review_command_id IS NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE tenant_id = ? AND operation = 'authorization.review' AND idempotency_key = ?
        AND resource_id <> ?
    )`;

export const BIND_AUTHORIZATION_REVIEW_COMMAND_SQL = `
  INSERT OR IGNORE INTO idempotency_keys (
    tenant_id, operation, idempotency_key, resource_id, created_at
  ) SELECT ?, 'authorization.review', ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE tenant_id = 'platform' AND operation = 'authorization.review-target'
        AND idempotency_key = ? AND resource_id = ?
    )`;

export const REJECT_AUTHORIZATION_REQUEST_SQL = `
  UPDATE authorization_requests SET status = 'rejected', review_note = ?, reviewed_by = ?,
    review_command_id = ?, reviewed_at = ?, updated_at = ?, encrypted_gateway_token = '',
    gateway_token_iv = '', gateway_token_digest = NULL
  WHERE request_id = ? AND status = 'pending' AND review_command_id IS NULL
    AND EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE tenant_id = 'platform' AND operation = 'authorization.review-target'
        AND idempotency_key = ? AND resource_id = ?
    ) AND EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE tenant_id = ? AND operation = 'authorization.review'
        AND idempotency_key = ? AND resource_id = ?
    )`;

export const APPROVE_AUTHORIZATION_REQUEST_SQL = `
  UPDATE authorization_requests SET status = 'approved', review_note = ?, reviewed_by = ?,
    review_command_id = ?, reviewed_at = ?, updated_at = ?
  WHERE request_id = ? AND status = 'pending' AND review_command_id IS NULL
    AND EXISTS (
      SELECT 1 FROM suppliers
      WHERE supplier_id = ? AND tenant_id = ? AND version = ?
    ) AND EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE tenant_id = 'platform' AND operation = 'authorization.review-target'
        AND idempotency_key = ? AND resource_id = ?
    ) AND EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE tenant_id = ? AND operation = 'authorization.review'
        AND idempotency_key = ? AND resource_id = ?
    )`;

export const ACTIVATE_REVIEWED_SUPPLIER_SQL = `
  UPDATE suppliers SET status = 'active', version = ?, updated_at = ?
  WHERE supplier_id = ? AND tenant_id = ? AND version = ?
    AND EXISTS (
      SELECT 1 FROM authorization_requests
      WHERE request_id = ? AND status = 'approved' AND review_command_id = ?
    ) AND EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE tenant_id = 'platform' AND operation = 'authorization.review-target'
        AND idempotency_key = ? AND resource_id = ?
    )`;

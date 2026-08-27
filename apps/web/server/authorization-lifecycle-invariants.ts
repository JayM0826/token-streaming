/**
 * One global claim serializes every lifecycle transition from the same stored
 * revision, including an owner revoke racing an administrator or a token
 * replacement. The actor-scoped command binding remains independently
 * replayable but cannot be reused with a different payload.
 */
export const CLAIM_AUTHORIZATION_LIFECYCLE_TARGET_SQL = `
  INSERT OR IGNORE INTO idempotency_keys (
    tenant_id, operation, idempotency_key, resource_id, created_at
  ) SELECT 'platform', 'authorization.lifecycle-target', ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM authorization_requests ar
      JOIN suppliers s ON s.supplier_id = ar.supplier_id AND s.tenant_id = ar.tenant_id
      WHERE ar.request_id = ? AND ar.tenant_id = ? AND ar.supplier_id = ?
        AND ar.status = ? AND ar.authorization_revision = ?
        AND s.version = ?
    ) AND NOT EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE tenant_id = ? AND operation = ? AND idempotency_key = ?
        AND resource_id <> ?
    )`;

export const BIND_AUTHORIZATION_LIFECYCLE_COMMAND_SQL = `
  INSERT OR IGNORE INTO idempotency_keys (
    tenant_id, operation, idempotency_key, resource_id, created_at
  ) SELECT ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE tenant_id = 'platform' AND operation = 'authorization.lifecycle-target'
        AND idempotency_key = ? AND resource_id = ?
    )`;

/**
 * Rotation has additional write predicates beyond lifecycle revision. Claiming
 * the target with the same ciphertext generation and lookup constraints keeps
 * a failed uniqueness/capacity CAS from leaving an orphan lifecycle claim.
 */
export function claimAuthorizationCredentialRotationTargetSql(
  keyedNamespaceCount: number,
  maximumAuthorizationsPerToken: number
): string {
  assertMaximumAuthorizationsPerToken(maximumAuthorizationsPerToken);
  const predicate = authorizationLookupPredicate(keyedNamespaceCount, "other");
  return `
    INSERT OR IGNORE INTO idempotency_keys (
      tenant_id, operation, idempotency_key, resource_id, created_at
    ) SELECT 'platform', 'authorization.lifecycle-target', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM authorization_requests ar
        JOIN suppliers s ON s.supplier_id = ar.supplier_id AND s.tenant_id = ar.tenant_id
        WHERE ar.request_id = ? AND ar.tenant_id = ? AND ar.supplier_id = ?
          AND ar.status = 'approved' AND ar.valid_until > ? AND ar.authorization_revision = ?
          AND ar.encrypted_gateway_token = ? AND ar.gateway_token_iv = ?
          AND ar.credential_key_id = ? AND ar.encryption_key_version = ?
          AND s.version = ?
          AND NOT EXISTS (
            SELECT 1 FROM authorization_requests other
            WHERE other.request_id <> ? AND other.status = 'approved' AND other.valid_until > ?
              AND (${predicate})
              AND (other.tenant_id <> ? OR other.supplier_id <> ?)
          )
          AND (
            SELECT COUNT(*) FROM authorization_requests other
            WHERE other.request_id <> ? AND other.status = 'approved' AND other.valid_until > ?
              AND (${predicate})
          ) < ${maximumAuthorizationsPerToken}
      ) AND NOT EXISTS (
        SELECT 1 FROM idempotency_keys
        WHERE tenant_id = ? AND operation = ? AND idempotency_key = ?
          AND resource_id <> ?
      )`;
}

export const WITHDRAW_PENDING_AUTHORIZATION_SQL = `
  UPDATE authorization_requests SET status = 'withdrawn',
    authorization_revision = authorization_revision + 1,
    encrypted_gateway_token = '', gateway_token_iv = '', gateway_token_digest = NULL,
    revoked_at = ?, revocation_reason_code = ?, updated_at = ?
  WHERE request_id = ? AND tenant_id = ? AND supplier_id = ?
    AND status = 'pending' AND authorization_revision = ?
    AND EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE tenant_id = 'platform' AND operation = 'authorization.lifecycle-target'
        AND idempotency_key = ? AND resource_id = ?
    ) AND EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE tenant_id = ? AND operation = 'authorization.withdraw'
        AND idempotency_key = ? AND resource_id = ?
    )`;

export const REVOKE_ACTIVE_AUTHORIZATION_SQL = `
  UPDATE authorization_requests SET status = 'revoked',
    authorization_revision = authorization_revision + 1,
    encrypted_gateway_token = '', gateway_token_iv = '', gateway_token_digest = NULL,
    revoked_at = ?, revocation_reason_code = ?, updated_at = ?
  WHERE request_id = ? AND tenant_id = ? AND supplier_id = ?
    AND status = 'approved' AND valid_until > ? AND authorization_revision = ?
    AND EXISTS (
      SELECT 1 FROM suppliers
      WHERE supplier_id = ? AND tenant_id = ? AND version = ?
    ) AND EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE tenant_id = 'platform' AND operation = 'authorization.lifecycle-target'
        AND idempotency_key = ? AND resource_id = ?
    ) AND EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE tenant_id = ? AND operation = 'authorization.revoke'
        AND idempotency_key = ? AND resource_id = ?
    )`;

/**
 * Replaces only one exact token generation. The new lookup predicate is also
 * checked at the write boundary so another authorization approval/rotation
 * cannot cross the per-token cap or bind a credential across supplier
 * principals between preflight and commit.
 */
export function rotateAuthorizationCredentialSql(
  keyedNamespaceCount: number,
  maximumAuthorizationsPerToken: number
): string {
  assertMaximumAuthorizationsPerToken(maximumAuthorizationsPerToken);
  const predicate = authorizationLookupPredicate(keyedNamespaceCount, "other");
  return `
    UPDATE authorization_requests SET encrypted_gateway_token = ?, gateway_token_iv = ?,
      credential_key_id = ?, gateway_token_digest = ?, gateway_token_digest_version = ?,
      gateway_token_lookup_key_id = ?, encryption_key_version = ?,
      authorization_revision = authorization_revision + 1,
      credential_rotated_at = ?, updated_at = ?
    WHERE request_id = ? AND tenant_id = ? AND supplier_id = ?
      AND status = 'approved' AND valid_until > ? AND authorization_revision = ?
      AND encrypted_gateway_token = ? AND gateway_token_iv = ?
      AND credential_key_id = ? AND encryption_key_version = ?
      AND NOT EXISTS (
        SELECT 1 FROM authorization_requests other
        WHERE other.request_id <> ? AND other.status = 'approved' AND other.valid_until > ?
          AND (${predicate})
          AND (other.tenant_id <> ? OR other.supplier_id <> ?)
      )
      AND (
        SELECT COUNT(*) FROM authorization_requests other
        WHERE other.request_id <> ? AND other.status = 'approved' AND other.valid_until > ?
          AND (${predicate})
      ) < ${maximumAuthorizationsPerToken}
      AND EXISTS (
        SELECT 1 FROM idempotency_keys
        WHERE tenant_id = 'platform' AND operation = 'authorization.lifecycle-target'
          AND idempotency_key = ? AND resource_id = ?
      ) AND EXISTS (
        SELECT 1 FROM idempotency_keys
        WHERE tenant_id = ? AND operation = 'authorization.rotate-credential'
          AND idempotency_key = ? AND resource_id = ?
      )`;
}

/**
 * Offer publication is one write-side authorization CAS. A preflight read may
 * be stale, so the INSERT itself repeats the exact authorization revision,
 * credential, expiry, and supplier aggregate predicates.
 */
export const CREATE_CAPACITY_OFFER_WITH_AUTHORIZATION_CAS_SQL = `
  INSERT INTO capacity_offers (
    offer_id, tenant_id, supplier_id, authorization_request_id, provider_id, source_type,
    model, region_code, data_classes_json, requests_per_minute, tokens_per_minute,
    concurrency, max_output_tokens, currency, price_micros_per_million_tokens, status,
    valid_from, valid_until, version, created_at, updated_at
  ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CNY', ?, 'active', ?, ?, 1, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM authorization_requests ar
      JOIN suppliers s ON s.supplier_id = ar.supplier_id AND s.tenant_id = ar.tenant_id
      WHERE ar.request_id = ? AND ar.tenant_id = ? AND ar.supplier_id = ?
        AND ar.authorization_revision = ? AND ar.status = 'approved'
        AND ar.valid_until > ? AND ar.valid_until >= ?
        AND ar.encrypted_gateway_token <> '' AND ar.gateway_token_iv <> ''
        AND ar.gateway_token_digest IS NOT NULL
        AND s.version = ? AND s.status = 'active'
    ) AND NOT EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE tenant_id = ? AND operation = 'offer.create' AND idempotency_key = ?
    )`;

export const BIND_CAPACITY_OFFER_COMMAND_SQL = `
  INSERT OR IGNORE INTO idempotency_keys (
    tenant_id, operation, idempotency_key, resource_id, created_at
  ) SELECT ?, 'offer.create', ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM capacity_offers WHERE offer_id = ? AND tenant_id = ? AND supplier_id = ?
    )`;

export function authorizationCredentialRotationCommandBinding(
  requestId: string,
  reasonCode: string,
  legacyCredentialDigest: string
): string {
  return `${requestId}:${reasonCode}:${legacyCredentialDigest}`;
}

export function capacityOfferCommandBinding(input: {
  authorizationRequestId: string;
  model: string;
  dataClasses: ReadonlyArray<"P0" | "P1">;
  limits: {
    requestsPerMinute: number;
    tokensPerMinute: number;
    concurrency: number;
    maxOutputTokens: number;
  };
  priceMicrosPerMillionTokens: string;
  validUntil: string;
}): string {
  return `offer.create:v1:${JSON.stringify([
    input.authorizationRequestId,
    input.model.trim(),
    [...input.dataClasses].sort(),
    input.limits.requestsPerMinute,
    input.limits.tokensPerMinute,
    input.limits.concurrency,
    input.limits.maxOutputTokens,
    BigInt(input.priceMicrosPerMillionTokens).toString(),
    new Date(input.validUntil).toISOString()
  ])}`;
}

/**
 * A rotation invalidates only work which has not crossed the reserved ->
 * running boundary. The exact old revision identifies reservations carrying
 * the displaced credential generation, while the EXISTS guard proves the new
 * generation won the lifecycle CAS before any balance is released.
 */
export const FAIL_RESERVED_INFERENCE_AFTER_CREDENTIAL_ROTATION_SQL = `
  UPDATE inference_jobs SET status = 'failed', reservation_expires_at = NULL,
    error_code = 'GATEWAY_CREDENTIAL_ROTATED', completed_at = ?,
    authorization_request_id = COALESCE(authorization_request_id, ?),
    authorization_revision = COALESCE(authorization_revision, ?)
  WHERE status = 'reserved'
    AND (
      authorization_request_id = ? OR (
        authorization_request_id IS NULL AND offer_id IN (
          SELECT offer_id FROM capacity_offers WHERE authorization_request_id = ?
        )
      )
    )
    AND (authorization_revision = ? OR authorization_revision IS NULL)
    AND EXISTS (
      SELECT 1 FROM authorization_requests
      WHERE request_id = ? AND tenant_id = ? AND supplier_id = ?
        AND status = 'approved' AND authorization_revision = ?
        AND gateway_token_digest = ?
    )`;

export const FAIL_RESERVED_INFERENCE_FOR_REVOKED_AUTHORIZATION_SQL = `
  UPDATE inference_jobs SET status = 'failed', reservation_expires_at = NULL,
    error_code = 'AUTHORIZATION_REVOKED', completed_at = ?,
    authorization_request_id = COALESCE(authorization_request_id, ?)
  WHERE status = 'reserved' AND (
      authorization_request_id = ? OR (
        authorization_request_id IS NULL AND offer_id IN (
          SELECT offer_id FROM capacity_offers WHERE authorization_request_id = ?
        )
      )
    ) AND EXISTS (
      SELECT 1 FROM authorization_requests
      WHERE request_id = ? AND status = 'revoked' AND authorization_revision = ?
    )`;

export const FAIL_QUEUED_ARTIFACTS_FOR_REVOKED_AUTHORIZATION_SQL = `
  UPDATE artifact_tasks SET status = 'failed', instruction_ciphertext = '', instruction_iv = '',
    lease_digest = NULL, lease_expires_at = NULL, execution_deadline_at = NULL,
    error_code = 'AUTHORIZATION_REVOKED', completed_at = ?, updated_at = ?
  WHERE authorization_request_id = ? AND status = 'queued'
    AND cancellation_requested_at IS NULL AND EXISTS (
      SELECT 1 FROM authorization_requests
      WHERE request_id = ? AND status = 'revoked' AND authorization_revision = ?
    )`;

export const CANCEL_LEASED_ARTIFACTS_FOR_REVOKED_AUTHORIZATION_SQL = `
  UPDATE artifact_tasks SET cancellation_requested_at = ?,
    instruction_ciphertext = '', instruction_iv = '',
    error_code = 'AUTHORIZATION_REVOKED_PENDING', updated_at = ?
  WHERE authorization_request_id = ? AND status IN ('claimed', 'running')
    AND cancellation_requested_at IS NULL AND EXISTS (
      SELECT 1 FROM authorization_requests
      WHERE request_id = ? AND status = 'revoked' AND authorization_revision = ?
    )`;

export const UPDATE_SUPPLIER_AFTER_AUTHORIZATION_REVOCATION_SQL = `
  UPDATE suppliers SET version = ?, updated_at = ?, supply_enabled = CASE
      WHEN EXISTS (
        SELECT 1 FROM authorization_requests other
        WHERE other.tenant_id = suppliers.tenant_id AND other.supplier_id = suppliers.supplier_id
          AND other.status = 'approved' AND other.valid_until > ?
          AND other.encrypted_gateway_token <> '' AND other.gateway_token_iv <> ''
          AND other.gateway_token_digest IS NOT NULL
      ) THEN supply_enabled ELSE 0 END
    WHERE supplier_id = ? AND tenant_id = ? AND version = ?
      AND EXISTS (
        SELECT 1 FROM authorization_requests
        WHERE request_id = ? AND tenant_id = ? AND supplier_id = ?
          AND status = 'revoked' AND authorization_revision = ?
      )`;

export const DELETE_AGENT_HEARTBEAT_AFTER_AUTHORIZATION_REVOCATION_SQL = `
  DELETE FROM supplier_artifact_workers WHERE supplier_tenant_id = ?
    AND EXISTS (
      SELECT 1 FROM authorization_requests
      WHERE request_id = ? AND tenant_id = ? AND supplier_id = ?
        AND status = 'revoked' AND authorization_revision = ?
    )`;

export const DELETE_AGENT_HEARTBEAT_AFTER_CREDENTIAL_ROTATION_SQL = `
  DELETE FROM supplier_artifact_workers WHERE supplier_tenant_id = ?
    AND EXISTS (
      SELECT 1 FROM authorization_requests
      WHERE request_id = ? AND tenant_id = ? AND supplier_id = ?
        AND status = 'approved' AND authorization_revision = ?
        AND gateway_token_digest = ?
    )`;

function authorizationLookupPredicate(keyedNamespaceCount: number, alias: string): string {
  if (!Number.isInteger(keyedNamespaceCount) || keyedNamespaceCount < 1 || keyedNamespaceCount > 8) {
    throw new RangeError("authorization lookup namespace count is out of bounds");
  }
  const keyed = Array.from({ length: keyedNamespaceCount }, () =>
    `(${alias}.gateway_token_digest_version = ? AND ${alias}.gateway_token_lookup_key_id = ? AND ${alias}.gateway_token_digest = ?)`
  ).join(" OR ");
  return `((${alias}.gateway_token_digest_version = 1 AND ${alias}.gateway_token_digest = ?) OR ${keyed})`;
}

function assertMaximumAuthorizationsPerToken(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new RangeError("maximum authorizations per token is out of bounds");
  }
}

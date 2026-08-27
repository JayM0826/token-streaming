/**
 * Every statement in this module is a single SQLite write-side gate. D1
 * serializes the write and the balance/capacity predicate together, avoiding
 * a read-then-write window where concurrent requests could over-reserve or
 * settle the same promotional balance.
 */

export const RESERVE_INFERENCE_JOB_SQL = `
  INSERT OR IGNORE INTO inference_jobs (
    job_id, buyer_tenant_id, supplier_tenant_id, offer_id, authorization_request_id,
    authorization_revision, idempotency_key, model,
    data_class, privacy_mode, prompt_digest, digest_version, max_output_tokens,
    reserved_charge_micros, reservation_expires_at, status, created_at
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?
  WHERE (
    COALESCE((SELECT SUM(CASE WHEN direction = 'credit' THEN CAST(amount_micros AS INTEGER)
      ELSE -CAST(amount_micros AS INTEGER) END) FROM ledger_entries WHERE tenant_id = ?), 0)
    - COALESCE((SELECT SUM(CAST(reserved_charge_micros AS INTEGER)) FROM inference_jobs
      WHERE buyer_tenant_id = ? AND status IN ('reserved', 'running')), 0)
    - COALESCE((SELECT SUM(CAST(reserved_charge_micros AS INTEGER)) FROM artifact_tasks
      WHERE buyer_tenant_id = ? AND status IN ('queued', 'claimed', 'running')), 0)
  ) >= CAST(? AS INTEGER)
  AND EXISTS (
    SELECT 1 FROM capacity_offers o
    JOIN suppliers s ON s.supplier_id = o.supplier_id AND s.tenant_id = o.tenant_id
    JOIN authorization_requests ar
      ON ar.request_id = o.authorization_request_id AND ar.status = 'approved'
    WHERE o.offer_id = ? AND o.authorization_request_id = ?
      AND o.tenant_id = s.tenant_id AND o.supplier_id = s.supplier_id
      AND ar.tenant_id = o.tenant_id AND ar.supplier_id = o.supplier_id
      AND ar.provider_id = o.provider_id AND ar.authorization_revision = ?
      AND ar.encrypted_gateway_token <> '' AND ar.gateway_token_iv <> ''
      AND ar.gateway_token_digest IS NOT NULL
      AND o.tenant_id = ? AND o.tenant_id <> ?
      AND o.status = 'active' AND o.valid_from <= ? AND o.valid_until > ?
      AND ar.valid_until > ? AND s.status = 'active' AND s.supply_enabled = 1
  )
  AND (
    (SELECT COUNT(*) FROM inference_jobs
      WHERE offer_id = ? AND status IN ('reserved', 'running'))
    + (SELECT COUNT(*) FROM artifact_tasks
      WHERE offer_id = ? AND status IN ('claimed', 'running'))
  ) < ?`;

export const RESERVE_ARTIFACT_TASK_SQL = `
  INSERT OR IGNORE INTO artifact_tasks (
    task_id, buyer_tenant_id, supplier_tenant_id, offer_id, authorization_request_id,
    authorization_revision, artifact_id, idempotency_key, model, data_class, privacy_mode, instruction_digest,
    digest_version, instruction_ciphertext, instruction_iv, content_key_version,
    max_output_tokens, max_total_tokens, reserved_charge_micros, status, created_at, updated_at
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?
  WHERE EXISTS (
    SELECT 1 FROM artifacts
    WHERE artifact_id = ? AND tenant_id = ? AND status = 'ready'
      AND content_purged_at IS NULL AND expires_at > ?
  )
  AND EXISTS (
    SELECT 1 FROM capacity_offers o
    JOIN suppliers s ON s.supplier_id = o.supplier_id AND s.tenant_id = o.tenant_id
    JOIN authorization_requests ar
      ON ar.request_id = o.authorization_request_id AND ar.status = 'approved'
    WHERE o.offer_id = ? AND o.authorization_request_id = ?
      AND o.tenant_id = s.tenant_id AND o.supplier_id = s.supplier_id
      AND ar.tenant_id = o.tenant_id AND ar.supplier_id = o.supplier_id
      AND ar.provider_id = o.provider_id AND ar.authorization_revision = ?
      AND ar.encrypted_gateway_token <> '' AND ar.gateway_token_iv <> ''
      AND ar.gateway_token_digest IS NOT NULL
      AND o.tenant_id = ? AND o.tenant_id <> ?
      AND o.status = 'active' AND o.valid_from <= ? AND o.valid_until > ?
      AND ar.valid_until > ? AND s.status = 'active' AND s.supply_enabled = 1
  )
  AND (SELECT COUNT(*) FROM artifact_tasks
    WHERE buyer_tenant_id = ? AND status IN ('queued', 'claimed', 'running')) < ?
  AND (
    COALESCE((SELECT SUM(CASE WHEN direction = 'credit' THEN CAST(amount_micros AS INTEGER)
      ELSE -CAST(amount_micros AS INTEGER) END) FROM ledger_entries WHERE tenant_id = ?), 0)
    - COALESCE((SELECT SUM(CAST(reserved_charge_micros AS INTEGER)) FROM inference_jobs
      WHERE buyer_tenant_id = ? AND status IN ('reserved', 'running')), 0)
    - COALESCE((SELECT SUM(CAST(reserved_charge_micros AS INTEGER)) FROM artifact_tasks
      WHERE buyer_tenant_id = ? AND status IN ('queued', 'claimed', 'running')), 0)
  ) >= CAST(? AS INTEGER)`;

export const COMPLETE_INFERENCE_JOB_SQL = `
  UPDATE inference_jobs SET status = 'completed', provider_request_id = ?, input_tokens = ?,
    output_tokens = ?, total_tokens = ?, charge_micros = ?, output_ciphertext = ?, output_iv = ?,
    content_key_version = ?, output_expires_at = ?, reservation_expires_at = NULL, completed_at = ?
  WHERE job_id = ? AND status = 'running'
    AND reservation_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    AND CAST(reserved_charge_micros AS INTEGER) >= CAST(? AS INTEGER)
    AND (
      COALESCE((SELECT SUM(CASE WHEN direction = 'credit' THEN CAST(amount_micros AS INTEGER)
        ELSE -CAST(amount_micros AS INTEGER) END) FROM ledger_entries WHERE tenant_id = ?), 0)
      - COALESCE((SELECT SUM(CAST(reserved_charge_micros AS INTEGER)) FROM inference_jobs
        WHERE buyer_tenant_id = ? AND job_id <> ? AND status IN ('reserved', 'running')), 0)
      - COALESCE((SELECT SUM(CAST(reserved_charge_micros AS INTEGER)) FROM artifact_tasks
        WHERE buyer_tenant_id = ? AND status IN ('queued', 'claimed', 'running')), 0)
    ) >= CAST(? AS INTEGER)`;

export const COMPLETE_ARTIFACT_TASK_SQL = `
  UPDATE artifact_tasks SET status = 'completed', input_tokens = ?, output_tokens = ?, total_tokens = ?,
    charge_micros = ?, output_ciphertext = ?, output_iv = ?, content_key_version = ?, output_expires_at = ?,
    instruction_ciphertext = '', instruction_iv = '', lease_digest = NULL, lease_expires_at = NULL,
    execution_deadline_at = NULL, completed_at = ?, updated_at = ?
  WHERE task_id = ? AND supplier_tenant_id = ? AND lease_digest = ?
    AND status IN ('claimed', 'running') AND cancellation_requested_at IS NULL
    AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    AND execution_deadline_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    AND attempt = ? AND completed_segments = ? AND total_segments = ? AND processed_bytes = ?
    AND input_tokens = ? AND output_tokens = ? AND total_tokens = ?
    AND CAST(reserved_charge_micros AS INTEGER) >= CAST(? AS INTEGER)
    AND (
      COALESCE((SELECT SUM(CASE WHEN direction = 'credit' THEN CAST(amount_micros AS INTEGER)
        ELSE -CAST(amount_micros AS INTEGER) END) FROM ledger_entries WHERE tenant_id = ?), 0)
      - COALESCE((SELECT SUM(CAST(reserved_charge_micros AS INTEGER)) FROM inference_jobs
        WHERE buyer_tenant_id = ? AND status IN ('reserved', 'running')), 0)
      - COALESCE((SELECT SUM(CAST(reserved_charge_micros AS INTEGER)) FROM artifact_tasks
        WHERE buyer_tenant_id = ? AND task_id <> ? AND status IN ('queued', 'claimed', 'running')), 0)
    ) >= CAST(? AS INTEGER)`;

export const AVAILABLE_BALANCE_SQL = `
  SELECT printf('%lld',
    COALESCE((SELECT SUM(CASE WHEN direction = 'credit' THEN CAST(amount_micros AS INTEGER)
      ELSE -CAST(amount_micros AS INTEGER) END) FROM ledger_entries WHERE tenant_id = ?), 0)
    - COALESCE((SELECT SUM(CAST(reserved_charge_micros AS INTEGER)) FROM inference_jobs
      WHERE buyer_tenant_id = ? AND status IN ('reserved', 'running')), 0)
    - COALESCE((SELECT SUM(CAST(reserved_charge_micros AS INTEGER)) FROM artifact_tasks
      WHERE buyer_tenant_id = ? AND status IN ('queued', 'claimed', 'running')), 0)
  ) AS available`;

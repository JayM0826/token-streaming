/** Queued work has no lease holder and can be cancelled before physical purge. */
export const CANCEL_QUEUED_ARTIFACT_TASK_FOR_PURGE_SQL = `
  UPDATE artifact_tasks SET status = 'cancelled', cancellation_requested_at = ?,
    instruction_ciphertext = '', instruction_iv = '', output_ciphertext = NULL,
    output_iv = NULL, output_expires_at = NULL, lease_digest = NULL, lease_expires_at = NULL,
    execution_deadline_at = NULL, error_code = 'USER_CONTENT_PURGED',
    completed_at = ?, updated_at = ?
  WHERE task_id = ? AND buyer_tenant_id = ? AND status = 'queued'
    AND cancellation_requested_at IS NULL`;

/**
 * Distinguishes an expired task output from a complete task-content purge.
 * `artifact_tasks.content_purged_at` is also used by retention to mark output
 * expiry, so it is not sufficient proof that the encrypted input generation
 * and instruction have been physically cleared.
 */
export const SELECT_ARTIFACT_TASK_PURGE_STATE_SQL = `
  SELECT t.task_id AS resource_id, t.artifact_id, t.status, t.content_purged_at,
    t.instruction_ciphertext, t.instruction_iv, t.output_ciphertext, t.output_iv,
    t.output_expires_at, a.status AS artifact_status,
    a.content_purged_at AS artifact_content_purged_at,
    CASE WHEN t.content_purged_at IS NOT NULL
      AND t.instruction_ciphertext = '' AND t.instruction_iv = ''
      AND t.output_ciphertext IS NULL AND t.output_iv IS NULL AND t.output_expires_at IS NULL
      AND a.status = 'deleted' AND a.content_purged_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM artifact_chunks c
        WHERE c.artifact_id = a.artifact_id AND c.tenant_id = a.tenant_id
      )
    THEN a.content_purged_at ELSE NULL END AS full_content_purged_at
  FROM artifact_tasks t
  JOIN artifacts a ON a.artifact_id = t.artifact_id AND a.tenant_id = t.buyer_tenant_id
  WHERE t.task_id = ? AND t.buyer_tenant_id = ?`;

/** Replays safely after physical finalization if the first audit write failed. */
export const IDEMPOTENT_CONTENT_PURGE_AUDIT_SQL = `
  INSERT OR IGNORE INTO audit_events (
    audit_id, tenant_id, actor_id, action, resource_type, resource_id, details_json, occurred_at
  ) SELECT ?, ?, ?, ?, ?, ?, '{}', ?
    WHERE NOT EXISTS (
      SELECT 1 FROM audit_events
      WHERE tenant_id = ? AND action = ? AND resource_type = ? AND resource_id = ?
    )`;

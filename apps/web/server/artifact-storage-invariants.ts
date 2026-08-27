/** Keeps each purge transition small; complete maintenance requires Workers Paid. */
export const ARTIFACT_PURGE_GENERATION_BATCH_SIZE = 4;

export const SELECT_ARTIFACT_PURGE_GENERATIONS_SQL = `
  SELECT part_number, storage_key, uploaded_at FROM artifact_chunks
  WHERE artifact_id = ? AND tenant_id = ?
  ORDER BY part_number ASC LIMIT ${ARTIFACT_PURGE_GENERATION_BATCH_SIZE}`;

/** Deletes only the exact chunk generation whose object deletion was confirmed. */
export const DELETE_ARTIFACT_CHUNK_GENERATION_SQL = `
  DELETE FROM artifact_chunks WHERE artifact_id = ? AND tenant_id = ?
    AND part_number = ? AND storage_key = ? AND uploaded_at = ?`;

/** Makes one immutable generation eligible for durable object-store deletion retries. */
export const TOMBSTONE_ARTIFACT_CHUNK_GENERATION_SQL = `
  UPDATE artifact_chunks SET upload_status = 'deleting'
  WHERE artifact_id = ? AND tenant_id = ? AND part_number = ?
    AND storage_key = ? AND uploaded_at = ?
    AND upload_status IN ('pending', 'ready', 'deleting')`;

/** Serializes physical purge against every active task reservation/lease. */
export const CLAIM_ARTIFACT_PURGE_SQL = `
  UPDATE artifacts SET content_purged_at = COALESCE(content_purged_at, ?),
    expires_at = ?, updated_at = ?
  WHERE artifact_id = ? AND tenant_id = ? AND NOT EXISTS (
    SELECT 1 FROM artifact_tasks t WHERE t.artifact_id = artifacts.artifact_id
      AND t.status IN ('queued', 'claimed', 'running')
  )`;

/** Marks metadata deleted only after every immutable object generation left D1. */
export const FINALIZE_ARTIFACT_PURGE_SQL = `
  UPDATE artifacts SET status = 'deleted', file_name = 'deleted-artifact', manifest_sha256 = NULL,
    content_purged_at = COALESCE(content_purged_at, ?), updated_at = ?
  WHERE artifact_id = ? AND tenant_id = ? AND status <> 'deleted'
    AND NOT EXISTS (
      SELECT 1 FROM artifact_chunks c
      WHERE c.artifact_id = artifacts.artifact_id AND c.tenant_id = artifacts.tenant_id
    )`;

export interface ArtifactObjectDeletionCandidate {
  artifactId: string;
  tenantId: string;
  storageKey: string;
}

/** Keeps both retry scheduling and the retention deadline non-sliding. */
export const ENQUEUE_ARTIFACT_OBJECT_DELETION_SQL = `
  INSERT INTO artifact_object_deletions (
    storage_key, artifact_id, tenant_id, next_attempt_at, retain_until, attempts, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  ON CONFLICT (storage_key) DO UPDATE SET
    next_attempt_at = MIN(next_attempt_at, excluded.next_attempt_at),
    retain_until = MIN(retain_until, excluded.retain_until), updated_at = excluded.updated_at`;

export function enqueueArtifactObjectDeletion(
  db: D1Database,
  candidate: ArtifactObjectDeletionCandidate,
  now: string,
  nextAttemptAt: string,
  retainUntil: string
): D1PreparedStatement {
  return db.prepare(ENQUEUE_ARTIFACT_OBJECT_DELETION_SQL).bind(
    candidate.storageKey, candidate.artifactId, candidate.tenantId,
    nextAttemptAt, retainUntil, now, now
  );
}

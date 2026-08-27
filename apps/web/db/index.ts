import { env } from "cloudflare:workers";

let schemaReady: Promise<void> | undefined;

export function getD1(): D1Database {
  if (!env.DB) {
    throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  }
  return env.DB;
}

export function getArtifactBucket(): R2Bucket {
  if (!env.ARTIFACTS) throw new Error("Cloudflare R2 binding `ARTIFACTS` is unavailable.");
  return env.ARTIFACTS;
}

export function getRuntimeEnv(): Cloudflare.Env {
  return env;
}

export async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = initializeSchema().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  await schemaReady;
}

async function initializeSchema(): Promise<void> {
  const db = getD1();
  const statements = SCHEMA_STATEMENTS.map((statement) => db.prepare(statement));
  await db.batch(statements);
  await ensureRuntimeColumns(db);
  await db.batch(POST_COLUMN_SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)));
  await db.prepare("PRAGMA optimize").run();
}

async function ensureRuntimeColumns(db: D1Database): Promise<void> {
  for (const migration of RUNTIME_COLUMN_MIGRATIONS) {
    if (await columnExists(db, migration.table, migration.column)) continue;
    try {
      await db.prepare(migration.sql).run();
    } catch (error) {
      // Separate Worker isolates can race on the first request after a deploy.
      // A duplicate-column error is safe only when a fresh schema read proves
      // that the other isolate installed the exact column we were adding.
      if (!await columnExists(db, migration.table, migration.column)) throw error;
    }
  }
}

async function columnExists(db: D1Database, table: string, column: string): Promise<boolean> {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return result.results.some((entry) => entry.name === column);
}

const RUNTIME_COLUMN_MIGRATIONS = [
  {
    table: "authorization_requests",
    column: "gateway_token_digest",
    sql: "ALTER TABLE `authorization_requests` ADD `gateway_token_digest` text"
  },
  {
    table: "artifact_tasks",
    column: "privacy_mode",
    sql: "ALTER TABLE `artifact_tasks` ADD `privacy_mode` text DEFAULT 'standard' NOT NULL"
  },
  {
    table: "artifact_tasks",
    column: "content_key_version",
    sql: "ALTER TABLE `artifact_tasks` ADD `content_key_version` integer DEFAULT 1 NOT NULL"
  },
  {
    table: "artifact_tasks",
    column: "content_purged_at",
    sql: "ALTER TABLE `artifact_tasks` ADD `content_purged_at` text"
  },
  {
    table: "artifacts",
    column: "privacy_mode",
    sql: "ALTER TABLE `artifacts` ADD `privacy_mode` text DEFAULT 'standard' NOT NULL"
  },
  {
    table: "artifacts",
    column: "content_purged_at",
    sql: "ALTER TABLE `artifacts` ADD `content_purged_at` text"
  },
  {
    table: "inference_jobs",
    column: "privacy_mode",
    sql: "ALTER TABLE `inference_jobs` ADD `privacy_mode` text DEFAULT 'standard' NOT NULL"
  },
  {
    table: "inference_jobs",
    column: "content_key_version",
    sql: "ALTER TABLE `inference_jobs` ADD `content_key_version` integer DEFAULT 1 NOT NULL"
  },
  {
    table: "inference_jobs",
    column: "content_purged_at",
    sql: "ALTER TABLE `inference_jobs` ADD `content_purged_at` text"
  },
  {
    table: "artifact_task_evidence",
    column: "digest_version",
    sql: "ALTER TABLE `artifact_task_evidence` ADD `digest_version` integer DEFAULT 1 NOT NULL"
  },
  {
    table: "artifact_tasks",
    column: "digest_version",
    sql: "ALTER TABLE `artifact_tasks` ADD `digest_version` integer DEFAULT 1 NOT NULL"
  },
  {
    table: "inference_jobs",
    column: "digest_version",
    sql: "ALTER TABLE `inference_jobs` ADD `digest_version` integer DEFAULT 1 NOT NULL"
  },
  {
    table: "service_evidence",
    column: "digest_version",
    sql: "ALTER TABLE `service_evidence` ADD `digest_version` integer DEFAULT 1 NOT NULL"
  },
  {
    table: "authorization_requests",
    column: "gateway_token_digest_version",
    sql: "ALTER TABLE `authorization_requests` ADD `gateway_token_digest_version` integer DEFAULT 1 NOT NULL"
  },
  {
    table: "authorization_requests",
    column: "review_command_id",
    sql: "ALTER TABLE `authorization_requests` ADD `review_command_id` text"
  },
  {
    table: "marketplace_events",
    column: "schema_version",
    sql: "ALTER TABLE `marketplace_events` ADD `schema_version` integer DEFAULT 1 NOT NULL"
  },
  {
    table: "inference_jobs",
    column: "reserved_charge_micros",
    sql: "ALTER TABLE `inference_jobs` ADD `reserved_charge_micros` text DEFAULT '0' NOT NULL"
  },
  {
    table: "inference_jobs",
    column: "reservation_expires_at",
    sql: "ALTER TABLE `inference_jobs` ADD `reservation_expires_at` text"
  },
  {
    table: "artifact_chunks",
    column: "upload_status",
    sql: "ALTER TABLE `artifact_chunks` ADD `upload_status` text DEFAULT 'ready' NOT NULL"
  },
  {
    table: "artifact_tasks",
    column: "cancellation_requested_at",
    sql: "ALTER TABLE `artifact_tasks` ADD `cancellation_requested_at` text"
  },
  {
    table: "artifact_tasks",
    column: "execution_deadline_at",
    sql: "ALTER TABLE `artifact_tasks` ADD `execution_deadline_at` text"
  }
] as const;

const POST_COLUMN_SCHEMA_STATEMENTS = [
  "CREATE INDEX IF NOT EXISTS idx_authorization_requests_credential_status ON authorization_requests (gateway_token_digest_version, gateway_token_digest, status, valid_until)"
] as const;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS suppliers (
    supplier_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('individual', 'organization')),
    legal_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    country_code TEXT NOT NULL,
    tax_residence_country_code TEXT NOT NULL,
    status TEXT NOT NULL,
    supply_enabled INTEGER NOT NULL DEFAULT 0 CHECK (supply_enabled IN (0, 1)),
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_tenant_id ON suppliers (tenant_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_user_id ON suppliers (user_id)",
  `CREATE TABLE IF NOT EXISTS authorization_requests (
    request_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    metering_mode TEXT NOT NULL,
    evidence_ref TEXT NOT NULL,
    model_pattern TEXT NOT NULL,
    region_code TEXT NOT NULL,
    data_classes_json TEXT NOT NULL,
    requests_per_minute INTEGER NOT NULL,
    tokens_per_minute INTEGER NOT NULL,
    concurrency INTEGER NOT NULL,
    max_output_tokens INTEGER NOT NULL,
    valid_until TEXT NOT NULL,
    gateway_endpoint TEXT NOT NULL,
    encrypted_gateway_token TEXT NOT NULL,
    gateway_token_iv TEXT NOT NULL,
    gateway_token_digest TEXT,
    gateway_token_digest_version INTEGER NOT NULL DEFAULT 1,
    encryption_key_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    review_note TEXT,
    reviewed_by TEXT,
    review_command_id TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_authorization_requests_tenant_status ON authorization_requests (tenant_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_authorization_requests_status_created ON authorization_requests (status, created_at)",
  `CREATE TABLE IF NOT EXISTS capacity_offers (
    offer_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    authorization_request_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    model TEXT NOT NULL,
    region_code TEXT NOT NULL,
    data_classes_json TEXT NOT NULL,
    requests_per_minute INTEGER NOT NULL,
    tokens_per_minute INTEGER NOT NULL,
    concurrency INTEGER NOT NULL,
    max_output_tokens INTEGER NOT NULL,
    currency TEXT NOT NULL CHECK (currency = 'CNY'),
    price_micros_per_million_tokens TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'expired')),
    valid_from TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_capacity_offers_market ON capacity_offers (status, model, valid_until)",
  "CREATE INDEX IF NOT EXISTS idx_capacity_offers_tenant_created ON capacity_offers (tenant_id, created_at)",
  `CREATE TABLE IF NOT EXISTS marketplace_events (
    event_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    causation_id TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    aggregate_version INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    payload_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_events_aggregate_version ON marketplace_events (tenant_id, aggregate_type, aggregate_id, aggregate_version)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_events_causation ON marketplace_events (tenant_id, causation_id)",
  "CREATE INDEX IF NOT EXISTS idx_marketplace_events_aggregate ON marketplace_events (tenant_id, aggregate_type, aggregate_id)",
  `CREATE TABLE IF NOT EXISTS inference_jobs (
    job_id TEXT PRIMARY KEY,
    buyer_tenant_id TEXT NOT NULL,
    supplier_tenant_id TEXT NOT NULL,
    offer_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    model TEXT NOT NULL,
    data_class TEXT NOT NULL CHECK (data_class IN ('P0', 'P1')),
    privacy_mode TEXT NOT NULL DEFAULT 'standard' CHECK (privacy_mode IN ('standard', 'strict')),
    prompt_digest TEXT NOT NULL,
    digest_version INTEGER NOT NULL DEFAULT 1,
    max_output_tokens INTEGER NOT NULL,
    reserved_charge_micros TEXT NOT NULL DEFAULT '0',
    reservation_expires_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'running', 'completed', 'failed')),
    provider_request_id TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    charge_micros TEXT,
    output_ciphertext TEXT,
    output_iv TEXT,
    content_key_version INTEGER NOT NULL DEFAULT 1,
    output_expires_at TEXT,
    content_purged_at TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_inference_jobs_idempotency ON inference_jobs (buyer_tenant_id, idempotency_key)",
  "CREATE INDEX IF NOT EXISTS idx_inference_jobs_buyer_created ON inference_jobs (buyer_tenant_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_inference_jobs_supplier_created ON inference_jobs (supplier_tenant_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_inference_jobs_offer_status ON inference_jobs (offer_id, status)",
  `CREATE TABLE IF NOT EXISTS usage_records (
    usage_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    buyer_tenant_id TEXT NOT NULL,
    supplier_tenant_id TEXT NOT NULL,
    offer_id TEXT NOT NULL,
    provider_request_id TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    receipt_ref TEXT,
    occurred_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_records_job_id ON usage_records (job_id)",
  "CREATE INDEX IF NOT EXISTS idx_usage_records_supplier_time ON usage_records (supplier_tenant_id, occurred_at)",
  `CREATE TABLE IF NOT EXISTS service_evidence (
    evidence_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    offer_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    requested_model TEXT NOT NULL,
    served_model TEXT NOT NULL,
    provider_request_id TEXT NOT NULL,
    assurance TEXT NOT NULL CHECK (assurance = 'node-signed-provider-response'),
    evidence_digest TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    output_digest TEXT NOT NULL,
    digest_version INTEGER NOT NULL DEFAULT 1,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    unit_price_micros_per_million_tokens TEXT NOT NULL,
    buyer_charge_micros TEXT NOT NULL,
    supplier_credit_micros TEXT NOT NULL,
    platform_fee_micros TEXT NOT NULL,
    receipt_ref TEXT,
    provider_completed_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_service_evidence_job_id ON service_evidence (job_id)",
  "CREATE INDEX IF NOT EXISTS idx_service_evidence_provider_time ON service_evidence (provider_id, recorded_at)",
  `CREATE TABLE IF NOT EXISTS ledger_entries (
    entry_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    job_id TEXT,
    entry_type TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
    amount_micros TEXT NOT NULL,
    currency TEXT NOT NULL CHECK (currency = 'CNY'),
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_ledger_entries_tenant_created ON ledger_entries (tenant_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_ledger_entries_job_id ON ledger_entries (job_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_entries_job_effect ON ledger_entries (job_id, entry_type) WHERE job_id IS NOT NULL AND entry_type IN ('inference-debit', 'supplier-credit', 'platform-fee')",
  `CREATE TABLE IF NOT EXISTS audit_events (
    audit_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    details_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_time ON audit_events (tenant_id, occurred_at)",
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    tenant_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_scope ON idempotency_keys (tenant_id, operation, idempotency_key)",
  `CREATE TABLE IF NOT EXISTS api_rate_limits (
    scope_key TEXT NOT NULL,
    action TEXT NOT NULL,
    window_started_at TEXT NOT NULL,
    request_count INTEGER NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_api_rate_limits_bucket ON api_rate_limits (scope_key, action, window_started_at)",
  "CREATE INDEX IF NOT EXISTS idx_api_rate_limits_expires ON api_rate_limits (expires_at)",
  `CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    privacy_mode TEXT NOT NULL DEFAULT 'standard' CHECK (privacy_mode IN ('standard', 'strict')),
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    chunk_size_bytes INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    uploaded_chunks INTEGER NOT NULL DEFAULT 0,
    manifest_sha256 TEXT,
    status TEXT NOT NULL CHECK (status IN ('uploading', 'ready', 'expired', 'deleted')),
    content_purged_at TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_artifacts_tenant_created ON artifacts (tenant_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_artifacts_status_expires ON artifacts (status, expires_at)",
  `CREATE TABLE IF NOT EXISTS artifact_chunks (
    artifact_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    part_number INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    plaintext_sha256 TEXT NOT NULL,
    ciphertext_sha256 TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    iv TEXT NOT NULL,
    upload_status TEXT NOT NULL DEFAULT 'ready' CHECK (upload_status IN ('pending', 'deleting', 'ready')),
    uploaded_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_chunks_part ON artifact_chunks (artifact_id, part_number)",
  "CREATE INDEX IF NOT EXISTS idx_artifact_chunks_tenant_artifact ON artifact_chunks (tenant_id, artifact_id)",
  `CREATE TABLE IF NOT EXISTS artifact_object_deletions (
    storage_key TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    next_attempt_at TEXT NOT NULL,
    retain_until TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_artifact_object_deletions_due ON artifact_object_deletions (next_attempt_at, retain_until)",
  "CREATE INDEX IF NOT EXISTS idx_artifact_object_deletions_artifact ON artifact_object_deletions (tenant_id, artifact_id)",
  `CREATE TABLE IF NOT EXISTS supplier_artifact_workers (
    supplier_tenant_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    authorization_request_ids_json TEXT NOT NULL,
    allowed_models_json TEXT NOT NULL,
    supported_media_types_json TEXT NOT NULL,
    max_artifact_bytes INTEGER NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_artifact_workers_identity ON supplier_artifact_workers (supplier_tenant_id, worker_id)",
  "CREATE INDEX IF NOT EXISTS idx_supplier_artifact_workers_capacity ON supplier_artifact_workers (supplier_tenant_id, provider_id, expires_at)",
  `CREATE TABLE IF NOT EXISTS artifact_tasks (
    task_id TEXT PRIMARY KEY,
    buyer_tenant_id TEXT NOT NULL,
    supplier_tenant_id TEXT NOT NULL,
    offer_id TEXT NOT NULL,
    authorization_request_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    model TEXT NOT NULL,
    data_class TEXT NOT NULL CHECK (data_class IN ('P0', 'P1')),
    privacy_mode TEXT NOT NULL DEFAULT 'standard' CHECK (privacy_mode IN ('standard', 'strict')),
    instruction_digest TEXT NOT NULL,
    digest_version INTEGER NOT NULL DEFAULT 1,
    instruction_ciphertext TEXT NOT NULL,
    instruction_iv TEXT NOT NULL,
    content_key_version INTEGER NOT NULL DEFAULT 1,
    max_output_tokens INTEGER NOT NULL,
    max_total_tokens INTEGER NOT NULL,
    reserved_charge_micros TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
    completed_segments INTEGER NOT NULL DEFAULT 0,
    total_segments INTEGER,
    processed_bytes INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0,
    worker_id TEXT,
    lease_digest TEXT,
    lease_expires_at TEXT,
    execution_deadline_at TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    charge_micros TEXT,
    output_ciphertext TEXT,
    output_iv TEXT,
    output_expires_at TEXT,
    content_purged_at TEXT,
    cancellation_requested_at TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_tasks_idempotency ON artifact_tasks (buyer_tenant_id, idempotency_key)",
  "CREATE INDEX IF NOT EXISTS idx_artifact_tasks_buyer_created ON artifact_tasks (buyer_tenant_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_artifact_tasks_supplier_status ON artifact_tasks (supplier_tenant_id, status, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_artifact_tasks_offer_status ON artifact_tasks (offer_id, status)",
  `CREATE TABLE IF NOT EXISTS artifact_task_checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    completed_segments INTEGER NOT NULL,
    total_segments INTEGER NOT NULL,
    processed_bytes INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    occurred_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_artifact_task_checkpoints_task_time ON artifact_task_checkpoints (task_id, occurred_at)",
  `CREATE TABLE IF NOT EXISTS artifact_task_evidence (
    evidence_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    requested_model TEXT NOT NULL,
    served_model TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    artifact_manifest_sha256 TEXT NOT NULL,
    artifact_content_sha256 TEXT NOT NULL,
    output_sha256 TEXT NOT NULL,
    digest_version INTEGER NOT NULL DEFAULT 1,
    provider_request_ids_sha256 TEXT NOT NULL,
    segments_completed INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    evidence_digest TEXT NOT NULL,
    buyer_charge_micros TEXT NOT NULL,
    supplier_credit_micros TEXT NOT NULL,
    platform_fee_micros TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_task_evidence_task ON artifact_task_evidence (task_id)",
  "CREATE INDEX IF NOT EXISTS idx_artifact_task_evidence_provider_time ON artifact_task_evidence (provider_id, recorded_at)",
  `CREATE TABLE IF NOT EXISTS agent_request_nonces (
    credential_digest TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_request_nonces_unique ON agent_request_nonces (credential_digest, nonce)",
  "CREATE INDEX IF NOT EXISTS idx_agent_request_nonces_expires ON agent_request_nonces (expires_at)"
] as const;

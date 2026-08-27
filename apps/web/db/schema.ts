import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  userId: text("user_id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const suppliers = sqliteTable(
  "suppliers",
  {
    supplierId: text("supplier_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    legalName: text("legal_name").notNull(),
    displayName: text("display_name").notNull(),
    countryCode: text("country_code").notNull(),
    taxResidenceCountryCode: text("tax_residence_country_code").notNull(),
    status: text("status").notNull(),
    supplyEnabled: integer("supply_enabled").notNull().default(0),
    version: integer("version").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_suppliers_tenant_id").on(table.tenantId),
    uniqueIndex("idx_suppliers_user_id").on(table.userId)
  ]
);

export const authorizationRequests = sqliteTable(
  "authorization_requests",
  {
    requestId: text("request_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    supplierId: text("supplier_id").notNull(),
    providerId: text("provider_id").notNull(),
    sourceType: text("source_type").notNull(),
    meteringMode: text("metering_mode").notNull(),
    evidenceRef: text("evidence_ref").notNull(),
    modelPattern: text("model_pattern").notNull(),
    regionCode: text("region_code").notNull(),
    dataClassesJson: text("data_classes_json").notNull(),
    requestsPerMinute: integer("requests_per_minute").notNull(),
    tokensPerMinute: integer("tokens_per_minute").notNull(),
    concurrency: integer("concurrency").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    validUntil: text("valid_until").notNull(),
    gatewayEndpoint: text("gateway_endpoint").notNull(),
    encryptedGatewayToken: text("encrypted_gateway_token").notNull(),
    gatewayTokenIv: text("gateway_token_iv").notNull(),
    credentialKeyId: text("credential_key_id").notNull().default("legacy-credential-v2"),
    gatewayTokenDigest: text("gateway_token_digest"),
    gatewayTokenDigestVersion: integer("gateway_token_digest_version").notNull().default(1),
    gatewayTokenLookupKeyId: text("gateway_token_lookup_key_id").notNull().default("legacy-commitment-v2"),
    encryptionKeyVersion: integer("encryption_key_version").notNull().default(1),
    status: text("status").notNull(),
    reviewNote: text("review_note"),
    reviewedBy: text("reviewed_by"),
    reviewCommandId: text("review_command_id"),
    reviewedAt: text("reviewed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    index("idx_authorization_requests_tenant_status").on(table.tenantId, table.status),
    index("idx_authorization_requests_status_created").on(table.status, table.createdAt),
    index("idx_authorization_requests_credential_status").on(
      table.gatewayTokenDigestVersion,
      table.gatewayTokenDigest,
      table.status,
      table.validUntil
    ),
    index("idx_authorization_requests_lookup_status").on(
      table.gatewayTokenDigestVersion,
      table.gatewayTokenLookupKeyId,
      table.gatewayTokenDigest,
      table.status,
      table.validUntil
    )
  ]
);

export const capacityOffers = sqliteTable(
  "capacity_offers",
  {
    offerId: text("offer_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    supplierId: text("supplier_id").notNull(),
    authorizationRequestId: text("authorization_request_id").notNull(),
    providerId: text("provider_id").notNull(),
    sourceType: text("source_type").notNull(),
    model: text("model").notNull(),
    regionCode: text("region_code").notNull(),
    dataClassesJson: text("data_classes_json").notNull(),
    requestsPerMinute: integer("requests_per_minute").notNull(),
    tokensPerMinute: integer("tokens_per_minute").notNull(),
    concurrency: integer("concurrency").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    currency: text("currency").notNull(),
    priceMicrosPerMillionTokens: text("price_micros_per_million_tokens").notNull(),
    status: text("status").notNull(),
    validFrom: text("valid_from").notNull(),
    validUntil: text("valid_until").notNull(),
    version: integer("version").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    index("idx_capacity_offers_market").on(table.status, table.model, table.validUntil),
    index("idx_capacity_offers_tenant_created").on(table.tenantId, table.createdAt)
  ]
);

export const marketplaceEvents = sqliteTable(
  "marketplace_events",
  {
    eventId: text("event_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    actorId: text("actor_id").notNull(),
    causationId: text("causation_id").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    aggregateVersion: integer("aggregate_version").notNull(),
    eventType: text("event_type").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    payloadJson: text("payload_json").notNull(),
    occurredAt: text("occurred_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_marketplace_events_aggregate_version").on(
      table.tenantId,
      table.aggregateType,
      table.aggregateId,
      table.aggregateVersion
    ),
    uniqueIndex("idx_marketplace_events_causation").on(table.tenantId, table.causationId),
    index("idx_marketplace_events_aggregate").on(table.tenantId, table.aggregateType, table.aggregateId)
  ]
);

export const inferenceJobs = sqliteTable(
  "inference_jobs",
  {
    jobId: text("job_id").primaryKey(),
    buyerTenantId: text("buyer_tenant_id").notNull(),
    supplierTenantId: text("supplier_tenant_id").notNull(),
    offerId: text("offer_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    model: text("model").notNull(),
    dataClass: text("data_class").notNull(),
    privacyMode: text("privacy_mode").notNull().default("standard"),
    promptDigest: text("prompt_digest").notNull(),
    digestVersion: integer("digest_version").notNull().default(1),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    reservedChargeMicros: text("reserved_charge_micros").notNull().default("0"),
    reservationExpiresAt: text("reservation_expires_at"),
    status: text("status").notNull(),
    providerRequestId: text("provider_request_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    chargeMicros: text("charge_micros"),
    outputCiphertext: text("output_ciphertext"),
    outputIv: text("output_iv"),
    contentKeyVersion: integer("content_key_version").notNull().default(1),
    outputExpiresAt: text("output_expires_at"),
    contentPurgedAt: text("content_purged_at"),
    errorCode: text("error_code"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at")
  },
  (table) => [
    uniqueIndex("idx_inference_jobs_idempotency").on(table.buyerTenantId, table.idempotencyKey),
    index("idx_inference_jobs_buyer_created").on(table.buyerTenantId, table.createdAt),
    index("idx_inference_jobs_supplier_created").on(table.supplierTenantId, table.createdAt),
    index("idx_inference_jobs_offer_status").on(table.offerId, table.status)
  ]
);

export const usageRecords = sqliteTable(
  "usage_records",
  {
    usageId: text("usage_id").primaryKey(),
    jobId: text("job_id").notNull(),
    buyerTenantId: text("buyer_tenant_id").notNull(),
    supplierTenantId: text("supplier_tenant_id").notNull(),
    offerId: text("offer_id").notNull(),
    providerRequestId: text("provider_request_id").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    receiptRef: text("receipt_ref"),
    occurredAt: text("occurred_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_usage_records_job_id").on(table.jobId),
    index("idx_usage_records_supplier_time").on(table.supplierTenantId, table.occurredAt)
  ]
);

export const serviceEvidence = sqliteTable(
  "service_evidence",
  {
    evidenceId: text("evidence_id").primaryKey(),
    jobId: text("job_id").notNull(),
    offerId: text("offer_id").notNull(),
    providerId: text("provider_id").notNull(),
    requestedModel: text("requested_model").notNull(),
    servedModel: text("served_model").notNull(),
    providerRequestId: text("provider_request_id").notNull(),
    assurance: text("assurance").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    inputDigest: text("input_digest").notNull(),
    outputDigest: text("output_digest").notNull(),
    digestVersion: integer("digest_version").notNull().default(1),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    unitPriceMicrosPerMillionTokens: text("unit_price_micros_per_million_tokens").notNull(),
    buyerChargeMicros: text("buyer_charge_micros").notNull(),
    supplierCreditMicros: text("supplier_credit_micros").notNull(),
    platformFeeMicros: text("platform_fee_micros").notNull(),
    receiptRef: text("receipt_ref"),
    providerCompletedAt: text("provider_completed_at").notNull(),
    recordedAt: text("recorded_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_service_evidence_job_id").on(table.jobId),
    index("idx_service_evidence_provider_time").on(table.providerId, table.recordedAt)
  ]
);

export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    entryId: text("entry_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    accountId: text("account_id").notNull(),
    jobId: text("job_id"),
    entryType: text("entry_type").notNull(),
    direction: text("direction").notNull(),
    amountMicros: text("amount_micros").notNull(),
    currency: text("currency").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    index("idx_ledger_entries_tenant_created").on(table.tenantId, table.createdAt),
    index("idx_ledger_entries_job_id").on(table.jobId),
    uniqueIndex("idx_ledger_entries_job_effect")
      .on(table.jobId, table.entryType)
      .where(sql`${table.jobId} IS NOT NULL AND ${table.entryType} IN ('inference-debit', 'supplier-credit', 'platform-fee')`)
  ]
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    auditId: text("audit_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    detailsJson: text("details_json").notNull(),
    occurredAt: text("occurred_at").notNull()
  },
  (table) => [index("idx_audit_events_tenant_time").on(table.tenantId, table.occurredAt)]
);

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    tenantId: text("tenant_id").notNull(),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    resourceId: text("resource_id").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_idempotency_keys_scope").on(table.tenantId, table.operation, table.idempotencyKey)
  ]
);

export const apiRateLimits = sqliteTable(
  "api_rate_limits",
  {
    scopeKey: text("scope_key").notNull(),
    action: text("action").notNull(),
    windowStartedAt: text("window_started_at").notNull(),
    requestCount: integer("request_count").notNull(),
    expiresAt: text("expires_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_api_rate_limits_bucket").on(table.scopeKey, table.action, table.windowStartedAt),
    index("idx_api_rate_limits_expires").on(table.expiresAt)
  ]
);

export const cryptographicKeyCanaries = sqliteTable(
  "cryptographic_key_canaries",
  {
    canaryId: text("canary_id").primaryKey(),
    domain: text("domain").notNull(),
    keyId: text("key_id").notNull(),
    formatVersion: integer("format_version").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv"),
    createdAt: text("created_at").notNull()
  },
  (table) => [uniqueIndex("idx_cryptographic_key_canaries_domain_key").on(table.domain, table.keyId)]
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    artifactId: text("artifact_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    fileName: text("file_name").notNull(),
    privacyMode: text("privacy_mode").notNull().default("standard"),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    chunkSizeBytes: integer("chunk_size_bytes").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    uploadedChunks: integer("uploaded_chunks").notNull().default(0),
    manifestSha256: text("manifest_sha256"),
    status: text("status").notNull(),
    contentPurgedAt: text("content_purged_at"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    index("idx_artifacts_tenant_created").on(table.tenantId, table.createdAt),
    index("idx_artifacts_status_expires").on(table.status, table.expiresAt)
  ]
);

export const artifactChunks = sqliteTable(
  "artifact_chunks",
  {
    artifactId: text("artifact_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    partNumber: integer("part_number").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    plaintextSha256: text("plaintext_sha256").notNull(),
    ciphertextSha256: text("ciphertext_sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    iv: text("iv").notNull(),
    uploadStatus: text("upload_status").notNull().default("ready"),
    uploadedAt: text("uploaded_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_artifact_chunks_part").on(table.artifactId, table.partNumber),
    index("idx_artifact_chunks_tenant_artifact").on(table.tenantId, table.artifactId)
  ]
);

export const artifactObjectDeletions = sqliteTable(
  "artifact_object_deletions",
  {
    storageKey: text("storage_key").primaryKey(),
    artifactId: text("artifact_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    nextAttemptAt: text("next_attempt_at").notNull(),
    retainUntil: text("retain_until").notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    index("idx_artifact_object_deletions_due").on(table.nextAttemptAt, table.retainUntil),
    index("idx_artifact_object_deletions_artifact").on(table.tenantId, table.artifactId)
  ]
);

export const supplierArtifactWorkers = sqliteTable(
  "supplier_artifact_workers",
  {
    supplierTenantId: text("supplier_tenant_id").notNull(),
    workerId: text("worker_id").notNull(),
    providerId: text("provider_id").notNull(),
    authorizationRequestIdsJson: text("authorization_request_ids_json").notNull(),
    allowedModelsJson: text("allowed_models_json").notNull(),
    supportedMediaTypesJson: text("supported_media_types_json").notNull(),
    maxArtifactBytes: integer("max_artifact_bytes").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    expiresAt: text("expires_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_supplier_artifact_workers_identity").on(table.supplierTenantId, table.workerId),
    index("idx_supplier_artifact_workers_capacity").on(table.supplierTenantId, table.providerId, table.expiresAt)
  ]
);

export const artifactTasks = sqliteTable(
  "artifact_tasks",
  {
    taskId: text("task_id").primaryKey(),
    buyerTenantId: text("buyer_tenant_id").notNull(),
    supplierTenantId: text("supplier_tenant_id").notNull(),
    offerId: text("offer_id").notNull(),
    authorizationRequestId: text("authorization_request_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    model: text("model").notNull(),
    dataClass: text("data_class").notNull(),
    privacyMode: text("privacy_mode").notNull().default("standard"),
    instructionDigest: text("instruction_digest").notNull(),
    digestVersion: integer("digest_version").notNull().default(1),
    instructionCiphertext: text("instruction_ciphertext").notNull(),
    instructionIv: text("instruction_iv").notNull(),
    contentKeyVersion: integer("content_key_version").notNull().default(1),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    maxTotalTokens: integer("max_total_tokens").notNull(),
    reservedChargeMicros: text("reserved_charge_micros").notNull(),
    status: text("status").notNull(),
    completedSegments: integer("completed_segments").notNull().default(0),
    totalSegments: integer("total_segments"),
    processedBytes: integer("processed_bytes").notNull().default(0),
    attempt: integer("attempt").notNull().default(0),
    workerId: text("worker_id"),
    leaseDigest: text("lease_digest"),
    leaseExpiresAt: text("lease_expires_at"),
    executionDeadlineAt: text("execution_deadline_at"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    chargeMicros: text("charge_micros"),
    outputCiphertext: text("output_ciphertext"),
    outputIv: text("output_iv"),
    outputExpiresAt: text("output_expires_at"),
    contentPurgedAt: text("content_purged_at"),
    cancellationRequestedAt: text("cancellation_requested_at"),
    errorCode: text("error_code"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at")
  },
  (table) => [
    uniqueIndex("idx_artifact_tasks_idempotency").on(table.buyerTenantId, table.idempotencyKey),
    index("idx_artifact_tasks_buyer_created").on(table.buyerTenantId, table.createdAt),
    index("idx_artifact_tasks_supplier_status").on(table.supplierTenantId, table.status, table.createdAt),
    index("idx_artifact_tasks_offer_status").on(table.offerId, table.status)
  ]
);

export const artifactTaskCheckpoints = sqliteTable(
  "artifact_task_checkpoints",
  {
    checkpointId: text("checkpoint_id").primaryKey(),
    taskId: text("task_id").notNull(),
    attempt: integer("attempt").notNull(),
    completedSegments: integer("completed_segments").notNull(),
    totalSegments: integer("total_segments").notNull(),
    processedBytes: integer("processed_bytes").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    occurredAt: text("occurred_at").notNull()
  },
  (table) => [index("idx_artifact_task_checkpoints_task_time").on(table.taskId, table.occurredAt)]
);

export const artifactTaskEvidence = sqliteTable(
  "artifact_task_evidence",
  {
    evidenceId: text("evidence_id").primaryKey(),
    taskId: text("task_id").notNull(),
    providerId: text("provider_id").notNull(),
    requestedModel: text("requested_model").notNull(),
    servedModel: text("served_model").notNull(),
    artifactId: text("artifact_id").notNull(),
    artifactManifestSha256: text("artifact_manifest_sha256").notNull(),
    artifactContentSha256: text("artifact_content_sha256").notNull(),
    outputSha256: text("output_sha256").notNull(),
    digestVersion: integer("digest_version").notNull().default(1),
    providerRequestIdsSha256: text("provider_request_ids_sha256").notNull(),
    segmentsCompleted: integer("segments_completed").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    buyerChargeMicros: text("buyer_charge_micros").notNull(),
    supplierCreditMicros: text("supplier_credit_micros").notNull(),
    platformFeeMicros: text("platform_fee_micros").notNull(),
    completedAt: text("completed_at").notNull(),
    recordedAt: text("recorded_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_artifact_task_evidence_task").on(table.taskId),
    index("idx_artifact_task_evidence_provider_time").on(table.providerId, table.recordedAt)
  ]
);

export const agentRequestNonces = sqliteTable(
  "agent_request_nonces",
  {
    credentialDigest: text("credential_digest").notNull(),
    nonce: text("nonce").notNull(),
    expiresAt: text("expires_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_agent_request_nonces_unique").on(table.credentialDigest, table.nonce),
    index("idx_agent_request_nonces_expires").on(table.expiresAt)
  ]
);

import {
  MARKETPLACE_API_VERSION,
  SUPPLIER_GATEWAY_PROTOCOL_VERSION,
  type AuthorizationRequestView,
  type CapacityOfferView,
  type CreateAuthorizationRequest,
  type CreateCapacityOfferRequest,
  type InferenceJobView,
  type LedgerEntryView,
  type MarketplaceDashboardSnapshot,
  type MarketplaceEvent,
  type MarketplacePrivacyMode,
  type RegisterSupplierRequest,
  type RevokeAuthorizationRequest,
  type ReviewAuthorizationRequest,
  type RotateAuthorizationCredentialRequest,
  type RunInferenceRequest,
  type RunInferenceResponse,
  type SetSupplyRequest,
  type SupplierGatewayExecutionEvidence,
  type SupplierGatewayUsage,
  type SupplierEvent,
  type SupplierProfileView
} from "@token-streaming/protocol";
import {
  MarketplaceDomainError,
  activateSupplier,
  assertSupplierProcessingAcknowledged,
  calculateMarketplacePrivacyRetentionMilliseconds,
  calculateSettlement,
  estimateMaximumChargeMicros,
  publishCapacityOffer,
  parseMarketplacePrivacyMode,
  recordProviderAuthorization,
  recordSupplierVerification,
  registerSupplier,
  rehydrateSupplier,
  revokeProviderAuthorization,
  requiredVerificationKinds
} from "@token-streaming/marketplace-domain";

import { ensureSchema, getD1 } from "@/db";
import { ApiError, readBoundedText } from "./http";
import {
  decryptContent,
  decryptCredential,
  createCredentialLookupDigest,
  createCredentialLookupDigests,
  createDigestCommitment,
  encryptContent,
  encryptCredential,
  requireAdmin,
  sha256Hex,
  validateGatewayEndpoint,
  type RequestIdentity
} from "./security";
import { getMarketplaceRuntimePolicy } from "./runtime-policy";
import { enforceTenantRateLimit } from "./rate-limit";
import { createSignedGatewayHeaders } from "./gateway-signing";
import { attestSupplierGateway } from "./gateway-attestation";
import { verifyGatewayServiceEvidence, type VerifiedGatewayServiceEvidence } from "./gateway-evidence";
import { listArtifacts, listArtifactTasks } from "./artifact-service";
import {
  AVAILABLE_BALANCE_SQL,
  COMPLETE_INFERENCE_JOB_SQL,
  RESERVE_INFERENCE_JOB_SQL
} from "./financial-invariants";
import {
  ACTIVATE_REVIEWED_SUPPLIER_SQL,
  APPROVE_AUTHORIZATION_REQUEST_SQL,
  BIND_AUTHORIZATION_REVIEW_COMMAND_SQL,
  CLAIM_AUTHORIZATION_REVIEW_TARGET_SQL,
  REJECT_AUTHORIZATION_REQUEST_SQL,
  claimAuthorizationReviewTargetWithLookupLimitSql,
  countApprovedAgentAuthorizationsSql
} from "./review-invariants";
import { isAuthorizationValidityAllowed } from "./authorization-invariants";
import { MAX_AGENT_AUTHORIZATIONS_PER_TOKEN } from "./agent-auth-invariants";
import { isLikelySecretEvidenceReference } from "./sensitive-reference";
import {
  BIND_CAPACITY_OFFER_COMMAND_SQL,
  BIND_AUTHORIZATION_LIFECYCLE_COMMAND_SQL,
  CANCEL_LEASED_ARTIFACTS_FOR_REVOKED_AUTHORIZATION_SQL,
  CLAIM_AUTHORIZATION_LIFECYCLE_TARGET_SQL,
  CREATE_CAPACITY_OFFER_WITH_AUTHORIZATION_CAS_SQL,
  DELETE_AGENT_HEARTBEAT_AFTER_AUTHORIZATION_REVOCATION_SQL,
  DELETE_AGENT_HEARTBEAT_AFTER_CREDENTIAL_ROTATION_SQL,
  FAIL_QUEUED_ARTIFACTS_FOR_REVOKED_AUTHORIZATION_SQL,
  FAIL_RESERVED_INFERENCE_AFTER_CREDENTIAL_ROTATION_SQL,
  FAIL_RESERVED_INFERENCE_FOR_REVOKED_AUTHORIZATION_SQL,
  REVOKE_ACTIVE_AUTHORIZATION_SQL,
  UPDATE_SUPPLIER_AFTER_AUTHORIZATION_REVOCATION_SQL,
  WITHDRAW_PENDING_AUTHORIZATION_SQL,
  authorizationCredentialRotationCommandBinding,
  capacityOfferCommandBinding,
  claimAuthorizationCredentialRotationTargetSql,
  rotateAuthorizationCredentialSql
} from "./authorization-lifecycle-invariants";

interface SupplierRow {
  supplier_id: string;
  tenant_id: string;
  user_id: string;
  kind: "individual" | "organization";
  legal_name: string;
  display_name: string;
  country_code: string;
  tax_residence_country_code: string;
  status: SupplierProfileView["status"];
  supply_enabled: number;
  version: number;
  created_at: string;
  updated_at: string;
}

interface AuthorizationRow {
  request_id: string;
  tenant_id: string;
  supplier_id: string;
  supplier_display_name?: string;
  provider_id: string;
  source_type: CreateAuthorizationRequest["sourceType"];
  metering_mode: CreateAuthorizationRequest["meteringMode"];
  evidence_ref: string;
  model_pattern: string;
  region_code: string;
  data_classes_json: string;
  requests_per_minute: number;
  tokens_per_minute: number;
  concurrency: number;
  max_output_tokens: number;
  valid_until: string;
  gateway_endpoint: string;
  encrypted_gateway_token: string;
  gateway_token_iv: string;
  credential_key_id: string;
  gateway_token_digest: string | null;
  gateway_token_digest_version: number;
  gateway_token_lookup_key_id: string;
  encryption_key_version: number;
  authorization_revision: number;
  status: AuthorizationRequestView["status"];
  review_note: string | null;
  review_command_id: string | null;
  reviewed_at: string | null;
  credential_rotated_at: string | null;
  revoked_at: string | null;
  revocation_reason_code: RevokeAuthorizationRequest["reasonCode"] | null;
  created_at: string;
}

interface OfferRow {
  offer_id: string;
  tenant_id: string;
  supplier_id: string;
  supplier_display_name: string;
  authorization_request_id: string;
  provider_id: string;
  source_type: CapacityOfferView["sourceType"];
  model: string;
  region_code: string;
  data_classes_json: string;
  requests_per_minute: number;
  tokens_per_minute: number;
  concurrency: number;
  max_output_tokens: number;
  currency: "CNY";
  price_micros_per_million_tokens: string;
  status: CapacityOfferView["status"];
  valid_from: string;
  valid_until: string;
  created_at: string;
  supplier_tenant_id?: string;
  gateway_endpoint?: string;
  encrypted_gateway_token?: string;
  gateway_token_iv?: string;
  credential_key_id?: string;
  encryption_key_version?: number;
  authorization_revision?: number;
  authorization_status?: AuthorizationRequestView["status"];
  authorization_valid_until?: string;
}

interface EventRow {
  event_id: string;
  tenant_id: string;
  actor_id: string;
  causation_id: string;
  aggregate_type: MarketplaceEvent["aggregateType"];
  aggregate_id: string;
  aggregate_version: number;
  event_type: MarketplaceEvent["type"];
  schema_version: number;
  payload_json: string;
  occurred_at: string;
}

interface JobRow {
  job_id: string;
  buyer_tenant_id?: string;
  offer_id: string;
  authorization_request_id?: string | null;
  authorization_revision?: number | null;
  model: string;
  privacy_mode: MarketplacePrivacyMode;
  prompt_digest?: string;
  digest_version?: number;
  data_class?: "P0" | "P1";
  max_output_tokens?: number;
  reserved_charge_micros: string;
  reservation_expires_at: string | null;
  status: InferenceJobView["status"];
  total_tokens: number | null;
  charge_micros: string | null;
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
  output_ciphertext?: string | null;
  output_iv?: string | null;
  content_key_version: number;
  output_expires_at?: string | null;
  content_purged_at: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  proof_provider_id?: string | null;
  proof_requested_model?: string | null;
  proof_served_model?: string | null;
  proof_provider_request_id?: string | null;
  proof_assurance?: "node-signed-provider-response" | null;
  proof_evidence_digest?: string | null;
  proof_unit_price?: string | null;
  proof_buyer_charge?: string | null;
  proof_completed_at?: string | null;
}

interface LedgerRow {
  entry_id: string;
  job_id: string | null;
  entry_type: LedgerEntryView["entryType"];
  direction: LedgerEntryView["direction"];
  amount_micros: string;
  currency: "CNY";
  created_at: string;
}

export async function getDashboard(identity: RequestIdentity): Promise<MarketplaceDashboardSnapshot> {
  await ensureSchema();
  await ensureUser(identity);
  await cleanupStaleInferenceReservations();
  await cleanupExpiredInferenceContent();
  const db = getD1();
  const now = new Date().toISOString();

  const supplier = await db
    .prepare("SELECT * FROM suppliers WHERE user_id = ? AND tenant_id = ?")
    .bind(identity.user.userId, identity.tenantId)
    .first<SupplierRow>();

  const ownAuthorizations = supplier
    ? await db
        .prepare(
          `SELECT ar.*, s.display_name AS supplier_display_name
           FROM authorization_requests ar
           JOIN suppliers s ON s.supplier_id = ar.supplier_id AND s.tenant_id = ar.tenant_id
           WHERE ar.tenant_id = ? ORDER BY ar.created_at DESC LIMIT 30`
        )
        .bind(identity.tenantId)
        .all<AuthorizationRow>()
    : { results: [] as AuthorizationRow[] };

  const ownOffers = await db
    .prepare(
      `SELECT o.*, s.display_name AS supplier_display_name,
        ar.status AS authorization_status, ar.valid_until AS authorization_valid_until
       FROM capacity_offers o
       JOIN suppliers s ON s.supplier_id = o.supplier_id AND s.tenant_id = o.tenant_id
       JOIN authorization_requests ar ON ar.request_id = o.authorization_request_id
         AND ar.tenant_id = o.tenant_id AND ar.supplier_id = o.supplier_id
       WHERE o.tenant_id = ? ORDER BY o.created_at DESC LIMIT 50`
    )
    .bind(identity.tenantId)
    .all<OfferRow>();

  const marketOffers = await db
    .prepare(
      `SELECT o.*, s.display_name AS supplier_display_name
       FROM capacity_offers o
       JOIN suppliers s ON s.supplier_id = o.supplier_id AND s.tenant_id = o.tenant_id
       JOIN authorization_requests ar ON ar.request_id = o.authorization_request_id
         AND ar.tenant_id = o.tenant_id AND ar.supplier_id = o.supplier_id
         AND ar.provider_id = o.provider_id AND ar.status = 'approved'
       WHERE o.status = 'active' AND o.valid_from <= ? AND o.valid_until > ?
         AND ar.valid_until > ? AND s.status = 'active' AND s.supply_enabled = 1
       ORDER BY CAST(o.price_micros_per_million_tokens AS INTEGER) ASC, o.created_at ASC LIMIT 50`
    )
    .bind(now, now, now)
    .all<OfferRow>();

  const ledger = await db
    .prepare(
      `SELECT entry_id, job_id, entry_type, direction, amount_micros, currency, created_at
       FROM ledger_entries WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 30`
    )
    .bind(identity.tenantId)
    .all<LedgerRow>();

  const jobs = await db
    .prepare(
      `SELECT j.job_id, j.buyer_tenant_id, j.offer_id, j.model, j.privacy_mode, j.status,
        j.total_tokens, j.charge_micros, j.error_code, j.content_key_version,
        j.output_expires_at, j.content_purged_at, j.created_at, j.completed_at,
        se.provider_id AS proof_provider_id,
        se.requested_model AS proof_requested_model,
        se.served_model AS proof_served_model,
        se.provider_request_id AS proof_provider_request_id,
        se.assurance AS proof_assurance,
        se.evidence_digest AS proof_evidence_digest,
        se.unit_price_micros_per_million_tokens AS proof_unit_price,
        se.buyer_charge_micros AS proof_buyer_charge,
        se.provider_completed_at AS proof_completed_at
       FROM inference_jobs j
       LEFT JOIN service_evidence se ON se.job_id = j.job_id
       WHERE j.buyer_tenant_id = ?
       ORDER BY j.created_at DESC LIMIT 30`
    )
    .bind(identity.tenantId)
    .all<JobRow>();

  const usage = await readUsageSummary(identity.tenantId);
  const pendingReviews = identity.isAdmin
    ? await db
        .prepare(
          `SELECT ar.*, s.display_name AS supplier_display_name
           FROM authorization_requests ar
           JOIN suppliers s ON s.supplier_id = ar.supplier_id AND s.tenant_id = ar.tenant_id
           WHERE ar.status = 'pending' AND ar.tenant_id <> ?
           ORDER BY ar.created_at ASC LIMIT 100`
        )
        .bind(identity.tenantId)
        .all<AuthorizationRow>()
    : { results: [] as AuthorizationRow[] };
  const [artifacts, artifactTasks] = await Promise.all([
    listArtifacts(identity),
    listArtifactTasks(identity)
  ]);

  const policy = getMarketplaceRuntimePolicy();
  return {
    apiVersion: MARKETPLACE_API_VERSION,
    generatedAt: now,
    user: {
      displayName: identity.user.displayName,
      email: identity.user.email,
      isAdmin: identity.isAdmin
    },
    supplier: supplier ? mapSupplier(supplier) : null,
    authorizationRequests: ownAuthorizations.results.map((row) => mapAuthorization(row, now)),
    offers: ownOffers.results.map((row) => mapOffer(row, identity.tenantId, now)),
    marketOffers: marketOffers.results.map((row) => mapOffer(row, identity.tenantId, now)),
    usage,
    ledger: ledger.results.map(mapLedger),
    jobs: jobs.results.map(mapJob),
    artifacts,
    artifactTasks,
    pendingReviews: pendingReviews.results.map((row) => mapAuthorization(row, now)),
    privacy: {
      supplierReceivesPlaintext: true,
      providerReceivesPlaintext: true,
      promptBodyPersisted: false,
      contentDigestsKeyed: true,
      loginProfileCopiedToMarketplace: false,
      standardOutputRetentionHours: policy.standardOutputRetentionHours,
      standardArtifactRetentionHours: policy.standardArtifactRetentionHours,
      strictOutputRetentionMinutes: policy.strictOutputRetentionMinutes,
      strictArtifactRetentionMinutes: policy.strictArtifactRetentionMinutes,
      activeContentCanBePurged: true
    }
  };
}

export async function registerSupplierProfile(
  identity: RequestIdentity,
  input: RegisterSupplierRequest
): Promise<MarketplaceDashboardSnapshot> {
  await ensureSchema();
  await ensureUser(identity);
  assertExactKeys(input, ["commandId", "kind", "legalName", "displayName", "countryCode", "taxResidenceCountryCode"]);
  const prior = await readIdempotency(identity.tenantId, "supplier.register", input.commandId);
  if (prior) return getDashboard(identity);
  await enforceTenantRateLimit(identity, "supplier.register", 5, 60 * 60_000);

  const db = getD1();
  const existing = await db
    .prepare("SELECT supplier_id FROM suppliers WHERE tenant_id = ? OR user_id = ? LIMIT 1")
    .bind(identity.tenantId, identity.user.userId)
    .first<{ supplier_id: string }>();
  if (existing) throw new ApiError("CONFLICT", "当前账号已经注册供应商。", 409);

  const now = new Date().toISOString();
  const supplierId = `supplier-${crypto.randomUUID()}`;
  const event = mapDomainError(() =>
    registerSupplier(
      {
        supplierId,
        kind: input.kind,
        legalName: input.legalName.trim(),
        displayName: input.displayName.trim(),
        countryCode: input.countryCode.toUpperCase(),
        taxResidenceCountryCode: input.taxResidenceCountryCode.toUpperCase()
      },
      commandContext(identity, input.commandId, now)
    )
  );

  await db.batch([
    eventInsert(db, event),
    db
      .prepare(
        `INSERT INTO suppliers (
          supplier_id, tenant_id, user_id, kind, legal_name, display_name, country_code,
          tax_residence_country_code, status, supply_enabled, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending-verification', 0, 1, ?, ?)`
      )
      .bind(
        supplierId,
        identity.tenantId,
        identity.user.userId,
        input.kind,
        input.legalName.trim(),
        input.displayName.trim(),
        input.countryCode.toUpperCase(),
        input.taxResidenceCountryCode.toUpperCase(),
        now,
        now
      ),
    auditInsert(db, identity, "supplier.registered", "supplier", supplierId, { kind: input.kind }, now),
    idempotencyInsert(db, identity.tenantId, "supplier.register", input.commandId, supplierId, now)
  ]);

  return getDashboard(identity);
}

export async function submitAuthorizationRequest(
  identity: RequestIdentity,
  input: CreateAuthorizationRequest
): Promise<MarketplaceDashboardSnapshot> {
  await ensureSchema();
  assertExactKeys(input, [
    "commandId",
    "providerId",
    "sourceType",
    "meteringMode",
    "evidenceRef",
    "modelPattern",
    "regionCode",
    "dataClasses",
    "limits",
    "validUntil",
    "gatewayEndpoint",
    "gatewayBearerToken"
  ]);
  const prior = await readIdempotency(identity.tenantId, "authorization.submit", input.commandId);
  if (prior) return getDashboard(identity);
  await enforceTenantRateLimit(identity, "authorization.submit", 10, 60 * 60_000);
  validateAuthorizationInput(input);
  const gateway = validateGatewayEndpoint(input.gatewayEndpoint, false);
  const requestId = `authorization-request-${crypto.randomUUID()}`;
  const encrypted = await encryptCredential(input.gatewayBearerToken, {
    tenantId: identity.tenantId,
    authorizationRequestId: requestId
  });
  const gatewayTokenDigest = await createCredentialLookupDigest(input.gatewayBearerToken);
  const db = getD1();
  const supplier = await requireSupplierRow(identity);
  if (supplier.status === "suspended" || supplier.status === "rejected") {
    throw new ApiError("SUPPLIER_NOT_ACTIVE", "当前供应商状态不允许提交授权。", 409);
  }
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO authorization_requests (
          request_id, tenant_id, supplier_id, provider_id, source_type, metering_mode, evidence_ref,
          model_pattern, region_code, data_classes_json, requests_per_minute, tokens_per_minute,
           concurrency, max_output_tokens, valid_until, gateway_endpoint, encrypted_gateway_token,
           gateway_token_iv, credential_key_id, gateway_token_digest, gateway_token_digest_version,
           gateway_token_lookup_key_id, encryption_key_version, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .bind(
        requestId,
        identity.tenantId,
        supplier.supplier_id,
        input.providerId,
        input.sourceType,
        input.meteringMode,
        input.evidenceRef,
        input.modelPattern,
        input.regionCode.toUpperCase(),
        JSON.stringify(input.dataClasses),
        input.limits.requestsPerMinute,
        input.limits.tokensPerMinute,
        input.limits.concurrency,
        input.limits.maxOutputTokens,
        input.validUntil,
        gateway.toString(),
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.keyId,
        gatewayTokenDigest.digest,
        gatewayTokenDigest.version,
        gatewayTokenDigest.keyId,
        encrypted.keyVersion,
        now,
        now
      ),
    auditInsert(db, identity, "authorization.submitted", "authorization-request", requestId, {
      providerId: input.providerId,
      sourceType: input.sourceType,
      gatewayHost: gateway.hostname
    }, now),
    idempotencyInsert(db, identity.tenantId, "authorization.submit", input.commandId, requestId, now)
  ]);

  return getDashboard(identity);
}

export async function reviewAuthorization(
  identity: RequestIdentity,
  requestId: string,
  input: ReviewAuthorizationRequest
): Promise<MarketplaceDashboardSnapshot> {
  await ensureSchema();
  requireAdmin(identity);
  assertIdentifier(requestId, "requestId");
  assertExactKeys(input, ["commandId", "decision", "reviewNote"]);
  assertIdentifier(input.commandId, "commandId");
  if (input.decision !== "approve" && input.decision !== "reject") {
    throw new ApiError("INVALID_REQUEST", "审核决定必须是 approve 或 reject。", 400);
  }
  const db = getD1();
  const request = await db
    .prepare("SELECT * FROM authorization_requests WHERE request_id = ?")
    .bind(requestId)
    .first<AuthorizationRow>();
  if (!request) throw new ApiError("NOT_FOUND", "授权申请不存在。", 404);
  if (request.tenant_id === identity.tenantId) {
    throw new ApiError("REVIEWER_CONFLICT", "审核员不能审核自己租户提交的供应授权。", 403);
  }
  const reviewBinding = `${requestId}:${input.decision}`;
  const prior = await readIdempotency(identity.tenantId, "authorization.review", input.commandId);
  if (prior) {
    if (prior !== reviewBinding) {
      throw new ApiError("CONFLICT", "该审核幂等键已绑定到其他申请或审核决定。", 409);
    }
    const replayed = await getD1().prepare(
      "SELECT status, review_command_id FROM authorization_requests WHERE request_id = ?"
    ).bind(requestId).first<{ status: string; review_command_id: string | null }>();
    if (replayed?.status !== (input.decision === "approve" ? "approved" : "rejected") ||
        replayed.review_command_id !== input.commandId) {
      throw new ApiError("CONFLICT", "该审核命令未形成完整的审核结果。", 409);
    }
    return getDashboard(identity);
  }
  await enforceTenantRateLimit(identity, "authorization.review", 60, 60 * 60_000);

  if (request.status !== "pending") throw new ApiError("CONFLICT", "授权申请已经完成审核。", 409);
  const now = new Date().toISOString();
  const note = normalizeOptionalText(input.reviewNote, 500);
  const reviewOperationToken = `review-op-${crypto.randomUUID()}`;

  if (input.decision === "reject") {
    await db.batch([
      reviewTargetClaimInsert(
        db, identity.tenantId, requestId, input.commandId,
        reviewBinding, reviewOperationToken, now
      ),
      guardedReviewIdempotencyInsert(
        db, identity.tenantId, input.commandId, reviewBinding,
        requestId, reviewOperationToken, now
      ),
      db
        .prepare(REJECT_AUTHORIZATION_REQUEST_SQL)
        .bind(
          note ?? "未通过生产授权审核", identity.actorId, input.commandId, now, now, requestId,
          requestId, reviewOperationToken,
          identity.tenantId, input.commandId, reviewBinding
        ),
      guardedReviewAuditInsert(db, identity, "authorization.rejected", requestId, input.commandId, reviewOperationToken, {
        supplierTenantId: request.tenant_id
      }, now)
    ]);
    const reviewed = await db.prepare(
      "SELECT status, review_command_id FROM authorization_requests WHERE request_id = ?"
    ).bind(requestId).first<{ status: string; review_command_id: string | null }>();
    if (reviewed?.status !== "rejected" || reviewed.review_command_id !== input.commandId) {
      throw new ApiError("CONFLICT", "授权申请已被其他审核操作处理。", 409);
    }
    return getDashboard(identity);
  }

  const gateway = validateGatewayEndpoint(request.gateway_endpoint, true);
  const gatewayToken = await decryptCredential(
    request.encrypted_gateway_token,
    request.gateway_token_iv,
    request.encryption_key_version,
    request.credential_key_id,
    { tenantId: request.tenant_id, authorizationRequestId: request.request_id }
  );
  const [reviewCredentialLookups, legacyCredentialDigest] = await Promise.all([
    createCredentialLookupDigests(gatewayToken),
    sha256Hex(gatewayToken)
  ]);
  const approvedForCredential = await db.prepare(
    countApprovedAgentAuthorizationsSql(reviewCredentialLookups.length)
  ).bind(
    now,
    legacyCredentialDigest,
    ...reviewCredentialLookups.flatMap((candidate) => [candidate.version, candidate.keyId, candidate.digest])
  ).first<{ authorization_count: number }>();
  if ((approvedForCredential?.authorization_count ?? 0) >= MAX_AGENT_AUTHORIZATIONS_PER_TOKEN) {
    throw new ApiError("CONFLICT", "该 Agent 凭据绑定的有效授权数量已达到安全上限。", 409);
  }
  const attestation = await attestSupplierGateway(gateway, gatewayToken, {
    providerId: request.provider_id,
    modelPattern: request.model_pattern,
    dataClasses: parseDataClasses(request.data_classes_json),
    limits: {
      requestsPerMinute: request.requests_per_minute,
      tokensPerMinute: request.tokens_per_minute,
      concurrency: request.concurrency,
      maxOutputTokens: request.max_output_tokens
    }
  });
  const events = await buildApprovalEvents(identity, request, input.commandId, now);
  const resultingState = rehydrateSupplier([
    ...(await readSupplierEvents(request.tenant_id, request.supplier_id)),
    ...events
  ]);
  if (!resultingState || resultingState.status !== "active") {
    throw new ApiError("INTERNAL_ERROR", "供应商激活状态生成失败。", 500);
  }

  const expectedSupplierVersion = resultingState.version - events.length;
  const statements = [
    reviewTargetClaimInsert(
      db, identity.tenantId, requestId, input.commandId,
      reviewBinding, reviewOperationToken, now,
      { legacyCredentialDigest, credentialLookups: reviewCredentialLookups }
    ),
    guardedReviewIdempotencyInsert(
      db, identity.tenantId, input.commandId, reviewBinding,
      requestId, reviewOperationToken, now
    ),
    db
      .prepare(APPROVE_AUTHORIZATION_REQUEST_SQL)
      .bind(
        note ?? "生产授权与节点健康证明审核通过", identity.actorId, input.commandId,
        now, now, requestId, request.supplier_id, request.tenant_id, expectedSupplierVersion,
        requestId, reviewOperationToken,
        identity.tenantId, input.commandId, reviewBinding
      ),
    db
      .prepare(ACTIVATE_REVIEWED_SUPPLIER_SQL)
      .bind(
        resultingState.version,
        now,
        request.supplier_id,
        request.tenant_id,
        expectedSupplierVersion,
        requestId,
        input.commandId,
        requestId,
        reviewOperationToken
      ),
    ...events.map((event) => guardedReviewEventInsert(
      db, event, requestId, input.commandId, reviewOperationToken, resultingState.version
    )),
    guardedReviewAuditInsert(db, identity, "authorization.approved", requestId, input.commandId, reviewOperationToken, {
      supplierTenantId: request.tenant_id,
      providerId: request.provider_id,
      attestedModelCount: attestation.matchedModels.length,
      attestedCapacity: attestation.limits
    }, now)
  ];
  await db.batch(statements);
  const reviewed = await db.prepare(
    `SELECT ar.status, ar.review_command_id, s.status AS supplier_status, s.version AS supplier_version
     FROM authorization_requests ar
     JOIN suppliers s ON s.supplier_id = ar.supplier_id AND s.tenant_id = ar.tenant_id
     WHERE ar.request_id = ?`
  ).bind(requestId).first<{
    status: string;
    review_command_id: string | null;
    supplier_status: string;
    supplier_version: number;
  }>();
  if (
    reviewed?.status !== "approved" || reviewed.review_command_id !== input.commandId ||
    reviewed.supplier_status !== "active" || reviewed.supplier_version !== resultingState.version
  ) {
    throw new ApiError("CONFLICT", "授权申请已被其他审核操作处理。", 409);
  }
  return getDashboard(identity);
}

export async function revokeAuthorization(
  identity: RequestIdentity,
  requestId: string,
  input: RevokeAuthorizationRequest
): Promise<MarketplaceDashboardSnapshot> {
  await ensureSchema();
  assertIdentifier(requestId, "requestId");
  assertExactKeys(input, ["commandId", "reasonCode"]);
  assertIdentifier(input.commandId, "commandId");
  assertAuthorizationRevocationReason(input.reasonCode);
  const supplier = await requireSupplierRow(identity);
  const db = getD1();
  const request = await db.prepare(
    `SELECT * FROM authorization_requests
     WHERE request_id = ? AND tenant_id = ? AND supplier_id = ?`
  ).bind(requestId, identity.tenantId, supplier.supplier_id).first<AuthorizationRow>();
  if (!request) throw new ApiError("NOT_FOUND", "授权不存在。", 404);

  const binding = `${requestId}:${input.reasonCode}`;
  const [withdrawReplay, revokeReplay] = await Promise.all([
    readIdempotency(identity.tenantId, "authorization.withdraw", input.commandId),
    readIdempotency(identity.tenantId, "authorization.revoke", input.commandId)
  ]);
  const replay = withdrawReplay ?? revokeReplay;
  if (replay) {
    if (replay !== binding) {
      throw new ApiError("AUTHORIZATION_STATE_CONFLICT", "该命令已绑定到其他授权生命周期操作。", 409);
    }
    return getDashboard(identity);
  }
  await enforceTenantRateLimit(identity, "authorization.lifecycle", 30, 60 * 60_000);
  const now = new Date().toISOString();
  if (request.status === "pending") {
    await withdrawPendingAuthorization(identity, supplier, request, input, binding, now);
    return getDashboard(identity);
  }
  if (request.status !== "approved" || request.valid_until <= now) {
    throw new ApiError("AUTHORIZATION_STATE_CONFLICT", "只有当前有效的已批准授权可以撤销。", 409);
  }
  await revokeApprovedAuthorization(identity, supplier, request, input, binding, now);
  return getDashboard(identity);
}

export async function rotateAuthorizationCredential(
  identity: RequestIdentity,
  requestId: string,
  input: RotateAuthorizationCredentialRequest
): Promise<MarketplaceDashboardSnapshot> {
  await ensureSchema();
  assertIdentifier(requestId, "requestId");
  assertExactKeys(input, ["commandId", "reasonCode", "gatewayBearerToken"]);
  assertIdentifier(input.commandId, "commandId");
  assertGatewayCredentialRotationReason(input.reasonCode);
  validateGatewayBearerToken(input.gatewayBearerToken);
  const supplier = await requireSupplierRow(identity);
  const db = getD1();
  const request = await db.prepare(
    `SELECT * FROM authorization_requests
     WHERE request_id = ? AND tenant_id = ? AND supplier_id = ?`
  ).bind(requestId, identity.tenantId, supplier.supplier_id).first<AuthorizationRow>();
  if (!request) throw new ApiError("NOT_FOUND", "授权不存在。", 404);

  const [credentialLookups, legacyCredentialDigest] = await Promise.all([
    createCredentialLookupDigests(input.gatewayBearerToken),
    sha256Hex(input.gatewayBearerToken)
  ]);
  const activeLookup = credentialLookups[0]!;
  const binding = authorizationCredentialRotationCommandBinding(
    requestId,
    input.reasonCode,
    legacyCredentialDigest
  );
  const replay = await readIdempotency(
    identity.tenantId,
    "authorization.rotate-credential",
    input.commandId
  );
  if (replay) {
    if (replay !== binding) {
      throw new ApiError("GATEWAY_CREDENTIAL_CONFLICT", "该换发命令已绑定到其他授权或凭据。", 409);
    }
    return getDashboard(identity);
  }
  const now = new Date().toISOString();
  if (request.status !== "approved" || request.valid_until <= now || !request.encrypted_gateway_token) {
    throw new ApiError("AUTHORIZATION_STATE_CONFLICT", "只有当前有效的已批准授权可以换发凭据。", 409);
  }
  await enforceTenantRateLimit(identity, "authorization.rotate-credential", 10, 60 * 60_000);
  const currentToken = await decryptCredential(
    request.encrypted_gateway_token,
    request.gateway_token_iv,
    request.encryption_key_version,
    request.credential_key_id,
    { tenantId: request.tenant_id, authorizationRequestId: request.request_id }
  );
  if (currentToken === input.gatewayBearerToken) {
    throw new ApiError("GATEWAY_CREDENTIAL_CONFLICT", "新 Gateway token 必须不同于当前 token。", 409);
  }

  const gateway = validateGatewayEndpoint(request.gateway_endpoint, true);
  const attestation = await attestSupplierGateway(gateway, input.gatewayBearerToken, {
    providerId: request.provider_id,
    modelPattern: request.model_pattern,
    dataClasses: parseDataClasses(request.data_classes_json),
    limits: {
      requestsPerMinute: request.requests_per_minute,
      tokensPerMinute: request.tokens_per_minute,
      concurrency: request.concurrency,
      maxOutputTokens: request.max_output_tokens
    }
  });
  const encrypted = await encryptCredential(input.gatewayBearerToken, {
    tenantId: request.tenant_id,
    authorizationRequestId: request.request_id
  });
  const operationToken = `authorization-rotate-op-${crypto.randomUUID()}`;
  const targetKey = `${requestId}:${request.authorization_revision}`;
  const operation = "authorization.rotate-credential";
  const nextRevision = request.authorization_revision + 1;
  await db.batch([
    db.prepare(claimAuthorizationCredentialRotationTargetSql(
      credentialLookups.length,
      MAX_AGENT_AUTHORIZATIONS_PER_TOKEN
    )).bind(
      targetKey,
      operationToken,
      now,
      requestId,
      identity.tenantId,
      supplier.supplier_id,
      now,
      request.authorization_revision,
      request.encrypted_gateway_token,
      request.gateway_token_iv,
      request.credential_key_id,
      request.encryption_key_version,
      supplier.version,
      requestId,
      now,
      legacyCredentialDigest,
      ...credentialLookups.flatMap((candidate) => [candidate.version, candidate.keyId, candidate.digest]),
      identity.tenantId,
      supplier.supplier_id,
      requestId,
      now,
      legacyCredentialDigest,
      ...credentialLookups.flatMap((candidate) => [candidate.version, candidate.keyId, candidate.digest]),
      identity.tenantId,
      operation,
      input.commandId,
      binding
    ),
    lifecycleCommandBinding(
      db, identity.tenantId, operation, input.commandId,
      binding, targetKey, operationToken, now
    ),
    db.prepare(rotateAuthorizationCredentialSql(
      credentialLookups.length,
      MAX_AGENT_AUTHORIZATIONS_PER_TOKEN
    )).bind(
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.keyId,
      activeLookup.digest,
      activeLookup.version,
      activeLookup.keyId,
      encrypted.keyVersion,
      now,
      now,
      requestId,
      identity.tenantId,
      supplier.supplier_id,
      now,
      request.authorization_revision,
      request.encrypted_gateway_token,
      request.gateway_token_iv,
      request.credential_key_id,
      request.encryption_key_version,
      requestId,
      now,
      legacyCredentialDigest,
      ...credentialLookups.flatMap((candidate) => [candidate.version, candidate.keyId, candidate.digest]),
      identity.tenantId,
      supplier.supplier_id,
      requestId,
      now,
      legacyCredentialDigest,
      ...credentialLookups.flatMap((candidate) => [candidate.version, candidate.keyId, candidate.digest]),
      targetKey,
      operationToken,
      identity.tenantId,
      input.commandId,
      binding
    ),
    db.prepare(FAIL_RESERVED_INFERENCE_AFTER_CREDENTIAL_ROTATION_SQL).bind(
      now,
      requestId,
      request.authorization_revision,
      requestId,
      requestId,
      request.authorization_revision,
      requestId,
      identity.tenantId,
      supplier.supplier_id,
      nextRevision,
      activeLookup.digest
    ),
    db.prepare(DELETE_AGENT_HEARTBEAT_AFTER_CREDENTIAL_ROTATION_SQL).bind(
      identity.tenantId, requestId, identity.tenantId, supplier.supplier_id,
      nextRevision, activeLookup.digest
    ),
    guardedAuthorizationLifecycleAuditInsert(
      db,
      identity,
      "authorization.credential-rotated",
      requestId,
      "approved",
      nextRevision,
      operation,
      input.commandId,
      binding,
      {
        reasonCode: input.reasonCode,
        gatewayHost: gateway.hostname,
        authorizationRevision: nextRevision,
        attestedModelCount: attestation.matchedModels.length
      },
      now
    )
  ]);
  const rotated = await db.prepare(
    `SELECT status, authorization_revision, gateway_token_digest,
      EXISTS (
        SELECT 1 FROM idempotency_keys
        WHERE tenant_id = ? AND operation = 'authorization.rotate-credential'
          AND idempotency_key = ? AND resource_id = ?
      ) AS command_bound
     FROM authorization_requests WHERE request_id = ? AND tenant_id = ? AND supplier_id = ?`
  ).bind(
    identity.tenantId,
    input.commandId,
    binding,
    requestId,
    identity.tenantId,
    supplier.supplier_id
  ).first<{
    status: string;
    authorization_revision: number;
    gateway_token_digest: string | null;
    command_bound: number;
  }>();
  if (
    rotated?.status !== "approved" || rotated.authorization_revision !== nextRevision ||
    rotated.gateway_token_digest !== activeLookup.digest || rotated.command_bound !== 1
  ) {
    throw new ApiError("GATEWAY_CREDENTIAL_CONFLICT", "授权在凭据换发期间发生变化。", 409, true);
  }
  return getDashboard(identity);
}

export async function createCapacityOffer(
  identity: RequestIdentity,
  input: CreateCapacityOfferRequest
): Promise<MarketplaceDashboardSnapshot> {
  await ensureSchema();
  assertExactKeys(input, [
    "commandId",
    "authorizationRequestId",
    "model",
    "dataClasses",
    "limits",
    "priceMicrosPerMillionTokens",
    "validUntil"
  ]);
  assertIdentifier(input.commandId, "commandId");
  assertIdentifier(input.authorizationRequestId, "authorizationRequestId");
  assertText(input.model, "model", 120);
  assertDataClasses(input.dataClasses);
  assertLimits(input.limits);
  assertPositiveIntegerString(input.priceMicrosPerMillionTokens, "priceMicrosPerMillionTokens");
  const normalizedModel = input.model.trim();
  const normalizedDataClasses = [...input.dataClasses].sort() as Array<"P0" | "P1">;
  const normalizedPrice = BigInt(input.priceMicrosPerMillionTokens).toString();
  const normalizedValidUntil = normalizeUtcTimestamp(input.validUntil, "validUntil");
  const binding = capacityOfferCommandBinding({
    authorizationRequestId: input.authorizationRequestId,
    model: normalizedModel,
    dataClasses: normalizedDataClasses,
    limits: input.limits,
    priceMicrosPerMillionTokens: normalizedPrice,
    validUntil: normalizedValidUntil
  });
  const prior = await readIdempotency(identity.tenantId, "offer.create", input.commandId);
  if (prior) {
    if (prior !== binding) {
      throw new ApiError("CONFLICT", "该报价命令已绑定到其他规范化请求。", 409);
    }
    return getDashboard(identity);
  }
  const validUntil = assertFutureTimestamp(normalizedValidUntil, "validUntil");
  await enforceTenantRateLimit(identity, "offer.create", 30, 60 * 60_000);

  const db = getD1();
  const supplier = await requireSupplierRow(identity);
  const authorization = await db
    .prepare(
      `SELECT * FROM authorization_requests
       WHERE request_id = ? AND tenant_id = ? AND supplier_id = ? AND status = 'approved'`
    )
    .bind(input.authorizationRequestId, identity.tenantId, supplier.supplier_id)
    .first<AuthorizationRow>();
  if (!authorization) throw new ApiError("AUTHORIZATION_REQUIRED", "需要已审核通过的授权。", 409);

  const supplierEvents = await readSupplierEvents(identity.tenantId, supplier.supplier_id);
  const supplierState = rehydrateSupplier(supplierEvents);
  if (!supplierState) throw new ApiError("SUPPLIER_REQUIRED", "供应商状态不存在。", 409);
  const now = new Date().toISOString();
  const offerId = `offer-${crypto.randomUUID()}`;
  const event = mapDomainError(() =>
    publishCapacityOffer(
      supplierState,
      {
        offerId,
        authorizationId: `authorization-${authorization.request_id}`,
        providerId: authorization.provider_id,
        model: normalizedModel,
        regionCode: authorization.region_code,
        dataClasses: normalizedDataClasses,
        limits: input.limits,
        currency: "CNY",
        rates: [{ unit: "million_tokens", amountMicros: normalizedPrice }],
        validFrom: now,
        validUntil: validUntil.toISOString()
      },
      commandContext(identity, input.commandId, now)
    )
  );

  await db.batch([
    db
      .prepare(CREATE_CAPACITY_OFFER_WITH_AUTHORIZATION_CAS_SQL)
      .bind(
        offerId,
        identity.tenantId,
        supplier.supplier_id,
        authorization.request_id,
        authorization.provider_id,
        authorization.source_type,
        normalizedModel,
        authorization.region_code,
        JSON.stringify(normalizedDataClasses),
        input.limits.requestsPerMinute,
        input.limits.tokensPerMinute,
        input.limits.concurrency,
        input.limits.maxOutputTokens,
        normalizedPrice,
        now,
        validUntil.toISOString(),
        now,
        now,
        authorization.request_id,
        identity.tenantId,
        supplier.supplier_id,
        authorization.authorization_revision,
        now,
        validUntil.toISOString(),
        supplier.version,
        identity.tenantId,
        input.commandId
      ),
    guardedCapacityOfferEventInsert(db, event, offerId, identity.tenantId),
    guardedCapacityOfferAuditInsert(db, identity, offerId, {
      model: normalizedModel,
      authorizationRequestId: authorization.request_id
    }, now),
    db.prepare(BIND_CAPACITY_OFFER_COMMAND_SQL).bind(
      identity.tenantId, input.commandId, binding, now,
      offerId, identity.tenantId, supplier.supplier_id
    )
  ]);

  const committedOffer = await readIdempotency(identity.tenantId, "offer.create", input.commandId);
  if (!committedOffer) {
    throw new ApiError("AUTHORIZATION_STATE_CONFLICT", "授权在报价发布期间发生变化。", 409, true);
  }
  if (committedOffer !== binding) {
    throw new ApiError("CONFLICT", "该报价命令已绑定到其他规范化请求。", 409);
  }

  return getDashboard(identity);
}

export async function setSupplyState(
  identity: RequestIdentity,
  input: SetSupplyRequest
): Promise<MarketplaceDashboardSnapshot> {
  await ensureSchema();
  assertExactKeys(input, ["commandId", "enabled"]);
  assertIdentifier(input.commandId, "commandId");
  if (typeof input.enabled !== "boolean") throw new ApiError("INVALID_REQUEST", "enabled 必须是布尔值。", 400);
  const prior = await readIdempotency(identity.tenantId, "supply.set", input.commandId);
  if (prior) return getDashboard(identity);
  await enforceTenantRateLimit(identity, "supply.set", 60, 60 * 60_000);
  const db = getD1();
  const supplier = await requireSupplierRow(identity);
  if (input.enabled && supplier.status !== "active") {
    throw new ApiError("SUPPLIER_NOT_ACTIVE", "审核通过后才能开启供应。", 409);
  }
  const now = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE suppliers SET supply_enabled = ?, updated_at = ?
         WHERE supplier_id = ? AND tenant_id = ? AND (
           ? = 0 OR EXISTS (
             SELECT 1 FROM authorization_requests
             WHERE tenant_id = ? AND supplier_id = ? AND status = 'approved' AND valid_until > ?
               AND encrypted_gateway_token <> '' AND gateway_token_iv <> ''
               AND gateway_token_digest IS NOT NULL
           )
         )`
      )
      .bind(
        input.enabled ? 1 : 0,
        now,
        supplier.supplier_id,
        identity.tenantId,
        input.enabled ? 1 : 0,
        identity.tenantId,
        supplier.supplier_id,
        now
      ),
    db.prepare(
      `INSERT INTO audit_events (
        audit_id, tenant_id, actor_id, action, resource_type, resource_id, details_json, occurred_at
      ) SELECT ?, ?, ?, ?, 'supplier', ?, '{}', ?
        WHERE EXISTS (
          SELECT 1 FROM suppliers
          WHERE supplier_id = ? AND tenant_id = ? AND supply_enabled = ?
        )`
    ).bind(
      `audit-${crypto.randomUUID()}`,
      identity.tenantId,
      identity.actorId,
      input.enabled ? "supply.enabled" : "supply.disabled",
      supplier.supplier_id,
      now,
      supplier.supplier_id,
      identity.tenantId,
      input.enabled ? 1 : 0
    ),
    db.prepare(
      `INSERT INTO idempotency_keys (
        tenant_id, operation, idempotency_key, resource_id, created_at
      ) SELECT ?, 'supply.set', ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM suppliers
          WHERE supplier_id = ? AND tenant_id = ? AND supply_enabled = ?
        )`
    ).bind(
      identity.tenantId,
      input.commandId,
      supplier.supplier_id,
      now,
      supplier.supplier_id,
      identity.tenantId,
      input.enabled ? 1 : 0
    )
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new ApiError("AUTHORIZATION_REQUIRED", "至少需要一条当前有效授权才能开启供应。", 409);
  }
  return getDashboard(identity);
}

export async function runInference(
  identity: RequestIdentity,
  input: RunInferenceRequest,
  idempotencyKey: string,
  requestId: string
): Promise<RunInferenceResponse> {
  await ensureSchema();
  await ensureUser(identity);
  await cleanupStaleInferenceReservations();
  await cleanupExpiredInferenceContent();
  assertExactKeys(input, [
    "model", "input", "dataClass", "maxOutputTokens", "privacyMode",
    "supplierProcessingAcknowledged"
  ]);
  validateInferenceInput(input);
  assertIdempotencyKey(idempotencyKey);
  const db = getD1();

  const existing = await readInferenceForReplay(identity.tenantId, idempotencyKey);
  if (existing) {
    await assertInferenceIdempotencyMatch(identity.tenantId, existing, input);
    return replayInference(existing, requestId);
  }

  const policy = getMarketplaceRuntimePolicy();
  await enforceTenantRateLimit(identity, "inference.run", policy.inferenceRequestsPerMinute, 60_000);

  const now = new Date().toISOString();
  const offer = await selectOffer(identity.tenantId, input, now);
  const authorizationRevision = requiredPositiveInteger(
    offer.authorization_revision,
    "authorizationRevision"
  );
  const estimatedInputTokens = Math.max(1, new TextEncoder().encode(input.input).byteLength);
  const estimatedCharge = estimateMaximumChargeMicros({
    estimatedInputTokens: estimatedInputTokens + 256,
    maxOutputTokens: input.maxOutputTokens,
    priceMicrosPerMillionTokens: offer.price_micros_per_million_tokens
  });

  const jobId = `job-${crypto.randomUUID()}`;
  const inputSha256 = await sha256Hex(input.input);
  const inputCommitment = await createDigestCommitment(inputSha256, {
    purpose: "prompt",
    tenantId: identity.tenantId,
    resourceId: jobId
  });
  const reservationExpiresAt = new Date(
    Date.now() + policy.inferenceReservationTimeoutSeconds * 1_000
  ).toISOString();
  const reservation = await db
    .prepare(RESERVE_INFERENCE_JOB_SQL)
    .bind(
      jobId,
      identity.tenantId,
      offer.supplier_tenant_id,
      offer.offer_id,
      offer.authorization_request_id,
      authorizationRevision,
      idempotencyKey,
      input.model,
      input.dataClass,
      input.privacyMode,
      inputCommitment.digest,
      inputCommitment.version,
      input.maxOutputTokens,
      estimatedCharge,
      reservationExpiresAt,
      now,
      identity.tenantId,
      identity.tenantId,
      identity.tenantId,
      estimatedCharge,
      offer.offer_id,
      offer.authorization_request_id,
      authorizationRevision,
      offer.supplier_tenant_id,
      identity.tenantId,
      now,
      now,
      now,
      offer.offer_id,
      offer.offer_id,
      offer.concurrency
    )
    .run();
  if ((reservation.meta.changes ?? 0) !== 1) {
    const raced = await readInferenceForReplay(identity.tenantId, idempotencyKey);
    if (raced) {
      await assertInferenceIdempotencyMatch(identity.tenantId, raced, input);
      return replayInference(raced, requestId);
    }
    if ((await readBalanceMicros(identity.tenantId)) < BigInt(estimatedCharge)) {
      throw new ApiError("INSUFFICIENT_BALANCE", "试运营余额不足以覆盖本次请求的最大费用。", 402);
    }
    throw new ApiError("CAPACITY_UNAVAILABLE", "所选容量刚刚被占用，请稍后重试。", 409, true);
  }

  const started = await db
    .prepare(
      "UPDATE inference_jobs SET status = 'running' WHERE job_id = ? AND status = 'reserved' AND reservation_expires_at > ?"
    )
    .bind(jobId, now)
    .run();
  if ((started.meta.changes ?? 0) !== 1) {
    throw new ApiError("CAPACITY_UNAVAILABLE", "请求预留已过期，请使用新的幂等键重试。", 409, true);
  }

  try {
    const gateway = validateGatewayEndpoint(requiredText(offer.gateway_endpoint, "gatewayEndpoint"), true);
    const token = await decryptCredential(
      requiredText(offer.encrypted_gateway_token, "encryptedGatewayToken"),
      requiredText(offer.gateway_token_iv, "gatewayTokenIv"),
      offer.encryption_key_version ?? 1,
      requiredText(offer.credential_key_id, "credentialKeyId"),
      {
        tenantId: offer.tenant_id,
        authorizationRequestId: offer.authorization_request_id
      }
    );
    const gatewayResult = await callGateway(gateway, token, jobId, offer.provider_id, inputSha256, input);
    if (gatewayResult.usage.inputTokens > estimatedInputTokens + 256) {
      throw new ApiError("GATEWAY_FAILED", "供应网关返回了超出请求边界的输入计量。", 502);
    }
    if (gatewayResult.usage.outputTokens > input.maxOutputTokens) {
      throw new ApiError("GATEWAY_FAILED", "供应网关返回了超出约定上限的输出计量。", 502);
    }

    const settlement = calculateSettlement({
      totalTokens: gatewayResult.usage.totalTokens,
      priceMicrosPerMillionTokens: offer.price_micros_per_million_tokens,
      platformFeeBps: policy.platformFeeBps
    });
    if (BigInt(settlement.buyerChargeMicros) > BigInt(estimatedCharge)) {
      throw new ApiError("GATEWAY_FAILED", "最终计量超过请求预留上限，平台已阻止记账。", 502);
    }
    const outputEncrypted = await encryptContent(gatewayResult.output, {
      purpose: "inference-output",
      tenantId: identity.tenantId,
      resourceId: jobId
    });
    const completedAt = new Date().toISOString();
    const outputExpiresAt = new Date(
      Date.now() + outputRetentionMilliseconds(input.privacyMode, policy)
    ).toISOString();
    const usageId = `usage-${crypto.randomUUID()}`;
    const serviceProof = {
      assurance: gatewayResult.evidence.assurance,
      providerId: gatewayResult.evidence.providerId,
      requestedModel: gatewayResult.evidence.requestedModel,
      servedModel: gatewayResult.evidence.servedModel,
      providerRequestId: gatewayResult.evidence.providerRequestId,
      unitPriceMicrosPerMillionTokens: offer.price_micros_per_million_tokens,
      buyerChargeMicros: settlement.buyerChargeMicros,
      evidenceDigest: gatewayResult.evidence.evidenceDigest,
      completedAt: gatewayResult.evidence.completedAt
    } as const;
    const outputCommitment = await createDigestCommitment(gatewayResult.evidence.outputSha256, {
      purpose: "inference-output",
      tenantId: identity.tenantId,
      resourceId: jobId
    });
    const statements = [
      db
        .prepare(COMPLETE_INFERENCE_JOB_SQL)
        .bind(
          gatewayResult.providerRequestId,
          gatewayResult.usage.inputTokens,
          gatewayResult.usage.outputTokens,
          gatewayResult.usage.totalTokens,
          settlement.buyerChargeMicros,
          outputEncrypted.ciphertext,
          outputEncrypted.iv,
          outputEncrypted.keyVersion,
          outputExpiresAt,
          completedAt,
          jobId,
          settlement.buyerChargeMicros,
          identity.tenantId,
          identity.tenantId,
          jobId,
          identity.tenantId,
          settlement.buyerChargeMicros
        ),
      db
        .prepare(
          `INSERT INTO usage_records (
            usage_id, job_id, buyer_tenant_id, supplier_tenant_id, offer_id, provider_request_id,
            input_tokens, output_tokens, total_tokens, receipt_ref, occurred_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM inference_jobs
              WHERE job_id = ? AND status = 'completed' AND completed_at = ?
            )`
        )
        .bind(
          usageId,
          jobId,
          identity.tenantId,
          offer.supplier_tenant_id,
          offer.offer_id,
          gatewayResult.providerRequestId,
          gatewayResult.usage.inputTokens,
          gatewayResult.usage.outputTokens,
          gatewayResult.usage.totalTokens,
          gatewayResult.receiptRef,
          completedAt,
          jobId,
          completedAt
        ),
      db
        .prepare(
          `INSERT INTO service_evidence (
            evidence_id, job_id, offer_id, provider_id, requested_model, served_model,
            provider_request_id, assurance, evidence_digest, input_digest, output_digest, digest_version,
            input_tokens, output_tokens, total_tokens, unit_price_micros_per_million_tokens,
            buyer_charge_micros, supplier_credit_micros, platform_fee_micros, receipt_ref,
            provider_completed_at, recorded_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM inference_jobs
              WHERE job_id = ? AND status = 'completed' AND completed_at = ? AND charge_micros = ?
            )`
        )
        .bind(
          `evidence-${crypto.randomUUID()}`,
          jobId,
          offer.offer_id,
          gatewayResult.evidence.providerId,
          gatewayResult.evidence.requestedModel,
          gatewayResult.evidence.servedModel,
          gatewayResult.evidence.providerRequestId,
          gatewayResult.evidence.assurance,
          gatewayResult.evidence.evidenceDigest,
          inputCommitment.digest,
          outputCommitment.digest,
          inputCommitment.version,
          gatewayResult.evidence.usage.input_tokens,
          gatewayResult.evidence.usage.output_tokens,
          gatewayResult.evidence.usage.total_tokens,
          offer.price_micros_per_million_tokens,
          settlement.buyerChargeMicros,
          settlement.supplierCreditMicros,
          settlement.platformFeeMicros,
          gatewayResult.evidence.receiptRef,
          gatewayResult.evidence.completedAt,
          completedAt,
          jobId,
          completedAt,
          settlement.buyerChargeMicros
        ),
      guardedInferenceLedgerInsert(db, identity.tenantId, `buyer-${identity.tenantId}`, jobId, "inference-debit", "debit", settlement.buyerChargeMicros, completedAt, gatewayResult.evidence.evidenceDigest),
      guardedInferenceLedgerInsert(db, offer.supplier_tenant_id!, `supplier-${offer.supplier_tenant_id}`, jobId, "supplier-credit", "credit", settlement.supplierCreditMicros, completedAt, gatewayResult.evidence.evidenceDigest),
      guardedInferenceAuditInsert(db, identity, jobId, {
        offerId: offer.offer_id,
        providerId: gatewayResult.evidence.providerId,
        requestedModel: gatewayResult.evidence.requestedModel,
        servedModel: gatewayResult.evidence.servedModel,
        assurance: gatewayResult.evidence.assurance,
        evidenceDigest: gatewayResult.evidence.evidenceDigest,
        totalTokens: gatewayResult.usage.totalTokens,
        chargeMicros: settlement.buyerChargeMicros
      }, completedAt, gatewayResult.evidence.evidenceDigest)
    ];
    if (settlement.platformFeeMicros !== "0") {
      statements.push(
        guardedInferenceLedgerInsert(db, "platform", "platform-fees", jobId, "platform-fee", "credit", settlement.platformFeeMicros, completedAt, gatewayResult.evidence.evidenceDigest)
      );
    }
    await db.batch(statements);
    const committed = await db.prepare(
      `SELECT j.status, se.evidence_digest FROM inference_jobs j
       LEFT JOIN service_evidence se ON se.job_id = j.job_id WHERE j.job_id = ?`
    ).bind(jobId).first<{ status: string; evidence_digest: string | null }>();
    if (committed?.status !== "completed" || committed.evidence_digest !== gatewayResult.evidence.evidenceDigest) {
      throw new ApiError("INSUFFICIENT_BALANCE", "预留已失效或可用余额不足，平台未写入任何结算记录。", 409);
    }

    return {
      ok: true,
      requestId,
      output: gatewayResult.output,
      usage: gatewayResult.usage,
      serviceProof,
      job: {
        jobId,
        offerId: offer.offer_id,
        model: input.model,
        privacyMode: input.privacyMode,
        status: "completed",
        totalTokens: gatewayResult.usage.totalTokens,
        chargeMicros: settlement.buyerChargeMicros,
        errorCode: null,
        serviceProof,
        contentExpiresAt: outputExpiresAt,
        contentPurgedAt: null,
        createdAt: now,
        completedAt
      }
    };
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "GATEWAY_FAILED";
    await db
      .prepare(
        `UPDATE inference_jobs SET status = 'failed', reservation_expires_at = NULL,
         error_code = ?, completed_at = ? WHERE job_id = ? AND status IN ('reserved', 'running')`
      )
      .bind(code, new Date().toISOString(), jobId)
      .run();
    throw error;
  }
}

async function ensureUser(identity: RequestIdentity): Promise<void> {
  const db = getD1();
  const now = new Date().toISOString();
  // Authentication owns the account profile. The marketplace only needs the
  // opaque user id for account continuity, so do not duplicate email or name
  // in D1. Updating the sentinel values also scrubs legacy rows on next login.
  const privateEmail = "redacted@identity.invalid";
  const privateDisplayName = "平台成员";
  await db.batch([
    db
      .prepare("INSERT OR IGNORE INTO users (user_id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(identity.user.userId, privateEmail, privateDisplayName, now, now),
    db
      .prepare("UPDATE users SET email = ?, display_name = ?, updated_at = ? WHERE user_id = ?")
      .bind(privateEmail, privateDisplayName, now, identity.user.userId),
    db
      .prepare(
        `INSERT OR IGNORE INTO ledger_entries (
          entry_id, tenant_id, account_id, job_id, entry_type, direction, amount_micros, currency, created_at
        ) VALUES (?, ?, ?, NULL, 'promotional-credit', 'credit', ?, 'CNY', ?)`
      )
      .bind(
        `welcome-${identity.tenantId}`,
        identity.tenantId,
        `buyer-${identity.tenantId}`,
        getMarketplaceRuntimePolicy().welcomeCreditMicros,
        now
      )
  ]);
}

async function requireSupplierRow(identity: RequestIdentity): Promise<SupplierRow> {
  const supplier = await getD1()
    .prepare("SELECT * FROM suppliers WHERE tenant_id = ? AND user_id = ?")
    .bind(identity.tenantId, identity.user.userId)
    .first<SupplierRow>();
  if (!supplier) throw new ApiError("SUPPLIER_REQUIRED", "请先完成供应商注册。", 409);
  return supplier;
}

async function readSupplierEvents(tenantId: string, supplierId: string): Promise<SupplierEvent[]> {
  const result = await getD1()
    .prepare(
      `SELECT * FROM marketplace_events
       WHERE tenant_id = ? AND aggregate_type = 'supplier' AND aggregate_id = ?
       ORDER BY aggregate_version ASC`
    )
    .bind(tenantId, supplierId)
    .all<EventRow>();
  return result.results.map((row) => ({
    schemaVersion: row.schema_version,
    eventId: row.event_id,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    causationId: row.causation_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    occurredAt: row.occurred_at,
    type: row.event_type,
    payload: JSON.parse(row.payload_json) as never
  })) as SupplierEvent[];
}

async function withdrawPendingAuthorization(
  identity: RequestIdentity,
  supplier: SupplierRow,
  request: AuthorizationRow,
  input: RevokeAuthorizationRequest,
  binding: string,
  now: string
): Promise<void> {
  const db = getD1();
  const operation = "authorization.withdraw";
  const operationToken = `authorization-withdraw-op-${crypto.randomUUID()}`;
  const targetKey = `${request.request_id}:${request.authorization_revision}`;
  const nextRevision = request.authorization_revision + 1;
  await db.batch([
    lifecycleTargetClaim(
      db, identity, supplier, request, operation, input.commandId,
      binding, operationToken, targetKey, now
    ),
    lifecycleCommandBinding(
      db, identity.tenantId, operation, input.commandId,
      binding, targetKey, operationToken, now
    ),
    db.prepare(WITHDRAW_PENDING_AUTHORIZATION_SQL).bind(
      now,
      input.reasonCode,
      now,
      request.request_id,
      identity.tenantId,
      supplier.supplier_id,
      request.authorization_revision,
      targetKey,
      operationToken,
      identity.tenantId,
      input.commandId,
      binding
    ),
    guardedAuthorizationLifecycleAuditInsert(
      db,
      identity,
      "authorization.withdrawn",
      request.request_id,
      "withdrawn",
      nextRevision,
      operation,
      input.commandId,
      binding,
      { reasonCode: input.reasonCode, authorizationRevision: nextRevision },
      now
    )
  ]);
  const withdrawn = await db.prepare(
    `SELECT status, authorization_revision, encrypted_gateway_token, gateway_token_iv,
      EXISTS (
        SELECT 1 FROM idempotency_keys
        WHERE tenant_id = ? AND operation = 'authorization.withdraw'
          AND idempotency_key = ? AND resource_id = ?
      ) AS command_bound,
      gateway_token_digest FROM authorization_requests
     WHERE request_id = ? AND tenant_id = ? AND supplier_id = ?`
  ).bind(
    identity.tenantId,
    input.commandId,
    binding,
    request.request_id,
    identity.tenantId,
    supplier.supplier_id
  ).first<{
    status: string;
    authorization_revision: number;
    encrypted_gateway_token: string;
    gateway_token_iv: string;
    gateway_token_digest: string | null;
    command_bound: number;
  }>();
  if (
    withdrawn?.status !== "withdrawn" || withdrawn.authorization_revision !== nextRevision ||
    withdrawn.encrypted_gateway_token !== "" || withdrawn.gateway_token_iv !== "" ||
    withdrawn.gateway_token_digest !== null || withdrawn.command_bound !== 1
  ) {
    throw new ApiError("AUTHORIZATION_STATE_CONFLICT", "授权申请在撤回期间发生变化。", 409, true);
  }
}

async function revokeApprovedAuthorization(
  identity: RequestIdentity,
  supplier: SupplierRow,
  request: AuthorizationRow,
  input: RevokeAuthorizationRequest,
  binding: string,
  now: string
): Promise<void> {
  const history = await readSupplierEvents(identity.tenantId, supplier.supplier_id);
  const state = rehydrateSupplier(history);
  if (!state || state.version !== supplier.version) {
    throw new ApiError("AUTHORIZATION_STATE_CONFLICT", "供应商聚合状态已变化，请重试。", 409, true);
  }
  const event = mapDomainError(() => revokeProviderAuthorization(
    state,
    {
      authorizationId: `authorization-${request.request_id}`,
      reasonCode: input.reasonCode
    },
    commandContext(identity, input.commandId, now)
  ));
  const db = getD1();
  const operation = "authorization.revoke";
  const operationToken = `authorization-revoke-op-${crypto.randomUUID()}`;
  const targetKey = `${request.request_id}:${request.authorization_revision}`;
  const nextRevision = request.authorization_revision + 1;
  await db.batch([
    lifecycleTargetClaim(
      db, identity, supplier, request, operation, input.commandId,
      binding, operationToken, targetKey, now
    ),
    lifecycleCommandBinding(
      db, identity.tenantId, operation, input.commandId,
      binding, targetKey, operationToken, now
    ),
    db.prepare(REVOKE_ACTIVE_AUTHORIZATION_SQL).bind(
      now,
      input.reasonCode,
      now,
      request.request_id,
      identity.tenantId,
      supplier.supplier_id,
      now,
      request.authorization_revision,
      supplier.supplier_id,
      identity.tenantId,
      supplier.version,
      targetKey,
      operationToken,
      identity.tenantId,
      input.commandId,
      binding
    ),
    db.prepare(UPDATE_SUPPLIER_AFTER_AUTHORIZATION_REVOCATION_SQL).bind(
      event.aggregateVersion,
      now,
      now,
      supplier.supplier_id,
      identity.tenantId,
      supplier.version,
      request.request_id,
      identity.tenantId,
      supplier.supplier_id,
      nextRevision
    ),
    guardedAuthorizationLifecycleEventInsert(
      db,
      event,
      request.request_id,
      nextRevision,
      event.aggregateVersion,
      targetKey,
      operationToken
    ),
    db.prepare(FAIL_RESERVED_INFERENCE_FOR_REVOKED_AUTHORIZATION_SQL).bind(
      now,
      request.request_id,
      request.request_id,
      request.request_id,
      request.request_id,
      nextRevision
    ),
    db.prepare(FAIL_QUEUED_ARTIFACTS_FOR_REVOKED_AUTHORIZATION_SQL).bind(
      now,
      now,
      request.request_id,
      request.request_id,
      nextRevision
    ),
    db.prepare(CANCEL_LEASED_ARTIFACTS_FOR_REVOKED_AUTHORIZATION_SQL).bind(
      now,
      now,
      request.request_id,
      request.request_id,
      nextRevision
    ),
    db.prepare(DELETE_AGENT_HEARTBEAT_AFTER_AUTHORIZATION_REVOCATION_SQL).bind(
      identity.tenantId,
      request.request_id,
      identity.tenantId,
      supplier.supplier_id,
      nextRevision
    ),
    guardedAuthorizationLifecycleAuditInsert(
      db,
      identity,
      "authorization.revoked",
      request.request_id,
      "revoked",
      nextRevision,
      operation,
      input.commandId,
      binding,
      { reasonCode: input.reasonCode, authorizationRevision: nextRevision },
      now,
      event.eventId
    )
  ]);
  const revoked = await db.prepare(
    `SELECT ar.status, ar.authorization_revision, ar.encrypted_gateway_token,
      ar.gateway_token_iv, ar.gateway_token_digest, s.version AS supplier_version,
      EXISTS (
        SELECT 1 FROM idempotency_keys
        WHERE tenant_id = ? AND operation = 'authorization.revoke'
          AND idempotency_key = ? AND resource_id = ?
      ) AS command_bound
     FROM authorization_requests ar
     JOIN suppliers s ON s.supplier_id = ar.supplier_id AND s.tenant_id = ar.tenant_id
     WHERE ar.request_id = ? AND ar.tenant_id = ? AND ar.supplier_id = ?`
  ).bind(
    identity.tenantId,
    input.commandId,
    binding,
    request.request_id,
    identity.tenantId,
    supplier.supplier_id
  ).first<{
    status: string;
    authorization_revision: number;
    encrypted_gateway_token: string;
    gateway_token_iv: string;
    gateway_token_digest: string | null;
    supplier_version: number;
    command_bound: number;
  }>();
  if (
    revoked?.status !== "revoked" || revoked.authorization_revision !== nextRevision ||
    revoked.encrypted_gateway_token !== "" || revoked.gateway_token_iv !== "" ||
    revoked.gateway_token_digest !== null || revoked.supplier_version !== event.aggregateVersion ||
    revoked.command_bound !== 1
  ) {
    throw new ApiError("AUTHORIZATION_STATE_CONFLICT", "授权在撤销期间发生变化。", 409, true);
  }
}

function lifecycleTargetClaim(
  db: D1Database,
  identity: RequestIdentity,
  supplier: SupplierRow,
  request: AuthorizationRow,
  operation: string,
  commandId: string,
  binding: string,
  operationToken: string,
  targetKey: string,
  now: string
): D1PreparedStatement {
  return db.prepare(CLAIM_AUTHORIZATION_LIFECYCLE_TARGET_SQL).bind(
    targetKey,
    operationToken,
    now,
    request.request_id,
    identity.tenantId,
    supplier.supplier_id,
    request.status,
    request.authorization_revision,
    supplier.version,
    identity.tenantId,
    operation,
    commandId,
    binding
  );
}

function lifecycleCommandBinding(
  db: D1Database,
  tenantId: string,
  operation: string,
  commandId: string,
  binding: string,
  targetKey: string,
  operationToken: string,
  now: string
): D1PreparedStatement {
  return db.prepare(BIND_AUTHORIZATION_LIFECYCLE_COMMAND_SQL).bind(
    tenantId,
    operation,
    commandId,
    binding,
    now,
    targetKey,
    operationToken
  );
}

function guardedAuthorizationLifecycleEventInsert(
  db: D1Database,
  event: SupplierEvent,
  requestId: string,
  authorizationRevision: number,
  supplierVersion: number,
  targetKey: string,
  operationToken: string
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO marketplace_events (
      event_id, tenant_id, actor_id, causation_id, aggregate_type, aggregate_id,
      aggregate_version, event_type, schema_version, payload_json, occurred_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM authorization_requests
        WHERE request_id = ? AND status = 'revoked' AND authorization_revision = ?
      ) AND EXISTS (
        SELECT 1 FROM suppliers
        WHERE supplier_id = ? AND tenant_id = ? AND version = ?
      ) AND EXISTS (
        SELECT 1 FROM idempotency_keys
        WHERE tenant_id = 'platform' AND operation = 'authorization.lifecycle-target'
          AND idempotency_key = ? AND resource_id = ?
      )`
  ).bind(
    event.eventId,
    event.tenantId,
    event.actorId,
    event.causationId,
    event.aggregateType,
    event.aggregateId,
    event.aggregateVersion,
    event.type,
    event.schemaVersion,
    JSON.stringify(event.payload),
    event.occurredAt,
    requestId,
    authorizationRevision,
    event.aggregateId,
    event.tenantId,
    supplierVersion,
    targetKey,
    operationToken
  );
}

function guardedAuthorizationLifecycleAuditInsert(
  db: D1Database,
  identity: RequestIdentity,
  action: "authorization.withdrawn" | "authorization.revoked" | "authorization.credential-rotated",
  requestId: string,
  status: "withdrawn" | "revoked" | "approved",
  authorizationRevision: number,
  operation: string,
  commandId: string,
  binding: string,
  details: Record<string, unknown>,
  occurredAt: string,
  requiredEventId?: string
): D1PreparedStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO audit_events (
      audit_id, tenant_id, actor_id, action, resource_type, resource_id, details_json, occurred_at
    ) SELECT ?, ?, ?, ?, 'authorization-request', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM authorization_requests
        WHERE request_id = ? AND tenant_id = ? AND status = ? AND authorization_revision = ?
      ) AND EXISTS (
        SELECT 1 FROM idempotency_keys
        WHERE tenant_id = ? AND operation = ? AND idempotency_key = ? AND resource_id = ?
      ) AND (? IS NULL OR EXISTS (
        SELECT 1 FROM marketplace_events WHERE event_id = ? AND tenant_id = ?
      ))`
  ).bind(
    `audit-authorization-lifecycle-${identity.tenantId}-${operation}-${commandId}`,
    identity.tenantId,
    identity.actorId,
    action,
    requestId,
    JSON.stringify(details),
    occurredAt,
    requestId,
    identity.tenantId,
    status,
    authorizationRevision,
    identity.tenantId,
    operation,
    commandId,
    binding,
    requiredEventId ?? null,
    requiredEventId ?? null,
    identity.tenantId
  );
}

async function buildApprovalEvents(
  admin: RequestIdentity,
  request: AuthorizationRow,
  commandId: string,
  now: string
): Promise<SupplierEvent[]> {
  let history = await readSupplierEvents(request.tenant_id, request.supplier_id);
  let state = rehydrateSupplier(history);
  if (!state) throw new ApiError("SUPPLIER_REQUIRED", "授权申请对应的供应商不存在。", 409);
  const events: SupplierEvent[] = [];
  let index = 0;

  for (const kind of requiredVerificationKinds(state.kind)) {
    if (state.verifications.some((verification) => verification.kind === kind && verification.status === "verified")) continue;
    index += 1;
    const event = mapDomainError(() =>
      recordSupplierVerification(
        state!,
        {
          verificationId: `verification-${request.request_id}-${kind}`,
          kind,
          status: "verified",
          evidenceRef: `${request.evidence_ref}-${kind}`,
          completedAt: now,
          expiresAt: request.valid_until
        },
        commandContextForTenant(request.tenant_id, admin.actorId, `${commandId}-verification-${index}`, now)
      )
    );
    events.push(event);
    history = [...history, event];
    state = rehydrateSupplier(history)!;
  }

  index += 1;
  const authorizationEvent = mapDomainError(() =>
    recordProviderAuthorization(
      state!,
      {
        authorizationId: `authorization-${request.request_id}`,
        providerId: request.provider_id,
        sourceType: request.source_type,
        authorizedUse: "inference-resale",
        meteringMode: request.metering_mode,
        evidenceRef: request.evidence_ref,
        modelPatterns: [request.model_pattern],
        regionCodes: [request.region_code],
        allowedDataClasses: parseDataClasses(request.data_classes_json),
        capacityCeiling: {
          requestsPerMinute: request.requests_per_minute,
          tokensPerMinute: request.tokens_per_minute,
          concurrency: request.concurrency,
          maxOutputTokens: request.max_output_tokens
        },
        validFrom: now,
        validUntil: request.valid_until,
        status: "active"
      },
      commandContextForTenant(request.tenant_id, admin.actorId, `${commandId}-authorization-${index}`, now)
    )
  );
  events.push(authorizationEvent);
  history = [...history, authorizationEvent];
  state = rehydrateSupplier(history)!;

  if (state.status === "pending-verification") {
    index += 1;
    const activationEvent = mapDomainError(() =>
      activateSupplier(
        state!,
        commandContextForTenant(request.tenant_id, admin.actorId, `${commandId}-activation-${index}`, now)
      )
    );
    events.push(activationEvent);
  }
  return events;
}

async function selectOffer(buyerTenantId: string, input: RunInferenceRequest, now: string): Promise<OfferRow> {
  const classNeedle = `%\"${input.dataClass}\"%`;
  const offer = await getD1()
    .prepare(
      `SELECT o.*, s.display_name AS supplier_display_name, s.tenant_id AS supplier_tenant_id,
              ar.gateway_endpoint, ar.encrypted_gateway_token, ar.gateway_token_iv,
              ar.credential_key_id, ar.encryption_key_version, ar.authorization_revision
       FROM capacity_offers o
       JOIN suppliers s ON s.supplier_id = o.supplier_id AND s.tenant_id = o.tenant_id
       JOIN authorization_requests ar ON ar.request_id = o.authorization_request_id AND ar.status = 'approved'
       WHERE o.status = 'active' AND o.model = ? AND o.valid_from <= ? AND o.valid_until > ?
         AND ar.valid_until > ? AND o.data_classes_json LIKE ? AND o.max_output_tokens >= ?
         AND s.status = 'active' AND s.supply_enabled = 1 AND s.tenant_id <> ?
         AND (SELECT COALESCE(SUM(total_tokens), 0) FROM usage_records
              WHERE offer_id = o.offer_id AND occurred_at > ?) + ? <= o.tokens_per_minute
       ORDER BY CAST(o.price_micros_per_million_tokens AS INTEGER) ASC, o.created_at ASC
       LIMIT 1`
    )
    .bind(
      input.model,
      now,
      now,
      now,
      classNeedle,
      input.maxOutputTokens,
      buyerTenantId,
      new Date(Date.now() - 60_000).toISOString(),
      input.maxOutputTokens + new TextEncoder().encode(input.input).byteLength
    )
    .first<OfferRow>();
  if (!offer) throw new ApiError("CAPACITY_UNAVAILABLE", "当前没有满足模型、数据等级和容量约束的在线报价。", 409, true);
  return offer;
}

async function callGateway(
  endpoint: URL,
  token: string,
  jobId: string,
  providerId: string,
  inputSha256: string,
  input: RunInferenceRequest
): Promise<{
  output: string;
  providerRequestId: string;
  receiptRef: string | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  evidence: VerifiedGatewayServiceEvidence;
}> {
  const requestStartedAt = new Date().toISOString();
  const rawBody = JSON.stringify({
    protocol_version: SUPPLIER_GATEWAY_PROTOCOL_VERSION,
    request_id: jobId,
    model: input.model,
    input: input.input,
    data_class: input.dataClass,
    max_output_tokens: input.maxOutputTokens,
    stream: false
  });
  const signedHeaders = await createSignedGatewayHeaders(token, jobId, rawBody);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...signedHeaders
      },
      body: rawBody,
      signal: AbortSignal.timeout(60_000)
    });
  } catch {
    throw new ApiError("GATEWAY_FAILED", "供应网关连接失败或超时。", 502, true);
  }
  const maximumResponseBytes = getMarketplaceRuntimePolicy().maximumGatewayResponseBytes;
  const raw = await readBoundedText(response, maximumResponseBytes, () =>
    new ApiError("GATEWAY_FAILED", "供应网关响应超过大小限制。", 502)
  );
  if (!response.ok) throw new ApiError("GATEWAY_FAILED", `供应网关返回 HTTP ${response.status}。`, 502, response.status >= 500);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError("GATEWAY_FAILED", "供应网关响应不是有效 JSON。", 502);
  }
  if (!isRecord(parsed) || !isRecord(parsed.usage)) {
    throw new ApiError("SERVICE_EVIDENCE_FAILED", "供应节点未返回完整的执行凭证。", 502);
  }
  assertGatewayExactKeys(parsed, ["output", "usage", "execution_evidence", "execution_evidence_signature"]);
  assertGatewayExactKeys(parsed.usage, ["input_tokens", "output_tokens", "total_tokens"]);
  const output = requiredBoundedString(parsed.output, "output", 200_000);
  const inputTokens = positiveSafeInteger(parsed.usage.input_tokens, "usage.input_tokens");
  const outputTokens = positiveSafeInteger(parsed.usage.output_tokens, "usage.output_tokens", true);
  const totalTokens = positiveSafeInteger(parsed.usage.total_tokens, "usage.total_tokens");
  if (inputTokens + outputTokens !== totalTokens) {
    throw new ApiError("GATEWAY_FAILED", "供应网关总用量与输入、输出用量不一致。", 502);
  }
  const evidenceSignature = requiredEvidenceString(
    parsed.execution_evidence_signature,
    "execution_evidence_signature",
    256
  );
  const wireUsage: SupplierGatewayUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens
  };
  const evidence = await verifyGatewayServiceEvidence({
    gatewayToken: token,
    requestId: jobId,
    providerId,
    requestedModel: input.model,
    inputSha256,
    output,
    usage: wireUsage,
    evidence: parsed.execution_evidence as SupplierGatewayExecutionEvidence,
    evidenceSignature,
    requestStartedAt
  });
  return {
    output,
    providerRequestId: evidence.providerRequestId,
    receiptRef: evidence.receiptRef,
    usage: { inputTokens, outputTokens, totalTokens },
    evidence
  };
}

async function replayInference(existing: JobRow, requestId: string): Promise<RunInferenceResponse> {
  if (existing.status === "reserved" || existing.status === "running") {
    throw new ApiError("CONFLICT", "相同幂等键的请求仍在处理中。", 409, true);
  }
  if (existing.status === "failed") {
    throw new ApiError("CONFLICT", `相同幂等键的请求此前失败：${existing.error_code ?? "UNKNOWN"}。`, 409);
  }
  if (
    !existing.output_ciphertext ||
    !existing.output_iv ||
    !existing.output_expires_at ||
    existing.output_expires_at <= new Date().toISOString()
  ) {
    throw new ApiError("CONFLICT", existing.content_purged_at
      ? "该请求内容已按用户要求清除，账本与执行凭证仍保留。"
      : "该请求已完成，但结果重放窗口已经结束。", 409);
  }
  const output = await decryptContent(
    existing.output_ciphertext,
    existing.output_iv,
    existing.content_key_version,
    {
      purpose: "inference-output",
      tenantId: requiredText(existing.buyer_tenant_id, "buyerTenantId"),
      resourceId: existing.job_id
    }
  );
  const job = mapJob(existing);
  if (!job.serviceProof) {
    throw new ApiError("CONFLICT", "该历史请求没有价服一致执行凭证，不能作为可计费结果重放。", 409);
  }
  return {
    ok: true,
    requestId,
    output,
    usage: {
      inputTokens: existing.input_tokens ?? 0,
      outputTokens: existing.output_tokens ?? 0,
      totalTokens: existing.total_tokens ?? 0
    },
    serviceProof: job.serviceProof,
    job
  };
}

async function readInferenceForReplay(tenantId: string, idempotencyKey: string): Promise<JobRow | null> {
  return getD1()
    .prepare(
      `SELECT j.*,
        se.provider_id AS proof_provider_id,
        se.requested_model AS proof_requested_model,
        se.served_model AS proof_served_model,
        se.provider_request_id AS proof_provider_request_id,
        se.assurance AS proof_assurance,
        se.evidence_digest AS proof_evidence_digest,
        se.unit_price_micros_per_million_tokens AS proof_unit_price,
        se.buyer_charge_micros AS proof_buyer_charge,
        se.provider_completed_at AS proof_completed_at
       FROM inference_jobs j
       LEFT JOIN service_evidence se ON se.job_id = j.job_id
       WHERE j.buyer_tenant_id = ? AND j.idempotency_key = ?`
    )
    .bind(tenantId, idempotencyKey)
    .first<JobRow>();
}

async function assertInferenceIdempotencyMatch(
  tenantId: string,
  existing: JobRow,
  input: RunInferenceRequest
): Promise<void> {
  const inputSha256 = await sha256Hex(input.input);
  const digestVersion = existing.digest_version ?? 1;
  const expectedDigest = digestVersion === 1
    ? inputSha256
    : digestVersion === 2
      ? (await createDigestCommitment(inputSha256, {
        purpose: "prompt",
        tenantId,
        resourceId: existing.job_id
      })).digest
      : invalidPersistedDigestVersion();
  if (
    existing.prompt_digest !== expectedDigest ||
    existing.model !== input.model ||
    existing.data_class !== input.dataClass ||
    existing.privacy_mode !== input.privacyMode ||
    existing.max_output_tokens !== input.maxOutputTokens
  ) {
    throw new ApiError("CONFLICT", "该幂等键已绑定到不同的推理请求。", 409);
  }
}

function invalidPersistedDigestVersion(): never {
  throw new ApiError("INTERNAL_ERROR", "持久化内容摘要版本不受支持。", 500);
}

async function readUsageSummary(tenantId: string): Promise<MarketplaceDashboardSnapshot["usage"]> {
  const row = await getD1()
    .prepare(
      `SELECT
        ((SELECT COUNT(*) FROM inference_jobs WHERE (buyer_tenant_id = ? OR supplier_tenant_id = ?) AND status = 'completed') +
         (SELECT COUNT(*) FROM artifact_tasks WHERE (buyer_tenant_id = ? OR supplier_tenant_id = ?) AND status = 'completed')) AS completed_jobs,
        ((SELECT COUNT(*) FROM inference_jobs WHERE (buyer_tenant_id = ? OR supplier_tenant_id = ?) AND status = 'failed') +
         (SELECT COUNT(*) FROM artifact_tasks WHERE (buyer_tenant_id = ? OR supplier_tenant_id = ?) AND status = 'failed')) AS failed_jobs,
        (SELECT COALESCE(SUM(total_tokens), 0) FROM usage_records WHERE buyer_tenant_id = ? OR supplier_tenant_id = ?) AS total_tokens,
        (SELECT printf('%lld', COALESCE(SUM(CAST(amount_micros AS INTEGER)), 0)) FROM ledger_entries WHERE tenant_id = ? AND entry_type = 'supplier-credit') AS supplier_earnings,
        (SELECT printf('%lld', COALESCE(SUM(CAST(amount_micros AS INTEGER)), 0)) FROM ledger_entries WHERE tenant_id = ? AND entry_type = 'inference-debit') AS buyer_spend,
        (SELECT printf('%lld', COALESCE(SUM(CASE WHEN direction = 'credit' THEN CAST(amount_micros AS INTEGER) ELSE -CAST(amount_micros AS INTEGER) END), 0))
         FROM ledger_entries WHERE tenant_id = ?) AS balance`
    )
    .bind(
      tenantId, tenantId, tenantId, tenantId,
      tenantId, tenantId, tenantId, tenantId,
      tenantId, tenantId, tenantId, tenantId, tenantId
    )
    .first<{
      completed_jobs: number;
      failed_jobs: number;
      total_tokens: number;
      supplier_earnings: string;
      buyer_spend: string;
      balance: string;
    }>();
  return {
    completedJobs: row?.completed_jobs ?? 0,
    failedJobs: row?.failed_jobs ?? 0,
    totalTokens: row?.total_tokens ?? 0,
    supplierEarningsMicros: row?.supplier_earnings ?? "0",
    buyerSpendMicros: row?.buyer_spend ?? "0",
    promotionalBalanceMicros: row?.balance ?? "0"
  };
}

async function cleanupExpiredInferenceContent(now = new Date().toISOString()): Promise<void> {
  await getD1().prepare(
    `UPDATE inference_jobs SET output_ciphertext = NULL, output_iv = NULL,
       output_expires_at = NULL, content_purged_at = COALESCE(content_purged_at, ?)
     WHERE output_expires_at IS NOT NULL AND output_expires_at <= ?`
  ).bind(now, now).run();
}

async function cleanupStaleInferenceReservations(now = new Date().toISOString()): Promise<void> {
  const legacyReservationCutoff = new Date(
    Date.parse(now) - getMarketplaceRuntimePolicy().inferenceReservationTimeoutSeconds * 1_000
  ).toISOString();
  await getD1().prepare(
    `UPDATE inference_jobs SET status = 'failed', reservation_expires_at = NULL,
       error_code = 'EXECUTION_TIMEOUT', completed_at = ?
     WHERE status IN ('reserved', 'running') AND (
       reservation_expires_at <= ? OR (reservation_expires_at IS NULL AND created_at <= ?)
     )`
  ).bind(now, now, legacyReservationCutoff).run();
}

function outputRetentionMilliseconds(
  privacyMode: MarketplacePrivacyMode,
  policy: ReturnType<typeof getMarketplaceRuntimePolicy>
): number {
  return mapDomainError(() => calculateMarketplacePrivacyRetentionMilliseconds(privacyMode, policy).output);
}

async function readBalanceMicros(tenantId: string): Promise<bigint> {
  const row = await getD1()
    .prepare(AVAILABLE_BALANCE_SQL)
    .bind(tenantId, tenantId, tenantId)
    .first<{ available: string }>();
  return BigInt(row?.available ?? "0");
}

async function readIdempotency(tenantId: string, operation: string, key: string): Promise<string | null> {
  assertIdentifier(key, "commandId");
  const row = await getD1()
    .prepare("SELECT resource_id FROM idempotency_keys WHERE tenant_id = ? AND operation = ? AND idempotency_key = ?")
    .bind(tenantId, operation, key)
    .first<{ resource_id: string }>();
  return row?.resource_id ?? null;
}

function mapSupplier(row: SupplierRow): SupplierProfileView {
  return {
    supplierId: row.supplier_id,
    kind: row.kind,
    displayName: row.display_name,
    legalName: row.legal_name,
    countryCode: row.country_code,
    status: row.status,
    supplyEnabled: row.supply_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapAuthorization(row: AuthorizationRow, now: string): AuthorizationRequestView {
  return {
    requestId: row.request_id,
    supplierId: row.supplier_id,
    supplierDisplayName: row.supplier_display_name ?? "供应商",
    providerId: row.provider_id,
    sourceType: row.source_type,
    modelPattern: row.model_pattern,
    regionCode: row.region_code,
    dataClasses: parseDataClasses(row.data_classes_json),
    limits: {
      requestsPerMinute: row.requests_per_minute,
      tokensPerMinute: row.tokens_per_minute,
      concurrency: row.concurrency,
      maxOutputTokens: row.max_output_tokens
    },
    evidenceRef: row.evidence_ref,
    gatewayHost: new URL(row.gateway_endpoint).hostname,
    validUntil: row.valid_until,
    status: row.status === "approved" && row.valid_until <= now ? "expired" : row.status,
    reviewNote: row.review_note,
    authorizationRevision: row.authorization_revision,
    credentialRotatedAt: row.credential_rotated_at,
    revokedAt: row.revoked_at,
    revocationReasonCode: row.revocation_reason_code,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at
  };
}

function mapOffer(row: OfferRow, tenantId: string, now: string): CapacityOfferView {
  const authorizationUnavailable = row.authorization_status !== undefined && (
    row.authorization_status !== "approved" ||
    (row.authorization_valid_until !== undefined && row.authorization_valid_until <= now)
  );
  return {
    offerId: row.offer_id,
    supplierId: row.supplier_id,
    supplierDisplayName: row.supplier_display_name,
    providerId: row.provider_id,
    sourceType: row.source_type,
    model: row.model,
    regionCode: row.region_code,
    dataClasses: parseDataClasses(row.data_classes_json),
    limits: {
      requestsPerMinute: row.requests_per_minute,
      tokensPerMinute: row.tokens_per_minute,
      concurrency: row.concurrency,
      maxOutputTokens: row.max_output_tokens
    },
    currency: "CNY",
    priceMicrosPerMillionTokens: row.price_micros_per_million_tokens,
    status: row.valid_until <= now ? "expired" : authorizationUnavailable ? "paused" : row.status,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    createdAt: row.created_at,
    mine: row.tenant_id === tenantId
  };
}

function mapLedger(row: LedgerRow): LedgerEntryView {
  return {
    entryId: row.entry_id,
    jobId: row.job_id,
    entryType: row.entry_type,
    direction: row.direction,
    amountMicros: row.amount_micros,
    currency: row.currency,
    createdAt: row.created_at
  };
}

function mapJob(row: JobRow): InferenceJobView {
  const proofValues = [
    row.proof_provider_id,
    row.proof_requested_model,
    row.proof_served_model,
    row.proof_provider_request_id,
    row.proof_assurance,
    row.proof_evidence_digest,
    row.proof_unit_price,
    row.proof_buyer_charge,
    row.proof_completed_at
  ];
  const presentProofValues = proofValues.filter((value) => value !== undefined && value !== null).length;
  if (presentProofValues !== 0 && presentProofValues !== proofValues.length) {
    throw new ApiError("INTERNAL_ERROR", "服务执行凭证存储不完整。", 500);
  }
  if (row.proof_assurance !== undefined && row.proof_assurance !== null && row.proof_assurance !== "node-signed-provider-response") {
    throw new ApiError("INTERNAL_ERROR", "服务执行凭证保障等级无效。", 500);
  }
  const serviceProof = presentProofValues === proofValues.length
    ? {
        assurance: "node-signed-provider-response" as const,
        providerId: row.proof_provider_id!,
        requestedModel: row.proof_requested_model!,
        servedModel: row.proof_served_model!,
        providerRequestId: row.proof_provider_request_id!,
        unitPriceMicrosPerMillionTokens: row.proof_unit_price!,
        buyerChargeMicros: row.proof_buyer_charge!,
        evidenceDigest: row.proof_evidence_digest!,
        completedAt: row.proof_completed_at!
      }
    : null;
  return {
    jobId: row.job_id,
    offerId: row.offer_id,
    model: row.model,
    privacyMode: row.privacy_mode,
    status: row.status,
    totalTokens: row.total_tokens,
    chargeMicros: row.charge_micros,
    errorCode: row.error_code,
    serviceProof,
    contentExpiresAt: row.output_expires_at ?? null,
    contentPurgedAt: row.content_purged_at,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

function eventInsert(db: D1Database, event: MarketplaceEvent): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO marketplace_events (
        event_id, tenant_id, actor_id, causation_id, aggregate_type, aggregate_id,
        aggregate_version, event_type, schema_version, payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      event.eventId,
      event.tenantId,
      event.actorId,
      event.causationId,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.type,
      event.schemaVersion,
      JSON.stringify(event.payload),
      event.occurredAt
    );
}

function guardedCapacityOfferEventInsert(
  db: D1Database,
  event: MarketplaceEvent,
  offerId: string,
  tenantId: string
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO marketplace_events (
      event_id, tenant_id, actor_id, causation_id, aggregate_type, aggregate_id,
      aggregate_version, event_type, schema_version, payload_json, occurred_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM capacity_offers WHERE offer_id = ? AND tenant_id = ?
      )`
  ).bind(
    event.eventId,
    event.tenantId,
    event.actorId,
    event.causationId,
    event.aggregateType,
    event.aggregateId,
    event.aggregateVersion,
    event.type,
    event.schemaVersion,
    JSON.stringify(event.payload),
    event.occurredAt,
    offerId,
    tenantId
  );
}

function guardedReviewEventInsert(
  db: D1Database,
  event: MarketplaceEvent,
  requestId: string,
  reviewCommandId: string,
  reviewOperationToken: string,
  supplierVersion: number
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO marketplace_events (
      event_id, tenant_id, actor_id, causation_id, aggregate_type, aggregate_id,
      aggregate_version, event_type, schema_version, payload_json, occurred_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM authorization_requests
        WHERE request_id = ? AND status = 'approved' AND review_command_id = ?
      ) AND EXISTS (
        SELECT 1 FROM suppliers
        WHERE supplier_id = ? AND tenant_id = ? AND version = ? AND status = 'active'
      ) AND EXISTS (
        SELECT 1 FROM idempotency_keys
        WHERE tenant_id = 'platform' AND operation = 'authorization.review-target'
          AND idempotency_key = ? AND resource_id = ?
      )`
  ).bind(
    event.eventId, event.tenantId, event.actorId, event.causationId, event.aggregateType,
    event.aggregateId, event.aggregateVersion, event.type, event.schemaVersion,
    JSON.stringify(event.payload), event.occurredAt, requestId, reviewCommandId,
    event.aggregateId, event.tenantId, supplierVersion, requestId, reviewOperationToken
  );
}

function guardedReviewAuditInsert(
  db: D1Database,
  identity: RequestIdentity,
  action: "authorization.approved" | "authorization.rejected",
  requestId: string,
  reviewCommandId: string,
  reviewOperationToken: string,
  details: Record<string, unknown>,
  occurredAt: string
): D1PreparedStatement {
  const status = action === "authorization.approved" ? "approved" : "rejected";
  return db.prepare(
    `INSERT INTO audit_events (
      audit_id, tenant_id, actor_id, action, resource_type, resource_id, details_json, occurred_at
    ) SELECT ?, ?, ?, ?, 'authorization-request', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM authorization_requests
        WHERE request_id = ? AND status = ? AND review_command_id = ?
      ) AND EXISTS (
        SELECT 1 FROM idempotency_keys
        WHERE tenant_id = 'platform' AND operation = 'authorization.review-target'
          AND idempotency_key = ? AND resource_id = ?
      )`
  ).bind(
    `audit-${crypto.randomUUID()}`, identity.tenantId, identity.actorId, action, requestId,
    JSON.stringify(details), occurredAt, requestId, status, reviewCommandId,
    requestId, reviewOperationToken
  );
}

function reviewTargetClaimInsert(
  db: D1Database,
  reviewerTenantId: string,
  requestId: string,
  commandId: string,
  resourceBinding: string,
  operationToken: string,
  createdAt: string,
  lookupLimit?: {
    legacyCredentialDigest: string;
    credentialLookups: ReadonlyArray<{ digest: string; version: 2 | 3; keyId: string }>;
  }
): D1PreparedStatement {
  if (lookupLimit) {
    return db.prepare(
      claimAuthorizationReviewTargetWithLookupLimitSql(lookupLimit.credentialLookups.length)
    ).bind(
      requestId,
      operationToken,
      createdAt,
      requestId,
      reviewerTenantId,
      createdAt,
      lookupLimit.legacyCredentialDigest,
      ...lookupLimit.credentialLookups.flatMap((candidate) => [
        candidate.version,
        candidate.keyId,
        candidate.digest
      ]),
      MAX_AGENT_AUTHORIZATIONS_PER_TOKEN,
      reviewerTenantId,
      commandId,
      resourceBinding
    );
  }
  return db.prepare(CLAIM_AUTHORIZATION_REVIEW_TARGET_SQL).bind(
    requestId, operationToken, createdAt, requestId, reviewerTenantId,
    reviewerTenantId, commandId, resourceBinding
  );
}

function guardedReviewIdempotencyInsert(
  db: D1Database,
  tenantId: string,
  commandId: string,
  resourceBinding: string,
  requestId: string,
  reviewOperationToken: string,
  createdAt: string
): D1PreparedStatement {
  return db.prepare(BIND_AUTHORIZATION_REVIEW_COMMAND_SQL).bind(
    tenantId, commandId, resourceBinding, createdAt, requestId, reviewOperationToken
  );
}

function auditInsert(
  db: D1Database,
  identity: RequestIdentity,
  action: string,
  resourceType: string,
  resourceId: string,
  details: Record<string, unknown>,
  occurredAt: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
        audit_id, tenant_id, actor_id, action, resource_type, resource_id, details_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      `audit-${crypto.randomUUID()}`,
      identity.tenantId,
      identity.actorId,
      action,
      resourceType,
      resourceId,
      JSON.stringify(details),
      occurredAt
    );
}

function guardedCapacityOfferAuditInsert(
  db: D1Database,
  identity: RequestIdentity,
  offerId: string,
  details: Record<string, unknown>,
  occurredAt: string
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit_events (
      audit_id, tenant_id, actor_id, action, resource_type, resource_id, details_json, occurred_at
    ) SELECT ?, ?, ?, 'offer.published', 'capacity-offer', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM capacity_offers WHERE offer_id = ? AND tenant_id = ?
      )`
  ).bind(
    `audit-${crypto.randomUUID()}`,
    identity.tenantId,
    identity.actorId,
    offerId,
    JSON.stringify(details),
    occurredAt,
    offerId,
    identity.tenantId
  );
}

function guardedInferenceLedgerInsert(
  db: D1Database,
  tenantId: string,
  accountId: string,
  jobId: string,
  entryType: LedgerEntryView["entryType"],
  direction: LedgerEntryView["direction"],
  amountMicros: string,
  createdAt: string,
  evidenceDigest: string
): D1PreparedStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO ledger_entries (
      entry_id, tenant_id, account_id, job_id, entry_type, direction, amount_micros, currency, created_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, 'CNY', ?
      WHERE EXISTS (
        SELECT 1 FROM service_evidence WHERE job_id = ? AND evidence_digest = ?
      )`
  ).bind(
    `ledger-${crypto.randomUUID()}`, tenantId, accountId, jobId, entryType, direction,
    amountMicros, createdAt, jobId, evidenceDigest
  );
}

function guardedInferenceAuditInsert(
  db: D1Database,
  identity: RequestIdentity,
  jobId: string,
  details: Record<string, unknown>,
  occurredAt: string,
  evidenceDigest: string
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit_events (
      audit_id, tenant_id, actor_id, action, resource_type, resource_id, details_json, occurred_at
    ) SELECT ?, ?, ?, 'inference.completed', 'inference-job', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM service_evidence WHERE job_id = ? AND evidence_digest = ?
      )`
  ).bind(
    `audit-${crypto.randomUUID()}`, identity.tenantId, identity.actorId, jobId,
    JSON.stringify(details), occurredAt, jobId, evidenceDigest
  );
}

function idempotencyInsert(
  db: D1Database,
  tenantId: string,
  operation: string,
  key: string,
  resourceId: string,
  createdAt: string
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO idempotency_keys (tenant_id, operation, idempotency_key, resource_id, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(tenantId, operation, key, resourceId, createdAt);
}

function commandContext(identity: RequestIdentity, commandId: string, occurredAt: string) {
  return commandContextForTenant(identity.tenantId, identity.actorId, commandId, occurredAt);
}

function commandContextForTenant(tenantId: string, actorId: string, commandId: string, occurredAt: string) {
  return { tenantId, actorId, commandId, eventId: `event-${crypto.randomUUID()}`, occurredAt };
}

function mapDomainError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof MarketplaceDomainError)) throw error;
    const code = error.code === "AUTHORIZATION_REQUIRED"
      ? "AUTHORIZATION_REQUIRED"
      : error.code === "PRIVACY_ACKNOWLEDGEMENT_REQUIRED"
        ? "PRIVACY_ACKNOWLEDGEMENT_REQUIRED"
        : error.code === "INVALID_SUPPLIER_STATE" || error.code === "VERIFICATION_INCOMPLETE"
          ? "SUPPLIER_NOT_ACTIVE"
          : "INVALID_REQUEST";
    const status = code === "INVALID_REQUEST" || code === "PRIVACY_ACKNOWLEDGEMENT_REQUIRED" ? 400 : 409;
    const message = code === "PRIVACY_ACKNOWLEDGEMENT_REQUIRED"
      ? "提交前必须确认内容会发送给匹配供应节点及其上游 Provider 执行。"
      : error.message;
    throw new ApiError(code, message, status);
  }
}

function validateAuthorizationInput(input: CreateAuthorizationRequest): void {
  assertIdentifier(input.commandId, "commandId");
  assertIdentifier(input.providerId, "providerId");
  assertIdentifier(input.evidenceRef, "evidenceRef");
  if (isLikelySecretEvidenceReference(input.evidenceRef)) {
    throw new ApiError(
      "INVALID_REQUEST",
      "evidenceRef 只能填写合同、许可或证明编号，不能包含 API Key、令牌或 JWT。",
      400
    );
  }
  assertText(input.modelPattern, "modelPattern", 120);
  if (!/^[A-Z]{2}$/.test(input.regionCode.toUpperCase())) throw new ApiError("INVALID_REQUEST", "regionCode 必须是两位地区代码。", 400);
  if (!["api-project", "commercial-account", "subscription-plan", "self-hosted-license"].includes(input.sourceType)) {
    throw new ApiError("INVALID_REQUEST", "sourceType 无效。", 400);
  }
  if (!["provider-report", "signed-receipt", "dedicated-counter"].includes(input.meteringMode)) {
    throw new ApiError("INVALID_REQUEST", "meteringMode 无效。", 400);
  }
  assertDataClasses(input.dataClasses);
  assertLimits(input.limits);
  assertFutureTimestamp(input.validUntil, "validUntil");
  validateGatewayBearerToken(input.gatewayBearerToken);
}

function validateGatewayBearerToken(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{43,512}$/.test(value) ||
    new Set(value).size < 16
  ) {
    throw new ApiError("INVALID_REQUEST", "gatewayBearerToken 必须是至少 256 bit 的高熵 base64url 令牌。", 400);
  }
}

function assertAuthorizationRevocationReason(
  value: unknown
): asserts value is RevokeAuthorizationRequest["reasonCode"] {
  if (![
    "supplier-requested",
    "credential-compromised",
    "provider-revoked",
    "gateway-decommissioned"
  ].includes(value as string)) {
    throw new ApiError("INVALID_REQUEST", "授权撤销原因无效。", 400);
  }
}

function assertGatewayCredentialRotationReason(
  value: unknown
): asserts value is RotateAuthorizationCredentialRequest["reasonCode"] {
  if (!["scheduled", "credential-compromised", "gateway-reconfigured"].includes(value as string)) {
    throw new ApiError("INVALID_REQUEST", "Gateway 凭据换发原因无效。", 400);
  }
}

function validateInferenceInput(input: RunInferenceRequest): void {
  assertText(input.model, "model", 120);
  const maximumInputCharacters = getMarketplaceRuntimePolicy().maximumInputCharacters;
  if (typeof input.input !== "string" || input.input.length === 0 || input.input.length > maximumInputCharacters) {
    throw new ApiError("INVALID_REQUEST", `input 长度必须在 1 到 ${maximumInputCharacters} 字符之间。`, 400);
  }
  if (input.dataClass !== "P0" && input.dataClass !== "P1") {
    throw new ApiError("INVALID_REQUEST", "试运营仅支持 P0/P1 数据。", 400);
  }
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 32_768) {
    throw new ApiError("INVALID_REQUEST", "maxOutputTokens 必须是 1 到 32768 的整数。", 400);
  }
  mapDomainError(() => parseMarketplacePrivacyMode(input.privacyMode));
  mapDomainError(() => assertSupplierProcessingAcknowledged(input.supplierProcessingAcknowledged));
}

function assertExactKeys(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new ApiError("INVALID_REQUEST", "请求正文必须是对象。", 400);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new ApiError("INVALID_REQUEST", `请求包含不支持的字段：${key}。`, 400);
  }
}

function assertGatewayExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== allowed.length || actualKeys.some((key) => !allowedSet.has(key))) {
    throw new ApiError("SERVICE_EVIDENCE_FAILED", "供应节点执行凭证响应字段不完整或包含未约定字段。", 502);
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value)) {
    throw new ApiError("INVALID_REQUEST", `${label} 必须是稳定标识符。`, 400);
  }
}

function assertIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new ApiError("INVALID_REQUEST", "Idempotency-Key 必须是 8 到 128 字符的稳定标识符。", 400);
  }
}

function assertText(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new ApiError("INVALID_REQUEST", `${label} 长度必须在 1 到 ${maximum} 字符之间。`, 400);
  }
}

function normalizeOptionalText(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  assertText(value, "reviewNote", maximum);
  return value.trim();
}

function assertDataClasses(value: unknown): asserts value is Array<"P0" | "P1"> {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => item !== "P0" && item !== "P1")) {
    throw new ApiError("INVALID_REQUEST", "dataClasses 只能包含 P0 或 P1。", 400);
  }
  if (new Set(value).size !== value.length) throw new ApiError("INVALID_REQUEST", "dataClasses 不能重复。", 400);
}

function assertLimits(value: CreateAuthorizationRequest["limits"]): void {
  if (!isRecord(value)) throw new ApiError("INVALID_REQUEST", "limits 必须是对象。", 400);
  assertExactKeys(value, ["requestsPerMinute", "tokensPerMinute", "concurrency", "maxOutputTokens"]);
  for (const [key, maximum] of [
    ["requestsPerMinute", 100_000],
    ["tokensPerMinute", 1_000_000_000],
    ["concurrency", 10_000],
    ["maxOutputTokens", 1_000_000]
  ] as const) {
    const item = value[key];
    if (!Number.isSafeInteger(item) || item < 1 || item > maximum) {
      throw new ApiError("INVALID_REQUEST", `${key} 必须是 1 到 ${maximum} 的整数。`, 400);
    }
  }
}

function assertPositiveIntegerString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value)) {
    throw new ApiError("INVALID_REQUEST", `${label} 必须是正整数字符串。`, 400);
  }
}

function assertFutureTimestamp(value: unknown, label: string): Date {
  const normalized = normalizeUtcTimestamp(value, label);
  const timestamp = new Date(normalized);
  if (!isAuthorizationValidityAllowed(normalized, Date.now())) {
    throw new ApiError("INVALID_REQUEST", `${label} 必须晚于当前时间一分钟且不超过 90 天。`, 400);
  }
  return timestamp;
}

function normalizeUtcTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    throw new ApiError("INVALID_REQUEST", `${label} 必须是 UTC 时间。`, 400);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new ApiError("INVALID_REQUEST", `${label} 必须是有效的 UTC 时间。`, 400);
  }
  return timestamp.toISOString();
}

function parseDataClasses(value: string): Array<"P0" | "P1"> {
  try {
    const parsed = JSON.parse(value) as unknown;
    assertDataClasses(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("INTERNAL_ERROR", "存储的数据等级无法解析。", 500);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown, label: string, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ApiError("GATEWAY_FAILED", `${label} 必须是不小于 ${minimum} 的安全整数。`, 502);
  }
  return value as number;
}

function requiredBoundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new ApiError("GATEWAY_FAILED", `${label} 长度无效。`, 502);
  }
  return value;
}

function requiredEvidenceString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new ApiError("SERVICE_EVIDENCE_FAILED", `${label} 长度无效。`, 502);
  }
  return value;
}

function requiredText(value: string | undefined, label: string): string {
  if (!value) throw new ApiError("INTERNAL_ERROR", `${label} 缺失。`, 500);
  return value;
}

function requiredPositiveInteger(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) {
    throw new ApiError("INTERNAL_ERROR", `${label} 缺失或格式无效。`, 500);
  }
  return value!;
}

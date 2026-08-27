import { SUPPLIER_GATEWAY_HEADERS, createSupplierGatewaySignaturePayload } from "@token-streaming/protocol";

import { ensureSchema, getD1 } from "@/db";
import { ApiError, readBoundedText } from "./http";
import { enforceScopeRateLimit } from "./rate-limit";
import { createCredentialLookupDigest, createCredentialLookupDigests, sha256Hex } from "./security";
import {
  MAX_AGENT_AUTHORIZATIONS_PER_TOKEN,
  claimAgentNonceNamespacesSql,
  migrateAgentLookupNamespacesSql
} from "./agent-auth-invariants";

export interface AgentAuthorizationIdentity {
  credentialDigest: string;
  gatewayToken: string;
  supplierTenantId: string;
  supplierId: string;
  signedJobId: string;
  authorizations: Array<{
    requestId: string;
    authorizationRevision: number;
    providerId: string;
    modelPattern: string;
  }>;
}

interface AgentAuthorizationRow {
  request_id: string;
  tenant_id: string;
  supplier_id: string;
  provider_id: string;
  model_pattern: string;
  gateway_token_digest: string;
  gateway_token_digest_version: number;
  gateway_token_lookup_key_id: string;
  authorization_revision: number;
}

export async function readSignedAgentJson<T>(
  request: Request,
  maximumBytes = 64_000
): Promise<{ body: T; rawBody: string; identity: AgentAuthorizationIdentity }> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new ApiError("INVALID_REQUEST", "Agent 请求必须使用 application/json。", 415);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new ApiError("INVALID_REQUEST", "Agent 请求超过大小限制。", 413);
  const rawBody = await readBoundedText(request, maximumBytes, () =>
    new ApiError("INVALID_REQUEST", "Agent 请求超过大小限制。", 413)
  );
  let body: T;
  try {
    body = JSON.parse(rawBody) as T;
  } catch {
    throw new ApiError("INVALID_REQUEST", "Agent 请求 JSON 无法解析。", 400);
  }
  return { body, rawBody, identity: await authenticateAgentRequest(request, rawBody) };
}

export async function authenticateAgentRequest(
  request: Request,
  rawBody: string
): Promise<AgentAuthorizationIdentity> {
  await ensureSchema();
  const gatewayToken = bearerToken(request.headers.get("authorization"));
  const edgeAddress = request.headers.get("cf-connecting-ip")?.trim() || "edge-address-unavailable";
  const [credentialLookups, legacyCredentialDigest, preAuthScope] = await Promise.all([
    createCredentialLookupDigests(gatewayToken),
    sha256Hex(gatewayToken),
    createCredentialLookupDigest(`agent-edge:${edgeAddress}`)
  ]);
  const credentialLookup = credentialLookups[0]!;
  const credentialDigest = credentialLookup.digest;
  await enforceScopeRateLimit(
    `agent-auth-${preAuthScope.digest.slice(0, 48)}`,
    "agent.authentication",
    120,
    5 * 60_000
  );
  const db = getD1();
  const now = new Date().toISOString();
  const keyedLookupConditions = credentialLookups.map(() =>
    "(ar.gateway_token_digest_version = ? AND ar.gateway_token_lookup_key_id = ? AND ar.gateway_token_digest = ?)"
  ).join(" OR ");
  const resultPromise = db.prepare(
    `SELECT ar.request_id, ar.tenant_id, ar.supplier_id, ar.provider_id, ar.model_pattern,
       ar.gateway_token_digest, ar.gateway_token_digest_version, ar.gateway_token_lookup_key_id
       , ar.authorization_revision
     FROM authorization_requests ar
     JOIN suppliers s ON s.supplier_id = ar.supplier_id AND s.tenant_id = ar.tenant_id
     WHERE ((ar.gateway_token_digest_version = 1 AND ar.gateway_token_digest = ?)
         OR ${keyedLookupConditions})
       AND ar.status = 'approved' AND ar.valid_until > ?
       AND s.status = 'active' AND s.supply_enabled = 1
     ORDER BY ar.created_at ASC LIMIT ${MAX_AGENT_AUTHORIZATIONS_PER_TOKEN + 1}`
  ).bind(
    legacyCredentialDigest,
    ...credentialLookups.flatMap((candidate) => [candidate.version, candidate.keyId, candidate.digest]),
    now
  ).all<AgentAuthorizationRow>();

  const timestamp = requiredHeader(request, SUPPLIER_GATEWAY_HEADERS.timestamp, /^\d{13}$/);
  const nonce = requiredHeader(request, SUPPLIER_GATEWAY_HEADERS.nonce, /^[A-Za-z0-9_-]{16,128}$/);
  const jobId = requiredHeader(request, SUPPLIER_GATEWAY_HEADERS.jobId, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/);
  const signature = requiredHeader(request, SUPPLIER_GATEWAY_HEADERS.signature, /^[a-f0-9]{64}$/);
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) {
    throw agentAuthenticationFailed();
  }
  const bodySha256 = await sha256Hex(rawBody);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(gatewayToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const [matches, result] = await Promise.all([
    crypto.subtle.verify(
      "HMAC",
      key,
      hexToArrayBuffer(signature),
      new TextEncoder().encode(createSupplierGatewaySignaturePayload({ timestamp, nonce, jobId, bodySha256 }))
    ),
    resultPromise
  ]);
  if (!matches || result.results.length === 0) throw agentAuthenticationFailed();
  const first = result.results[0]!;
  if (result.results.some((row) => row.tenant_id !== first.tenant_id || row.supplier_id !== first.supplier_id)) {
    throw new ApiError("INTERNAL_ERROR", "Agent 凭据错误地绑定了多个供应主体。", 500);
  }
  await enforceScopeRateLimit(`agent-${credentialDigest}`, "agent.signed-request", 600, 5 * 60_000);
  await db.prepare(
    `DELETE FROM agent_request_nonces WHERE rowid IN (
       SELECT rowid FROM agent_request_nonces WHERE expires_at < ? ORDER BY expires_at ASC LIMIT 100
     )`
  ).bind(now).run();
  const nonceExpiresAt = new Date(timestampMs + 5 * 60_000).toISOString();
  const nonceNamespaces = [...new Set([
    legacyCredentialDigest,
    ...credentialLookups.map((candidate) => candidate.digest)
  ])];
  const inserted = await db.prepare(claimAgentNonceNamespacesSql(nonceNamespaces.length)).bind(
    ...nonceNamespaces,
    nonce,
    nonceExpiresAt,
    nonce
  ).run();
  if ((inserted.meta.changes ?? 0) !== nonceNamespaces.length) {
    throw new ApiError("CONFLICT", "Agent 请求 nonce 已经使用。", 409);
  }
  if (result.results.length > MAX_AGENT_AUTHORIZATIONS_PER_TOKEN) {
    await migrateEveryReadableLookupNamespace(
      db,
      credentialLookup,
      credentialLookups,
      legacyCredentialDigest,
      now
    );
    throw new ApiError("CONFLICT", "Agent 凭据绑定的有效授权数量超过安全上限。", 409);
  }
  const staleLookupRows = result.results.filter((row) =>
    row.gateway_token_digest_version !== credentialLookup.version ||
    row.gateway_token_lookup_key_id !== credentialLookup.keyId ||
    row.gateway_token_digest !== credentialLookup.digest
  );
  if (staleLookupRows.length > 0) {
    const migrated = await db.batch(staleLookupRows.map((row) => db.prepare(
      `UPDATE authorization_requests SET gateway_token_digest = ?, gateway_token_digest_version = ?,
         gateway_token_lookup_key_id = ?, updated_at = ?
       WHERE request_id = ? AND gateway_token_digest_version = ?
         AND gateway_token_lookup_key_id = ? AND gateway_token_digest = ?`
    ).bind(
      credentialLookup.digest, credentialLookup.version, credentialLookup.keyId, now,
      row.request_id, row.gateway_token_digest_version,
      row.gateway_token_lookup_key_id, row.gateway_token_digest
    )));
    if (migrated.some((entry) => (entry.meta.changes ?? 0) !== 1)) {
      throw new ApiError("CONFLICT", "Agent 凭据在鉴权期间发生变化。", 409, true);
    }
  }
  await migrateEveryReadableLookupNamespace(
    db,
    credentialLookup,
    credentialLookups,
    legacyCredentialDigest,
    now
  );
  await assertAuthenticatedRowsCurrent(db, result.results, credentialLookup, now);
  return {
    credentialDigest,
    gatewayToken,
    supplierTenantId: first.tenant_id,
    supplierId: first.supplier_id,
    signedJobId: jobId,
    authorizations: result.results.map((row) => ({
      requestId: row.request_id,
      authorizationRevision: row.authorization_revision,
      providerId: row.provider_id,
      modelPattern: row.model_pattern
    }))
  };
}

async function assertAuthenticatedRowsCurrent(
  db: D1Database,
  rows: readonly AgentAuthorizationRow[],
  active: { digest: string; version: 2 | 3; keyId: string },
  now: string
): Promise<void> {
  const revisions = rows.map(() => "(ar.request_id = ? AND ar.authorization_revision = ?)").join(" OR ");
  const current = await db.prepare(
    `SELECT COUNT(*) AS authorization_count FROM authorization_requests ar
     JOIN suppliers s ON s.supplier_id = ar.supplier_id AND s.tenant_id = ar.tenant_id
     WHERE (${revisions}) AND ar.status = 'approved' AND ar.valid_until > ?
       AND ar.gateway_token_digest_version = ? AND ar.gateway_token_lookup_key_id = ?
       AND ar.gateway_token_digest = ? AND s.status = 'active' AND s.supply_enabled = 1`
  ).bind(
    ...rows.flatMap((row) => [row.request_id, row.authorization_revision]),
    now,
    active.version,
    active.keyId,
    active.digest
  ).first<{ authorization_count: number }>();
  if ((current?.authorization_count ?? 0) !== rows.length) {
    throw new ApiError("CONFLICT", "Agent 授权在签名验证期间发生变化。", 409, true);
  }
}

async function migrateEveryReadableLookupNamespace(
  db: D1Database,
  active: { digest: string; version: 2 | 3; keyId: string },
  readable: ReadonlyArray<{ digest: string; version: 2 | 3; keyId: string }>,
  legacyDigest: string,
  now: string
): Promise<void> {
  await db.prepare(migrateAgentLookupNamespacesSql(readable.length)).bind(
    active.digest,
    active.version,
    active.keyId,
    now,
    active.version,
    active.keyId,
    active.digest,
    legacyDigest,
    ...readable.flatMap((candidate) => [candidate.version, candidate.keyId, candidate.digest])
  ).run();
}

function bearerToken(value: string | null): string {
  if (!value?.startsWith("Bearer ")) throw agentAuthenticationFailed();
  const token = value.slice("Bearer ".length);
  // Version-1 authorizations accepted a wider token format. Keep those usable
  // until their explicit validUntil while all newly submitted v2 credentials
  // remain subject to the stronger generator/validator at creation time.
  if (token.length < 32 || token.length > 4096 || token.trim() !== token) throw agentAuthenticationFailed();
  return token;
}

function requiredHeader(request: Request, name: string, pattern: RegExp): string {
  const value = request.headers.get(name);
  if (!value || !pattern.test(value)) throw agentAuthenticationFailed();
  return value;
}

function agentAuthenticationFailed(): ApiError {
  return new ApiError("AUTHENTICATION_REQUIRED", "Agent 身份验证失败。", 401);
}

function hexToArrayBuffer(value: string): ArrayBuffer {
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

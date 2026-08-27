import { SUPPLIER_GATEWAY_HEADERS, createSupplierGatewaySignaturePayload } from "@token-streaming/protocol";

import { ensureSchema, getD1 } from "@/db";
import { ApiError, readBoundedText } from "./http";
import { enforceScopeRateLimit } from "./rate-limit";
import { createCredentialLookupDigest, sha256Hex } from "./security";
import { INSERT_AGENT_NONCE_SQL } from "./agent-auth-invariants";

export interface AgentAuthorizationIdentity {
  credentialDigest: string;
  gatewayToken: string;
  supplierTenantId: string;
  supplierId: string;
  signedJobId: string;
  authorizations: Array<{
    requestId: string;
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
  gateway_token_digest_version: number;
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
  const [credentialLookup, legacyCredentialDigest, preAuthScope] = await Promise.all([
    createCredentialLookupDigest(gatewayToken),
    sha256Hex(gatewayToken),
    createCredentialLookupDigest(`agent-edge:${edgeAddress}`)
  ]);
  const credentialDigest = credentialLookup.digest;
  await enforceScopeRateLimit(
    `agent-auth-${preAuthScope.digest.slice(0, 48)}`,
    "agent.authentication",
    120,
    5 * 60_000
  );
  const db = getD1();
  const now = new Date().toISOString();
  const resultPromise = db.prepare(
    `SELECT ar.request_id, ar.tenant_id, ar.supplier_id, ar.provider_id, ar.model_pattern,
       ar.gateway_token_digest_version
     FROM authorization_requests ar
     JOIN suppliers s ON s.supplier_id = ar.supplier_id AND s.tenant_id = ar.tenant_id
     WHERE ((ar.gateway_token_digest_version = 2 AND ar.gateway_token_digest = ?)
         OR (ar.gateway_token_digest_version = 1 AND ar.gateway_token_digest = ?))
       AND ar.status = 'approved' AND ar.valid_until > ?
       AND s.status = 'active' AND s.supply_enabled = 1
     ORDER BY ar.created_at ASC LIMIT 100`
  ).bind(credentialDigest, legacyCredentialDigest, now).all<AgentAuthorizationRow>();

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
  const legacyRows = result.results.filter((row) => row.gateway_token_digest_version === 1);
  if (legacyRows.length > 0) {
    await db.batch(legacyRows.map((row) => db.prepare(
      `UPDATE authorization_requests SET gateway_token_digest = ?, gateway_token_digest_version = 2,
         updated_at = ? WHERE request_id = ? AND gateway_token_digest_version = 1
         AND gateway_token_digest = ?`
    ).bind(credentialDigest, now, row.request_id, legacyCredentialDigest)));
  }
  await db.prepare(
    `DELETE FROM agent_request_nonces WHERE rowid IN (
       SELECT rowid FROM agent_request_nonces WHERE expires_at < ? ORDER BY expires_at ASC LIMIT 100
     )`
  ).bind(now).run();
  const nonceExpiresAt = new Date(timestampMs + 5 * 60_000).toISOString();
  const inserted = await db.batch([
    db.prepare(INSERT_AGENT_NONCE_SQL).bind(credentialDigest, nonce, nonceExpiresAt),
    db.prepare(INSERT_AGENT_NONCE_SQL).bind(legacyCredentialDigest, nonce, nonceExpiresAt)
  ]);
  if (inserted.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new ApiError("CONFLICT", "Agent 请求 nonce 已经使用。", 409);
  }
  return {
    credentialDigest,
    gatewayToken,
    supplierTenantId: first.tenant_id,
    supplierId: first.supplier_id,
    signedJobId: jobId,
    authorizations: result.results.map((row) => ({
      requestId: row.request_id,
      providerId: row.provider_id,
      modelPattern: row.model_pattern
    }))
  };
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

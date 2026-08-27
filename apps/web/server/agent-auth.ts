import { SUPPLIER_GATEWAY_HEADERS, createSupplierGatewaySignaturePayload } from "@token-streaming/protocol";

import { ensureSchema, getD1 } from "@/db";
import { ApiError } from "./http";
import { enforceScopeRateLimit } from "./rate-limit";
import { sha256Hex } from "./security";

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
}

export async function readSignedAgentJson<T>(
  request: Request,
  maximumBytes = 64_000
): Promise<{ body: T; rawBody: string; identity: AgentAuthorizationIdentity }> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new ApiError("INVALID_REQUEST", "Agent 请求必须使用 application/json。", 415);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new ApiError("INVALID_REQUEST", "Agent 请求超过大小限制。", 413);
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > maximumBytes) throw new ApiError("INVALID_REQUEST", "Agent 请求超过大小限制。", 413);
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
  const credentialDigest = await sha256Hex(gatewayToken);
  const db = getD1();
  const result = await db.prepare(
    `SELECT ar.request_id, ar.tenant_id, ar.supplier_id, ar.provider_id, ar.model_pattern
     FROM authorization_requests ar
     JOIN suppliers s ON s.supplier_id = ar.supplier_id AND s.tenant_id = ar.tenant_id
     WHERE ar.gateway_token_digest = ? AND ar.status = 'approved'
       AND s.status = 'active' AND s.supply_enabled = 1
     ORDER BY ar.created_at ASC LIMIT 100`
  ).bind(credentialDigest).all<AgentAuthorizationRow>();
  if (result.results.length === 0) throw new ApiError("AUTHENTICATION_REQUIRED", "Agent 凭据未获授权或供应已经关闭。", 401);
  const first = result.results[0]!;
  if (result.results.some((row) => row.tenant_id !== first.tenant_id || row.supplier_id !== first.supplier_id)) {
    throw new ApiError("INTERNAL_ERROR", "Agent 凭据错误地绑定了多个供应主体。", 500);
  }

  const timestamp = requiredHeader(request, SUPPLIER_GATEWAY_HEADERS.timestamp, /^\d{13}$/);
  const nonce = requiredHeader(request, SUPPLIER_GATEWAY_HEADERS.nonce, /^[A-Za-z0-9_-]{16,128}$/);
  const jobId = requiredHeader(request, SUPPLIER_GATEWAY_HEADERS.jobId, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/);
  const signature = requiredHeader(request, SUPPLIER_GATEWAY_HEADERS.signature, /^[a-f0-9]{64}$/);
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) {
    throw new ApiError("AUTHENTICATION_REQUIRED", "Agent 请求时间戳已过期。", 401);
  }
  const bodySha256 = await sha256Hex(rawBody);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(gatewayToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const matches = await crypto.subtle.verify(
    "HMAC",
    key,
    hexToArrayBuffer(signature),
    new TextEncoder().encode(createSupplierGatewaySignaturePayload({ timestamp, nonce, jobId, bodySha256 }))
  );
  if (!matches) throw new ApiError("AUTHENTICATION_REQUIRED", "Agent 请求签名无效。", 401);
  await enforceScopeRateLimit(`agent-${credentialDigest}`, "agent.signed-request", 600, 5 * 60_000);
  const now = new Date().toISOString();
  await db.prepare(
    `DELETE FROM agent_request_nonces WHERE rowid IN (
       SELECT rowid FROM agent_request_nonces WHERE expires_at < ? ORDER BY expires_at ASC LIMIT 100
     )`
  ).bind(now).run();
  const inserted = await db.prepare(
    "INSERT OR IGNORE INTO agent_request_nonces (credential_digest, nonce, expires_at) VALUES (?, ?, ?)"
  ).bind(credentialDigest, nonce, new Date(timestampMs + 5 * 60_000).toISOString()).run();
  if ((inserted.meta.changes ?? 0) !== 1) throw new ApiError("CONFLICT", "Agent 请求 nonce 已经使用。", 409);
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
  if (!value?.startsWith("Bearer ")) throw new ApiError("AUTHENTICATION_REQUIRED", "Agent 缺少身份凭据。", 401);
  const token = value.slice("Bearer ".length);
  if (token.length < 32 || token.length > 4_096 || token.trim() !== token) {
    throw new ApiError("AUTHENTICATION_REQUIRED", "Agent 身份凭据无效。", 401);
  }
  return token;
}

function requiredHeader(request: Request, name: string, pattern: RegExp): string {
  const value = request.headers.get(name);
  if (!value || !pattern.test(value)) throw new ApiError("INVALID_REQUEST", `Agent 请求头 ${name} 无效。`, 400);
  return value;
}

function hexToArrayBuffer(value: string): ArrayBuffer {
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

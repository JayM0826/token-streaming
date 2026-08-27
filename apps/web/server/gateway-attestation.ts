import {
  MarketplaceDomainError,
  verifySupplierGatewayAttestation,
  type SupplierGatewayAttestationExpectation,
  type VerifiedSupplierGatewayAttestation
} from "@token-streaming/marketplace-domain";
import {
  SUPPLIER_GATEWAY_PROTOCOL_VERSION,
  type SupplierGatewayAttestationResponse
} from "@token-streaming/protocol";
import { createSignedGatewayHeaders } from "./gateway-signing";
import { ApiError } from "./http";

const MAXIMUM_ATTESTATION_BYTES = 64_000;

export async function attestSupplierGateway(
  endpoint: URL,
  gatewayToken: string,
  claim: Omit<SupplierGatewayAttestationExpectation, "requestId" | "challenge">,
  fetchImpl: typeof fetch = fetch
): Promise<VerifiedSupplierGatewayAttestation> {
  const requestId = `attestation-${crypto.randomUUID()}`;
  const challenge = crypto.randomUUID().replaceAll("-", "");
  const rawBody = JSON.stringify({
    protocol_version: SUPPLIER_GATEWAY_PROTOCOL_VERSION,
    request_id: requestId,
    challenge
  });
  const signedHeaders = await createSignedGatewayHeaders(gatewayToken, requestId, rawBody);
  const attestationEndpoint = new URL("/v3/attestation", endpoint.origin);
  let response: Response;
  try {
    response = await fetchImpl(attestationEndpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${gatewayToken}`,
        accept: "application/json",
        "content-type": "application/json",
        ...signedHeaders
      },
      body: rawBody,
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new ApiError(
      "GATEWAY_ATTESTATION_FAILED",
      "供应节点无法连接、证书无效或健康证明超时。",
      502,
      true
    );
  }
  if (!response.ok) {
    throw new ApiError(
      "GATEWAY_ATTESTATION_FAILED",
      `供应节点健康证明返回 HTTP ${response.status}。`,
      502,
      response.status === 429 || response.status >= 500
    );
  }
  const raw = await readBoundedResponseText(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError("GATEWAY_ATTESTATION_FAILED", "供应节点健康证明不是有效 JSON。", 502);
  }
  try {
    return verifySupplierGatewayAttestation(
      { requestId, challenge, ...claim },
      parsed as SupplierGatewayAttestationResponse
    );
  } catch (error) {
    if (error instanceof MarketplaceDomainError) {
      throw new ApiError(
        "GATEWAY_ATTESTATION_FAILED",
        "供应节点声明与待审核的 Provider、模型、数据等级或容量不一致。",
        409
      );
    }
    throw error;
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_ATTESTATION_BYTES) {
    throw new ApiError("GATEWAY_ATTESTATION_FAILED", "供应节点健康证明超过大小限制。", 502);
  }
  if (!response.body) {
    throw new ApiError("GATEWAY_ATTESTATION_FAILED", "供应节点健康证明为空。", 502);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAXIMUM_ATTESTATION_BYTES) {
      await reader.cancel();
      throw new ApiError("GATEWAY_ATTESTATION_FAILED", "供应节点健康证明超过大小限制。", 502);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

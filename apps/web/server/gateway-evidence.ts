import {
  MarketplaceDomainError,
  verifySupplierExecutionEvidence,
  type VerifiedSupplierExecutionEvidence
} from "@token-streaming/marketplace-domain";
import {
  createSupplierGatewayExecutionEvidencePayload,
  type SupplierGatewayExecutionEvidence,
  type SupplierGatewayUsage
} from "@token-streaming/protocol";
import { ApiError } from "./http";
import { sha256Hex } from "./security";

export interface GatewayEvidenceVerificationInput {
  gatewayToken: string;
  requestId: string;
  providerId: string;
  requestedModel: string;
  inputSha256: string;
  output: string;
  usage: SupplierGatewayUsage;
  evidence: SupplierGatewayExecutionEvidence;
  evidenceSignature: string;
  requestStartedAt: string;
}

export interface VerifiedGatewayServiceEvidence extends VerifiedSupplierExecutionEvidence {
  assurance: "node-signed-provider-response";
  evidenceDigest: string;
}

export async function verifyGatewayServiceEvidence(
  input: GatewayEvidenceVerificationInput
): Promise<VerifiedGatewayServiceEvidence> {
  if (!/^[a-f0-9]{64}$/.test(input.evidenceSignature)) {
    throw evidenceFailure("供应节点执行凭证签名格式无效。");
  }
  const outputSha256 = await sha256Hex(input.output);
  let verified: VerifiedSupplierExecutionEvidence;
  try {
    verified = verifySupplierExecutionEvidence(
      {
        requestId: input.requestId,
        providerId: input.providerId,
        requestedModel: input.requestedModel,
        inputSha256: input.inputSha256,
        outputSha256,
        usage: input.usage,
        requestStartedAt: input.requestStartedAt,
        verifiedAt: new Date().toISOString()
      },
      input.evidence
    );
  } catch (error) {
    if (error instanceof MarketplaceDomainError) {
      throw evidenceFailure("供应节点返回的 Provider、模型、内容摘要或用量与订单不一致。");
    }
    throw error;
  }

  const payload = createSupplierGatewayExecutionEvidencePayload(input.evidence);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.gatewayToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signatureMatches = await crypto.subtle.verify(
    "HMAC",
    key,
    hexToArrayBuffer(input.evidenceSignature),
    new TextEncoder().encode(payload)
  );
  if (!signatureMatches) {
    throw evidenceFailure("供应节点执行凭证签名验证失败。");
  }

  return {
    ...verified,
    assurance: "node-signed-provider-response",
    evidenceDigest: await sha256Hex(`${payload}\n${input.evidenceSignature}`)
  };
}

function hexToArrayBuffer(value: string): ArrayBuffer {
  const result = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result.buffer;
}

function evidenceFailure(message: string): ApiError {
  return new ApiError("SERVICE_EVIDENCE_FAILED", message, 502);
}

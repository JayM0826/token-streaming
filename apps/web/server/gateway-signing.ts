import {
  SUPPLIER_GATEWAY_HEADERS,
  createSupplierGatewaySignaturePayload
} from "@token-streaming/protocol";
import { sha256Hex } from "./security";

export async function createSignedGatewayHeaders(
  gatewayToken: string,
  jobId: string,
  rawBody: string,
  timestampMs = Date.now(),
  nonce = crypto.randomUUID()
): Promise<Record<string, string>> {
  const timestamp = String(timestampMs);
  const bodySha256 = await sha256Hex(rawBody);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(gatewayToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(createSupplierGatewaySignaturePayload({ timestamp, nonce, jobId, bodySha256 }))
  );
  return {
    [SUPPLIER_GATEWAY_HEADERS.jobId]: jobId,
    [SUPPLIER_GATEWAY_HEADERS.timestamp]: timestamp,
    [SUPPLIER_GATEWAY_HEADERS.nonce]: nonce,
    [SUPPLIER_GATEWAY_HEADERS.signature]: bytesToHex(new Uint8Array(signature))
  };
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

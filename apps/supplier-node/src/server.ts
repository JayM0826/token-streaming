import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SUPPLIER_GATEWAY_HEADERS, type SupplierGatewayErrorResponse } from "@token-streaming/protocol";
import { SupplierNodeError } from "./errors.js";
import type { SupplierNodeRuntime } from "./runtime.js";

export function createSupplierNodeServer(runtime: SupplierNodeRuntime): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://supplier-node.invalid");
      if (request.method === "GET" && url.pathname === "/healthz" && !url.search) {
        const readiness = runtime.readiness();
        return sendJson(response, readiness.status === "ready" ? 200 : 503, readiness);
      }
      const isInference = request.method === "POST" && url.pathname === "/v3/inference" && !url.search;
      const isAttestation = request.method === "POST" && url.pathname === "/v3/attestation" && !url.search;
      if (!isInference && !isAttestation) {
        return sendJson(response, 404, errorBody("INVALID_REQUEST", "接口不存在。", false));
      }
      const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        return sendJson(response, 415, errorBody("INVALID_REQUEST", "Content-Type 必须是 application/json。", false));
      }
      const rawBody = await readRequestBody(request, runtime.config.limits.maxInputBytes + 16_384);
      const call = {
        authorization: singleHeader(request, "authorization"),
        timestamp: singleHeader(request, SUPPLIER_GATEWAY_HEADERS.timestamp),
        nonce: singleHeader(request, SUPPLIER_GATEWAY_HEADERS.nonce),
        jobId: singleHeader(request, SUPPLIER_GATEWAY_HEADERS.jobId),
        signature: singleHeader(request, SUPPLIER_GATEWAY_HEADERS.signature),
        rawBody
      };
      const result = isAttestation
        ? await runtime.handleAttestation(call)
        : await runtime.handleInference(call);
      return sendJson(response, result.status, result.body);
    } catch (error) {
      const normalized = error instanceof SupplierNodeError
        ? error
        : new SupplierNodeError("INTERNAL_ERROR", "供应节点发生内部错误。", 500, true);
      return sendJson(response, normalized.status, errorBody(normalized.code, normalized.message, normalized.retryable));
    }
  });
}

export async function listenSupplierNode(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function readRequestBody(request: IncomingMessage, maximumBytes: number): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new SupplierNodeError("INVALID_REQUEST", "请求体超过节点大小限制。", 413);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maximumBytes) {
      throw new SupplierNodeError("INVALID_REQUEST", "请求体超过节点大小限制。", 413);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  });
  response.end(encoded);
}

function errorBody(
  code: SupplierGatewayErrorResponse["error"]["code"],
  message: string,
  retryable: boolean
): SupplierGatewayErrorResponse {
  return { error: { code, message, retryable } };
}

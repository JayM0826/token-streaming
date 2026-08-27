import type { MarketplaceApiErrorBody, MarketplaceApiErrorCode } from "@token-streaming/protocol";

export class ApiError extends Error {
  readonly code: MarketplaceApiErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: MarketplaceApiErrorCode,
    message: string,
    status: number,
    retryable = false
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export async function readJson<T>(request: Request, maximumBytes = 64_000): Promise<T> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ApiError("INVALID_REQUEST", "请求必须使用 application/json。", 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ApiError("INVALID_REQUEST", "请求内容超过大小限制。", 413);
  }
  const text = await readBoundedText(request, maximumBytes, () =>
    new ApiError("INVALID_REQUEST", "请求内容超过大小限制。", 413)
  );
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("INVALID_REQUEST", "请求 JSON 无法解析。", 400);
  }
}

export async function readBoundedText(
  source: Request | Response,
  maximumBytes: number,
  tooLarge: () => Error
): Promise<string> {
  const declaredLength = Number(source.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw tooLarge();
  if (!source.body) return "";
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) {
    throw new ApiError("CSRF_REJECTED", "缺少来源校验信息。", 403);
  }
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(request.url).origin;
  } catch {
    throw new ApiError("CSRF_REJECTED", "请求来源无效。", 403);
  }
  if (origin !== expectedOrigin) {
    throw new ApiError("CSRF_REJECTED", "跨站写入已被拒绝。", 403);
  }
}

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("strict-transport-security", "max-age=63072000; includeSubDomains");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function apiFailure(error: unknown, requestId: string): Response {
  const normalized = normalizeError(error);
  const body: MarketplaceApiErrorBody = {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      requestId,
      retryable: normalized.retryable
    }
  };
  return jsonResponse(body, { status: normalized.status });
}

export async function apiRoute(
  handler: (requestId: string) => Promise<Response>,
  requestId = crypto.randomUUID()
): Promise<Response> {
  try {
    return await handler(requestId);
  } catch (error) {
    console.error(JSON.stringify({ event: "api.request.failed", requestId, error: safeErrorName(error) }));
    return apiFailure(error, requestId);
  }
}

function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error && error.message.includes("D1 binding")) {
    return new ApiError("DATABASE_UNAVAILABLE", "持久化服务暂时不可用。", 503, true);
  }
  if (error instanceof Error && error.message.includes("R2 binding")) {
    return new ApiError("ARTIFACT_STORAGE_UNAVAILABLE", "文件存储服务暂时不可用。", 503, true);
  }
  return new ApiError("INTERNAL_ERROR", "服务暂时无法完成请求。", 500, true);
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

interface ErrorPayload {
  message?: unknown;
  type?: unknown;
  code?: unknown;
}

export function formatProviderHttpError(
  prefix: string,
  response: Pick<Response, "status" | "headers">,
  body: unknown,
  sensitiveValues: readonly string[] = []
): Error {
  const payload = extractErrorPayload(body);
  const metadata = [
    formatMetadata("type", payload?.type, sensitiveValues),
    formatMetadata("code", payload?.code, sensitiveValues),
    formatMetadata("request_id", response.headers.get("x-request-id") ?? response.headers.get("request-id"), sensitiveValues)
  ].filter((value): value is string => Boolean(value));
  const suffix = metadata.length ? ` (${metadata.join(", ")})` : "";
  const message = sanitizeText(payload?.message, sensitiveValues) ?? "Upstream returned an error response.";

  return new Error(`${prefix} with HTTP ${response.status}${suffix}: ${message}`);
}

function extractErrorPayload(body: unknown): ErrorPayload | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    return error as ErrorPayload;
  }
  if (typeof error === "string") {
    return { message: error, type: record.type, code: record.code };
  }
  if (record.message !== undefined || record.type !== undefined || record.code !== undefined) {
    return { message: record.message, type: record.type, code: record.code };
  }
  return undefined;
}

function formatMetadata(name: string, value: unknown, sensitiveValues: readonly string[]): string | undefined {
  const sanitized = sanitizeText(value, sensitiveValues, 120);
  return sanitized ? `${name}=${sanitized.replace(/\s+/g, "_")}` : undefined;
}

function sanitizeText(value: unknown, sensitiveValues: readonly string[], limit = 500): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }

  let sanitized = String(value).replace(/[\r\n\t]+/g, " ").trim();
  for (const secret of sensitiveValues) {
    if (secret) {
      sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    }
  }
  if (!sanitized) {
    return undefined;
  }
  return sanitized.length <= limit ? sanitized : `${sanitized.slice(0, limit)}...`;
}

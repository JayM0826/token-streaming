interface ErrorWithCause extends Error {
  cause?: unknown;
  code?: unknown;
}

export function formatProviderNetworkError(prefix: string, error: unknown): Error {
  const details = collectErrorDetails(error);
  return new Error(`${prefix}: ${details.join(": ")}`, { cause: error });
}

export function isTransientProviderNetworkError(error: unknown): boolean {
  const codes = collectErrorCodes(error);
  return codes.some((code) =>
    ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code)
  );
}

function collectErrorDetails(error: unknown): string[] {
  const details: string[] = [];
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (isErrorLike(current) && !visited.has(current)) {
    visited.add(current);
    const code = typeof current.code === "string" ? current.code : undefined;
    const message = current.message.trim();
    const detail = [code, message].filter(Boolean).join(" ");
    if (detail && !details.includes(detail)) {
      details.push(detail);
    }
    current = current.cause;
  }
  return details.length ? details : ["unknown network error"];
}

function collectErrorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (isErrorLike(current) && !visited.has(current)) {
    visited.add(current);
    if (typeof current.code === "string") {
      codes.push(current.code);
    }
    current = current.cause;
  }
  return codes;
}

function isErrorLike(value: unknown): value is ErrorWithCause {
  return value instanceof Error;
}

import type { MarketplaceDataClass } from "@token-streaming/protocol";

export type UpstreamProtocol = "responses" | "chat-completions";

export interface SupplierNodeConfig {
  bindHost: string;
  port: number;
  gatewayToken: string;
  providerId: string;
  allowedModels: string[];
  allowedDataClasses: Array<Extract<MarketplaceDataClass, "P0" | "P1">>;
  limits: {
    requestsPerMinute: number;
    tokensPerMinute: number;
    concurrency: number;
    maxOutputTokens: number;
    maxInputBytes: number;
    maxArtifactBytes: number;
    artifactSegmentBytes: number;
  };
  upstream: {
    protocol: UpstreamProtocol;
    baseUrl: URL;
    apiKey: string;
    timeoutMs: number;
    maximumResponseBytes: number;
  };
}

export function loadSupplierNodeConfig(env: NodeJS.ProcessEnv = process.env): SupplierNodeConfig {
  const gatewayToken = requiredSecret(env.SUPPLIER_NODE_GATEWAY_TOKEN, "SUPPLIER_NODE_GATEWAY_TOKEN", 32);
  const apiKey = requiredSecret(env.SUPPLIER_NODE_UPSTREAM_API_KEY, "SUPPLIER_NODE_UPSTREAM_API_KEY", 8);
  const providerId = requiredIdentifier(env.SUPPLIER_NODE_PROVIDER_ID, "SUPPLIER_NODE_PROVIDER_ID");
  const allowedModels = requiredCsv(env.SUPPLIER_NODE_ALLOWED_MODELS, "SUPPLIER_NODE_ALLOWED_MODELS");
  if (allowedModels.some((model) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model))) {
    throw new Error("SUPPLIER_NODE_ALLOWED_MODELS must contain exact 1-120 character model names without wildcards.");
  }
  const allowedDataClasses = parseDataClasses(env.SUPPLIER_NODE_ALLOWED_DATA_CLASSES ?? "P0");
  const maxInputBytes = integer(env.SUPPLIER_NODE_MAX_INPUT_BYTES, 65_536, 1, 1_000_000, "SUPPLIER_NODE_MAX_INPUT_BYTES");
  const maxArtifactBytes = integer(
    env.SUPPLIER_NODE_MAX_ARTIFACT_BYTES,
    0,
    0,
    256 * 1024 * 1024,
    "SUPPLIER_NODE_MAX_ARTIFACT_BYTES"
  );
  const artifactSegmentBytes = integer(
    env.SUPPLIER_NODE_ARTIFACT_SEGMENT_BYTES,
    Math.max(1, Math.min(262_144, maxInputBytes - 16_384)),
    1,
    524_288,
    "SUPPLIER_NODE_ARTIFACT_SEGMENT_BYTES"
  );
  if (maxArtifactBytes > 0 && (maxInputBytes < 20_480 || artifactSegmentBytes < 16_384 || artifactSegmentBytes > maxInputBytes - 4_096)) {
    throw new Error("SUPPLIER_NODE_ARTIFACT_SEGMENT_BYTES must leave at least 4096 bytes for task instructions.");
  }
  const protocol = env.SUPPLIER_NODE_UPSTREAM_PROTOCOL ?? "responses";
  if (protocol !== "responses" && protocol !== "chat-completions") {
    throw new Error("SUPPLIER_NODE_UPSTREAM_PROTOCOL must be responses or chat-completions.");
  }
  const baseUrl = validateUpstreamBaseUrl(env.SUPPLIER_NODE_UPSTREAM_BASE_URL);
  const allowedHosts = requiredCsv(
    env.SUPPLIER_NODE_UPSTREAM_HOST_ALLOWLIST,
    "SUPPLIER_NODE_UPSTREAM_HOST_ALLOWLIST"
  ).map((value) => value.toLowerCase());
  if (!allowedHosts.some((host) => baseUrl.hostname === host || baseUrl.hostname.endsWith(`.${host}`))) {
    throw new Error("SUPPLIER_NODE_UPSTREAM_BASE_URL host is not in SUPPLIER_NODE_UPSTREAM_HOST_ALLOWLIST.");
  }

  return {
    bindHost: validateBindHost(env.SUPPLIER_NODE_BIND_HOST ?? "127.0.0.1"),
    port: integer(env.SUPPLIER_NODE_PORT, 8789, 1, 65_535, "SUPPLIER_NODE_PORT"),
    gatewayToken,
    providerId,
    allowedModels,
    allowedDataClasses,
    limits: {
      requestsPerMinute: integer(env.SUPPLIER_NODE_REQUESTS_PER_MINUTE, 30, 1, 10_000, "SUPPLIER_NODE_REQUESTS_PER_MINUTE"),
      tokensPerMinute: integer(env.SUPPLIER_NODE_TOKENS_PER_MINUTE, 100_000, 1, 100_000_000, "SUPPLIER_NODE_TOKENS_PER_MINUTE"),
      concurrency: integer(env.SUPPLIER_NODE_CONCURRENCY, 2, 1, 1_000, "SUPPLIER_NODE_CONCURRENCY"),
      maxOutputTokens: integer(env.SUPPLIER_NODE_MAX_OUTPUT_TOKENS, 4_096, 1, 32_768, "SUPPLIER_NODE_MAX_OUTPUT_TOKENS"),
      maxInputBytes,
      maxArtifactBytes,
      artifactSegmentBytes
    },
    upstream: {
      protocol,
      baseUrl,
      apiKey,
      timeoutMs: integer(env.SUPPLIER_NODE_UPSTREAM_TIMEOUT_MS, 60_000, 1_000, 600_000, "SUPPLIER_NODE_UPSTREAM_TIMEOUT_MS"),
      maximumResponseBytes: integer(
        env.SUPPLIER_NODE_MAXIMUM_UPSTREAM_RESPONSE_BYTES,
        1_000_000,
        1_024,
        10_000_000,
        "SUPPLIER_NODE_MAXIMUM_UPSTREAM_RESPONSE_BYTES"
      )
    }
  };
}

function requiredSecret(value: string | undefined, name: string, minimumLength: number): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length < minimumLength || normalized.length > 4_096) {
    throw new Error(`${name} must contain ${minimumLength} to 4096 characters.`);
  }
  return normalized;
}

function requiredIdentifier(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(normalized)) {
    throw new Error(`${name} is missing or invalid.`);
  }
  return normalized;
}

function requiredCsv(value: string | undefined, name: string): string[] {
  const values = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0 || values.length > 100 || values.some((item) => item.length > 200)) {
    throw new Error(`${name} must contain 1 to 100 comma-separated values.`);
  }
  return [...new Set(values)];
}

function parseDataClasses(value: string): Array<"P0" | "P1"> {
  const values = requiredCsv(value, "SUPPLIER_NODE_ALLOWED_DATA_CLASSES");
  if (values.some((item) => item !== "P0" && item !== "P1")) {
    throw new Error("SUPPLIER_NODE_ALLOWED_DATA_CLASSES may contain only P0 and P1.");
  }
  return values as Array<"P0" | "P1">;
}

function validateUpstreamBaseUrl(value: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error("SUPPLIER_NODE_UPSTREAM_BASE_URL must be a public HTTPS URL.");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.port && url.port !== "443") ||
    isBlockedHostname(hostname) ||
    isIpLiteral(hostname)
  ) {
    throw new Error("SUPPLIER_NODE_UPSTREAM_BASE_URL must be a public HTTPS URL on port 443.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function validateBindHost(value: string): string {
  if (value !== "127.0.0.1" && value !== "::1" && value !== "0.0.0.0" && value !== "::") {
    throw new Error("SUPPLIER_NODE_BIND_HOST must be an explicit loopback or wildcard bind address.");
  }
  return value;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function isIpLiteral(hostname: string): boolean {
  return hostname.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  );
}

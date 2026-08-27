import { homedir } from "node:os";
import path from "node:path";
import { SUPPLIER_AGENT_PROFILE_VERSION, SupplierAgentError, type SupplierAgentProfile, type SupplierAgentProfileInput } from "./types.js";

export interface SupplierAgentPaths {
  root: string;
  profile: string;
  vault: string;
}

const PROFILE_KEYS = [
  "providerId",
  "allowedModels",
  "allowedDataClasses",
  "publicGatewayEndpoint",
  "controlPlaneBaseUrl",
  "gatewayPort",
  "upstreamProtocol",
  "upstreamBaseUrl",
  "upstreamHostAllowlist",
  "limits"
] as const;

export function resolveSupplierAgentPaths(override?: string): SupplierAgentPaths {
  const configured = override?.trim();
  const root = configured
    ? path.resolve(configured)
    : process.platform === "win32"
      ? path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "GongSuanYun", "SupplierAgent")
      : process.platform === "darwin"
        ? path.join(homedir(), "Library", "Application Support", "GongSuanYun", "SupplierAgent")
        : path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "gongsuanyun", "supplier-agent");
  return {
    root,
    profile: path.join(root, "profile.json"),
    vault: path.join(root, "vault.json")
  };
}

export function createSupplierAgentProfile(input: SupplierAgentProfileInput, prior?: SupplierAgentProfile, now = new Date().toISOString()): SupplierAgentProfile {
  const validated = validateSupplierAgentProfileInput(input);
  return {
    profileVersion: SUPPLIER_AGENT_PROFILE_VERSION,
    ...validated,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now
  };
}

export function validateSupplierAgentProfile(value: unknown): SupplierAgentProfile {
  const record = requireRecord(value, "profile");
  const input = record.profileVersion === 1
    ? migrateLegacyProfile(record)
    : (() => {
        assertExactKeys(record, ["profileVersion", ...PROFILE_KEYS, "createdAt", "updatedAt"], "profile");
        if (record.profileVersion !== SUPPLIER_AGENT_PROFILE_VERSION) invalid("不支持的供应客户端配置版本。");
        return validateSupplierAgentProfileInput(record);
      })();
  const createdAt = timestamp(record.createdAt, "createdAt");
  const updatedAt = timestamp(record.updatedAt, "updatedAt");
  return { profileVersion: SUPPLIER_AGENT_PROFILE_VERSION, ...input, createdAt, updatedAt };
}

export function validateSupplierAgentProfileInput(value: unknown): SupplierAgentProfileInput {
  const record = requireRecord(value, "profile");
  assertExactKeys(record, PROFILE_KEYS, "profile");
  const providerId = identifier(record.providerId, "providerId");
  const allowedModels = uniqueStrings(record.allowedModels, "allowedModels", 100, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/);
  const allowedDataClasses = dataClasses(record.allowedDataClasses);
  const publicGatewayEndpoint = publicEndpoint(record.publicGatewayEndpoint);
  const controlPlaneBaseUrl = controlPlaneUrl(record.controlPlaneBaseUrl);
  const gatewayPort = integer(record.gatewayPort, "gatewayPort", 1, 65_535);
  if (record.upstreamProtocol !== "responses" && record.upstreamProtocol !== "chat-completions") {
    invalid("upstreamProtocol 必须是 responses 或 chat-completions。");
  }
  const upstreamBaseUrl = publicHttpsUrl(record.upstreamBaseUrl, "upstreamBaseUrl");
  const upstreamHostAllowlist = uniqueStrings(record.upstreamHostAllowlist, "upstreamHostAllowlist", 100, /^[A-Za-z0-9.-]{1,253}$/)
    .map((item) => item.toLowerCase());
  const upstreamHost = new URL(upstreamBaseUrl).hostname.toLowerCase();
  if (!upstreamHostAllowlist.some((host) => upstreamHost === host || upstreamHost.endsWith(`.${host}`))) {
    invalid("上游地址不在主机白名单中。");
  }
  const limitsRecord = requireRecord(record.limits, "limits");
  assertExactKeys(limitsRecord, [
    "requestsPerMinute", "tokensPerMinute", "concurrency", "maxOutputTokens", "maxInputBytes",
    "maxArtifactBytes", "artifactSegmentBytes"
  ], "limits");
  const maxInputBytes = integer(limitsRecord.maxInputBytes, "maxInputBytes", 1, 1_000_000);
  const maxArtifactBytes = integer(limitsRecord.maxArtifactBytes, "maxArtifactBytes", 0, 256 * 1024 * 1024);
  const artifactSegmentBytes = integer(limitsRecord.artifactSegmentBytes, "artifactSegmentBytes", 1, 524_288);
  if (maxArtifactBytes > 0 && (maxInputBytes < 20_480 || artifactSegmentBytes < 16_384 || artifactSegmentBytes > maxInputBytes - 4_096)) {
    invalid("启用文件任务时，分段大小必须至少 16384 字节，并为任务说明保留 4096 字节输入空间。");
  }
  return {
    providerId,
    allowedModels,
    allowedDataClasses,
    publicGatewayEndpoint,
    controlPlaneBaseUrl,
    gatewayPort,
    upstreamProtocol: record.upstreamProtocol,
    upstreamBaseUrl,
    upstreamHostAllowlist,
    limits: {
      requestsPerMinute: integer(limitsRecord.requestsPerMinute, "requestsPerMinute", 1, 10_000),
      tokensPerMinute: integer(limitsRecord.tokensPerMinute, "tokensPerMinute", 1, 100_000_000),
      concurrency: integer(limitsRecord.concurrency, "concurrency", 1, 1_000),
      maxOutputTokens: integer(limitsRecord.maxOutputTokens, "maxOutputTokens", 1, 32_768),
      maxInputBytes,
      maxArtifactBytes,
      artifactSegmentBytes
    }
  };
}

function migrateLegacyProfile(record: Record<string, unknown>): SupplierAgentProfileInput {
  const legacyKeys = PROFILE_KEYS.filter((key) => key !== "controlPlaneBaseUrl");
  assertExactKeys(record, ["profileVersion", ...legacyKeys, "createdAt", "updatedAt"], "profile");
  const legacyLimits = requireRecord(record.limits, "limits");
  const maxInputBytes = integer(legacyLimits.maxInputBytes, "maxInputBytes", 1, 1_000_000);
  return validateSupplierAgentProfileInput({
    providerId: record.providerId,
    allowedModels: record.allowedModels,
    allowedDataClasses: record.allowedDataClasses,
    publicGatewayEndpoint: record.publicGatewayEndpoint,
    controlPlaneBaseUrl: "https://gongsuanyun-market.wenzaiyin.chatgpt.site",
    gatewayPort: record.gatewayPort,
    upstreamProtocol: record.upstreamProtocol,
    upstreamBaseUrl: record.upstreamBaseUrl,
    upstreamHostAllowlist: record.upstreamHostAllowlist,
    limits: {
      ...legacyLimits,
      maxArtifactBytes: maxInputBytes >= 20_480 ? 256 * 1024 * 1024 : 0,
      artifactSegmentBytes: maxInputBytes >= 20_480 ? Math.min(262_144, maxInputBytes - 4_096) : 1
    }
  });
}

function publicEndpoint(value: unknown): string {
  const normalized = publicHttpsUrl(value, "publicGatewayEndpoint");
  const url = new URL(normalized);
  if (url.pathname !== "/v3/inference") invalid("公网节点地址必须以 /v3/inference 结尾。");
  return url.toString();
}

function controlPlaneUrl(value: unknown): string {
  const normalized = publicHttpsUrl(value, "controlPlaneBaseUrl");
  const url = new URL(normalized);
  if (url.pathname !== "/") invalid("平台地址必须是 HTTPS 站点根地址。");
  return url.origin;
}

function publicHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(`${label} 必须是公网 HTTPS 地址。`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(`${label} 必须是公网 HTTPS 地址。`);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    (url.port && url.port !== "443") || isIpLiteral(hostname) || isBlockedHostname(hostname)
  ) {
    invalid(`${label} 必须是公网 HTTPS 地址且不能包含凭据、查询参数或私网主机。`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function dataClasses(value: unknown): Array<"P0" | "P1"> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || value.some((item) => item !== "P0" && item !== "P1")) {
    invalid("allowedDataClasses 只能包含 P0 或 P1。");
  }
  return [...new Set(value)] as Array<"P0" | "P1">;
}

function uniqueStrings(value: unknown, label: string, maximum: number, pattern: RegExp): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) invalid(`${label} 数量无效。`);
  const result = value.map((item) => {
    if (typeof item !== "string" || !pattern.test(item)) invalid(`${label} 包含无效值。`);
    return item;
  });
  if (new Set(result).size !== result.length) invalid(`${label} 不能包含重复值。`);
  return result;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(value)) invalid(`${label} 无效。`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${label} 必须是 ${minimum} 到 ${maximum} 的整数。`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) invalid(`${label} 无效。`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} 必须是对象。`);
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) invalid(`${label} 字段不完整或包含未知字段。`);
}

function isIpLiteral(hostname: string): boolean {
  return hostname.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function isBlockedHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal");
}

function invalid(message: string): never {
  throw new SupplierAgentError("INVALID_INPUT", message);
}

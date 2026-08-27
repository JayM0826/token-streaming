import { getChatGPTUser, type ChatGPTUser } from "@/app/chatgpt-auth";
import { getRuntimeEnv } from "@/db";
import { ApiError } from "./http";

export interface RequestIdentity {
  user: ChatGPTUser;
  tenantId: string;
  actorId: string;
  isAdmin: boolean;
}

export async function requireIdentity(): Promise<RequestIdentity> {
  const user = await getChatGPTUser();
  if (!user) {
    throw new ApiError("AUTHENTICATION_REQUIRED", "请先使用 ChatGPT 账号登录。", 401);
  }
  const tenantId = await stableId("tenant", user.userId);
  const actorId = await stableId("actor", user.userId);
  return { user, tenantId, actorId, isAdmin: isAdminUser(user.userId) };
}

export function requireAdmin(identity: RequestIdentity): void {
  if (!identity.isAdmin) {
    throw new ApiError("ADMIN_REQUIRED", "此操作需要平台审核员权限。", 403);
  }
}

export interface CredentialEncryptionContext {
  tenantId: string;
  authorizationRequestId: string;
}

export interface ContentEncryptionContext {
  purpose: "inference-output" | "artifact-instruction" | "artifact-output";
  tenantId: string;
  resourceId: string;
}

export interface DigestCommitmentContext {
  purpose: "prompt" | "inference-output" | "artifact-instruction" | "artifact-manifest" | "artifact-content" | "artifact-output";
  tenantId: string;
  resourceId: string;
}

export async function encryptCredential(
  plaintext: string,
  context: CredentialEncryptionContext
): Promise<{ ciphertext: string; iv: string; keyVersion: 2 }> {
  if (plaintext.length < 8 || plaintext.length > 4_096) {
    throw new ApiError("INVALID_REQUEST", "网关令牌长度必须在 8 到 4096 字符之间。", 400);
  }
  const encrypted = await encryptText(plaintext, await credentialKey(), credentialAdditionalData(context));
  return { ...encrypted, keyVersion: 2 };
}

export async function decryptCredential(
  ciphertext: string,
  iv: string,
  keyVersion: number,
  context: CredentialEncryptionContext
): Promise<string> {
  return decryptText(
    ciphertext,
    iv,
    await credentialKey(),
    keyVersion === 1 ? undefined : keyVersion === 2 ? credentialAdditionalData(context) : invalidKeyVersion()
  );
}

export async function encryptContent(
  plaintext: string,
  context: ContentEncryptionContext
): Promise<{ ciphertext: string; iv: string; keyVersion: 2 }> {
  if (plaintext.length < 1 || plaintext.length > 200_000) {
    throw new ApiError("GATEWAY_FAILED", "敏感内容长度不符合加密存储边界。", 502);
  }
  const encrypted = await encryptText(plaintext, await contentKey(), contentAdditionalData(context));
  return { ...encrypted, keyVersion: 2 };
}

export async function decryptContent(
  ciphertext: string,
  iv: string,
  keyVersion: number,
  context: ContentEncryptionContext
): Promise<string> {
  return decryptText(
    ciphertext,
    iv,
    keyVersion === 1 ? await credentialKey() : keyVersion === 2 ? await contentKey() : invalidKeyVersion(),
    keyVersion === 1 ? undefined : contentAdditionalData(context)
  );
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Bytes(value: ArrayBuffer | ArrayBufferView): Promise<string> {
  const source = value instanceof ArrayBuffer
    ? value
    : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return bytesToHex(new Uint8Array(digest));
}

export async function createDigestCommitment(
  sha256Digest: string,
  context: DigestCommitmentContext
): Promise<{ digest: string; version: 2 }> {
  if (!/^[a-f0-9]{64}$/.test(sha256Digest)) {
    throw new ApiError("INTERNAL_ERROR", "内容摘要格式无效。", 500);
  }
  const payload = new TextEncoder().encode([
    "gongsuanyun.digest-commitment.v2",
    context.purpose,
    context.tenantId,
    context.resourceId,
    sha256Digest
  ].join("\n"));
  const signature = await crypto.subtle.sign("HMAC", await commitmentKey(), payload);
  return { digest: bytesToHex(new Uint8Array(signature)), version: 2 };
}

export async function encryptArtifactChunk(
  plaintext: ArrayBuffer,
  context: { tenantId: string; artifactId: string; partNumber: number; plaintextSha256: string }
): Promise<{ ciphertext: ArrayBuffer; iv: string; ciphertextSha256: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: artifactAdditionalData(context) },
    await artifactKey(),
    plaintext
  );
  return {
    ciphertext,
    iv: bytesToBase64(iv),
    ciphertextSha256: await sha256Bytes(ciphertext)
  };
}

export async function decryptArtifactChunk(
  ciphertext: ArrayBuffer,
  iv: string,
  context: { tenantId: string; artifactId: string; partNumber: number; plaintextSha256: string }
): Promise<ArrayBuffer> {
  try {
    return await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(iv), additionalData: artifactAdditionalData(context) },
      await artifactKey(),
      ciphertext
    );
  } catch {
    throw new ApiError("ARTIFACT_INTEGRITY_FAILED", "文件分块无法解密或完整性校验失败。", 500);
  }
}

export function validateGatewayEndpoint(value: string, requireAllowlistMatch: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError("INVALID_REQUEST", "网关地址不是有效 URL。", 400);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    isIpLiteral(hostname) ||
    isBlockedHostname(hostname)
  ) {
    throw new ApiError("INVALID_REQUEST", "网关必须是标准 443 端口上的公开 HTTPS 域名。", 400);
  }
  if (url.pathname.length > 512 || url.search.length > 0) {
    throw new ApiError("INVALID_REQUEST", "网关路径过长或包含不允许的查询参数。", 400);
  }
  if (requireAllowlistMatch && !isAllowedGatewayHost(hostname)) {
    throw new ApiError("GATEWAY_HOST_NOT_ALLOWED", "网关域名尚未加入平台生产白名单。", 403);
  }
  return url;
}

function isAdminUser(userId: string): boolean {
  if (process.env.NODE_ENV === "development" && userId === "local-development-user") return true;
  const configured = getRuntimeEnv().MARKETPLACE_ADMIN_USER_IDS ?? "";
  return configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(userId);
}

function isAllowedGatewayHost(hostname: string): boolean {
  if (process.env.NODE_ENV === "development" && hostname.endsWith(".example.com")) return true;
  const allowlist = (getRuntimeEnv().MARKETPLACE_GATEWAY_HOST_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return allowlist.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
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

async function stableId(prefix: string, value: string): Promise<string> {
  return `${prefix}-${(await sha256Hex(value)).slice(0, 32)}`;
}

async function credentialKey(): Promise<CryptoKey> {
  let encoded = getRuntimeEnv().MARKETPLACE_CREDENTIAL_KEY;
  if (!encoded && process.env.NODE_ENV === "development") {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("gongsuanyun-local-development-only"));
    encoded = bytesToBase64(new Uint8Array(digest));
  }
  if (!encoded) {
    throw new ApiError("INTERNAL_ERROR", "生产凭据加密密钥尚未配置。", 503);
  }
  const bytes = base64ToBytes(encoded);
  if (bytes.byteLength !== 32) {
    throw new ApiError("INTERNAL_ERROR", "生产凭据加密密钥格式无效。", 503);
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function artifactKey(): Promise<CryptoKey> {
  let encoded = getRuntimeEnv().MARKETPLACE_ARTIFACT_KEY;
  if (!encoded && process.env.NODE_ENV === "development") {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("gongsuanyun-artifact-local-development-only"));
    encoded = bytesToBase64(new Uint8Array(digest));
  }
  if (!encoded) throw new ApiError("ARTIFACT_STORAGE_UNAVAILABLE", "生产文件加密密钥尚未配置。", 503);
  const bytes = base64ToBytes(encoded);
  if (bytes.byteLength !== 32) throw new ApiError("ARTIFACT_STORAGE_UNAVAILABLE", "生产文件加密密钥格式无效。", 503);
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function contentKey(): Promise<CryptoKey> {
  let encoded = getRuntimeEnv().MARKETPLACE_CONTENT_KEY;
  if (!encoded && process.env.NODE_ENV === "development") {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("gongsuanyun-content-local-development-only"));
    encoded = bytesToBase64(new Uint8Array(digest));
  }
  if (!encoded) throw new ApiError("INTERNAL_ERROR", "生产内容加密密钥尚未配置。", 503);
  const bytes = base64ToBytes(encoded);
  if (bytes.byteLength !== 32) throw new ApiError("INTERNAL_ERROR", "生产内容加密密钥格式无效。", 503);
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function commitmentKey(): Promise<CryptoKey> {
  let encoded = getRuntimeEnv().MARKETPLACE_COMMITMENT_KEY;
  if (!encoded && process.env.NODE_ENV === "development") {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("gongsuanyun-commitment-local-development-only"));
    encoded = bytesToBase64(new Uint8Array(digest));
  }
  if (!encoded) throw new ApiError("INTERNAL_ERROR", "生产内容承诺密钥尚未配置。", 503);
  const bytes = base64ToBytes(encoded);
  if (bytes.byteLength !== 32) throw new ApiError("INTERNAL_ERROR", "生产内容承诺密钥格式无效。", 503);
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function encryptText(
  plaintext: string,
  key: CryptoKey,
  additionalData?: ArrayBuffer
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, ...(additionalData ? { additionalData } : {}) },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

async function decryptText(
  ciphertext: string,
  iv: string,
  key: CryptoKey,
  additionalData?: ArrayBuffer
): Promise<string> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(iv), ...(additionalData ? { additionalData } : {}) },
      key,
      base64ToBytes(ciphertext)
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new ApiError("INTERNAL_ERROR", "加密内容无法读取或记录绑定校验失败。", 500);
  }
}

function credentialAdditionalData(context: CredentialEncryptionContext): ArrayBuffer {
  return new TextEncoder().encode([
    "gongsuanyun.credential.v2",
    context.tenantId,
    context.authorizationRequestId
  ].join("\n")).buffer as ArrayBuffer;
}

function contentAdditionalData(context: ContentEncryptionContext): ArrayBuffer {
  return new TextEncoder().encode([
    "gongsuanyun.content.v2",
    context.purpose,
    context.tenantId,
    context.resourceId
  ].join("\n")).buffer as ArrayBuffer;
}

function invalidKeyVersion(): never {
  throw new ApiError("INTERNAL_ERROR", "加密密钥版本不受支持。", 500);
}

function artifactAdditionalData(input: {
  tenantId: string;
  artifactId: string;
  partNumber: number;
  plaintextSha256: string;
}): ArrayBuffer {
  return new TextEncoder().encode(
    ["gongsuanyun.artifact-chunk.v1", input.tenantId, input.artifactId, String(input.partNumber), input.plaintextSha256].join("\n")
  ).buffer as ArrayBuffer;
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

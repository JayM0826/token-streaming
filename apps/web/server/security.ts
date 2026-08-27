import { getChatGPTUser, type ChatGPTUser } from "@/app/chatgpt-auth";
import { getD1, getRuntimeEnv } from "@/db";
import { ApiError } from "./http";
import {
  assertVersionedKeyringVerifiers,
  createKeyCustodyVerifier,
  KeyringConfigurationError,
  resolveLegacyKeyAliasEnabled,
  resolveVersionedKeyring,
  type VersionedKeyMetadata,
  type ResolvedVersionedKeyring
} from "./keyring";

export const LEGACY_CREDENTIAL_KEY_ID = "legacy-credential-v2";
export const LEGACY_CREDENTIAL_LOOKUP_KEY_ID = "legacy-commitment-v2";
export const MARKETPLACE_CRYPTO_READER_VERSION = 3;

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
): Promise<{ ciphertext: string; iv: string; keyVersion: 2 | 3; keyId: string }> {
  if (plaintext.length < 8 || plaintext.length > 4_096) {
    throw new ApiError("INVALID_REQUEST", "网关令牌长度必须在 8 到 4096 字符之间。", 400);
  }
  const keyring = await credentialKeyring();
  const keyId = keyring.activeKeyId;
  const keyVersion = keyId === LEGACY_CREDENTIAL_KEY_ID ? 2 : 3;
  const encrypted = await encryptText(
    plaintext,
    await importAesKey(keyring.keyBytes(keyId)),
    credentialAdditionalData(context, keyVersion, keyId)
  );
  return { ...encrypted, keyVersion, keyId };
}

export async function decryptCredential(
  ciphertext: string,
  iv: string,
  keyVersion: number,
  keyId: string,
  context: CredentialEncryptionContext
): Promise<string> {
  const keyring = await credentialKeyring();
  if (keyVersion === 1 && keyId !== LEGACY_CREDENTIAL_KEY_ID) invalidKeyVersion();
  if (keyVersion === 2 && keyId !== LEGACY_CREDENTIAL_KEY_ID) invalidKeyVersion();
  if (keyVersion === 3 && keyId === LEGACY_CREDENTIAL_KEY_ID) invalidKeyVersion();
  if (keyVersion !== 1 && keyVersion !== 2 && keyVersion !== 3) invalidKeyVersion();
  return decryptText(
    ciphertext,
    iv,
    await importAesKey(referencedKeyBytes(keyring, keyId)),
    keyVersion === 1 ? undefined : credentialAdditionalData(context, keyVersion, keyId)
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
    keyVersion === 1
      ? await importAesKey(referencedKeyBytes(await credentialKeyring(), LEGACY_CREDENTIAL_KEY_ID))
      : keyVersion === 2
        ? await contentKey()
        : invalidKeyVersion(),
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

export interface CredentialLookupDigest {
  digest: string;
  version: 2 | 3;
  keyId: string;
}

export async function createCredentialLookupDigest(token: string): Promise<CredentialLookupDigest> {
  return (await createCredentialLookupDigests(token))[0]!;
}

export async function createCredentialLookupDigests(token: string): Promise<CredentialLookupDigest[]> {
  const keyring = await credentialLookupKeyring();
  return Promise.all(keyring.keyIds.map(async (keyId) => {
    const version = keyId === LEGACY_CREDENTIAL_LOOKUP_KEY_ID ? 2 : 3;
    const payload = new TextEncoder().encode(version === 2
      ? `gongsuanyun.credential-lookup.v2\n${token}`
      : `gongsuanyun.credential-lookup.v3\n${keyId}\n${token}`);
    const key = await crypto.subtle.importKey(
      "raw",
      keyring.keyBytes(keyId),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, payload);
    return { digest: bytesToHex(new Uint8Array(signature)), version, keyId };
  }));
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

export interface RuntimeCryptographicConfiguration {
  credentialActiveKeyId: string;
  credentialReadableKeyCount: number;
  credentialConfigurationGeneration: number | null;
  credentialStagedKeyCount: number;
  credentialLookupActiveKeyId: string;
  credentialLookupReadableKeyCount: number;
  credentialLookupConfigurationGeneration: number | null;
  credentialLookupStagedKeyCount: number;
  credentialLookupSeparated: boolean;
}

export interface CredentialKeyringInventory {
  credentialActiveKeyId: string;
  credentialKeyIds: readonly string[];
  credentialStagedKeyIds: readonly string[];
  credentialConfigurationGeneration: number | null;
  credentialCanonicalManifest: string | null;
  credentialKeyMetadata: readonly VersionedKeyMetadata[];
  credentialLookupActiveKeyId: string;
  credentialLookupKeyIds: readonly string[];
  credentialLookupStagedKeyIds: readonly string[];
  credentialLookupConfigurationGeneration: number | null;
  credentialLookupCanonicalManifest: string | null;
  credentialLookupKeyMetadata: readonly VersionedKeyMetadata[];
}

export async function getCredentialKeyringInventory(): Promise<CredentialKeyringInventory> {
  const [credentials, lookups] = await Promise.all([
    credentialKeyring(false),
    credentialLookupKeyring(false)
  ]);
  return {
    credentialActiveKeyId: credentials.activeKeyId,
    credentialKeyIds: credentials.keyIds,
    credentialStagedKeyIds: credentials.stagedKeyIds,
    credentialConfigurationGeneration: credentials.configurationGeneration,
    credentialCanonicalManifest: credentials.canonicalManifest,
    credentialKeyMetadata: credentials.allKeyIds.map((keyId) => credentials.keyMetadata(keyId)),
    credentialLookupActiveKeyId: lookups.activeKeyId,
    credentialLookupKeyIds: lookups.keyIds,
    credentialLookupStagedKeyIds: lookups.stagedKeyIds,
    credentialLookupConfigurationGeneration: lookups.configurationGeneration,
    credentialLookupCanonicalManifest: lookups.canonicalManifest,
    credentialLookupKeyMetadata: lookups.allKeyIds.map((keyId) => lookups.keyMetadata(keyId))
  };
}

/**
 * Returns only the non-secret verifier for one already configured runtime key.
 * The fresh-database baseline endpoint compares this with an independently
 * recorded recovery-system verifier before it can create the first canary.
 */
export async function createRuntimeKeyCustodyVerifier(
  domain: "credential-encryption" | "credential-lookup",
  keyId: string
): Promise<string> {
  const keyring = domain === "credential-encryption"
    ? await credentialKeyring(false)
    : await credentialLookupKeyring(false);
  return createKeyCustodyVerifier(domain, keyId, keyring.verificationKeyBytes(keyId));
}

export async function assertAppliedCredentialKeyringManifestState(): Promise<void> {
  await Promise.all([credentialKeyring(true), credentialLookupKeyring(true)]);
}

export interface CredentialEncryptionKeyCanary {
  ciphertext: string;
  iv: string;
  formatVersion: 1;
}

const CREDENTIAL_CANARY_PLAINTEXT = "gongsuanyun.credential-key-canary.v1";

export async function createCredentialEncryptionKeyCanary(
  keyId: string
): Promise<CredentialEncryptionKeyCanary> {
  const keyring = await credentialKeyring(false);
  const encrypted = await encryptText(
    CREDENTIAL_CANARY_PLAINTEXT,
    await importAesKey(referencedVerificationKeyBytes(keyring, keyId)),
    keyCanaryAdditionalData("credential-encryption", keyId)
  );
  return { ...encrypted, formatVersion: 1 };
}

export async function assertCredentialEncryptionKeyCanary(
  keyId: string,
  canary: CredentialEncryptionKeyCanary
): Promise<void> {
  if (canary.formatVersion !== 1) invalidRuntimeKeyConfiguration();
  const keyring = await credentialKeyring(false);
  const plaintext = await decryptText(
    canary.ciphertext,
    canary.iv,
    await importAesKey(referencedVerificationKeyBytes(keyring, keyId)),
    keyCanaryAdditionalData("credential-encryption", keyId)
  );
  if (plaintext !== CREDENTIAL_CANARY_PLAINTEXT) invalidRuntimeKeyConfiguration();
}

export async function createCredentialLookupKeyCanary(keyId: string): Promise<string> {
  const keyring = await credentialLookupKeyring(false);
  const key = await crypto.subtle.importKey(
    "raw",
    referencedVerificationKeyBytes(keyring, keyId),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const payload = new TextEncoder().encode(`gongsuanyun.lookup-key-canary.v1\n${keyId}`);
  const signature = await crypto.subtle.sign("HMAC", key, payload);
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Validates every readable production key without exporting key material. The
 * lookup legacy id is the sole deliberate alias: it maps the old lookup HMAC
 * to the commitment key until rows have lazily migrated to a dedicated ring.
 */
export async function assertRuntimeCryptographicConfiguration(): Promise<RuntimeCryptographicConfiguration> {
  const [credentials, lookups, contentBytes, artifactBytes, commitmentBytes] = await Promise.all([
    credentialKeyring(false),
    credentialLookupKeyring(false),
    contentKeyBytes(),
    artifactKeyBytes(),
    commitmentKeyBytes()
  ]);
  const materials: Array<{ label: string; fingerprint: string }> = [
    ...credentials.allKeyIds.map((keyId) => ({
      label: `credential:${keyId}`,
      fingerprint: bytesToHex(credentials.verificationKeyBytes(keyId))
    })),
    ...lookups.allKeyIds.map((keyId) => ({
      label: `lookup:${keyId}`,
      fingerprint: bytesToHex(lookups.verificationKeyBytes(keyId))
    })),
    { label: "content", fingerprint: bytesToHex(contentBytes) },
    { label: "artifact", fingerprint: bytesToHex(artifactBytes) },
    { label: "commitment", fingerprint: bytesToHex(commitmentBytes) }
  ];
  const byFingerprint = new Map<string, string[]>();
  for (const material of materials) {
    const labels = byFingerprint.get(material.fingerprint) ?? [];
    labels.push(material.label);
    byFingerprint.set(material.fingerprint, labels);
  }
  for (const labels of byFingerprint.values()) {
    if (labels.length === 1) continue;
    const expectedLegacyAlias = new Set([
      `lookup:${LEGACY_CREDENTIAL_LOOKUP_KEY_ID}`,
      "commitment"
    ]);
    if (labels.length !== 2 || labels.some((label) => !expectedLegacyAlias.has(label))) {
      invalidRuntimeKeyConfiguration();
    }
  }
  await Promise.all([
    importAesKey(credentials.keyBytes(credentials.activeKeyId)),
    contentKey(),
    artifactKey(),
    commitmentKey()
  ]);
  return {
    credentialActiveKeyId: credentials.activeKeyId,
    credentialReadableKeyCount: credentials.keyIds.length,
    credentialConfigurationGeneration: credentials.configurationGeneration,
    credentialStagedKeyCount: credentials.stagedKeyIds.length,
    credentialLookupActiveKeyId: lookups.activeKeyId,
    credentialLookupReadableKeyCount: lookups.keyIds.length,
    credentialLookupConfigurationGeneration: lookups.configurationGeneration,
    credentialLookupStagedKeyCount: lookups.stagedKeyIds.length,
    credentialLookupSeparated: lookups.activeKeyId !== LEGACY_CREDENTIAL_LOOKUP_KEY_ID
  };
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

async function credentialKeyring(enforceManifestState = true): Promise<ResolvedVersionedKeyring> {
  const runtime = getRuntimeEnv();
  try {
    const keyring = resolveVersionedKeyring({
      domain: "credential-encryption",
      serialized: runtime.MARKETPLACE_CREDENTIAL_KEYRING,
      slotManifest: runtime.MARKETPLACE_CREDENTIAL_KEYRING_MANIFEST,
      slotKeys: credentialKeySlots(runtime),
      legacyKey: runtime.MARKETPLACE_CREDENTIAL_KEY,
      legacyKeyId: LEGACY_CREDENTIAL_KEY_ID,
      developmentKey: process.env.NODE_ENV === "development"
        ? await developmentKey("gongsuanyun-local-development-only")
        : undefined
    });
    await assertVersionedKeyringVerifiers(keyring);
    if (enforceManifestState) await assertPersistedKeyringManifestState(keyring);
    return keyring;
  } catch (error) {
    if (error instanceof KeyringConfigurationError) invalidVersionedKeyringConfiguration(error);
    throw error;
  }
}

async function credentialLookupKeyring(enforceManifestState = true): Promise<ResolvedVersionedKeyring> {
  const runtime = getRuntimeEnv();
  try {
    const legacyEnabled = resolveLegacyKeyAliasEnabled(
      runtime.MARKETPLACE_CREDENTIAL_LOOKUP_LEGACY_ENABLED
    );
    const keyring = resolveVersionedKeyring({
      domain: "credential-lookup",
      serialized: runtime.MARKETPLACE_CREDENTIAL_LOOKUP_KEYRING,
      slotManifest: runtime.MARKETPLACE_CREDENTIAL_LOOKUP_KEYRING_MANIFEST,
      slotKeys: credentialLookupKeySlots(runtime),
      legacyKey: legacyEnabled ? runtime.MARKETPLACE_COMMITMENT_KEY : undefined,
      legacyKeyId: LEGACY_CREDENTIAL_LOOKUP_KEY_ID,
      legacyAliasEnabled: legacyEnabled,
      developmentKey: legacyEnabled && process.env.NODE_ENV === "development"
        ? await developmentKey("gongsuanyun-commitment-local-development-only")
        : undefined
    });
    await assertVersionedKeyringVerifiers(keyring);
    if (enforceManifestState) await assertPersistedKeyringManifestState(keyring);
    return keyring;
  } catch (error) {
    if (error instanceof KeyringConfigurationError) invalidVersionedKeyringConfiguration(error);
    throw error;
  }
}

async function assertPersistedKeyringManifestState(
  keyring: ResolvedVersionedKeyring
): Promise<void> {
  const row = await getD1().prepare(
    `SELECT generation, manifest_hash, minimum_reader_version
     FROM cryptographic_keyring_states WHERE domain = ?`
  ).bind(keyring.domain).first<{
    generation: number;
    manifest_hash: string;
    minimum_reader_version: number;
  }>();
  if (keyring.configurationGeneration === null || keyring.canonicalManifest === null) {
    if (row) {
      throw new ApiError(
        "CRYPTO_CONFIG_ROLLBACK",
        "已应用 slot manifest 后不能移除 manifest 并退回兼容源。",
        503
      );
    }
    return;
  }
  const expectedHash = await sha256Hex(keyring.canonicalManifest);
  if (row && row.generation > keyring.configurationGeneration) {
    throw new ApiError(
      "CRYPTO_CONFIG_ROLLBACK",
      "密钥 manifest generation 低于已应用配置，数据面已失败关闭。",
      503
    );
  }
  if (
    !row || row.minimum_reader_version > MARKETPLACE_CRYPTO_READER_VERSION ||
    row.generation !== keyring.configurationGeneration ||
    !constantTimeEqual(row.manifest_hash, expectedHash)
  ) invalidRuntimeKeyConfiguration();
}

function credentialKeySlots(runtime: Cloudflare.Env): readonly (string | undefined)[] {
  return [
    runtime.MARKETPLACE_CREDENTIAL_KEY_SLOT_01,
    runtime.MARKETPLACE_CREDENTIAL_KEY_SLOT_02,
    runtime.MARKETPLACE_CREDENTIAL_KEY_SLOT_03,
    runtime.MARKETPLACE_CREDENTIAL_KEY_SLOT_04,
    runtime.MARKETPLACE_CREDENTIAL_KEY_SLOT_05,
    runtime.MARKETPLACE_CREDENTIAL_KEY_SLOT_06,
    runtime.MARKETPLACE_CREDENTIAL_KEY_SLOT_07,
    runtime.MARKETPLACE_CREDENTIAL_KEY_SLOT_08
  ];
}

function credentialLookupKeySlots(runtime: Cloudflare.Env): readonly (string | undefined)[] {
  return [
    runtime.MARKETPLACE_CREDENTIAL_LOOKUP_KEY_SLOT_01,
    runtime.MARKETPLACE_CREDENTIAL_LOOKUP_KEY_SLOT_02,
    runtime.MARKETPLACE_CREDENTIAL_LOOKUP_KEY_SLOT_03,
    runtime.MARKETPLACE_CREDENTIAL_LOOKUP_KEY_SLOT_04,
    runtime.MARKETPLACE_CREDENTIAL_LOOKUP_KEY_SLOT_05,
    runtime.MARKETPLACE_CREDENTIAL_LOOKUP_KEY_SLOT_06,
    runtime.MARKETPLACE_CREDENTIAL_LOOKUP_KEY_SLOT_07,
    runtime.MARKETPLACE_CREDENTIAL_LOOKUP_KEY_SLOT_08
  ];
}

function referencedKeyBytes(
  keyring: ResolvedVersionedKeyring,
  keyId: string
): Uint8Array<ArrayBuffer> {
  try {
    return keyring.keyBytes(keyId);
  } catch (error) {
    if (error instanceof KeyringConfigurationError) {
      throw new ApiError(
        "CRYPTO_REFERENCED_KEY_MISSING",
        "生产凭据密钥环缺少记录引用的密钥。",
        503,
        true
      );
    }
    throw error;
  }
}

function referencedVerificationKeyBytes(
  keyring: ResolvedVersionedKeyring,
  keyId: string
): Uint8Array<ArrayBuffer> {
  try {
    return keyring.verificationKeyBytes(keyId);
  } catch (error) {
    if (error instanceof KeyringConfigurationError) {
      throw new ApiError(
        "CRYPTO_REFERENCED_KEY_MISSING",
        "生产凭据密钥环缺少待验证的密钥。",
        503,
        true
      );
    }
    throw error;
  }
}

async function importAesKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function artifactKey(): Promise<CryptoKey> {
  return importAesKey(await artifactKeyBytes());
}

async function contentKey(): Promise<CryptoKey> {
  return importAesKey(await contentKeyBytes());
}

async function commitmentKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    await commitmentKeyBytes(),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function artifactKeyBytes(): Promise<Uint8Array<ArrayBuffer>> {
  return singularKeyBytes(
    getRuntimeEnv().MARKETPLACE_ARTIFACT_KEY,
    "gongsuanyun-artifact-local-development-only",
    "ARTIFACT_STORAGE_UNAVAILABLE",
    "生产文件加密密钥尚未配置或格式无效。"
  );
}

async function contentKeyBytes(): Promise<Uint8Array<ArrayBuffer>> {
  return singularKeyBytes(
    getRuntimeEnv().MARKETPLACE_CONTENT_KEY,
    "gongsuanyun-content-local-development-only",
    "INTERNAL_ERROR",
    "生产内容加密密钥尚未配置或格式无效。"
  );
}

async function commitmentKeyBytes(): Promise<Uint8Array<ArrayBuffer>> {
  return singularKeyBytes(
    getRuntimeEnv().MARKETPLACE_COMMITMENT_KEY,
    "gongsuanyun-commitment-local-development-only",
    "INTERNAL_ERROR",
    "生产内容承诺密钥尚未配置或格式无效。"
  );
}

async function singularKeyBytes(
  configured: string | undefined,
  developmentSeed: string,
  code: "INTERNAL_ERROR" | "ARTIFACT_STORAGE_UNAVAILABLE",
  message: string
): Promise<Uint8Array<ArrayBuffer>> {
  const encoded = configured ?? (process.env.NODE_ENV === "development"
    ? await developmentKey(developmentSeed)
    : undefined);
  if (!encoded) throw new ApiError(code, message, 503);
  try {
    const bytes = base64ToBytes(encoded);
    if (bytes.byteLength !== 32) throw new Error("invalid key length");
    return bytes;
  } catch {
    throw new ApiError(code, message, 503);
  }
}

async function developmentKey(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  return bytesToBase64(new Uint8Array(digest));
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

function credentialAdditionalData(
  context: CredentialEncryptionContext,
  keyVersion: 2 | 3,
  keyId: string
): ArrayBuffer {
  return new TextEncoder().encode([
    keyVersion === 2 ? "gongsuanyun.credential.v2" : "gongsuanyun.credential.v3",
    ...(keyVersion === 3 ? [keyId] : []),
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

function keyCanaryAdditionalData(domain: "credential-encryption", keyId: string): ArrayBuffer {
  return new TextEncoder().encode([
    "gongsuanyun.key-canary.v1",
    domain,
    keyId
  ].join("\n")).buffer as ArrayBuffer;
}

function invalidKeyVersion(): never {
  throw new ApiError("INTERNAL_ERROR", "加密密钥版本不受支持。", 500);
}

function invalidRuntimeKeyConfiguration(): never {
  throw new ApiError("CRYPTO_CONFIG_INVALID", "生产加密密钥配置无效或未相互隔离。", 503);
}

function invalidVersionedKeyringConfiguration(error: KeyringConfigurationError): never {
  if (error.reason === "capacity") {
    throw new ApiError(
      "CRYPTO_KEYRING_CAPACITY_EXHAUSTED",
      "生产凭据密钥环超过八把密钥的安全容量上限。",
      503
    );
  }
  invalidRuntimeKeyConfiguration();
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

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

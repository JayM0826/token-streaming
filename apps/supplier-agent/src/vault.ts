import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import {
  SUPPLIER_AGENT_VAULT_VERSION,
  SupplierAgentError,
  type EncryptedSupplierAgentVault,
  type SupplierAgentProfile,
  type SupplierAgentSecrets
} from "./types.js";

const KDF_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export async function encryptSupplierAgentVault(
  secrets: SupplierAgentSecrets,
  passphrase: string,
  profile: SupplierAgentProfile
): Promise<EncryptedSupplierAgentVault> {
  validatePassphrase(passphrase);
  validateSecrets(secrets);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(profileAdditionalData(profile));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      vaultVersion: SUPPLIER_AGENT_VAULT_VERSION,
      kdf: "scrypt-v1",
      cipher: "aes-256-gcm",
      salt: salt.toString("base64url"),
      iv: iv.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url")
    };
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

export async function decryptSupplierAgentVault(
  value: unknown,
  passphrase: string,
  profile: SupplierAgentProfile
): Promise<SupplierAgentSecrets> {
  validatePassphrase(passphrase);
  const vault = validateVault(value);
  const salt = decode(vault.salt, 16, "salt");
  const iv = decode(vault.iv, 12, "iv");
  const authTag = decode(vault.authTag, 16, "authTag");
  const ciphertext = decode(vault.ciphertext, undefined, "ciphertext");
  const key = await deriveKey(passphrase, salt);
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(profileAdditionalData(profile));
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
    return validateSecrets(parsed);
  } catch {
    throw new SupplierAgentError("VAULT_UNLOCK_FAILED", "口令错误或本地密钥库已损坏。");
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}

export function validatePassphrase(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 1_024) {
    throw new SupplierAgentError("INVALID_INPUT", "本地加密口令必须包含 12 到 1024 个字符。");
  }
}

function validateVault(value: unknown): EncryptedSupplierAgentVault {
  if (!isRecord(value)) throw unlockFailure();
  const expected = ["vaultVersion", "kdf", "cipher", "salt", "iv", "authTag", "ciphertext"];
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length || keys.some((key) => !expected.includes(key)) ||
    value.vaultVersion !== SUPPLIER_AGENT_VAULT_VERSION || value.kdf !== "scrypt-v1" || value.cipher !== "aes-256-gcm"
  ) throw unlockFailure();
  for (const key of ["salt", "iv", "authTag", "ciphertext"] as const) {
    if (typeof value[key] !== "string" || value[key].length < 1 || value[key].length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(value[key])) {
      throw unlockFailure();
    }
  }
  return value as unknown as EncryptedSupplierAgentVault;
}

function validateSecrets(value: unknown): SupplierAgentSecrets {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !("gatewayToken" in value) || !("upstreamApiKey" in value)) {
    throw new SupplierAgentError("INVALID_INPUT", "供应凭据结构无效。");
  }
  if (typeof value.gatewayToken !== "string" || value.gatewayToken.length < 32 || value.gatewayToken.length > 4_096) {
    throw new SupplierAgentError("INVALID_INPUT", "网关令牌长度无效。");
  }
  if (typeof value.upstreamApiKey !== "string" || value.upstreamApiKey.length < 8 || value.upstreamApiKey.length > 4_096) {
    throw new SupplierAgentError("INVALID_INPUT", "Provider API Key 长度无效。");
  }
  return { gatewayToken: value.gatewayToken, upstreamApiKey: value.upstreamApiKey };
}

function profileAdditionalData(profile: SupplierAgentProfile): Buffer {
  const canonicalProfile = canonicalJson(profile);
  return createHash("sha256")
    .update("gongsuanyun:supplier-agent:vault-profile:v2\0", "utf8")
    .update(canonicalProfile, "utf8")
    .digest();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(passphrase, salt, 32, KDF_OPTIONS, (error, key) => error ? reject(error) : resolve(key as Buffer));
  });
}

function decode(value: string, expectedLength: number | undefined, label: string): Buffer {
  const result = Buffer.from(value, "base64url");
  if ((expectedLength !== undefined && result.length !== expectedLength) || result.length === 0) {
    throw new SupplierAgentError("VAULT_UNLOCK_FAILED", `本地密钥库 ${label} 无效。`);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unlockFailure(): SupplierAgentError {
  return new SupplierAgentError("VAULT_UNLOCK_FAILED", "本地密钥库格式无效。");
}

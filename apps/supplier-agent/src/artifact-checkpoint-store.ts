import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SupplierArtifactCheckpointState } from "@token-streaming/supplier-node/runtime";

interface EncryptedCheckpoint {
  version: "gongsuanyun.agent-checkpoint.v2";
  cipher: "aes-256-gcm";
  createdAt: string;
  expiresAt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface SupplierArtifactCheckpointStoreOptions {
  ttlMilliseconds?: number;
  cleanupBatchSize?: number;
  now?: () => number;
}

export interface SupplierArtifactCheckpointCleanupResult {
  inspected: number;
  deleted: number;
  failed: number;
}

const MAX_CHECKPOINT_TTL_MILLISECONDS = 6 * 60 * 60_000;
const MAX_CHECKPOINT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CLOCK_SKEW_MILLISECONDS = 5 * 60_000;
const CHECKPOINT_SUFFIX = ".checkpoint.json";

export class SupplierArtifactCheckpointStore {
  private readonly directory: string;
  private readonly ttlMilliseconds: number;
  private readonly cleanupBatchSize: number;
  private readonly now: () => number;
  private cleanupCursor: string | undefined;

  constructor(root: string, options: SupplierArtifactCheckpointStoreOptions = {}) {
    this.directory = path.join(root, "artifact-checkpoints");
    this.ttlMilliseconds = boundedInteger(
      options.ttlMilliseconds ?? MAX_CHECKPOINT_TTL_MILLISECONDS,
      1,
      MAX_CHECKPOINT_TTL_MILLISECONDS,
      "checkpoint TTL"
    );
    this.cleanupBatchSize = boundedInteger(options.cleanupBatchSize ?? 100, 1, 1_000, "checkpoint cleanup batch size");
    this.now = options.now ?? Date.now;
  }

  async read(taskId: string, gatewayToken: string): Promise<SupplierArtifactCheckpointState | undefined> {
    const file = this.file(taskId);
    try {
      const envelope = await readEnvelope(file, this.now());
      const decipher = createDecipheriv("aes-256-gcm", checkpointKey(gatewayToken), Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(checkpointAdditionalData(taskId, envelope));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final()
      ]);
      try {
        return JSON.parse(plaintext.toString("utf8")) as SupplierArtifactCheckpointState;
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      if (isMissing(error)) return undefined;
      await discardUnsafeCheckpoint(file);
      return undefined;
    }
  }

  async write(taskId: string, gatewayToken: string, checkpoint: SupplierArtifactCheckpointState): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(checkpoint), "utf8");
    let temporary: string | undefined;
    try {
      if (plaintext.byteLength > 24 * 1024 * 1024) throw new Error("Artifact checkpoint exceeds the local safety limit.");
      const file = this.file(taskId);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const now = this.now();
      const lifetime = await this.readAuthenticatedLifetime(file, taskId, gatewayToken, now);
      const createdAt = lifetime?.createdAt ?? new Date(now).toISOString();
      const expiresAt = lifetime?.expiresAt ?? new Date(now + this.ttlMilliseconds).toISOString();
      const iv = randomBytes(12);
      const envelope: EncryptedCheckpoint = {
        version: "gongsuanyun.agent-checkpoint.v2",
        cipher: "aes-256-gcm",
        createdAt,
        expiresAt,
        iv: iv.toString("base64"),
        authTag: "",
        ciphertext: ""
      };
      const cipher = createCipheriv("aes-256-gcm", checkpointKey(gatewayToken), iv);
      cipher.setAAD(checkpointAdditionalData(taskId, envelope));
      envelope.ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64");
      envelope.authTag = cipher.getAuthTag().toString("base64");
      temporary = `${file}.${process.pid}.${now}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, file);
      temporary = undefined;
      await chmod(file, 0o600).catch(() => undefined);
    } finally {
      plaintext.fill(0);
      if (temporary) await unlink(temporary).catch(() => undefined);
    }
  }

  async delete(taskId: string): Promise<void> {
    await unlink(this.file(taskId)).catch((error: unknown) => {
      if (!isMissing(error)) {
        throw checkpointStoreError(
          "CHECKPOINT_CLEANUP_FAILED",
          "Artifact checkpoint could not be removed.",
          error
        );
      }
    });
  }

  async cleanupExpired(): Promise<SupplierArtifactCheckpointCleanupResult> {
    let names: string[];
    try {
      names = (await readdir(this.directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && isCheckpointCandidate(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (isMissing(error)) return { inspected: 0, deleted: 0, failed: 0 };
      throw checkpointStoreError("CHECKPOINT_DIRECTORY_UNAVAILABLE", "Artifact checkpoint directory cannot be inspected.", error);
    }
    if (names.length === 0) {
      this.cleanupCursor = undefined;
      return { inspected: 0, deleted: 0, failed: 0 };
    }
    const cursor = this.cleanupCursor;
    const start = cursor === undefined
      ? 0
      : Math.max(0, names.findIndex((name) => name > cursor));
    const ordered = [...names.slice(start), ...names.slice(0, start)];
    const selected = ordered.slice(0, this.cleanupBatchSize);
    let deleted = 0;
    let failed = 0;
    const now = this.now();
    for (const name of selected) {
      const file = path.join(this.directory, name);
      try {
        if (isCheckpointTemporary(name)) throw new Error("Orphaned artifact checkpoint temporary file.");
        await readEnvelope(file, now);
      } catch (error) {
        if (isMissing(error)) continue;
        try {
          await unlink(file);
          deleted += 1;
        } catch (deletionError) {
          if (!isMissing(deletionError)) failed += 1;
        }
      }
    }
    this.cleanupCursor = selected.at(-1);
    return { inspected: selected.length, deleted, failed };
  }

  private file(taskId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(taskId)) throw new Error("Artifact task id is invalid.");
    return path.join(this.directory, `${taskId}${CHECKPOINT_SUFFIX}`);
  }

  private async readAuthenticatedLifetime(
    file: string,
    taskId: string,
    gatewayToken: string,
    now: number
  ): Promise<Pick<EncryptedCheckpoint, "createdAt" | "expiresAt"> | undefined> {
    try {
      const envelope = await readEnvelope(file, now);
      const decipher = createDecipheriv("aes-256-gcm", checkpointKey(gatewayToken), Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(checkpointAdditionalData(taskId, envelope));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final()
      ]);
      plaintext.fill(0);
      return { createdAt: envelope.createdAt, expiresAt: envelope.expiresAt };
    } catch (error) {
      if (isMissing(error)) return undefined;
      await discardUnsafeCheckpoint(file);
      return undefined;
    }
  }
}

async function readEnvelope(file: string, now: number): Promise<EncryptedCheckpoint> {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_CHECKPOINT_FILE_BYTES) {
    throw new Error("Encrypted artifact checkpoint exceeds the local safety limit.");
  }
  const raw = await readFile(file, "utf8");
  const envelope = JSON.parse(raw) as unknown;
  if (!isRecord(envelope)) throw new Error("Encrypted artifact checkpoint format is invalid.");
  const expected = ["version", "cipher", "createdAt", "expiresAt", "iv", "authTag", "ciphertext"];
  const keys = Object.keys(envelope);
  if (
    keys.length !== expected.length || keys.some((key) => !expected.includes(key)) ||
    envelope.version !== "gongsuanyun.agent-checkpoint.v2" || envelope.cipher !== "aes-256-gcm" ||
    typeof envelope.createdAt !== "string" || typeof envelope.expiresAt !== "string" ||
    typeof envelope.iv !== "string" || typeof envelope.authTag !== "string" || typeof envelope.ciphertext !== "string" ||
    !isBase64(envelope.iv) || !isBase64(envelope.authTag) || !isBase64(envelope.ciphertext) ||
    Buffer.from(envelope.iv, "base64").byteLength !== 12 || Buffer.from(envelope.authTag, "base64").byteLength !== 16
  ) throw new Error("Encrypted artifact checkpoint format is invalid.");
  const createdAt = parseCanonicalTimestamp(envelope.createdAt);
  const expiresAt = parseCanonicalTimestamp(envelope.expiresAt);
  if (
    expiresAt <= createdAt || expiresAt - createdAt > MAX_CHECKPOINT_TTL_MILLISECONDS ||
    createdAt > now + MAX_CLOCK_SKEW_MILLISECONDS || expiresAt <= now
  ) throw new Error("Encrypted artifact checkpoint has expired or has an invalid lifetime.");
  return envelope as unknown as EncryptedCheckpoint;
}

function checkpointAdditionalData(taskId: string, envelope: Pick<EncryptedCheckpoint, "version" | "createdAt" | "expiresAt">): Buffer {
  return Buffer.from([
    envelope.version,
    taskId,
    envelope.createdAt,
    envelope.expiresAt
  ].join("\n"), "utf8");
}

async function discardUnsafeCheckpoint(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if (isMissing(error)) return;
    throw checkpointStoreError(
      "CHECKPOINT_CLEANUP_FAILED",
      "Unsafe artifact checkpoint could not be removed.",
      error
    );
  }
}

function parseCanonicalTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Encrypted artifact checkpoint timestamp is invalid.");
  }
  return parsed;
}

function isBase64(value: string): boolean {
  return value.length > 0 && value.length <= MAX_CHECKPOINT_FILE_BYTES * 2 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isCheckpointCandidate(name: string): boolean {
  return name.endsWith(CHECKPOINT_SUFFIX) || isCheckpointTemporary(name);
}

function isCheckpointTemporary(name: string): boolean {
  return name.includes(`${CHECKPOINT_SUFFIX}.`) && name.endsWith(".tmp");
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${label}.`);
  return value;
}

function checkpointStoreError(code: string, message: string, cause: unknown): Error & { code: string } {
  return Object.assign(new Error(message, { cause }), { name: "SupplierArtifactCheckpointStoreError", code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkpointKey(gatewayToken: string): Buffer {
  return createHash("sha256")
    .update("gongsuanyun.agent-checkpoint-key.v1\n", "utf8")
    .update(gatewayToken, "utf8")
    .digest();
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

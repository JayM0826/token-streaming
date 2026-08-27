import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SupplierArtifactCheckpointState } from "@token-streaming/supplier-node/runtime";

interface EncryptedCheckpoint {
  version: "gongsuanyun.agent-checkpoint.v1";
  cipher: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class SupplierArtifactCheckpointStore {
  private readonly directory: string;

  constructor(root: string) {
    this.directory = path.join(root, "artifact-checkpoints");
  }

  async read(taskId: string, gatewayToken: string): Promise<SupplierArtifactCheckpointState | undefined> {
    const file = this.file(taskId);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (Buffer.byteLength(raw, "utf8") > 32 * 1024 * 1024) throw new Error("Encrypted artifact checkpoint exceeds the local safety limit.");
    const envelope = JSON.parse(raw) as EncryptedCheckpoint;
    if (
      envelope.version !== "gongsuanyun.agent-checkpoint.v1" || envelope.cipher !== "aes-256-gcm" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.iv) || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.authTag) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)
    ) throw new Error("Encrypted artifact checkpoint format is invalid.");
    const decipher = createDecipheriv("aes-256-gcm", checkpointKey(gatewayToken), Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(taskId, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
    return JSON.parse(plaintext) as SupplierArtifactCheckpointState;
  }

  async write(taskId: string, gatewayToken: string, checkpoint: SupplierArtifactCheckpointState): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(checkpoint), "utf8");
    if (plaintext.byteLength > 24 * 1024 * 1024) throw new Error("Artifact checkpoint exceeds the local safety limit.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", checkpointKey(gatewayToken), iv);
    cipher.setAAD(Buffer.from(taskId, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: EncryptedCheckpoint = {
      version: "gongsuanyun.agent-checkpoint.v1",
      cipher: "aes-256-gcm",
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(taskId);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, file);
    await chmod(file, 0o600).catch(() => undefined);
  }

  async delete(taskId: string): Promise<void> {
    await unlink(this.file(taskId)).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }

  private file(taskId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(taskId)) throw new Error("Artifact task id is invalid.");
    return path.join(this.directory, `${taskId}.checkpoint.json`);
  }
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

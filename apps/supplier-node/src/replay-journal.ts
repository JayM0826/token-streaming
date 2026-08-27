import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { dirname } from "node:path";
import { SupplierNodeError } from "./errors.js";

type NonceRecordV2 = { version: 2; kind: "nonce"; key: string; expiresAt: number };
type RequestRecordV2 = {
  version: 2;
  kind: "request";
  key: string;
  bodyCommitment: string;
  expiresAt: number;
};
type ReplayRecordV2 = NonceRecordV2 | RequestRecordV2;
type LegacyNonceRecord = { version: 1; kind: "nonce"; key: string; expiresAt: number };
type LegacyRequestRecord = {
  version: 1;
  kind: "request";
  key: string;
  bodySha256: string;
  expiresAt: number;
};
type ParsedReplayRecord = ReplayRecordV2 | LegacyNonceRecord | LegacyRequestRecord;

export interface PersistentReplayJournalOptions {
  compactionIntervalMilliseconds?: number;
  now?: () => number;
}

const MAXIMUM_JOURNAL_BYTES = 16 * 1024 * 1024;
const SIZE_COMPACTION_THRESHOLD_BYTES = 8 * 1024 * 1024;
const DEFAULT_COMPACTION_INTERVAL_MILLISECONDS = 5 * 60_000;
const APPEND_COMPACTION_THRESHOLD = 1_000;
const BODY_COMMITMENT_DOMAIN = "gongsuanyun.supplier-node.replay-body-commitment.v2\n";

/**
 * Crash-safe metadata-only replay journal. Claims are fsynced before upstream
 * execution. Request bodies are represented only by a gateway-token-keyed,
 * domain-separated commitment; raw body digests and content are never written.
 */
export class PersistentReplayJournal {
  private readonly nonces = new Map<string, number>();
  private readonly requests = new Map<string, { bodyCommitment: string; expiresAt: number }>();
  private readonly now: () => number;
  private readonly compactionIntervalMilliseconds: number;
  private appendedSinceCompaction = 0;
  private lastCompactedAt: number;
  private terminalFailure: unknown;
  private compactionTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly journalPath: string,
    private readonly gatewayToken: string,
    options: PersistentReplayJournalOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.compactionIntervalMilliseconds = boundedInteger(
      options.compactionIntervalMilliseconds ?? DEFAULT_COMPACTION_INTERVAL_MILLISECONDS,
      1_000,
      60 * 60_000,
      "replay journal compaction interval"
    );
    const nowMs = this.now();
    this.lastCompactedAt = nowMs;
    const directory = dirname(journalPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existsSync(journalPath)) createEmptyJournal(journalPath, directory);
    chmodSync(journalPath, 0o600);
    if (statSync(journalPath).size > MAXIMUM_JOURNAL_BYTES) {
      throw new Error("Supplier replay journal exceeds the 16 MiB safety limit.");
    }
    this.load(readFileSync(journalPath, "utf8"), nowMs);
    // Rewrites active v1 records as keyed v2 records before startup completes.
    this.compact(nowMs);
    this.compactionTimer = setInterval(() => {
      try {
        this.compactNow();
      } catch {
        // compactNow records a terminal failure; claims and readiness then fail closed.
      }
    }, this.compactionIntervalMilliseconds);
    this.compactionTimer.unref();
  }

  isHealthy(): boolean {
    return this.terminalFailure === undefined;
  }

  close(): void {
    if (this.compactionTimer) clearInterval(this.compactionTimer);
    this.compactionTimer = undefined;
  }

  /** Manual/testable entry used by the same fail-closed background compactor. */
  compactNow(nowMs = this.now()): void {
    this.assertHealthy();
    try {
      this.compact(nowMs);
    } catch (error) {
      this.terminalFailure = error;
      throw replayProtectionUnavailable();
    }
  }

  claimNonce(nonce: string, expiresAt: number, nowMs: number): void {
    this.assertHealthy();
    this.prune(nowMs);
    const key = digestIdentifier(nonce);
    if ((this.nonces.get(key) ?? -1) >= nowMs) {
      throw new SupplierNodeError("REPLAY_DETECTED", "请求 nonce 已经使用。", 409);
    }
    const record: NonceRecordV2 = { version: 2, kind: "nonce", key, expiresAt };
    this.append(record, nowMs);
    this.nonces.set(key, expiresAt);
    this.maybeCompactAfterAppend(nowMs);
  }

  claimRequest(requestId: string, bodySha256: string, expiresAt: number, nowMs: number): void {
    this.assertHealthy();
    this.prune(nowMs);
    const key = digestIdentifier(requestId);
    const bodyCommitment = createBodyCommitment(this.gatewayToken, bodySha256);
    const prior = this.requests.get(key);
    if (prior && prior.expiresAt >= nowMs) {
      if (prior.bodyCommitment !== bodyCommitment) {
        throw new SupplierNodeError("IDEMPOTENCY_CONFLICT", "同一任务标识对应了不同请求体。", 409);
      }
      throw new SupplierNodeError(
        "REPLAY_DETECTED",
        "任务已在当前或先前节点进程中受理；为避免重复上游计费，本次不再执行。",
        409
      );
    }
    const record: RequestRecordV2 = { version: 2, kind: "request", key, bodyCommitment, expiresAt };
    this.append(record, nowMs);
    this.requests.set(key, { bodyCommitment, expiresAt });
    this.maybeCompactAfterAppend(nowMs);
  }

  private load(serialized: string, nowMs: number): void {
    for (const line of serialized.split("\n")) {
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        invalidJournal();
      }
      const record = parseRecord(value);
      if (record.expiresAt < nowMs) continue;
      if (record.kind === "nonce") {
        if (this.nonces.has(record.key)) invalidJournal();
        this.nonces.set(record.key, record.expiresAt);
        continue;
      }
      const bodyCommitment = record.version === 1
        ? createBodyCommitment(this.gatewayToken, record.bodySha256)
        : record.bodyCommitment;
      if (this.requests.has(record.key)) invalidJournal();
      this.requests.set(record.key, { bodyCommitment, expiresAt: record.expiresAt });
    }
  }

  private append(record: ReplayRecordV2, nowMs: number): void {
    const serialized = `${JSON.stringify(record)}\n`;
    try {
      let currentBytes = statSync(this.journalPath).size;
      const additionBytes = Buffer.byteLength(serialized, "utf8");
      if (currentBytes + additionBytes > MAXIMUM_JOURNAL_BYTES) {
        this.compact(nowMs);
        currentBytes = statSync(this.journalPath).size;
      }
      if (currentBytes + additionBytes > MAXIMUM_JOURNAL_BYTES) {
        throw new Error("Supplier replay journal cannot accept another claim within its 16 MiB limit.");
      }
      const descriptor = openSync(this.journalPath, "a", 0o600);
      try {
        writeAll(descriptor, Buffer.from(serialized, "utf8"));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      this.appendedSinceCompaction += 1;
    } catch (error) {
      this.terminalFailure = error;
      throw replayProtectionUnavailable();
    }
  }

  private maybeCompactAfterAppend(nowMs: number): void {
    try {
      const shouldCompact =
        this.appendedSinceCompaction >= APPEND_COMPACTION_THRESHOLD ||
        nowMs - this.lastCompactedAt >= this.compactionIntervalMilliseconds ||
        statSync(this.journalPath).size >= SIZE_COMPACTION_THRESHOLD_BYTES;
      if (shouldCompact) this.compact(nowMs);
    } catch (error) {
      this.terminalFailure = error;
      throw replayProtectionUnavailable();
    }
  }

  private assertHealthy(): void {
    if (this.terminalFailure !== undefined) throw replayProtectionUnavailable();
  }

  private prune(nowMs: number): void {
    for (const [key, expiresAt] of this.nonces) {
      if (expiresAt < nowMs) this.nonces.delete(key);
    }
    for (const [key, entry] of this.requests) {
      if (entry.expiresAt < nowMs) this.requests.delete(key);
    }
  }

  private compact(nowMs: number): void {
    this.prune(nowMs);
    const lines: string[] = [];
    for (const [key, expiresAt] of this.nonces) {
      lines.push(JSON.stringify({ version: 2, kind: "nonce", key, expiresAt } satisfies NonceRecordV2));
    }
    for (const [key, entry] of this.requests) {
      lines.push(JSON.stringify({
        version: 2,
        kind: "request",
        key,
        bodyCommitment: entry.bodyCommitment,
        expiresAt: entry.expiresAt
      } satisfies RequestRecordV2));
    }
    const serialized = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_JOURNAL_BYTES) {
      throw new Error("Supplier replay journal active set exceeds the 16 MiB safety limit.");
    }
    const temporaryPath = `${this.journalPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      const descriptor = openSync(temporaryPath, "r+");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, this.journalPath);
      chmodSync(this.journalPath, 0o600);
      fsyncDirectoryBestEffort(dirname(this.journalPath));
    } finally {
      try {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      } catch {
        // A uniquely named metadata-only temp is ignored; startup reads only the canonical journal.
      }
    }
    this.appendedSinceCompaction = 0;
    this.lastCompactedAt = nowMs;
  }
}

function parseRecord(value: unknown): ParsedReplayRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidJournal();
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.version !== 1 && candidate.version !== 2) ||
    (candidate.kind !== "nonce" && candidate.kind !== "request") ||
    typeof candidate.key !== "string" || !/^[a-f0-9]{64}$/.test(candidate.key) ||
    !Number.isSafeInteger(candidate.expiresAt) || (candidate.expiresAt as number) < 0
  ) invalidJournal();
  if (candidate.kind === "nonce") {
    if (Object.keys(candidate).length !== 4) invalidJournal();
    return candidate as unknown as NonceRecordV2 | LegacyNonceRecord;
  }
  if (candidate.version === 1) {
    if (
      Object.keys(candidate).length !== 5 ||
      typeof candidate.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.bodySha256)
    ) invalidJournal();
    return candidate as unknown as LegacyRequestRecord;
  }
  if (
    Object.keys(candidate).length !== 5 ||
    typeof candidate.bodyCommitment !== "string" || !/^[a-f0-9]{64}$/.test(candidate.bodyCommitment)
  ) invalidJournal();
  return candidate as unknown as RequestRecordV2;
}

function createEmptyJournal(journalPath: string, directory: string): void {
  const descriptor = openSync(journalPath, "wx", 0o600);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectoryBestEffort(directory);
}

function fsyncDirectoryBestEffort(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return ["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(
    String((error as NodeJS.ErrnoException).code)
  );
}

function writeAll(descriptor: number, value: Buffer): void {
  let offset = 0;
  while (offset < value.byteLength) {
    const written = writeSync(descriptor, value, offset, value.byteLength - offset);
    if (written < 1) throw new Error("Supplier replay journal write made no progress.");
    offset += written;
  }
}

function invalidJournal(): never {
  throw new Error("Supplier replay journal is corrupt; refusing to start without replay protection.");
}

function replayProtectionUnavailable(): SupplierNodeError {
  return new SupplierNodeError("INTERNAL_ERROR", "节点重放保护不可用，已停止受理请求。", 503, true);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${label}.`);
  return value;
}

function digestIdentifier(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createBodyCommitment(gatewayToken: string, bodySha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(bodySha256)) throw new Error("Request body digest is invalid.");
  return createHmac("sha256", gatewayToken)
    .update(BODY_COMMITMENT_DOMAIN, "utf8")
    .update(bodySha256, "ascii")
    .digest("hex");
}

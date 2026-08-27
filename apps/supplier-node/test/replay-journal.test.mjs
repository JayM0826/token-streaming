import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PersistentReplayJournal } from "../dist/replay-journal.js";
import { sha256Hex } from "../dist/signature.js";

const gatewayToken = "gateway-token-abcdefghijklmnopqrstuvwxyz-123456";

test("legacy v1 records migrate to keyed v2 without losing active replay protection", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gongsuanyun-replay-v1-"));
  const journalPath = path.join(root, "replay.jsonl");
  const now = Date.parse("2026-08-28T00:00:00.000Z");
  const nonce = "nonce-legacy-migration-1234";
  const requestId = "job-legacy-migration-1234";
  const bodySha256 = sha256Hex("low entropy customer body");
  await writeFile(journalPath, [
    JSON.stringify({ version: 1, kind: "nonce", key: digest(nonce), expiresAt: now + 300_000 }),
    JSON.stringify({ version: 1, kind: "request", key: digest(requestId), bodySha256, expiresAt: now + 900_000 }),
    ""
  ].join("\n"), { mode: 0o600 });
  const journal = new PersistentReplayJournal(journalPath, gatewayToken, { now: () => now });
  t.after(async () => {
    journal.close();
    await rm(root, { recursive: true, force: true });
  });

  const migrated = await readFile(journalPath, "utf8");
  assert.match(migrated, /"version":2/);
  assert.match(migrated, /"bodyCommitment":"[a-f0-9]{64}"/);
  assert.doesNotMatch(migrated, /bodySha256|low entropy customer body/);
  assert.equal(migrated.includes(bodySha256), false);
  assert.throws(
    () => journal.claimNonce(nonce, now + 300_000, now),
    (error) => error.code === "REPLAY_DETECTED"
  );
  assert.throws(
    () => journal.claimRequest(requestId, bodySha256, now + 900_000, now),
    (error) => error.code === "REPLAY_DETECTED"
  );
  assert.throws(
    () => journal.claimRequest(requestId, sha256Hex("different body"), now + 900_000, now),
    (error) => error.code === "IDEMPOTENCY_CONFLICT"
  );
});

test("manual periodic compaction removes expired low-volume records and retains append-triggered claims", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gongsuanyun-replay-expiry-"));
  const journalPath = path.join(root, "replay.jsonl");
  let now = Date.parse("2026-08-28T00:00:00.000Z");
  let journal = new PersistentReplayJournal(journalPath, gatewayToken, {
    now: () => now,
    compactionIntervalMilliseconds: 1_000
  });
  t.after(async () => {
    journal.close();
    await rm(root, { recursive: true, force: true });
  });
  const requestId = "job-time-compaction-1234";
  const bodySha256 = sha256Hex("private body");
  now += 2_000;
  journal.claimRequest(requestId, bodySha256, now + 2_000, now);
  journal.close();

  journal = new PersistentReplayJournal(journalPath, gatewayToken, { now: () => now });
  assert.throws(
    () => journal.claimRequest(requestId, bodySha256, now + 2_000, now),
    (error) => error.code === "REPLAY_DETECTED"
  );
  now += 2_001;
  journal.compactNow(now);
  assert.equal(await readFile(journalPath, "utf8"), "");
});

test("corrupt journals refuse startup and compaction failures poison subsequent claims", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gongsuanyun-replay-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const corruptPath = path.join(root, "corrupt.jsonl");
  await writeFile(corruptPath, "{not-json}\n", { mode: 0o600 });
  assert.throws(
    () => new PersistentReplayJournal(corruptPath, gatewayToken),
    /corrupt; refusing to start/
  );

  const failedPath = path.join(root, "failed.jsonl");
  const now = Date.parse("2026-08-28T00:00:00.000Z");
  const journal = new PersistentReplayJournal(failedPath, gatewayToken, {
    now: () => now,
    compactionIntervalMilliseconds: 1_000
  });
  t.after(() => journal.close());
  await rm(failedPath);
  await mkdir(failedPath);
  await waitUntil(() => !journal.isHealthy());
  assert.equal(journal.isHealthy(), false);
  assert.throws(
    () => journal.claimNonce("nonce-after-compact-failure", now + 300_000, now),
    (error) => error.code === "INTERNAL_ERROR" && error.status === 503 && error.retryable === true
  );
});

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(predicate(), true, "background compaction did not run before the test deadline");
}

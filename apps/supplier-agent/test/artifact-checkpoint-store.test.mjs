import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SupplierArtifactCheckpointStore } from "../dist/artifact-checkpoint-store.js";

test("artifact checkpoints are encrypted, task-bound, resumable, and deletable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gongsuanyun-checkpoint-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = Date.parse("2026-08-28T00:00:00.000Z");
  const store = new SupplierArtifactCheckpointStore(root, { now: () => now });
  const taskId = "artifact-task-checkpoint-12345678";
  const token = "gateway-token-abcdefghijklmnopqrstuvwxyz-123456";
  const checkpoint = {
    protocolVersion: "gongsuanyun.artifact-worker.v2",
    taskId,
    artifactManifestSha256: "a".repeat(64),
    model: "model-exact-2026-08-25",
    completedSegments: 2,
    processedBytes: 1024,
    summaries: ["sensitive summary"],
    providerRequestIds: ["provider-request-1"],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
  };

  await store.write(taskId, token, checkpoint);
  const file = path.join(root, "artifact-checkpoints", `${taskId}.checkpoint.json`);
  const raw = await readFile(file, "utf8");
  const firstEnvelope = JSON.parse(raw);
  assert.equal(raw.includes("sensitive summary"), false);
  assert.equal(firstEnvelope.version, "gongsuanyun.agent-checkpoint.v2");
  assert.equal(firstEnvelope.createdAt, "2026-08-28T00:00:00.000Z");
  assert.equal(firstEnvelope.expiresAt, "2026-08-28T06:00:00.000Z");
  assert.deepEqual(await store.read(taskId, token), checkpoint);

  now += 60 * 60_000;
  const updated = { ...checkpoint, summaries: ["updated sensitive summary"] };
  await store.write(taskId, token, updated);
  const secondEnvelope = JSON.parse(await readFile(file, "utf8"));
  assert.equal(secondEnvelope.createdAt, firstEnvelope.createdAt);
  assert.equal(secondEnvelope.expiresAt, firstEnvelope.expiresAt);
  assert.deepEqual(await store.read(taskId, token), updated);

  secondEnvelope.expiresAt = "2026-08-28T05:59:00.000Z";
  await writeFile(file, JSON.stringify(secondEnvelope), "utf8");
  assert.equal(await store.read(taskId, token), undefined);
  await assert.rejects(() => access(file), { code: "ENOENT" });

  await store.write(taskId, token, checkpoint);
  assert.equal(await store.read(taskId, `${token}-wrong`), undefined);
  await assert.rejects(() => access(file), { code: "ENOENT" });
  await store.delete(taskId);
  assert.equal(await store.read(taskId, token), undefined);
});

test("checkpoint cleanup is bounded and removes expired, legacy, and corrupt files without blocking", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gongsuanyun-checkpoint-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "artifact-checkpoints");
  await mkdir(directory, { recursive: true });
  for (const taskId of ["artifact-task-a-12345678", "artifact-task-b-12345678", "artifact-task-c-12345678"]) {
    await writeFile(path.join(directory, `${taskId}.checkpoint.json`), JSON.stringify({
      version: "gongsuanyun.agent-checkpoint.v1",
      cipher: "aes-256-gcm",
      iv: "legacy",
      authTag: "legacy",
      ciphertext: "legacy"
    }));
  }
  await writeFile(path.join(directory, "artifact-task-d-12345678.checkpoint.json"), "not-json");
  await writeFile(path.join(directory, "artifact-task-e-12345678.checkpoint.json.1.2.deadbeef.tmp"), "orphaned");
  const store = new SupplierArtifactCheckpointStore(root, {
    cleanupBatchSize: 2,
    now: () => Date.parse("2026-08-28T07:00:00.000Z")
  });

  const first = await store.cleanupExpired();
  const second = await store.cleanupExpired();
  const third = await store.cleanupExpired();
  assert.deepEqual(first, { inspected: 2, deleted: 2, failed: 0 });
  assert.deepEqual(second, { inspected: 2, deleted: 2, failed: 0 });
  assert.deepEqual(third, { inspected: 1, deleted: 1, failed: 0 });
  assert.deepEqual(await store.cleanupExpired(), { inspected: 0, deleted: 0, failed: 0 });
});

test("expired checkpoints are discarded on read and cannot outlive the six-hour cap", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gongsuanyun-checkpoint-expiry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = "artifact-task-expiry-12345678";
  const token = "gateway-token-abcdefghijklmnopqrstuvwxyz-123456";
  let now = Date.parse("2026-08-28T00:00:00.000Z");
  const firstProcess = new SupplierArtifactCheckpointStore(root, { now: () => now });
  await firstProcess.write(taskId, token, checkpointValue(taskId));

  now += 6 * 60 * 60_000 + 1;
  const restarted = new SupplierArtifactCheckpointStore(root, { now: () => now });
  assert.equal(await restarted.read(taskId, token), undefined);
  await assert.rejects(
    () => access(path.join(root, "artifact-checkpoints", `${taskId}.checkpoint.json`)),
    { code: "ENOENT" }
  );
});

test("artifact checkpoint paths reject traversal-like task ids", async () => {
  const store = new SupplierArtifactCheckpointStore(tmpdir());
  await assert.rejects(() => store.write("../outside", "x".repeat(32), {}));
});

test("checkpoint deletion failures use a stable fail-closed code", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gongsuanyun-checkpoint-delete-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = "artifact-task-delete-failure-12345678";
  await mkdir(path.join(root, "artifact-checkpoints", `${taskId}.checkpoint.json`), { recursive: true });
  const store = new SupplierArtifactCheckpointStore(root);

  await assert.rejects(
    () => store.delete(taskId),
    (error) => error.code === "CHECKPOINT_CLEANUP_FAILED"
  );
});

function checkpointValue(taskId) {
  return {
    checkpointVersion: "gongsuanyun.artifact-checkpoint.v1",
    taskId,
    artifactManifestSha256: "a".repeat(64),
    completedSegments: 1,
    totalSegments: 1,
    processedBytes: 1,
    summaries: ["sensitive summary"],
    providerRequestIds: ["provider-request-1"],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  };
}

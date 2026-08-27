import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SupplierArtifactCheckpointStore } from "../dist/artifact-checkpoint-store.js";

test("artifact checkpoints are encrypted, task-bound, resumable, and deletable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gongsuanyun-checkpoint-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SupplierArtifactCheckpointStore(root);
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
  const raw = await readFile(path.join(root, "artifact-checkpoints", `${taskId}.checkpoint.json`), "utf8");
  assert.equal(raw.includes("sensitive summary"), false);
  assert.deepEqual(await store.read(taskId, token), checkpoint);
  await assert.rejects(() => store.read(taskId, `${token}-wrong`));
  await store.delete(taskId);
  assert.equal(await store.read(taskId, token), undefined);
});

test("artifact checkpoint paths reject traversal-like task ids", async () => {
  const store = new SupplierArtifactCheckpointStore(tmpdir());
  await assert.rejects(() => store.write("../outside", "x".repeat(32), {}));
});

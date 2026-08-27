import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createGatewaySignature, sha256Hex } from "@token-streaming/supplier-node/runtime";
import { SupplierArtifactCheckpointStore } from "../dist/artifact-checkpoint-store.js";
import { SupplierArtifactWorker } from "../dist/artifact-worker.js";

const gatewayToken = "gateway-token-abcdefghijklmnopqrstuvwxyz-123456";

test("outbound artifact worker signs every control call, streams chunks, checkpoints, and completes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gongsuanyun-worker-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = new TextEncoder().encode("large task content");
  const assignment = makeAssignment(bytes);
  const calls = [];
  let now = Date.parse("2026-08-28T00:00:00.000Z");
  const checkpointStore = new SupplierArtifactCheckpointStore(root, { now: () => now });
  await checkpointStore.write(assignment.task_id, gatewayToken, {
    ...checkpointValue(),
    completedSegments: 0,
    processedBytes: 0,
    summaries: [],
    providerRequestIds: [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  });
  now += 5 * 60 * 60_000;
  const runtime = {
    async executeArtifactTask(received, chunks, checkpoint, onCheckpoint) {
      assert.equal(received.task_id, assignment.task_id);
      assert.equal(checkpoint, undefined);
      const downloaded = [];
      for await (const chunk of chunks) downloaded.push(...chunk.bytes);
      assert.deepEqual(downloaded, [...bytes]);
      const next = checkpointValue();
      await onCheckpoint(next, {
        completedSegments: 1,
        totalSegments: 1,
        processedBytes: bytes.byteLength,
        usage: next.usage
      });
      const freshEnvelope = JSON.parse(await readFile(
        path.join(root, "artifact-checkpoints", `${assignment.task_id}.checkpoint.json`),
        "utf8"
      ));
      assert.equal(freshEnvelope.createdAt, "2026-08-28T05:00:00.000Z");
      assert.equal(freshEnvelope.expiresAt, "2026-08-28T11:00:00.000Z");
      return {
        output: "final result",
        usage: next.usage,
        executionEvidence: {
          evidence_version: "gongsuanyun.artifact-evidence.v1",
          task_id: assignment.task_id,
          provider_id: "provider-test",
          requested_model: assignment.model,
          served_model: assignment.model,
          artifact_id: assignment.artifact.artifact_id,
          artifact_manifest_sha256: assignment.artifact.manifest_sha256,
          artifact_content_sha256: sha256Hex(Buffer.from(bytes)),
          output_sha256: sha256Hex("final result"),
          provider_request_ids_sha256: "d".repeat(64),
          segments_completed: 1,
          usage: next.usage,
          completed_at: "2026-08-26T00:01:00.000Z"
        },
        executionEvidenceSignature: "e".repeat(64),
        checkpoint: next
      };
    }
  };
  const fetch = async (url, init) => {
    const parsed = new URL(url);
    const headers = new Headers(init.headers);
    const rawBody = typeof init.body === "string" ? init.body : "";
    verifySignedRequest(headers, rawBody);
    calls.push({ path: parsed.pathname, method: init.method, rawBody, headers });
    if (parsed.pathname.endsWith("/claim")) {
      const body = JSON.parse(rawBody);
      assert.equal(body.max_artifact_bytes, 256 * 1024 * 1024);
      assert.deepEqual(body.allowed_models, [assignment.model]);
      return json({
        protocol_version: "gongsuanyun.artifact-worker.v2",
        request_id: body.request_id,
        task: assignment,
        retry_after_ms: 0
      });
    }
    if (parsed.pathname.includes("/chunks/1")) {
      assert.equal(headers.get("x-gongsuanyun-lease-token"), assignment.lease_token);
      return new Response(bytes, { headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
        "x-content-sha256": assignment.artifact.chunks[0].sha256
      } });
    }
    if (parsed.pathname.endsWith("/checkpoint")) return json({ ok: true, leaseExpiresAt: assignment.lease_expires_at });
    if (parsed.pathname.endsWith("/complete")) return json({ ok: true, taskId: assignment.task_id, status: "completed", chargeMicros: "3" });
    throw new Error(`unexpected path ${parsed.pathname}`);
  };
  const worker = new SupplierArtifactWorker({
    controlPlaneBaseUrl: "https://market.example.com",
    workerId: "worker-test-12345678",
    gatewayToken,
    providerId: "provider-test",
    allowedModels: [assignment.model],
    maxArtifactBytes: 256 * 1024 * 1024,
    runtime,
    checkpointStore,
    fetch
  });

  assert.equal(await worker.pollOnce(), 250);
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/v1/agent/artifact-tasks/claim",
    `/api/v1/agent/artifact-tasks/${assignment.task_id}/chunks/1`,
    `/api/v1/agent/artifact-tasks/${assignment.task_id}/checkpoint`,
    `/api/v1/agent/artifact-tasks/${assignment.task_id}/complete`
  ]);
  assert.equal(calls.some((call) => call.rawBody.includes(gatewayToken)), false);
  assert.equal(await checkpointStore.read(assignment.task_id, gatewayToken), undefined);
  assert.equal(worker.status().lastErrorCode, null);
  assert.ok(worker.status().lastCompletedAt);
});

test("a restarted offline worker purges an expired checkpoint before its next claim", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gongsuanyun-worker-expired-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = "artifact-task-offline-12345678";
  let now = Date.parse("2026-08-28T00:00:00.000Z");
  const firstProcess = new SupplierArtifactCheckpointStore(root, { now: () => now });
  await firstProcess.write(taskId, gatewayToken, { ...checkpointValue(), taskId });
  now += 6 * 60 * 60_000 + 1;
  const restartedStore = new SupplierArtifactCheckpointStore(root, { now: () => now });
  const worker = new SupplierArtifactWorker({
    controlPlaneBaseUrl: "https://market.example.com",
    workerId: "worker-offline-12345678",
    gatewayToken,
    providerId: "provider-test",
    allowedModels: ["model-exact-2026-08-26"],
    maxArtifactBytes: 256 * 1024 * 1024,
    runtime: { executeArtifactTask: async () => assert.fail("expired offline work must not execute") },
    checkpointStore: restartedStore,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      return json({
        protocol_version: "gongsuanyun.artifact-worker.v2",
        request_id: body.request_id,
        task: null,
        retry_after_ms: 5_000
      });
    }
  });

  assert.equal(await worker.pollOnce(), 5_000);
  await assert.rejects(
    () => access(path.join(root, "artifact-checkpoints", `${taskId}.checkpoint.json`)),
    { code: "ENOENT" }
  );
});

test("checkpoint cleanup deletion failures block claims with a stable code", async () => {
  let requested = false;
  const worker = new SupplierArtifactWorker({
    controlPlaneBaseUrl: "https://market.example.com",
    workerId: "worker-cleanup-failure-12345678",
    gatewayToken,
    providerId: "provider-test",
    allowedModels: ["model-exact-2026-08-26"],
    maxArtifactBytes: 256 * 1024 * 1024,
    runtime: { executeArtifactTask: async () => assert.fail("work must not execute") },
    checkpointStore: {
      cleanupExpired: async () => ({ inspected: 1, deleted: 0, failed: 1 })
    },
    fetch: async () => {
      requested = true;
      throw new Error("claim must not be sent");
    }
  });

  await assert.rejects(
    () => worker.pollOnce(),
    (error) => error.code === "CHECKPOINT_CLEANUP_FAILED" && error.retryable === false
  );
  assert.equal(requested, false);
});

test("a resumed lease without its authenticated checkpoint fails before provider execution", async () => {
  const assignment = { ...makeAssignment(new TextEncoder().encode("resume content")), resume_from_segment: 1 };
  const paths = [];
  let providerExecuted = false;
  const worker = new SupplierArtifactWorker({
    controlPlaneBaseUrl: "https://market.example.com",
    workerId: "worker-missing-resume-12345678",
    gatewayToken,
    providerId: "provider-test",
    allowedModels: [assignment.model],
    maxArtifactBytes: 256 * 1024 * 1024,
    runtime: {
      executeArtifactTask: async () => {
        providerExecuted = true;
        assert.fail("provider execution must not start without the resumed checkpoint");
      }
    },
    checkpointStore: {
      cleanupExpired: async () => ({ inspected: 0, deleted: 0, failed: 0 }),
      read: async () => undefined,
      delete: async () => undefined
    },
    fetch: async (url, init) => {
      const parsed = new URL(url);
      paths.push(parsed.pathname);
      if (parsed.pathname.endsWith("/claim")) {
        const body = JSON.parse(init.body);
        return json({
          protocol_version: "gongsuanyun.artifact-worker.v2",
          request_id: body.request_id,
          task: assignment,
          retry_after_ms: 0
        });
      }
      if (parsed.pathname.endsWith("/fail")) {
        assert.equal(JSON.parse(init.body).code, "ARTIFACT_CHECKPOINT_REQUIRED");
        return json({ ok: true, taskId: assignment.task_id, status: "failed" });
      }
      throw new Error(`unexpected path ${parsed.pathname}`);
    }
  });

  await assert.rejects(
    () => worker.pollOnce(),
    (error) => error.code === "ARTIFACT_CHECKPOINT_REQUIRED" && error.retryable === false
  );
  assert.equal(providerExecuted, false);
  assert.deepEqual(paths, [
    "/api/v1/agent/artifact-tasks/claim",
    `/api/v1/agent/artifact-tasks/${assignment.task_id}/fail`
  ]);
});

test("accepted completion retries local checkpoint deletion before any later claim", async () => {
  const bytes = new TextEncoder().encode("terminal checkpoint content");
  const assignment = makeAssignment(bytes);
  const paths = [];
  let claimCount = 0;
  let deleteAttempts = 0;
  const checkpointStore = {
    cleanupExpired: async () => ({ inspected: 0, deleted: 0, failed: 0 }),
    read: async () => undefined,
    delete: async () => {
      deleteAttempts += 1;
      if (deleteAttempts === 1) {
        throw Object.assign(new Error("checkpoint locked"), { code: "CHECKPOINT_CLEANUP_FAILED" });
      }
    }
  };
  const worker = new SupplierArtifactWorker({
    controlPlaneBaseUrl: "https://market.example.com",
    workerId: "worker-terminal-delete-12345678",
    gatewayToken,
    providerId: "provider-test",
    allowedModels: [assignment.model],
    maxArtifactBytes: 256 * 1024 * 1024,
    runtime: {
      executeArtifactTask: async () => ({
        output: "final result",
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        executionEvidence: {
          evidence_version: "gongsuanyun.artifact-evidence.v1",
          task_id: assignment.task_id,
          provider_id: "provider-test",
          requested_model: assignment.model,
          served_model: assignment.model,
          artifact_id: assignment.artifact.artifact_id,
          artifact_manifest_sha256: assignment.artifact.manifest_sha256,
          artifact_content_sha256: sha256Hex(Buffer.from(bytes)),
          output_sha256: sha256Hex("final result"),
          provider_request_ids_sha256: "d".repeat(64),
          segments_completed: 1,
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          completed_at: "2026-08-28T00:01:00.000Z"
        },
        executionEvidenceSignature: "e".repeat(64),
        checkpoint: checkpointValue()
      })
    },
    checkpointStore,
    fetch: async (url, init) => {
      const parsed = new URL(url);
      paths.push(parsed.pathname);
      if (parsed.pathname.endsWith("/claim")) {
        claimCount += 1;
        const body = JSON.parse(init.body);
        return json({
          protocol_version: "gongsuanyun.artifact-worker.v2",
          request_id: body.request_id,
          task: claimCount === 1 ? assignment : null,
          retry_after_ms: claimCount === 1 ? 0 : 5_000
        });
      }
      if (parsed.pathname.endsWith("/complete")) {
        return json({ ok: true, taskId: assignment.task_id, status: "completed", chargeMicros: "3" });
      }
      throw new Error(`unexpected path ${parsed.pathname}`);
    }
  });

  await assert.rejects(
    () => worker.pollOnce(),
    (error) => error.code === "CHECKPOINT_CLEANUP_FAILED"
  );
  assert.equal(paths.some((value) => value.endsWith("/fail")), false);
  assert.equal(claimCount, 1);
  assert.equal(await worker.pollOnce(), 5_000);
  assert.equal(deleteAttempts, 2);
  assert.equal(claimCount, 2);
});

test("a non-retryable terminal failure blocks later claims until checkpoint deletion recovers", async () => {
  const bytes = new TextEncoder().encode("terminal provider failure content");
  const assignment = makeAssignment(bytes);
  const paths = [];
  let claimCount = 0;
  let deleteAttempts = 0;
  let deletionRecovered = false;
  let checkpointPresent = false;
  const checkpointStore = {
    cleanupExpired: async () => ({ inspected: 0, deleted: 0, failed: 0 }),
    read: async () => undefined,
    write: async () => {
      checkpointPresent = true;
    },
    delete: async () => {
      deleteAttempts += 1;
      assert.equal(checkpointPresent, true);
      if (!deletionRecovered) {
        throw Object.assign(new Error("checkpoint locked"), { code: "CHECKPOINT_CLEANUP_FAILED" });
      }
      checkpointPresent = false;
    }
  };
  const worker = new SupplierArtifactWorker({
    controlPlaneBaseUrl: "https://market.example.com",
    workerId: "worker-terminal-failure-delete-12345678",
    gatewayToken,
    providerId: "provider-test",
    allowedModels: [assignment.model],
    maxArtifactBytes: 256 * 1024 * 1024,
    runtime: {
      async executeArtifactTask(_assignment, _chunks, _checkpoint, onCheckpoint) {
        const checkpoint = checkpointValue();
        await onCheckpoint(checkpoint, {
          completedSegments: 1,
          totalSegments: 1,
          processedBytes: bytes.byteLength,
          usage: checkpoint.usage
        });
        throw Object.assign(new Error("provider rejected terminally"), {
          code: "PROVIDER_TERMINAL_FAILURE",
          retryable: false
        });
      }
    },
    checkpointStore,
    fetch: async (url, init) => {
      const parsed = new URL(url);
      paths.push(parsed.pathname);
      if (parsed.pathname.endsWith("/claim")) {
        claimCount += 1;
        const body = JSON.parse(init.body);
        return json({
          protocol_version: "gongsuanyun.artifact-worker.v2",
          request_id: body.request_id,
          task: claimCount === 1 ? assignment : null,
          retry_after_ms: claimCount === 1 ? 0 : 5_000
        });
      }
      if (parsed.pathname.endsWith("/checkpoint")) {
        return json({ ok: true, leaseExpiresAt: assignment.lease_expires_at });
      }
      if (parsed.pathname.endsWith("/fail")) {
        const body = JSON.parse(init.body);
        assert.equal(body.code, "PROVIDER_TERMINAL_FAILURE");
        assert.equal(body.retryable, false);
        return json({ ok: true, taskId: assignment.task_id, status: "failed" });
      }
      throw new Error(`unexpected path ${parsed.pathname}`);
    }
  });

  await assert.rejects(
    () => worker.pollOnce(),
    (error) => error.code === "CHECKPOINT_CLEANUP_FAILED"
  );
  assert.equal(claimCount, 1);
  assert.equal(deleteAttempts, 1);
  assert.equal(paths.filter((value) => value.endsWith("/fail")).length, 1);

  const pathsBeforeBlockedPoll = paths.length;
  await assert.rejects(
    () => worker.pollOnce(),
    (error) => error.code === "CHECKPOINT_CLEANUP_FAILED"
  );
  assert.equal(paths.length, pathsBeforeBlockedPoll);
  assert.equal(claimCount, 1);
  assert.equal(deleteAttempts, 2);

  deletionRecovered = true;
  assert.equal(await worker.pollOnce(), 5_000);
  assert.equal(checkpointPresent, false);
  assert.equal(deleteAttempts, 3);
  assert.equal(claimCount, 2);
  assert.equal(paths.filter((value) => value.endsWith("/fail")).length, 1);
});

function verifySignedRequest(headers, rawBody) {
  const timestamp = headers.get("x-gongsuanyun-timestamp");
  const nonce = headers.get("x-gongsuanyun-nonce");
  const jobId = headers.get("x-gongsuanyun-job-id");
  const signature = headers.get("x-gongsuanyun-signature");
  assert.equal(headers.get("authorization"), `Bearer ${gatewayToken}`);
  assert.ok(timestamp && nonce && jobId && signature);
  assert.equal(
    signature,
    createGatewaySignature(gatewayToken, { timestamp, nonce, jobId, bodySha256: sha256Hex(rawBody) })
  );
}

function makeAssignment(bytes) {
  return {
    protocol_version: "gongsuanyun.artifact-worker.v2",
    task_id: "artifact-task-worker-12345678",
    lease_token: "lease-token-abcdefghijklmnopqrstuvwxyz-123456",
    lease_expires_at: "2026-08-26T00:05:00.000Z",
    attempt: 1,
    resume_from_segment: 0,
    model: "model-exact-2026-08-26",
    instruction: "总结全文",
    data_class: "P0",
    privacy_mode: "strict",
    max_output_tokens: 4096,
    max_total_tokens: 100000,
    artifact: {
      artifact_id: "artifact-worker-12345678",
      file_name: "input.txt",
      media_type: "text/plain",
      size_bytes: bytes.byteLength,
      manifest_sha256: "a".repeat(64),
      chunks: [{ part_number: 1, size_bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }]
    }
  };
}

function checkpointValue() {
  return {
    checkpointVersion: "gongsuanyun.artifact-checkpoint.v1",
    taskId: "artifact-task-worker-12345678",
    artifactManifestSha256: "a".repeat(64),
    completedSegments: 1,
    totalSegments: 1,
    processedBytes: 18,
    summaries: ["summary"],
    providerRequestIds: ["provider-request-1"],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
  };
}

function json(value) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

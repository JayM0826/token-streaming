import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createExecutionEvidenceSignature, createGatewaySignature, sha256Hex } from "../dist/signature.js";
import { SupplierNodeRuntime } from "../dist/runtime.js";
import { createSupplierNodeServer } from "../dist/server.js";

const token = "gateway-token-abcdefghijklmnopqrstuvwxyz-123456";
const replayTestRoot = path.join(tmpdir(), `gongsuanyun-runtime-test-${process.pid}-${randomUUID()}`);
test.after(() => rm(replayTestRoot, { recursive: true, force: true }));

test("runtime refuses to start without durable replay protection", () => {
  assert.throws(
    () => new SupplierNodeRuntime(
      config({ replayJournalPath: undefined }),
      { providerId: "provider-test", invoke: async () => providerResult() },
      () => undefined
    ),
    /replay journal path is required/
  );
});

test("runtime enforces signed idempotency and never logs prompt or credentials", async () => {
  const logs = [];
  let calls = 0;
  const adapter = {
    providerId: "provider-test",
    async invoke() {
      calls += 1;
      return providerResult();
    }
  };
  const runtime = new SupplierNodeRuntime(config(), adapter, (event) => logs.push(event));
  const first = await runtime.handleInference(signedCall(requestBody(), "nonce-runtime-first-1234"));
  const replay = await runtime.handleInference(signedCall(requestBody(), "nonce-runtime-replay-123"));
  const conflict = await runtime.handleInference(
    signedCall(requestBody({ input: "different secret prompt" }), "nonce-runtime-conflict-1")
  );

  assert.equal(first.status, 200);
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");
  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /private prompt|different secret prompt|gateway-token|upstream-secret/);
});

test("runtime fails closed for unapproved models, substitutions, and provider over-reporting", async () => {
  let calls = 0;
  const adapter = {
    providerId: "provider-test",
    async invoke() {
      calls += 1;
      return providerResult({ usage: { input_tokens: 2, output_tokens: 33, total_tokens: 35 } });
    }
  };
  const runtime = new SupplierNodeRuntime(config(), adapter, () => undefined);
  const modelRejected = await runtime.handleInference(
    signedCall(requestBody({ request_id: "job-unapproved1", model: "other-model" }), "nonce-runtime-model-12345")
  );
  const usageRejected = await runtime.handleInference(
    signedCall(requestBody({ request_id: "job-overreport1" }), "nonce-runtime-usage-12345")
  );
  const substituted = new SupplierNodeRuntime(
    config(),
    { providerId: "provider-test", invoke: async () => providerResult({ servedModel: "model-cheap" }) },
    () => undefined
  );
  const substitutionRejected = await substituted.handleInference(
    signedCall(requestBody({ request_id: "job-substitution1" }), "nonce-runtime-substitution")
  );
  assert.equal(modelRejected.status, 403);
  assert.equal(modelRejected.body.error.code, "MODEL_NOT_ALLOWED");
  assert.equal(usageRejected.status, 502);
  assert.equal(usageRejected.body.error.code, "UPSTREAM_RESPONSE_INVALID");
  assert.equal(substitutionRejected.status, 502);
  assert.equal(substitutionRejected.body.error.code, "UPSTREAM_MODEL_MISMATCH");
  assert.equal(calls, 1);
});

test("persistent replay journal rejects captured and re-signed requests after restart", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gongsuanyun-replay-"));
  const replayJournalPath = path.join(root, "replay.jsonl");
  t.after(() => rm(root, { recursive: true, force: true }));
  let firstCalls = 0;
  const firstRuntime = new SupplierNodeRuntime(
    config({ replayJournalPath }),
    { providerId: "provider-test", invoke: async () => { firstCalls += 1; return providerResult(); } },
    () => undefined
  );
  const captured = signedCall(requestBody(), "nonce-before-restart-1234");
  assert.equal((await firstRuntime.handleInference(captured)).status, 200);
  assert.equal(firstCalls, 1);
  firstRuntime.setDraining();
  const journal = await readFile(replayJournalPath, "utf8");
  assert.match(journal, /"version":2/);
  assert.match(journal, /"bodyCommitment":"[a-f0-9]{64}"/);
  assert.doesNotMatch(journal, /bodySha256|private prompt/);
  assert.equal(journal.includes(sha256Hex(captured.rawBody)), false);

  let restartedCalls = 0;
  const restarted = new SupplierNodeRuntime(
    config({ replayJournalPath }),
    { providerId: "provider-test", invoke: async () => { restartedCalls += 1; return providerResult(); } },
    () => undefined
  );
  const capturedReplay = await restarted.handleInference(captured);
  const reSignedReplay = await restarted.handleInference(
    signedCall(requestBody(), "nonce-after-restart-12345")
  );
  assert.equal(capturedReplay.status, 409);
  assert.equal(capturedReplay.body.error.code, "REPLAY_DETECTED");
  assert.equal(reSignedReplay.status, 409);
  assert.equal(reSignedReplay.body.error.code, "REPLAY_DETECTED");
  assert.equal(restartedCalls, 0);
  restarted.setDraining();
});

test("HTTP server exposes health and the signed v3 inference route", async (t) => {
  const runtime = new SupplierNodeRuntime(
    config(),
    { providerId: "provider-test", invoke: async () => providerResult() },
    () => undefined
  );
  const server = createSupplierNodeServer(runtime);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  const readiness = await health.json();
  assert.deepEqual(readiness, { status: "ready", protocol_version: "gongsuanyun.gateway.v3" });
  assert.equal(readiness.provider_id, undefined);

  const attestationCall = signedCall(attestationBody(), "nonce-http-attest-1234567");
  const attestation = await fetch(`${baseUrl}/v3/attestation`, {
    method: "POST",
    headers: {
      authorization: attestationCall.authorization,
      "content-type": "application/json",
      "x-gongsuanyun-job-id": attestationCall.jobId,
      "x-gongsuanyun-timestamp": attestationCall.timestamp,
      "x-gongsuanyun-nonce": attestationCall.nonce,
      "x-gongsuanyun-signature": attestationCall.signature
    },
    body: attestationCall.rawBody
  });
  assert.equal(attestation.status, 200);
  assert.deepEqual(await attestation.json(), {
    status: "ready",
    protocol_version: "gongsuanyun.gateway.v3",
    provider_id: "provider-test",
    allowed_models: ["model-a"],
    allowed_data_classes: ["P0"],
    limits: {
      requests_per_minute: 30,
      tokens_per_minute: 100_000,
      concurrency: 2,
      max_output_tokens: 32
    },
    request_id: "attestation-request-123456",
    challenge: "challenge-value-abcdefghijklmnopqrstuvwxyz"
  });

  const call = signedCall(requestBody(), "nonce-http-server-123456");
  const response = await fetch(`${baseUrl}/v3/inference`, {
    method: "POST",
    headers: {
      authorization: call.authorization,
      "content-type": "application/json",
      "x-gongsuanyun-job-id": call.jobId,
      "x-gongsuanyun-timestamp": call.timestamp,
      "x-gongsuanyun-nonce": call.nonce,
      "x-gongsuanyun-signature": call.signature
    },
    body: call.rawBody
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.execution_evidence.provider_request_id, "provider-request-1");
  assert.equal(result.execution_evidence.provider_id, "provider-test");
  assert.equal(result.execution_evidence.requested_model, "model-a");
  assert.equal(result.execution_evidence.served_model, "model-a");
  assert.equal(result.execution_evidence.input_sha256, sha256Hex("private prompt"));
  assert.equal(result.execution_evidence.output_sha256, sha256Hex("hello"));
  assert.equal(
    result.execution_evidence_signature,
    createExecutionEvidenceSignature(token, result.execution_evidence)
  );
});

function config(overrides = {}) {
  return {
    bindHost: "127.0.0.1",
    port: 8789,
    gatewayToken: token,
    providerId: "provider-test",
    allowedModels: ["model-a"],
    allowedDataClasses: ["P0"],
    replayJournalPath: path.join(replayTestRoot, `${randomUUID()}.jsonl`),
    limits: {
      requestsPerMinute: 30,
      tokensPerMinute: 100_000,
      concurrency: 2,
      maxOutputTokens: 32,
      maxInputBytes: 65_536
    },
    upstream: {
      protocol: "responses",
      baseUrl: new URL("https://api.provider.example/v1"),
      apiKey: "upstream-secret-value",
      timeoutMs: 10_000,
      maximumResponseBytes: 10_000
    },
    ...overrides
  };
}

function attestationBody() {
  return JSON.stringify({
    protocol_version: "gongsuanyun.gateway.v3",
    request_id: "attestation-request-123456",
    challenge: "challenge-value-abcdefghijklmnopqrstuvwxyz"
  });
}

function requestBody(overrides = {}) {
  return JSON.stringify({
    protocol_version: "gongsuanyun.gateway.v3",
    request_id: "job-12345678",
    model: "model-a",
    input: "private prompt",
    data_class: "P0",
    max_output_tokens: 32,
    stream: false,
    ...overrides
  });
}

function signedCall(rawBody, nonce) {
  const payload = JSON.parse(rawBody);
  const timestamp = String(Date.now());
  const bodySha256 = sha256Hex(rawBody);
  return {
    authorization: `Bearer ${token}`,
    timestamp,
    nonce,
    jobId: payload.request_id,
    signature: createGatewaySignature(token, { timestamp, nonce, jobId: payload.request_id, bodySha256 }),
    rawBody
  };
}

function providerResult(overrides = {}) {
  return {
    output: "hello",
    providerRequestId: "provider-request-1",
    servedModel: "model-a",
    receiptRef: "receipt-1",
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    ...overrides
  };
}

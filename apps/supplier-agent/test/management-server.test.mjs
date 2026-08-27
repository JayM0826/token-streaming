import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SupplierAgentController } from "../dist/controller.js";
import { PassphraseAttemptGate, startSupplierAgentManagementServer } from "../dist/management-server.js";
import { resolveSupplierAgentPaths } from "../dist/profile.js";
import { SupplierAgentStore } from "../dist/store.js";
import { SupplierAgentError } from "../dist/types.js";

test("loopback management requires its session token and never exposes provider secrets in status", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gongsuanyun-agent-test-"));
  const gatewayPort = await freePort();
  const managementPort = await freePort();
  const managementUrl = `http://127.0.0.1:${managementPort}`;
  const controller = new SupplierAgentController(new SupplierAgentStore(resolveSupplierAgentPaths(root)), managementUrl);
  await controller.initialize();
  const management = await startSupplierAgentManagementServer(controller, managementPort, () => undefined);
  t.after(async () => {
    await controller.shutdown();
    await new Promise((resolve) => management.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const page = await fetch(`${managementUrl}/`);
  assert.equal(page.status, 200);
  const sessionCookie = page.headers.get("set-cookie") ?? "";
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(page.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.match(sessionCookie, /^gongsuanyun_agent_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.equal((await page.text()).includes(management.sessionToken), false);

  const unauthorized = await fetch(`${managementUrl}/api/status`);
  assert.equal(unauthorized.status, 401);

  const gatewayToken = "gateway-token-abcdefghijklmnopqrstuvwxyz-123456";
  const upstreamApiKey = "upstream-secret-abcdefghijklmnopqrstuvwxyz";
  const connection = await api(management, sessionCookie, "/api/setup", {
    profile: {
      providerId: "provider-test",
      allowedModels: ["model-exact-2026-08-25"],
      allowedDataClasses: ["P0"],
      publicGatewayEndpoint: "https://node.example.com/v3/inference",
      controlPlaneBaseUrl: "https://market.example.com",
      gatewayPort,
      upstreamProtocol: "responses",
      upstreamBaseUrl: "https://api.provider.example/v1",
      upstreamHostAllowlist: ["provider.example"],
      limits: {
        requestsPerMinute: 30,
        tokensPerMinute: 100_000,
        concurrency: 2,
        maxOutputTokens: 4_096,
        maxInputBytes: 65_536,
        maxArtifactBytes: 0,
        artifactSegmentBytes: 1
      }
    },
    upstreamApiKey,
    gatewayToken,
    passphrase: "correct horse battery staple"
  });
  assert.equal(connection.gatewayBearerToken, gatewayToken);

  const status = await api(management, sessionCookie, "/api/status", undefined, "GET");
  assert.equal(status.nodeStatus, "online");
  assert.equal(status.providerId, "provider-test");
  assert.equal(status.artifactWorker.state, "stopped");
  assert.equal(JSON.stringify(status).includes(gatewayToken), false);
  assert.equal(JSON.stringify(status).includes(upstreamApiKey), false);

  const missingReauthentication = await rawApi(management, sessionCookie, "/api/connection", {});
  assert.equal(missingReauthentication.response.status, 400);
  assert.equal(JSON.stringify(missingReauthentication.result).includes(gatewayToken), false);

  const wrongReauthentication = await rawApi(management, sessionCookie, "/api/connection", {
    passphrase: "wrong passphrase value"
  });
  assert.equal(wrongReauthentication.response.status, 400);
  assert.equal(JSON.stringify(wrongReauthentication.result).includes(gatewayToken), false);

  const revealed = await api(management, sessionCookie, "/api/connection", {
    passphrase: "correct horse battery staple"
  });
  assert.equal(revealed.gatewayBearerToken, gatewayToken);
  assert.equal(JSON.stringify(revealed).includes(upstreamApiKey), false);

  await api(management, sessionCookie, "/api/lock", {});
  const locked = await api(management, sessionCookie, "/api/status", undefined, "GET");
  assert.equal(locked.nodeStatus, "locked");
});

test("local passphrase verification throttles repeated and parallel failures", async () => {
  let now = 100_000;
  const gate = new PassphraseAttemptGate(5, 60_000, 30_000, () => now);
  const unlockFailure = () => Promise.reject(new SupplierAgentError("VAULT_UNLOCK_FAILED", "failed"));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(() => gate.run(unlockFailure), hasAgentCode("VAULT_UNLOCK_FAILED"));
  }
  await assert.rejects(() => gate.run(async () => "secret"), hasAgentCode("RATE_LIMITED"));

  now += 30_001;
  let release;
  const pending = gate.run(() => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(() => gate.run(async () => "parallel"), hasAgentCode("RATE_LIMITED"));
  release("verified");
  assert.equal(await pending, "verified");
  assert.equal(await gate.run(async () => "next"), "next");
});

async function api(management, sessionCookie, route, body, method = "POST") {
  const { response, result } = await rawApi(management, sessionCookie, route, body, method);
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

async function rawApi(management, sessionCookie, route, body, method = "POST") {
  const response = await fetch(`${management.url}${route}`, {
    method,
    headers: {
      ...(method === "POST" ? { "content-type": "application/json", origin: management.url } : {}),
      cookie: sessionCookie.split(";", 1)[0]
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json();
  return { response, result };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function hasAgentCode(code) {
  return (error) => error instanceof SupplierAgentError && error.code === code;
}

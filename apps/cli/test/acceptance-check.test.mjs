import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");
const acceptanceScript = path.join(repoRoot, "scripts", "check-acceptance.mjs");
const relayFixture = path.join(repoRoot, "apps", "cli", "test", "fixtures", "openai-compatible-server.mjs");

test("acceptance check reports missing OpenAI live smoke as incomplete", () => {
  const result = spawnSync(process.execPath, [acceptanceScript, "--quick", "--json"], {
    cwd: repoRoot,
    env: cleanProviderEnvironment({
      OPENAI_API_KEY: "",
      OPENAI_MODEL: "",
      OPENAI_TIMEOUT_MS: ""
    }),
    encoding: "utf8"
  });
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(output.kind, "acceptance-check");
  assert.equal(output.ok, false);
  assert.equal(output.offlineOk, true);
  assert.equal(output.liveSmoke.status, "missing-api-key");
  assert.equal(output.liveSmoke.verified, false);
  assert.equal(output.results.some((step) => step.name === "package" && step.ok), true);
  assert.equal(output.results.some((step) => step.name === "manifest" && step.ok), true);
  assert.deepEqual(output.results.find((step) => step.name === "stub-smoke")?.evidence, {
    provider: "stub",
    model: "stub",
    strategy: "default",
    review: "not-run",
    eventLog: true,
    report: true
  });
  assert.equal(output.results.some((step) => step.name === "repository-doctor" && step.ok), true);
});

test("acceptance check verifies Responses and Chat Completions provider probes", async () => {
  const relay = spawn(process.execPath, [relayFixture], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const port = await readFirstLine(relay);
    for (const [protocol, endpoint] of [
      ["responses", "responses"],
      ["chat-completions", "chat/completions"]
    ]) {
      const result = spawnSync(process.execPath, [acceptanceScript, "--quick", "--json"], {
        cwd: repoRoot,
        env: cleanProviderEnvironment({
          OPENAI_API_KEY: "relay-key",
          OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
          OPENAI_API_PROTOCOL: protocol,
          OPENAI_MODEL: "relay-model",
          OPENAI_TIMEOUT_MS: ""
        }),
        encoding: "utf8"
      });
      const output = JSON.parse(result.stdout);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.offlineOk, true);
      assert.equal(output.liveSmoke.status, "verified");
      assert.equal(output.liveSmoke.verified, true);
      assert.equal(output.liveSmoke.apiProtocol, protocol);
      assert.equal(output.liveSmoke.model, "relay-model");
      assert.equal(output.liveSmoke.timeoutMs, 30_000);
      assert.equal(output.liveSmoke.endpoint, `http://127.0.0.1:${port}/v1/${endpoint}`);
      assert.equal(output.results.find((step) => step.name === "stub-smoke")?.evidence?.provider, "stub");
      assert.doesNotMatch(output.results.find((step) => step.name === "repository-doctor")?.command ?? "", /--probe/);
      assert.match(output.results.find((step) => step.name === "live-smoke")?.command ?? "", /--probe/);
    }
  } finally {
    relay.kill();
  }
});

test("acceptance check verifies native Anthropic and Gemini provider probes", async () => {
  const relay = spawn(process.execPath, [relayFixture], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const port = await readFirstLine(relay);
    for (const provider of [
      {
        name: "anthropic",
        keyEnv: "ANTHROPIC_API_KEY",
        baseUrlEnv: "ANTHROPIC_BASE_URL",
        modelEnv: "ANTHROPIC_MODEL",
        model: "claude-test",
        endpoint: "messages"
      },
      {
        name: "gemini",
        keyEnv: "GEMINI_API_KEY",
        baseUrlEnv: "GEMINI_BASE_URL",
        modelEnv: "GEMINI_MODEL",
        model: "gemini-test",
        endpoint: "interactions"
      }
    ]) {
      const result = spawnSync(process.execPath, [acceptanceScript, "--quick", "--json", "--provider", provider.name], {
        cwd: repoRoot,
        env: cleanProviderEnvironment({
          [provider.keyEnv]: "native-key",
          [provider.baseUrlEnv]: `http://127.0.0.1:${port}/v1`,
          [provider.modelEnv]: provider.model
        }),
        encoding: "utf8"
      });
      const output = JSON.parse(result.stdout);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.offlineOk, true);
      assert.equal(output.liveSmoke.provider, provider.name);
      assert.equal(output.liveSmoke.status, "verified");
      assert.equal(output.liveSmoke.model, provider.model);
      assert.equal(output.liveSmoke.endpoint, `http://127.0.0.1:${port}/v1/${provider.endpoint}`);
      assert.match(output.results.find((step) => step.name === "live-smoke")?.command ?? "", new RegExp(`--provider ${provider.name}`));
    }
  } finally {
    relay.kill();
  }
});

test("acceptance check keeps offline gates green when the live provider fails", async () => {
  const relay = spawn(process.execPath, [relayFixture], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const port = await readFirstLine(relay);
    const result = spawnSync(process.execPath, [acceptanceScript, "--quick", "--json"], {
      cwd: repoRoot,
      env: cleanProviderEnvironment({
        OPENAI_API_KEY: "relay-key",
        OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
        OPENAI_API_PROTOCOL: "responses",
        OPENAI_MODEL: "failing-model",
        OPENAI_TIMEOUT_MS: ""
      }),
      encoding: "utf8"
    });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 1);
    assert.equal(output.ok, false);
    assert.equal(output.offlineOk, true);
    assert.equal(output.liveSmoke.status, "failed");
    assert.equal(output.results.find((step) => step.name === "repository-doctor")?.ok, true);
    assert.equal(output.results.find((step) => step.name === "live-smoke")?.ok, false);
  } finally {
    relay.kill();
  }
});

function readFirstLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for relay fixture.")), 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline !== -1) {
        clearTimeout(timeout);
        resolve(Number(stdout.slice(0, newline).trim()));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!stdout.includes("\n")) {
        clearTimeout(timeout);
        reject(new Error(`Relay fixture exited before listening (${code}).`));
      }
    });
  });
}

function cleanProviderEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const name of [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_API_PROTOCOL",
    "OPENAI_MODEL",
    "OPENAI_TIMEOUT_MS",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_TIMEOUT_MS",
    "GEMINI_API_KEY",
    "GEMINI_BASE_URL",
    "GEMINI_MODEL",
    "GEMINI_TIMEOUT_MS",
    "CODEX_EXEC_PATH",
    "CODEX_EXEC_MODEL",
    "CODEX_EXEC_SERVICE_TIER",
    "CODEX_EXEC_TIMEOUT_MS",
    "CODEX_EXEC_PROVIDER_DEPTH"
  ]) {
    environment[name] = "";
  }
  return { ...environment, ...overrides };
}

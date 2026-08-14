import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseModelProvider } from "../dist/doctor.js";

test("diagnoseModelProvider warns when auto falls back to stub without API key", async () => {
  const result = await diagnoseModelProvider({
    mode: "auto",
    requestedProvider: "auto",
    apiKey: "",
    manifest: {
      models: {
        auto_model: "configured-model"
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.effectiveProvider, "stub");
  assert.equal(result.selection.model, "configured-model");
  assert.equal(result.checks.some((check) => check.status === "warning" && check.name === "openai-api-key"), true);
  assert.equal(result.checks.some((check) => check.name === "probe" && check.status === "skipped"), true);
});

test("diagnoseModelProvider errors when openai is selected without API key", async () => {
  const result = await diagnoseModelProvider({
    mode: "max",
    requestedProvider: "openai",
    apiKey: "",
    manifest: {
      models: {
        max_model: "strong-model"
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.effectiveProvider, "openai");
  assert.equal(result.checks.some((check) => check.status === "error" && check.name === "openai-api-key"), true);
});

test("diagnoseModelProvider can probe the stub provider", async () => {
  const result = await diagnoseModelProvider({
    mode: "economy",
    requestedProvider: "stub",
    requestedModel: "stub-model",
    apiKey: "",
    probe: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.effectiveProvider, "stub");
  assert.equal(result.checks.some((check) => check.name === "probe" && check.status === "ok"), true);
});

test("diagnoseModelProvider reports custom OpenAI-compatible base URL", async () => {
  const result = await diagnoseModelProvider({
    mode: "auto",
    requestedProvider: "openai",
    requestedModel: "gpt-test",
    apiKey: "sk-test",
    baseUrl: "https://relay.example/v1",
    timeoutMs: 120_000,
    probe: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.effectiveProvider, "openai");
  assert.equal(result.requestTimeoutMs, 120_000);
  assert.equal(
    result.checks.some((check) => check.name === "openai-base-url" && check.message.includes("https://relay.example/v1")),
    true
  );
  assert.equal(
    result.checks.some((check) => check.name === "openai-timeout" && check.message.includes("120000ms")),
    true
  );
  assert.equal(
    result.checks.some((check) => check.name === "openai-api-protocol" && check.message.includes("/responses")),
    true
  );
});

test("diagnoseModelProvider reports the chat completions relay endpoint", async () => {
  const result = await diagnoseModelProvider({
    mode: "auto",
    requestedProvider: "openai",
    requestedModel: "relay-model",
    apiKey: "relay-key",
    baseUrl: "https://relay.example/v1/",
    apiProtocol: "chat-completions"
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.checks.some(
      (check) => check.name === "openai-api-protocol" && check.message.includes("https://relay.example/v1/chat/completions")
    ),
    true
  );
});

test("diagnoseModelProvider retries one transient transport failure", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      const cause = new Error("socket disconnected");
      cause.code = "ECONNRESET";
      throw new TypeError("fetch failed", { cause });
    }
    return new Response(JSON.stringify({ output_text: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await diagnoseModelProvider({
      mode: "auto",
      requestedProvider: "openai",
      requestedModel: "gpt-test",
      apiKey: "sk-test",
      probe: true
    });

    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.equal(result.checks.find((check) => check.name === "probe")?.message.includes("attempts=2"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("diagnoseModelProvider does not retry HTTP failures", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await diagnoseModelProvider({
      mode: "auto",
      requestedProvider: "openai",
      requestedModel: "gpt-test",
      apiKey: "sk-test",
      probe: true
    });

    assert.equal(result.ok, false);
    assert.equal(calls, 1);
    assert.equal(result.checks.find((check) => check.name === "probe")?.message, "OpenAI request failed with HTTP 401: invalid key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

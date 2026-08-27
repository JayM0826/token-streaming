import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleAdapter } from "../dist/openai-compatible-adapter.js";

test("responses adapter sends a bounded non-streaming request and normalizes usage", async () => {
  const calls = [];
  const adapter = new OpenAICompatibleAdapter({
    providerId: "provider-test",
    protocol: "responses",
    baseUrl: new URL("https://api.provider.example/v1"),
    apiKey: "upstream-secret-value",
    timeoutMs: 10_000,
    maximumResponseBytes: 10_000,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        id: "provider-request-1",
        model: "model-a",
        output_text: "hello",
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
      }, 200, { "x-request-id": "receipt-1" });
    }
  });
  const result = await adapter.invoke(gatewayRequest(), new AbortController().signal);
  assert.deepEqual(result, {
    output: "hello",
    providerRequestId: "provider-request-1",
    servedModel: "model-a",
    receiptRef: "receipt-1",
    usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
  });
  assert.equal(calls[0].url, "https://api.provider.example/v1/responses");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, "Bearer upstream-secret-value");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "model-a",
    input: "private prompt",
    max_output_tokens: 32,
    stream: false,
    store: false
  });
});

test("adapter rejects an upstream model substitution before returning billable usage", async () => {
  const adapter = new OpenAICompatibleAdapter({
    providerId: "provider-test",
    protocol: "responses",
    baseUrl: new URL("https://api.provider.example/v1"),
    apiKey: "upstream-secret-value",
    timeoutMs: 10_000,
    maximumResponseBytes: 10_000,
    fetch: async () => jsonResponse({
      id: "provider-request-downgrade",
      model: "model-cheap",
      output_text: "substituted",
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
    })
  });
  await assert.rejects(
    () => adapter.invoke(gatewayRequest(), new AbortController().signal),
    (error) => error.code === "UPSTREAM_MODEL_MISMATCH"
  );
});

test("chat adapter keeps native errors inside the adapter boundary", async () => {
  const adapter = new OpenAICompatibleAdapter({
    providerId: "provider-test",
    protocol: "chat-completions",
    baseUrl: new URL("https://api.provider.example/v1"),
    apiKey: "upstream-secret-value",
    timeoutMs: 10_000,
    maximumResponseBytes: 10_000,
    fetch: async () => jsonResponse({ error: { message: "secret leaked upstream" } }, 429)
  });
  await assert.rejects(
    () => adapter.invoke(gatewayRequest(), new AbortController().signal),
    (error) => {
      assert.equal(error.code, "UPSTREAM_RATE_LIMITED");
      assert.doesNotMatch(error.message, /secret leaked upstream|upstream-secret-value/);
      return true;
    }
  );
});

function gatewayRequest() {
  return {
    protocol_version: "gongsuanyun.gateway.v3",
    request_id: "job-12345678",
    model: "model-a",
    input: "private prompt",
    data_class: "P0",
    max_output_tokens: 32,
    stream: false
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

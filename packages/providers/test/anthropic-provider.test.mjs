import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicMessagesProvider, DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS } from "../dist/anthropic-provider.js";

test("AnthropicMessagesProvider maps the native Messages API contract", async () => {
  const calls = [];
  const provider = new AnthropicMessagesProvider({
    apiKey: "anthropic-secret",
    model: "claude-sonnet-5",
    baseUrl: "https://api.anthropic.test/v1/",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        model: "claude-sonnet-5",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "first" },
          { type: "text", text: "second" }
        ],
        usage: { input_tokens: 12, output_tokens: 4 }
      });
    }
  });

  const response = await provider.generate({
    mode: "max",
    reasoningEffort: "high",
    maxOutputTokens: 64,
    messages: [
      { role: "system", content: "Be precise." },
      { role: "user", content: "Inspect this." },
      { role: "assistant", content: "Initial answer." },
      { role: "tool", content: "Tool evidence." }
    ]
  });

  assert.equal(response.provider, "anthropic");
  assert.equal(response.model, "claude-sonnet-5");
  assert.equal(response.content, "first\nsecond");
  assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 4 });
  assert.equal(calls[0].url, "https://api.anthropic.test/v1/messages");
  assert.equal(calls[0].init.headers["x-api-key"], "anthropic-secret");
  assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "claude-sonnet-5",
    max_tokens: 64,
    system: "Be precise.",
    messages: [
      { role: "user", content: "Inspect this." },
      { role: "assistant", content: "Initial answer." },
      { role: "user", content: "Tool evidence." }
    ],
    output_config: { effort: "high" }
  });
});

test("AnthropicMessagesProvider uses a bounded default and omits unsupported effort", async () => {
  let requestBody;
  const provider = new AnthropicMessagesProvider({
    apiKey: "key",
    model: "claude-haiku-4-5",
    fetch: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return jsonResponse({ content: [{ type: "text", text: "ok" }] });
    }
  });
  await provider.generate({
    mode: "economy",
    reasoningEffort: "low",
    messages: [{ role: "user", content: "hello" }]
  });
  assert.equal(requestBody.max_tokens, DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS);
  assert.equal(requestBody.output_config, undefined);
});

test("AnthropicMessagesProvider reports safe HTTP and transport failures", async () => {
  const httpProvider = new AnthropicMessagesProvider({
    apiKey: "anthropic-secret",
    fetch: async () =>
      jsonResponse(
        { error: { type: "authentication_error", message: "bad anthropic-secret" } },
        401,
        { "request-id": "req-anthropic" }
      )
  });
  await assert.rejects(
    () => httpProvider.generate({ mode: "auto", messages: [{ role: "user", content: "hello" }] }),
    /Anthropic request failed with HTTP 401 \(type=authentication_error, request_id=req-anthropic\): bad \[REDACTED\]/
  );

  const networkProvider = new AnthropicMessagesProvider({
    apiKey: "anthropic-secret",
    fetch: async () => {
      throw new TypeError("fetch anthropic-secret failed");
    }
  });
  await assert.rejects(
    () => networkProvider.generate({ mode: "auto", messages: [{ role: "user", content: "hello" }] }),
    (error) => {
      assert.match(error.message, /Anthropic network request failed: fetch \[REDACTED\] failed/);
      assert.doesNotMatch(error.message, /anthropic-secret/);
      return true;
    }
  );
});

test("AnthropicMessagesProvider times out slow requests", async () => {
  const provider = new AnthropicMessagesProvider({
    apiKey: "key",
    timeoutMs: 5,
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))
  });
  await assert.rejects(
    () => provider.generate({ mode: "auto", messages: [{ role: "user", content: "hello" }] }),
    /Anthropic request timed out after 5ms/
  );
});

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

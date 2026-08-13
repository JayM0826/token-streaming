import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIChatCompletionsProvider } from "../dist/openai-chat-provider.js";

test("OpenAIChatCompletionsProvider sends a bounded chat completions request", async () => {
  const calls = [];
  const provider = new OpenAIChatCompletionsProvider({
    apiKey: "relay-key",
    model: "relay-model",
    baseUrl: "https://relay.example/v1/",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 9, completion_tokens: 3 }
      });
    }
  });

  const response = await provider.generate({
    mode: "max",
    reasoningEffort: "high",
    maxOutputTokens: 32,
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Respond with ok." }
    ]
  });

  assert.equal(response.provider, "openai");
  assert.equal(response.model, "relay-model");
  assert.equal(response.content, "ok");
  assert.deepEqual(response.usage, { inputTokens: 9, outputTokens: 3 });
  assert.equal(calls[0].url, "https://relay.example/v1/chat/completions");
  assert.equal(calls[0].init.headers.Authorization, "Bearer relay-key");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "relay-model",
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Respond with ok." }
    ],
    reasoning_effort: "high",
    max_completion_tokens: 32
  });
});

test("OpenAIChatCompletionsProvider extracts array content and reports upstream errors", async () => {
  const contentProvider = new OpenAIChatCompletionsProvider({
    apiKey: "relay-key",
    fetch: async () =>
      jsonResponse({
        choices: [{ message: { content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] } }]
      })
  });
  assert.equal(
    (await contentProvider.generate({ mode: "auto", messages: [{ role: "user", content: "hello" }] })).content,
    "first\nsecond"
  );

  const errorProvider = new OpenAIChatCompletionsProvider({
    apiKey: "relay-key",
    fetch: async () => jsonResponse({ error: { message: "unknown relay model" } }, 400)
  });
  await assert.rejects(
    () => errorProvider.generate({ mode: "auto", messages: [{ role: "user", content: "hello" }] }),
    /unknown relay model/
  );
});

test("OpenAIChatCompletionsProvider times out slow requests", async () => {
  const provider = new OpenAIChatCompletionsProvider({
    apiKey: "relay-key",
    timeoutMs: 5,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })
  });

  await assert.rejects(
    () => provider.generate({ mode: "auto", messages: [{ role: "user", content: "hello" }] }),
    /chat request timed out after 5ms/
  );
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

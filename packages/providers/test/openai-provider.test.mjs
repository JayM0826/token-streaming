import assert from "node:assert/strict";
import test from "node:test";
import { createModelProvider } from "../dist/factory.js";
import { OpenAIResponsesProvider } from "../dist/openai-provider.js";

test("OpenAIResponsesProvider sends a bounded Responses API request", async () => {
  const calls = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "sk-test",
    model: "gpt-test",
    baseUrl: "https://example.test/v1",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        output_text: "ok",
        usage: {
          input_tokens: 7,
          output_tokens: 2
        }
      });
    }
  });

  const response = await provider.generate({
    mode: "auto",
    reasoningEffort: "low",
    maxOutputTokens: 16,
    messages: [
      {
        role: "user",
        content: "Respond with ok."
      }
    ]
  });

  assert.equal(response.provider, "openai");
  assert.equal(response.model, "gpt-test");
  assert.equal(response.content, "ok");
  assert.deepEqual(response.usage, { inputTokens: 7, outputTokens: 2 });
  assert.equal(calls[0].url, "https://example.test/v1/responses");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.equal(calls[0].init.signal instanceof AbortSignal, true);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "gpt-test",
    input: [{ role: "user", content: "Respond with ok." }],
    reasoning: { effort: "low" },
    max_output_tokens: 16
  });
});

test("createModelProvider passes custom OpenAI-compatible base URL from options", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ output_text: "ok" });
  };

  try {
    const provider = createModelProvider({
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-test",
      baseUrl: "https://relay.example/v1"
    });

    await provider.generate({
      mode: "auto",
      messages: [{ role: "user", content: "hello" }]
    });

    assert.equal(calls[0].url, "https://relay.example/v1/responses");
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createModelProvider selects the chat completions relay protocol", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  };

  try {
    const provider = createModelProvider({
      provider: "openai",
      apiKey: "relay-key",
      model: "relay-model",
      baseUrl: "https://relay.example/v1",
      apiProtocol: "chat-completions"
    });

    await provider.generate({ mode: "auto", messages: [{ role: "user", content: "hello" }] });
    assert.equal(calls[0].url, "https://relay.example/v1/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createModelProvider rejects unknown OpenAI API protocols", () => {
  assert.throws(
    () => createModelProvider({ provider: "openai", apiKey: "relay-key", apiProtocol: "legacy" }),
    /Invalid OpenAI API protocol/
  );
});

test("OpenAIResponsesProvider extracts text from output content arrays", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "sk-test",
    fetch: async () =>
      jsonResponse({
        output: [
          {
            content: [
              {
                type: "output_text",
                text: "first"
              },
              {
                type: "output_text",
                text: "second"
              }
            ]
          }
        ]
      })
  });

  const response = await provider.generate({
    mode: "auto",
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(response.content, "first\nsecond");
});

test("OpenAIResponsesProvider reports JSON and text error responses", async () => {
  const jsonProvider = new OpenAIResponsesProvider({
    apiKey: "sk-test",
    fetch: async () =>
      jsonResponse(
        {
          error: {
            message: "invalid model"
          }
        },
        400
      )
  });

  await assert.rejects(() => jsonProvider.generate({ mode: "auto", messages: [{ role: "user", content: "hello" }] }), /invalid model/);

  const textProvider = new OpenAIResponsesProvider({
    apiKey: "sk-test",
    fetch: async () => new Response("upstream unavailable", { status: 503 })
  });

  await assert.rejects(
    () => textProvider.generate({ mode: "auto", messages: [{ role: "user", content: "hello" }] }),
    /OpenAI request failed with HTTP 503: upstream unavailable/
  );
});

test("OpenAIResponsesProvider times out slow requests", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "sk-test",
    timeoutMs: 5,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })
  });

  await assert.rejects(
    () => provider.generate({ mode: "auto", messages: [{ role: "user", content: "hello" }] }),
    /OpenAI request timed out after 5ms/
  );
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

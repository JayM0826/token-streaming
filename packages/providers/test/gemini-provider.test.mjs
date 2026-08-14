import assert from "node:assert/strict";
import test from "node:test";
import { GeminiInteractionsProvider } from "../dist/gemini-provider.js";

test("GeminiInteractionsProvider maps the native v1 Interactions API contract", async () => {
  const calls = [];
  const provider = new GeminiInteractionsProvider({
    apiKey: "gemini-secret",
    model: "gemini-3.6-flash",
    baseUrl: "https://generativelanguage.test/v1/",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        model: "gemini-3.6-flash",
        steps: [
          { type: "thought", content: [{ type: "text", text: "summary" }] },
          { type: "model_output", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] }
        ],
        usage: { total_input_tokens: 8, total_output_tokens: 3 }
      });
    }
  });

  const response = await provider.generate({
    mode: "auto",
    reasoningEffort: "medium",
    maxOutputTokens: 32,
    messages: [
      { role: "system", content: "Return a concise answer." },
      { role: "user", content: "Respond with ok." }
    ]
  });

  assert.equal(response.provider, "gemini");
  assert.equal(response.model, "gemini-3.6-flash");
  assert.equal(response.content, "first\nsecond");
  assert.deepEqual(response.usage, { inputTokens: 8, outputTokens: 3 });
  assert.equal(calls[0].url, "https://generativelanguage.test/v1/interactions");
  assert.equal(calls[0].init.headers["x-goog-api-key"], "gemini-secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "gemini-3.6-flash",
    store: false,
    system_instruction: "Return a concise answer.",
    input: "Respond with ok.",
    generation_config: { thinking_level: "medium", max_output_tokens: 32 }
  });
});

test("GeminiInteractionsProvider preserves multi-message text without server-side storage", async () => {
  let requestBody;
  const provider = new GeminiInteractionsProvider({
    apiKey: "key",
    fetch: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return jsonResponse({ output_text: "ok" });
    }
  });
  const response = await provider.generate({
    mode: "auto",
    messages: [
      { role: "user", content: "Question" },
      { role: "assistant", content: "Draft" },
      { role: "tool", content: "Evidence" },
      { role: "user", content: "Revise" }
    ]
  });
  assert.equal(response.content, "ok");
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.input, "User:\nQuestion\n\nAssistant:\nDraft\n\nTool result:\nEvidence\n\nUser:\nRevise");
});

test("GeminiInteractionsProvider reports safe Google errors and timeouts", async () => {
  const errorProvider = new GeminiInteractionsProvider({
    apiKey: "gemini-secret",
    fetch: async () =>
      jsonResponse(
        { error: { code: 400, status: "INVALID_ARGUMENT", message: "bad gemini-secret" } },
        400,
        { "x-request-id": "req-gemini" }
      )
  });
  await assert.rejects(
    () => errorProvider.generate({ mode: "auto", messages: [{ role: "user", content: "hello" }] }),
    /Gemini request failed with HTTP 400 \(code=400, status=INVALID_ARGUMENT, request_id=req-gemini\): bad \[REDACTED\]/
  );

  const timeoutProvider = new GeminiInteractionsProvider({
    apiKey: "key",
    timeoutMs: 5,
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))
  });
  await assert.rejects(
    () => timeoutProvider.generate({ mode: "auto", messages: [{ role: "user", content: "hello" }] }),
    /Gemini request timed out after 5ms/
  );
});

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

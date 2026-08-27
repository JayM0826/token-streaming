import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, readBoundedText, readJson } from "../server/http.ts";

test("bounded reader cancels a streaming response before buffering past its limit", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("1234"));
      controller.enqueue(new TextEncoder().encode("5678"));
    },
    cancel() {
      cancelled = true;
    }
  }));

  await assert.rejects(
    () => readBoundedText(response, 6, () => new ApiError("INVALID_REQUEST", "too large", 413)),
    (error) => error instanceof ApiError && error.status === 413
  );
  assert.equal(cancelled, true);
});

test("JSON request parsing accepts an exact bounded body and rejects declared overflow", async () => {
  const body = JSON.stringify({ ok: true });
  assert.deepEqual(await readJson(new Request("https://example.test", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(body.length) },
    body
  }), body.length), { ok: true });

  await assert.rejects(
    () => readJson(new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1000" },
      body: "{}"
    }), 10),
    (error) => error instanceof ApiError && error.status === 413
  );
});

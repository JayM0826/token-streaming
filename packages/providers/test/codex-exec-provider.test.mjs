import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  CodexExecProvider,
  MAX_CODEX_EXEC_OUTPUT_BYTES,
  detectCodexExec
} from "../dist/index.js";

test("CodexExecProvider sends a bounded stdin prompt through an ephemeral read-only exec", async () => {
  let invocation;
  const provider = new CodexExecProvider({
    executablePath: process.execPath,
    model: "gpt-test",
    cwd: process.cwd(),
    environment: { CODEX_EXEC_PROVIDER_DEPTH: "0" },
    runner: async (options) => {
      invocation = options;
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ type: "turn.completed", model: "gpt-test", usage: { input_tokens: 12, output_tokens: 4 } })}\n`,
        stderr: "",
        finalMessage: "implemented safely"
      };
    }
  });

  const response = await provider.generate({
    mode: "auto",
    reasoningEffort: "high",
    maxOutputTokens: 100,
    messages: [
      { role: "system", content: "Stay focused." },
      { role: "user", content: "Inspect the repository." }
    ]
  });

  assert.equal(response.provider, "codex");
  assert.equal(response.model, "gpt-test");
  assert.equal(response.content, "implemented safely");
  assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 4 });
  assert.match(invocation.prompt, /^System:\nStay focused\.\n\nUser:\nInspect the repository\.$/);
  assert.equal(invocation.environment.CODEX_EXEC_PROVIDER_DEPTH, "1");
  assert.equal(invocation.args.includes("--ephemeral"), true);
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--sandbox"), invocation.args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--model"), invocation.args.indexOf("--model") + 2), ["--model", "gpt-test"]);
  assert.equal(invocation.args.includes("model_reasoning_effort=high"), true);
  assert.equal(invocation.args.includes("service_tier=fast"), true);
  assert.equal(invocation.args.at(-1), "-");
});

test("CodexExecProvider uses its compatible default model and parses JSONL fallback output", async () => {
  const provider = new CodexExecProvider({
    executablePath: process.execPath,
    runner: async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fallback answer" } })}\n`,
      stderr: "",
      finalMessage: "   "
    })
  });
  const response = await provider.generate({ mode: "economy", messages: [{ role: "user", content: "hello" }] });
  assert.equal(response.model, "gpt-5.5");
  assert.equal(response.content, "fallback answer");
});

test("CodexExecProvider reports timeout, output limits, and nested invocation safely", async () => {
  const request = { mode: "auto", messages: [{ role: "user", content: "hello" }] };
  const timedOut = new CodexExecProvider({
    executablePath: process.execPath,
    timeoutMs: 123,
    runner: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true })
  });
  await assert.rejects(() => timedOut.generate(request), /timed out after 123ms/);

  const tooLarge = new CodexExecProvider({
    executablePath: process.execPath,
    runner: async () => ({ exitCode: null, stdout: "", stderr: "", outputLimitExceeded: true })
  });
  await assert.rejects(() => tooLarge.generate(request), new RegExp(`exceeded the ${MAX_CODEX_EXEC_OUTPUT_BYTES}-byte limit`));

  const nested = new CodexExecProvider({
    executablePath: process.execPath,
    environment: { CODEX_EXEC_PROVIDER_DEPTH: "1" },
    runner: async () => ({ exitCode: 0, stdout: "", stderr: "", finalMessage: "unreachable" })
  });
  await assert.rejects(() => nested.generate(request), /Nested Codex exec provider calls are disabled/);
});

test("CodexExecProvider keeps the actionable tail of long process diagnostics", async () => {
  const provider = new CodexExecProvider({
    executablePath: process.execPath,
    runner: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: `${"warning ".repeat(100)}final actionable failure`
    })
  });
  await assert.rejects(
    () => provider.generate({ mode: "auto", messages: [{ role: "user", content: "hello" }] }),
    (error) => {
      assert.match(error.message, /final actionable failure/);
      assert.equal(error.message.length < 600, true);
      return true;
    }
  );
});

test("detectCodexExec prioritizes an installed Codex desktop binary and honors explicit paths", () => {
  const desktop = path.join("C:\\Users\\Tester\\AppData\\Local", "OpenAI", "Codex", "bin", "codex.exe");
  const detection = detectCodexExec({
    platform: "win32",
    environment: { LOCALAPPDATA: "C:\\Users\\Tester\\AppData\\Local", PATH: "C:\\Tools" },
    fileExists: (candidate) => candidate === desktop
  });
  assert.deepEqual(detection, { executablePath: desktop, source: "desktop", found: true, searchedPaths: [desktop] });

  const configured = detectCodexExec({
    configuredPath: "missing-codex.exe",
    environment: {},
    fileExists: () => false
  });
  assert.equal(configured.source, "configured");
  assert.equal(configured.found, false);
  assert.match(configured.executablePath, /missing-codex\.exe$/);
});

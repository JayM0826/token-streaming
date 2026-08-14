import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicMessagesProvider,
  CodexExecProvider,
  GeminiInteractionsProvider,
  OpenAIResponsesProvider,
  StubModelProvider,
  availableProviderNames,
  createModelProvider,
  resolveProviderConfig
} from "../dist/index.js";

test("factory creates each native provider with provider-specific environment", () => {
  const anthropic = createModelProvider({
    provider: "anthropic",
    environment: { ANTHROPIC_API_KEY: "a-key", ANTHROPIC_MODEL: "claude-test" }
  });
  const gemini = createModelProvider({
    provider: "gemini",
    environment: { GEMINI_API_KEY: "g-key", GEMINI_MODEL: "gemini-test" }
  });
  assert.equal(anthropic instanceof AnthropicMessagesProvider, true);
  assert.equal(gemini instanceof GeminiInteractionsProvider, true);
});

test("factory keeps deterministic auto precedence and model-family affinity", () => {
  const environment = {
    OPENAI_API_KEY: "o-key",
    ANTHROPIC_API_KEY: "a-key",
    GEMINI_API_KEY: "g-key"
  };
  assert.equal(createModelProvider({ provider: "auto", environment }) instanceof OpenAIResponsesProvider, true);
  assert.equal(
    createModelProvider({ provider: "auto", model: "claude-sonnet-5", environment }) instanceof AnthropicMessagesProvider,
    true
  );
  assert.equal(
    createModelProvider({ provider: "auto", model: "gemini-3.6-flash", environment }) instanceof GeminiInteractionsProvider,
    true
  );
  assert.equal(createModelProvider({ provider: "auto", model: "claude-sonnet-5", environment: {} }) instanceof StubModelProvider, true);
});

test("factory resolves native defaults and rejects missing explicit credentials", () => {
  const anthropic = resolveProviderConfig({ provider: "anthropic", environment: {} });
  const gemini = resolveProviderConfig({ provider: "gemini", environment: {} });
  assert.equal(anthropic.model, "claude-sonnet-5");
  assert.equal(anthropic.endpoint, "https://api.anthropic.com/v1/messages");
  assert.equal(gemini.model, "gemini-3.6-flash");
  assert.equal(gemini.endpoint, "https://generativelanguage.googleapis.com/v1/interactions");
  assert.throws(() => createModelProvider({ provider: "anthropic", environment: {} }), /ANTHROPIC_API_KEY is required/);
  assert.throws(() => createModelProvider({ provider: "gemini", environment: {} }), /GEMINI_API_KEY is required/);
});

test("availableProviderNames reports only configured commercial providers", () => {
  assert.deepEqual(availableProviderNames({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "" }), ["stub", "anthropic"]);
});

test("factory keeps Codex outside the explicit API auto fallback", () => {
  const runner = async () => ({ exitCode: 0, stdout: "", stderr: "", finalMessage: "ok" });
  const codex = createModelProvider({
    provider: "codex",
    codexExecPath: process.execPath,
    codexExecRunner: runner,
    environment: { CODEX_EXEC_MODEL: "gpt-local", CODEX_EXEC_TIMEOUT_MS: "45000" }
  });
  const config = resolveProviderConfig({
    provider: "codex",
    codexExecPath: process.execPath,
    environment: { CODEX_EXEC_MODEL: "gpt-local", CODEX_EXEC_TIMEOUT_MS: "45000" }
  });

  assert.equal(codex instanceof CodexExecProvider, true);
  assert.equal(config.provider, "codex");
  assert.equal(config.model, "gpt-local");
  assert.equal(config.timeoutMs, 45_000);
  assert.equal(config.serviceTier, "fast");
  assert.equal(config.executableFound, true);
  assert.equal(config.executableSource, "configured");
  assert.equal(
    createModelProvider({ provider: "auto", environment: { CODEX_EXEC_PATH: process.execPath } }) instanceof StubModelProvider,
    true
  );
  assert.deepEqual(availableProviderNames({ CODEX_EXEC_PATH: process.execPath }), ["stub"]);
});

test("factory validates and exposes the Codex service tier override", () => {
  const config = resolveProviderConfig({
    provider: "codex",
    codexExecPath: process.execPath,
    environment: { CODEX_EXEC_SERVICE_TIER: "flex" }
  });
  assert.equal(config.serviceTier, "flex");
  assert.throws(
    () => resolveProviderConfig({ provider: "codex", codexExecPath: process.execPath, environment: { CODEX_EXEC_SERVICE_TIER: "default" } }),
    /Use fast or flex/
  );
});

test("factory defaults to Codex while explicit auto remains API-key routed", () => {
  const runner = async () => ({ exitCode: 0, stdout: "", stderr: "", finalMessage: "ok" });
  const provider = createModelProvider({
    codexExecPath: process.execPath,
    codexExecRunner: runner,
    environment: {}
  });
  const config = resolveProviderConfig({ codexExecPath: process.execPath, environment: {} });

  assert.equal(provider instanceof CodexExecProvider, true);
  assert.equal(config.requestedProvider, "codex");
  assert.equal(config.provider, "codex");
  assert.equal(config.model, "gpt-5.5");
  assert.equal(createModelProvider({ provider: "auto", environment: {} }) instanceof StubModelProvider, true);
});

test("factory rejects an explicitly selected missing Codex executable", () => {
  assert.throws(
    () => createModelProvider({ provider: "codex", codexExecPath: "missing-codex-executable", environment: {} }),
    /runnable Codex executable is required/
  );
});

test("factory treats blank optional environment values as unset", () => {
  const config = resolveProviderConfig({
    provider: "openai",
    environment: { OPENAI_BASE_URL: "", OPENAI_API_PROTOCOL: "", OPENAI_MODEL: "", OPENAI_TIMEOUT_MS: "" }
  });
  assert.equal(config.baseUrl, "https://api.openai.com/v1");
  assert.equal(config.endpoint, "https://api.openai.com/v1/responses");
  assert.equal(config.model, "gpt-5.5");
  assert.equal(config.timeoutMs, 30_000);
});

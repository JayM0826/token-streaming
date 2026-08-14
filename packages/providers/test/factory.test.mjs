import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicMessagesProvider,
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

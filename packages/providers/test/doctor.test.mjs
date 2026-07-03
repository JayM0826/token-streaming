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

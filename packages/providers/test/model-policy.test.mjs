import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelSelection, scoreModelCandidates } from "../dist/model-policy.js";

test("resolveModelSelection prefers explicit CLI model override", () => {
  const selection = resolveModelSelection({
    mode: "economy",
    requestedProvider: "openai",
    requestedModel: "cli-model",
    manifest: {
      models: {
        economy_model: "manifest-economy"
      }
    }
  });

  assert.deepEqual(selection, {
    provider: "openai",
    model: "cli-model",
    source: "cli"
  });
});

test("resolveModelSelection uses environment model before manifest policy", () => {
  const selection = resolveModelSelection({
    mode: "auto",
    requestedProvider: "openai",
    environmentModel: "relay-model",
    manifest: {
      models: {
        auto_model: "manifest-model"
      }
    }
  });

  assert.deepEqual(selection, {
    provider: "openai",
    model: "relay-model",
    source: "environment"
  });
});

test("resolveModelSelection keeps CLI model above environment model", () => {
  const selection = resolveModelSelection({
    mode: "auto",
    requestedProvider: "openai",
    requestedModel: "cli-model",
    environmentModel: "relay-model"
  });

  assert.equal(selection.model, "cli-model");
  assert.equal(selection.source, "cli");
});

test("resolveModelSelection ignores whitespace-only environment model", () => {
  const selection = resolveModelSelection({
    mode: "auto",
    requestedProvider: "openai",
    environmentModel: "   ",
    manifest: {
      models: {
        auto_model: "manifest-model"
      }
    }
  });

  assert.equal(selection.model, "manifest-model");
  assert.equal(selection.source, "scored");
});

test("resolveModelSelection uses mode-specific manifest model", () => {
  const selection = resolveModelSelection({
    mode: "max",
    requestedProvider: "auto",
    manifest: {
      models: {
        default_provider: "auto",
        economy_model: "small-model",
        max_model: "strong-model"
      }
    }
  });

  assert.equal(selection.provider, "auto");
  assert.equal(selection.model, "strong-model");
  assert.equal(selection.source, "scored");
  assert.equal(selection.scoring.objective, "quality");
  assert.equal(selection.scoring.selected.model, "strong-model");
});

test("resolveModelSelection falls back to provider defaults", () => {
  const selection = resolveModelSelection({
    mode: "auto",
    requestedProvider: "stub",
    manifest: {
      models: {}
    }
  });

  assert.deepEqual(selection, {
    provider: "stub",
    source: "provider-default"
  });
});

test("resolveModelSelection honors available manifest candidate providers in auto mode", () => {
  const selection = resolveModelSelection({
    mode: "auto",
    requestedProvider: "auto",
    availableProviders: ["stub", "anthropic"],
    manifest: {
      models: {
        model_candidates: [
          "gpt-model;provider=openai;quality=0.99;cost=0.1;latency=0.1;tags=balanced",
          "claude-model;provider=anthropic;quality=0.9;cost=0.4;latency=0.4;tags=balanced"
        ]
      }
    }
  });

  assert.equal(selection.provider, "anthropic");
  assert.equal(selection.model, "claude-model");
  assert.equal(selection.scoring.candidates.some((candidate) => candidate.provider === "openai"), false);
});

test("resolveModelSelection uses the available provider default instead of an unavailable model family", () => {
  const selection = resolveModelSelection({
    mode: "auto",
    requestedProvider: "auto",
    availableProviders: ["stub", "anthropic"],
    manifest: {
      models: {
        default_provider: "auto",
        auto_model: "gpt-5.5",
        model_candidates: ["gpt-5.5;provider=openai;quality=0.94;cost=0.75;latency=0.55;tags=balanced"]
      }
    }
  });

  assert.deepEqual(selection, { provider: "auto", source: "provider-default" });
});

test("resolveModelSelection does not send another provider's manifest model to an explicit provider", () => {
  const selection = resolveModelSelection({
    mode: "max",
    requestedProvider: "anthropic",
    availableProviders: ["stub", "anthropic"],
    manifest: {
      models: {
        max_model: "gpt-5.5",
        model_candidates: ["gpt-5.5;provider=openai;quality=0.94;cost=0.75;latency=0.55;tags=max"]
      }
    }
  });

  assert.deepEqual(selection, { provider: "anthropic", source: "provider-default" });
});

test("scoreModelCandidates ranks manifest candidates by mode objective and telemetry", () => {
  const decision = scoreModelCandidates({
    mode: "economy",
    riskLevel: "low",
    manifest: {
      models: {
        model_candidates: [
          "cheap-model;provider=openai;quality=0.65;cost=0.15;latency=0.2;tags=cheap",
          "strong-model;provider=openai;quality=0.95;cost=0.9;latency=0.7;tags=strong"
        ]
      }
    },
    telemetry: {
      byModel: [
        {
          key: "cheap-model",
          failureRate: 0.1,
          calls: 10
        }
      ]
    }
  });

  assert.equal(decision.objective, "cost");
  assert.equal(decision.selected.model, "cheap-model");
  assert.equal(decision.candidates[0].failureRate, 0.1);
  assert.match(decision.candidates[0].reasons.join(" "), /Objective=cost/);
});

test("scoreModelCandidates gives auto mode affinity to balanced candidates", () => {
  const decision = scoreModelCandidates({
    mode: "auto",
    manifest: {
      models: {
        model_candidates: [
          "cheap-model;provider=openai;quality=0.72;cost=0.25;latency=0.25;tags=economy,fast",
          "balanced-model;provider=openai;quality=0.94;cost=0.75;latency=0.55;tags=balanced"
        ]
      }
    }
  });

  assert.equal(decision.objective, "balanced");
  assert.equal(decision.selected.model, "balanced-model");
  assert.match(decision.selected.reasons.join(" "), /Mode affinity boost applied for auto/);
});

test("scoreModelCandidates uses task-specific recommendations as routing feedback", () => {
  const decision = scoreModelCandidates({
    mode: "auto",
    task: "fix failing test",
    manifest: {
      models: {
        model_candidates: [
          "steady-model;provider=openai;quality=0.8;cost=0.5;latency=0.5;tags=balanced",
          "risky-model;provider=openai;quality=0.8;cost=0.5;latency=0.5;tags=balanced"
        ]
      }
    },
    telemetry: {
      recommendations: [
        {
          model: "steady-model",
          provider: "openai",
          mode: "auto",
          purpose: "planning",
          taskKind: "test-fix",
          confidence: "medium",
          recommendation: "prefer",
          efficiencyScore: 0.9,
          failureRate: 0,
          sessions: 8
        },
        {
          model: "risky-model",
          provider: "openai",
          mode: "auto",
          purpose: "planning",
          taskKind: "test-fix",
          confidence: "medium",
          recommendation: "avoid",
          efficiencyScore: 0.35,
          failureRate: 0.6,
          sessions: 8
        }
      ]
    }
  });

  assert.equal(decision.taskKind, "test-fix");
  assert.equal(decision.selected.model, "steady-model");
  assert.equal(decision.selected.feedback.recommendation, "prefer");
  assert.match(decision.selected.reasons.join(" "), /Telemetry recommendation=prefer/);
  assert.equal(decision.candidates.at(-1).model, "risky-model");
  assert.equal(decision.candidates.at(-1).feedback.recommendation, "avoid");
});

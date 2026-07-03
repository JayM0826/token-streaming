import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EventLog } from "../dist/event-log.js";
import { TelemetryStore } from "../dist/telemetry-store.js";

test("TelemetryStore aggregates model calls across sessions", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-telemetry-"));
  try {
    await appendModelCall(repoRoot, "ses_one", {
      purpose: "planning",
      provider: "openai",
      model: "gpt-a",
      mode: "max",
      reasoningEffort: "high",
      inputTokens: 100,
      outputTokens: 20,
      responseCharacters: 300
    });
    await appendCompletion(repoRoot, "ses_one", "ok");
    await appendModelCall(repoRoot, "ses_two", {
      purpose: "repair",
      provider: "openai",
      model: "gpt-a",
      mode: "auto",
      reasoningEffort: "high",
      inputTokens: 50,
      outputTokens: 10,
      responseCharacters: 120
    });
    await appendModelCall(repoRoot, "ses_two", {
      purpose: "planning",
      provider: "stub",
      model: "stub",
      mode: "economy",
      reasoningEffort: "medium",
      responseCharacters: 40
    });
    await appendCompletion(repoRoot, "ses_two", "ok");
    await appendModelCall(repoRoot, "ses_three", {
      purpose: "planning",
      provider: "stub",
      model: "stub",
      mode: "auto",
      reasoningEffort: "medium",
      responseCharacters: 60
    });
    await appendFailure(repoRoot, "ses_three", "Unexpected end of JSON input");

    const summary = await new TelemetryStore(repoRoot).summarizeModelCalls();

    assert.equal(summary.totalSessions, 3);
    assert.equal(summary.completedSessions, 2);
    assert.equal(summary.failedSessions, 1);
    assert.equal(summary.runningSessions, 0);
    assert.equal(summary.failureRate, 1 / 3);
    assert.equal(summary.totalCalls, 4);
    assert.equal(summary.totalInputTokens, 150);
    assert.equal(summary.totalOutputTokens, 30);
    assert.equal(summary.totalResponseCharacters, 520);
    assert.deepEqual(summary.byProvider.map((group) => [group.key, group.calls]), [
      ["openai", 2],
      ["stub", 2]
    ]);
    assert.deepEqual(
      summary.byProvider.map((group) => [group.key, group.sessions, group.failedSessions, group.failureRate]),
      [
        ["openai", 2, 0, 0],
        ["stub", 2, 1, 0.5]
      ]
    );
    assert.deepEqual(summary.byPurpose.map((group) => [group.key, group.calls]), [
      ["planning", 3],
      ["repair", 1]
    ]);
    assert.deepEqual(summary.byFailureCategory.map((group) => [group.key, group.sessions]), [["patch-proposal", 1]]);
    assert.equal(summary.byModel.find((group) => group.key === "gpt-a")?.inputTokens, 150);
    assert.equal(summary.recommendations.length, 4);
    assert.deepEqual(
      summary.recommendations.map((recommendation) => [
        recommendation.mode,
        recommendation.purpose,
        recommendation.taskKind,
        recommendation.model,
        recommendation.recommendation
      ]),
      [
        ["auto", "repair", "unknown", "gpt-a", "prefer"],
        ["max", "planning", "unknown", "gpt-a", "prefer"],
        ["economy", "planning", "unknown", "stub", "prefer"],
        ["auto", "planning", "unknown", "stub", "avoid"]
      ]
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TelemetryStore recommends models by inferred task kind", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-telemetry-"));
  try {
    await appendUserMessage(repoRoot, "ses_feature", "add a new API feature");
    await appendModelCall(repoRoot, "ses_feature", {
      purpose: "planning",
      provider: "openai",
      model: "gpt-feature",
      mode: "auto",
      reasoningEffort: "medium",
      inputTokens: 800,
      outputTokens: 200,
      responseCharacters: 2000
    });
    await appendCompletion(repoRoot, "ses_feature", "feature complete");

    await appendUserMessage(repoRoot, "ses_fix", "fix failing test");
    await appendModelCall(repoRoot, "ses_fix", {
      purpose: "planning",
      provider: "openai",
      model: "gpt-fix",
      mode: "auto",
      reasoningEffort: "medium",
      inputTokens: 900,
      outputTokens: 220,
      responseCharacters: 1800
    });
    await appendFailure(repoRoot, "ses_fix", "Tests failed");

    const recommendations = (await new TelemetryStore(repoRoot).summarizeModelCalls()).recommendations;

    assert.equal(recommendations.find((item) => item.model === "gpt-feature")?.taskKind, "feature");
    assert.equal(recommendations.find((item) => item.model === "gpt-feature")?.recommendation, "prefer");
    assert.equal(recommendations.find((item) => item.model === "gpt-fix")?.taskKind, "test-fix");
    assert.equal(recommendations.find((item) => item.model === "gpt-fix")?.recommendation, "avoid");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TelemetryStore returns empty totals when no model calls exist", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-telemetry-"));
  try {
    const summary = await new TelemetryStore(repoRoot).summarizeModelCalls();
    assert.equal(summary.totalSessions, 0);
    assert.equal(summary.completedSessions, 0);
    assert.equal(summary.totalCalls, 0);
    assert.equal(summary.failedSessions, 0);
    assert.equal(summary.runningSessions, 0);
    assert.equal(summary.failureRate, 0);
    assert.deepEqual(summary.byProvider, []);
    assert.deepEqual(summary.byFailureCategory, []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

async function appendModelCall(repoRoot, sessionId, call) {
  const log = new EventLog(repoRoot, sessionId);
  await log.append({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "model.called",
    call
  });
}

async function appendUserMessage(repoRoot, sessionId, message) {
  const log = new EventLog(repoRoot, sessionId);
  await log.append({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "user.message",
    message
  });
}

async function appendCompletion(repoRoot, sessionId, summary) {
  const log = new EventLog(repoRoot, sessionId);
  await log.append({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "run.completed",
    summary
  });
}

async function appendFailure(repoRoot, sessionId, error) {
  const log = new EventLog(repoRoot, sessionId);
  await log.append({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "run.failed",
    error
  });
}

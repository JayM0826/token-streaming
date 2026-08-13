import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EventLog } from "../dist/event-log.js";
import { SessionHistoryStore } from "../dist/session-history-store.js";

test("SessionHistoryStore lists and reads event timelines", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-history-"));
  try {
    const sessionId = "ses_test";
    const log = new EventLog(repoRoot, sessionId);

    await log.append({
      id: "evt_1",
      sessionId,
      timestamp: "2026-06-20T00:00:00.000Z",
      type: "user.message",
      message: "add endpoint"
    });
    await log.append({
      id: "evt_2",
      sessionId,
      timestamp: "2026-06-20T00:00:01.000Z",
      type: "run.completed",
      summary: "Session finished.\nMore details."
    });

    const store = new SessionHistoryStore(repoRoot);
    const summaries = await store.list();
    const events = await store.read(sessionId);

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.sessionId, sessionId);
    assert.equal(summaries[0]?.status, "completed");
    assert.equal(summaries[0]?.eventCount, 2);
    assert.equal(summaries[0]?.task, "add endpoint");
    assert.equal(summaries[0]?.summary, "Session finished.");
    assert.equal(events[0]?.type, "user.message");
    assert.equal(events[1]?.type, "run.completed");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("SessionHistoryStore summarizes failed sessions", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-history-"));
  try {
    const sessionId = "ses_failed";
    const log = new EventLog(repoRoot, sessionId);

    await log.append({
      id: "evt_1",
      sessionId,
      timestamp: "2026-06-20T00:00:00.000Z",
      type: "user.message",
      message: "apply malformed patch"
    });
    await log.append({
      id: "evt_2",
      sessionId,
      timestamp: "2026-06-20T00:00:01.000Z",
      type: "run.failed",
      error: "Unexpected end of JSON input\nMore details."
    });

    const summaries = await new SessionHistoryStore(repoRoot).list();

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.sessionId, sessionId);
    assert.equal(summaries[0]?.status, "failed");
    assert.equal(summaries[0]?.failureCategory, "patch-proposal");
    assert.equal(summaries[0]?.failedAt, "2026-06-20T00:00:01.000Z");
    assert.equal(summaries[0]?.error, "Unexpected end of JSON input");
    assert.equal(summaries[0]?.summary, undefined);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("SessionHistoryStore prefers structured run start metadata", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-history-"));
  try {
    const sessionId = "ses_started";
    const log = new EventLog(repoRoot, sessionId);

    await log.append({
      id: "evt_1",
      sessionId,
      timestamp: "2026-06-20T00:00:00.000Z",
      type: "run.started",
      task: "structured task",
      repoRoot,
      mode: "auto",
      strategy: "default"
    });
    await log.append({
      id: "evt_2",
      sessionId,
      timestamp: "2026-06-20T00:00:01.000Z",
      type: "user.message",
      message: "legacy task"
    });

    const [summary] = await new SessionHistoryStore(repoRoot).list();

    assert.equal(summary.task, "structured task");
    assert.equal(summary.startedAt, "2026-06-20T00:00:00.000Z");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("SessionHistoryStore returns an empty list when no sessions exist", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-history-"));
  try {
    const store = new SessionHistoryStore(repoRoot);
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("SessionHistoryStore rejects session ids that escape storage", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-history-"));
  try {
    const store = new SessionHistoryStore(repoRoot);
    await assert.rejects(() => store.read("../../outside"), /Invalid session id/);
    assert.throws(() => new EventLog(repoRoot, "../../outside"), /Invalid session id/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

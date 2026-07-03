import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RunReportStore } from "../dist/run-report-store.js";

test("RunReportStore lists and reads reports", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-reports-"));
  try {
    const store = new RunReportStore(repoRoot);
    const session = {
      id: "ses_report",
      repoRoot,
      mode: "auto",
      strategy: "default",
      startedAt: "2026-06-23T00:00:00.000Z"
    };

    const reportPath = await store.write({
      session,
      repo: {
        root: repoRoot,
        packageManager: "pnpm",
        scripts: {},
        trackedFiles: [],
        sourceDirectories: [],
        moduleManifestPaths: [],
        workflowManifestPaths: [],
        aiManifestPresent: true
      },
      manifest: {
        playbooks: [],
        modules: [],
        workflows: [],
        generated: false
      },
      plan: {
        strategy: "default",
        mode: "auto",
        task: "summarize",
        riskLevel: "low",
        phases: [],
        requiredAgents: [],
        handoffs: [],
        testCommands: [],
        notes: []
      },
      summary: "Done.",
      eventLogPath: "/tmp/session.jsonl",
      toolCalls: [
        {
          name: "test.run",
          ok: true,
          inputSummary: "pnpm test",
          outputSummary: "exit=0"
        }
      ],
      changes: {
        patchProposalFiles: ["notes/example.md"],
        repairProposalFiles: [],
        appliedFiles: ["notes/example.md"],
        checkpointId: "chk_report",
        gitStatus: "M notes/example.md",
        gitDiff: "diff --git a/notes/example.md b/notes/example.md"
      }
    });

    const reports = await store.list();
    const content = await store.read(session.id);

    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.sessionId, session.id);
    assert.equal(reports[0]?.status, "completed");
    assert.equal(reports[0]?.title, "Token Streaming Run ses_report");
    assert.equal(reports[0]?.createdAt, session.startedAt);
    assert.equal(reports[0]?.path, reportPath);
    assert.ok((reports[0]?.sizeBytes ?? 0) > 0);
    assert.match(content, /## Summary/);
    assert.match(content, /## Tools/);
    assert.match(content, /test\.run: ok/);
    assert.match(content, /## Changes/);
    assert.match(content, /checkpoint: chk_report/);
    assert.match(content, /applied files: notes\/example\.md/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("RunReportStore marks failure reports in summaries", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-reports-"));
  try {
    const store = new RunReportStore(repoRoot);
    const session = {
      id: "ses_failed_report",
      repoRoot,
      mode: "auto",
      strategy: "default",
      startedAt: "2026-06-23T00:00:00.000Z"
    };

    await store.write({
      session,
      repo: {
        root: repoRoot,
        packageManager: "pnpm",
        scripts: {},
        trackedFiles: [],
        sourceDirectories: [],
        moduleManifestPaths: [],
        workflowManifestPaths: [],
        aiManifestPresent: true
      },
      manifest: {
        playbooks: [],
        modules: [],
        workflows: [],
        generated: false
      },
      plan: {
        strategy: "default",
        mode: "auto",
        task: "apply malformed patch",
        riskLevel: "medium",
        phases: [],
        requiredAgents: [],
        handoffs: [],
        testCommands: [],
        notes: []
      },
      summary: "Run failed: Unexpected end of JSON input",
      eventLogPath: "/tmp/session.jsonl",
      changes: {
        patchProposalFiles: [],
        repairProposalFiles: [],
        appliedFiles: []
      }
    });

    const reports = await store.list();

    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.sessionId, session.id);
    assert.equal(reports[0]?.status, "failed");
    assert.equal(reports[0]?.failureCategory, "patch-proposal");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("RunReportStore classifies tool execution failure reports", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-reports-"));
  try {
    const store = new RunReportStore(repoRoot);
    const session = {
      id: "ses_tool_failed_report",
      repoRoot,
      mode: "auto",
      strategy: "default",
      startedAt: "2026-06-23T00:00:00.000Z"
    };

    await store.write({
      session,
      repo: {
        root: repoRoot,
        packageManager: "pnpm",
        scripts: {},
        trackedFiles: [],
        sourceDirectories: [],
        moduleManifestPaths: [],
        workflowManifestPaths: [],
        aiManifestPresent: true
      },
      manifest: {
        playbooks: [],
        modules: [],
        workflows: [],
        generated: false
      },
      plan: {
        strategy: "default",
        mode: "auto",
        task: "tools run file.read",
        riskLevel: "medium",
        phases: [],
        requiredAgents: [],
        handoffs: [],
        testCommands: [],
        notes: []
      },
      summary: "Run failed: Path escapes repository root: ../outside.txt",
      eventLogPath: "/tmp/session.jsonl",
      changes: {
        patchProposalFiles: [],
        repairProposalFiles: [],
        appliedFiles: []
      }
    });

    const reports = await store.list();

    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.status, "failed");
    assert.equal(reports[0]?.failureCategory, "tool-execution");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("RunReportStore returns an empty list when no reports exist", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-reports-"));
  try {
    assert.deepEqual(await new RunReportStore(repoRoot).list(), []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

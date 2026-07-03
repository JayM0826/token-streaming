import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AllowApprovalHost, TokenStreamingRuntime } from "../dist/index.js";

test("TokenStreamingRuntime runs all passing verification commands", async () => {
  const repoRoot = await createRuntimeRepo({
    test: markerScript("test-ran.txt"),
    typecheck: markerScript("typecheck-ran.txt"),
    lint: markerScript("lint-ran.txt")
  });

  try {
    const runtime = new TokenStreamingRuntime({ repoRoot, mode: "auto" });
    const result = await runtime.runTask({ task: "add a harmless endpoint" });

    assert.deepEqual(
      result.verificationResults.map((verification) => verification.exitCode),
      [0, 0, 0]
    );
    assert.deepEqual(
      result.verificationResults.map((verification) => verification.command),
      ["npm run test", "npm run typecheck", "npm run lint"]
    );
    assert.equal(await readFile(path.join(repoRoot, "test-ran.txt"), "utf8"), "ran");
    assert.equal(await readFile(path.join(repoRoot, "typecheck-ran.txt"), "utf8"), "ran");
    assert.equal(await readFile(path.join(repoRoot, "lint-ran.txt"), "utf8"), "ran");
    const events = await readSessionEvents(result.eventLogPath);
    assert.equal(events.filter((event) => event.type === "tool.started" && event.toolName === "test.run").length, 3);
    assert.equal(events.filter((event) => event.type === "tool.finished" && event.toolName === "test.run" && event.ok === true).length, 3);
    const review = events.find((event) => event.type === "review.completed");
    assert.equal(review?.review.verificationStatus, "passed");
    assert.equal(result.review.verificationStatus, "passed");
    const report = await readFile(result.reportPath, "utf8");
    assert.match(report, /## Tools/);
    assert.match(report, /## Review/);
    assert.match(report, /Recommendation: Ready for human review\./);
    assert.match(report, /test\.run: ok/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TokenStreamingRuntime stops verification after the first failing command", async () => {
  const repoRoot = await createRuntimeRepo({
    test: markerScript("test-ran.txt"),
    typecheck: "node -e \"process.exit(1)\"",
    lint: markerScript("lint-ran.txt")
  });

  try {
    const runtime = new TokenStreamingRuntime({ repoRoot, mode: "auto" });
    const result = await runtime.runTask({ task: "fix checkout failure" });

    assert.equal(result.verificationResults.length, 2);
    assert.equal(result.verificationResults[0]?.command, "npm run test");
    assert.equal(result.verificationResults[0]?.ok, true);
    assert.equal(result.verificationResults[1]?.command, "npm run typecheck");
    assert.equal(result.verificationResults[1]?.ok, false);
    assert.equal(existsSync(path.join(repoRoot, "lint-ran.txt")), false);
    const events = await readSessionEvents(result.eventLogPath);
    assert.equal(events.filter((event) => event.type === "tool.started" && event.toolName === "test.run").length, 2);
    assert.equal(events.filter((event) => event.type === "tool.finished" && event.toolName === "test.run").length, 2);
    assert.equal(events.some((event) => event.type === "tool.finished" && event.toolName === "test.run" && event.ok === false), true);
    assert.equal(events.find((event) => event.type === "review.completed")?.review.verificationStatus, "failed");
    assert.equal(result.review.recommendation, "Inspect the failing verification output before continuing.");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TokenStreamingRuntime blocks forbidden verification commands before execution", async () => {
  const repoRoot = await createRuntimeRepo(
    {
      test: markerScript("test-ran.txt"),
      typecheck: markerScript("typecheck-ran.txt"),
      lint: markerScript("lint-ran.txt")
    },
    "forbidden_commands:\n  - npm run typecheck\n"
  );

  try {
    const runtime = new TokenStreamingRuntime({ repoRoot, mode: "auto" });

    await assert.rejects(
      () => runtime.runTask({ task: "fix checkout failure" }),
      /Command blocked by policy: Command matches forbidden pattern: npm run typecheck/
    );
    assert.equal(await readFile(path.join(repoRoot, "test-ran.txt"), "utf8"), "ran");
    assert.equal(existsSync(path.join(repoRoot, "typecheck-ran.txt")), false);
    assert.equal(existsSync(path.join(repoRoot, "lint-ran.txt")), false);
    const events = await readLatestSessionEvents(repoRoot);
    const failure = events.find((event) => event.type === "run.failed");
    assert.match(failure?.error, /Command blocked by policy/);
    const report = await readLatestReport(repoRoot);
    assert.match(report, /## Summary/);
    assert.match(report, /Run failed: Command blocked by policy/);
    assert.match(report, /## Permissions/);
    assert.match(report, /command blocked \(high\): npm run typecheck/);
    assert.match(report, /## Tools/);
    assert.match(report, /test\.run: ok/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TokenStreamingRuntime approves configured verification commands through the approval host", async () => {
  const repoRoot = await createRuntimeRepo(
    {
      test: markerScript("test-ran.txt")
    },
    "approval_required_commands:\n  - npm run test\n"
  );

  try {
    const runtime = new TokenStreamingRuntime({ repoRoot, mode: "auto", approvalHost: new AllowApprovalHost() });
    const result = await runtime.runTask({ task: "fix checkout failure" });

    assert.equal(result.verificationResults.length, 1);
    assert.equal(result.verificationResults[0]?.ok, true);
    assert.equal(result.approvalResponses.length, 1);
    assert.equal(result.approvalResponses[0]?.approved, true);
    assert.equal(await readFile(path.join(repoRoot, "test-ran.txt"), "utf8"), "ran");
    const events = await readSessionEvents(result.eventLogPath);
    assert.equal(events.some((event) => event.type === "approval.requested" && event.request.target === "command"), true);
    assert.equal(events.some((event) => event.type === "approval.resolved" && event.response.approved === true), true);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TokenStreamingRuntime blocks approval-required verification commands by default", async () => {
  const repoRoot = await createRuntimeRepo(
    {
      test: markerScript("test-ran.txt")
    },
    "approval_required_commands:\n  - npm run test\n"
  );

  try {
    const runtime = new TokenStreamingRuntime({ repoRoot, mode: "auto" });

    await assert.rejects(() => runtime.runTask({ task: "fix checkout failure" }), /Command blocked by approval/);
    assert.equal(existsSync(path.join(repoRoot, "test-ran.txt")), false);
    const events = await readLatestSessionEvents(repoRoot);
    assert.equal(events.some((event) => event.type === "approval.requested" && event.request.target === "command"), true);
    assert.equal(events.some((event) => event.type === "run.failed" && /Command blocked by approval/.test(event.error)), true);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

async function createRuntimeRepo(scripts, safetyYaml) {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-runtime-"));
  await writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify(
      {
        scripts
      },
      null,
      2
    ),
    "utf8"
  );

  if (safetyYaml) {
    await writeFile(path.join(repoRoot, ".ai", "safety.yaml"), safetyYaml, { encoding: "utf8", flag: "w" }).catch(async (error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(repoRoot, ".ai"), { recursive: true });
      await writeFile(path.join(repoRoot, ".ai", "safety.yaml"), safetyYaml, "utf8");
    });
  }

  return repoRoot;
}

function markerScript(fileName) {
  return `node -e "require('fs').writeFileSync('${fileName}', 'ran')"`;
}

async function readSessionEvents(logPath) {
  const content = await readFile(logPath, "utf8");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readLatestSessionEvents(repoRoot) {
  const { readdir } = await import("node:fs/promises");
  const sessionRoot = path.join(repoRoot, ".token-streaming", "sessions");
  const entries = await readdir(sessionRoot);
  const latest = entries.filter((entry) => entry.endsWith(".jsonl")).sort().at(-1);
  assert.ok(latest);
  return readSessionEvents(path.join(sessionRoot, latest));
}

async function readLatestReport(repoRoot) {
  const { readdir } = await import("node:fs/promises");
  const reportsRoot = path.join(repoRoot, ".token-streaming", "reports");
  const entries = await readdir(reportsRoot);
  const latest = entries.filter((entry) => entry.endsWith(".md")).sort().at(-1);
  assert.ok(latest);
  return readFile(path.join(reportsRoot, latest), "utf8");
}

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TokenStreamingRuntime } from "../dist/index.js";

test("TokenStreamingRuntime can run a registered custom strategy", async () => {
  const repoRoot = await createRepo();
  try {
    const provider = new RecordingProvider();
    const customStrategy = {
      id: "custom-test",
      async createPlan(input) {
        return {
          strategy: "custom-test",
          mode: input.mode,
          task: input.task,
          riskLevel: "low",
          phases: [
            {
              id: "custom-phase",
              role: "orchestrator",
              title: "Custom phase",
              description: "Proves runtime strategy selection is injectable.",
              required: true
            }
          ],
          requiredAgents: ["orchestrator"],
          handoffs: [
            {
              from: "orchestrator",
              artifact: "custom plan",
              description: "Custom phase produces custom plan for the final run summary."
            }
          ],
          testCommands: [],
          notes: ["custom strategy selected"]
        };
      }
    };

    const runtime = new TokenStreamingRuntime({
      repoRoot,
      mode: "auto",
      strategy: "custom-test",
      strategies: [customStrategy],
      modelProvider: provider
    });

    const result = await runtime.runTask({ task: "summarize custom strategy", dryRun: true });

    assert.equal(result.session.strategy, "custom-test");
    assert.equal(result.plan.strategy, "custom-test");
    assert.deepEqual(result.plan.phases.map((phase) => phase.id), ["custom-phase"]);
    assert.match(result.summary, /custom-test strategy/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TokenStreamingRuntime rejects unknown strategies with available strategy names", async () => {
  const repoRoot = await createRepo();
  try {
    assert.throws(
      () => new TokenStreamingRuntime({ repoRoot, strategy: "missing" }),
      /Unknown strategy "missing". Available strategies: default./
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TokenStreamingRuntime uses mode profiles for model reasoning effort", async () => {
  const repoRoot = await createRepo();
  try {
    const economyProvider = new RecordingProvider();
    await new TokenStreamingRuntime({ repoRoot, mode: "economy", modelProvider: economyProvider }).runTask({
      task: "summarize economy mode",
      dryRun: true
    });

    const maxProvider = new RecordingProvider();
    await new TokenStreamingRuntime({ repoRoot, mode: "max", modelProvider: maxProvider }).runTask({
      task: "summarize max mode",
      dryRun: true
    });

    assert.equal(economyProvider.requests[0]?.reasoningEffort, "medium");
    assert.equal(maxProvider.requests[0]?.reasoningEffort, "high");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TokenStreamingRuntime records planning model calls in result, event log, and report", async () => {
  const repoRoot = await createRepo();
  try {
    const provider = new RecordingProvider({
      content: "Planning response.",
      usage: { inputTokens: 123, outputTokens: 45 }
    });
    const runtime = new TokenStreamingRuntime({ repoRoot, mode: "max", modelProvider: provider });

    const result = await runtime.runTask({ task: "summarize model telemetry", dryRun: true });
    const eventLog = await readFile(result.eventLogPath, "utf8");
    const report = await readFile(result.reportPath, "utf8");

    assert.equal(result.modelCalls.length, 1);
    assert.deepEqual(result.modelCalls[0], {
      purpose: "planning",
      provider: "recording",
      model: "recording-model",
      mode: "max",
      reasoningEffort: "high",
      inputTokens: 123,
      outputTokens: 45,
      responseCharacters: "Planning response.".length
    });
    assert.match(eventLog, /"type":"model.called"/);
    assert.match(report, /## Model Calls/);
    assert.match(report, /planning: recording\/recording-model max reasoning=high/);
    assert.match(result.summary, /Model calls: planning:recording\/recording-model:high/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TokenStreamingRuntime can run optional parallel role agents before planning", async () => {
  const repoRoot = await createRepo();
  try {
    const provider = new RecordingProvider({ content: "Role artifact." });
    const runtime = new TokenStreamingRuntime({ repoRoot, mode: "auto", modelProvider: provider });

    const result = await runtime.runTask({ task: "fix failing test", dryRun: true, parallelAgents: true });
    const eventLog = await readFile(result.eventLogPath, "utf8");
    const events = eventLog
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const report = await readFile(result.reportPath, "utf8");

    assert.deepEqual(
      result.agentRuns.map((run) => run.role).sort(),
      ["coder", "research", "reviewer", "tester"]
    );
    assert.equal(result.agentRuns.every((run) => run.ok), true);
    assert.equal(result.modelCalls.filter((call) => call.purpose === "agent").length, 4);
    assert.equal(result.modelCalls.filter((call) => call.purpose === "planning").length, 1);
    assert.equal(events.filter((event) => event.type === "agent.started").length, 4);
    assert.equal(events.filter((event) => event.type === "agent.finished" && event.ok).length, 4);
    assert.match(provider.requests.at(-1)?.messages.at(-1)?.content, /## Parallel Agent Artifacts/);
    assert.match(result.summary, /Parallel agent artifacts: 4/);
    assert.match(report, /## Agent Runs/);
    assert.match(report, /research\/research: ok/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TokenStreamingRuntime records run.failed when the model provider throws", async () => {
  const repoRoot = await createRepo();
  try {
    const runtime = new TokenStreamingRuntime({
      repoRoot,
      mode: "auto",
      modelProvider: new ThrowingProvider()
    });

    await assert.rejects(() => runtime.runTask({ task: "summarize provider failure", dryRun: true }), /provider exploded/);

    const sessionsDir = path.join(repoRoot, ".token-streaming", "sessions");
    const sessionFiles = await readdir(sessionsDir);
    assert.equal(sessionFiles.length, 1);

    const eventLog = await readFile(path.join(sessionsDir, sessionFiles[0]), "utf8");
    const events = eventLog
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));

    assert.equal(events.some((event) => event.type === "model.called"), false);
    assert.equal(
      events.some((event) => event.type === "run.failed" && /Model call failed during planning: provider exploded/.test(event.error)),
      true
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "review.completed" &&
          event.review.verificationStatus === "not-run" &&
          event.review.recommendation === "Inspect the recorded failure before continuing."
      ),
      true
    );

    const reportsDir = path.join(repoRoot, ".token-streaming", "reports");
    const reportFiles = await readdir(reportsDir);
    assert.equal(reportFiles.length, 1);
    const report = await readFile(path.join(reportsDir, reportFiles[0]), "utf8");
    assert.match(report, /## Summary/);
    assert.match(report, /Run failed: Model call failed during planning: provider exploded/);
    assert.match(report, /## Model Calls/);
    assert.match(report, /no model calls recorded/);
    assert.match(report, /## Review/);
    assert.match(report, /Recommendation: Inspect the recorded failure before continuing\./);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TokenStreamingRuntime records a report when initialization fails", async () => {
  const repoRoot = await createRepo();
  try {
    const failingStrategy = {
      id: "failing-init",
      async createPlan() {
        throw new Error("strategy initialization exploded");
      }
    };
    const runtime = new TokenStreamingRuntime({
      repoRoot,
      strategy: "failing-init",
      strategies: [failingStrategy],
      modelProvider: new RecordingProvider()
    });

    await assert.rejects(() => runtime.runTask({ task: "initialize failing strategy" }), /strategy initialization exploded/);

    const sessionFiles = await readdir(path.join(repoRoot, ".token-streaming", "sessions"));
    const reportFiles = await readdir(path.join(repoRoot, ".token-streaming", "reports"));
    assert.equal(sessionFiles.length, 1);
    assert.equal(reportFiles.length, 1);

    const eventLog = await readFile(path.join(repoRoot, ".token-streaming", "sessions", sessionFiles[0]), "utf8");
    const report = await readFile(path.join(repoRoot, ".token-streaming", "reports", reportFiles[0]), "utf8");
    assert.match(eventLog, /"type":"run.failed"/);
    assert.match(eventLog, /Run failed during initialization: strategy initialization exploded/);
    assert.match(eventLog, /"type":"review.completed"/);
    assert.match(report, /Run failed during initialization: strategy initialization exploded/);
    assert.match(report, /Recommendation: Resolve the initialization failure before continuing\./);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TokenStreamingRuntime records run.failed when a patch proposal cannot be parsed", async () => {
  const repoRoot = await createRepo();
  try {
    const runtime = new TokenStreamingRuntime({
      repoRoot,
      mode: "auto",
      modelProvider: new RecordingProvider({ content: '```json\n{"summary":"Broken patch","files":[\n```' })
    });

    await assert.rejects(() => runtime.runTask({ task: "apply malformed patch", dryRun: true }), /Unexpected end of JSON input/);

    const sessionsDir = path.join(repoRoot, ".token-streaming", "sessions");
    const sessionFiles = await readdir(sessionsDir);
    assert.equal(sessionFiles.length, 1);

    const eventLog = await readFile(path.join(sessionsDir, sessionFiles[0]), "utf8");
    const events = eventLog
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));

    assert.equal(events.some((event) => event.type === "model.called"), true);
    assert.equal(events.some((event) => event.type === "run.failed" && /Unexpected end of JSON input/.test(event.error)), true);
    assert.equal(
      events.some(
        (event) =>
          event.type === "review.completed" &&
          event.review.findings.some((finding) => /Run failed: Unexpected end of JSON input/.test(finding))
      ),
      true
    );

    const reportsDir = path.join(repoRoot, ".token-streaming", "reports");
    const reportFiles = await readdir(reportsDir);
    assert.equal(reportFiles.length, 1);
    const report = await readFile(path.join(reportsDir, reportFiles[0]), "utf8");
    assert.match(report, /Run failed: Unexpected end of JSON input/);
    assert.match(report, /planning: recording\/recording-model auto reasoning=medium/);
    assert.match(report, /Recommendation: Inspect the recorded failure before continuing\./);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TokenStreamingRuntime records repair model calls separately", async () => {
  const repoRoot = await createRepo({
    test: "node -e \"process.exit(1)\""
  });
  try {
    const provider = new SequenceProvider([
      { content: "Planning response.", usage: { inputTokens: 10, outputTokens: 5 } },
      {
        content: '{"summary":"Repair note","files":[{"path":"repair.txt","content":"repair\\n"}]}',
        usage: { inputTokens: 20, outputTokens: 8 }
      }
    ]);
    const proposal = '{"summary":"Initial note","files":[{"path":"note.txt","content":"note\\n"}]}';
    const runtime = new TokenStreamingRuntime({ repoRoot, mode: "auto", modelProvider: provider });

    const result = await runtime.runTask({
      task: "fix failing test",
      apply: true,
      repair: true,
      patchProposalText: proposal
    });

    assert.equal(result.modelCalls.length, 2);
    assert.deepEqual(
      result.modelCalls.map((call) => call.purpose),
      ["planning", "repair"]
    );
    assert.equal(result.modelCalls[0]?.reasoningEffort, "medium");
    assert.equal(result.modelCalls[1]?.reasoningEffort, "high");
    assert.equal(result.modelCalls[1]?.inputTokens, 20);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TokenStreamingRuntime previews default orchestration without calling a model", async () => {
  const repoRoot = await createRepo({
    test: "node -e \"console.log('test')\"",
    typecheck: "node -e \"console.log('typecheck')\""
  });
  try {
    const provider = new RecordingProvider();
    const runtime = new TokenStreamingRuntime({ repoRoot, mode: "auto", modelProvider: provider });

    const preview = await runtime.previewPlan("fix checkout failing test");

    assert.equal(provider.requests.length, 0);
    assert.equal(preview.plan.strategy, "default");
    assert.equal(preview.plan.mode, "auto");
    assert.deepEqual(
      preview.plan.phases.map((phase) => phase.id),
      ["orchestrate", "research", "code-change", "tests", "review"]
    );
    assert.deepEqual(preview.plan.testCommands, ["npm run test", "npm run typecheck"]);
    assert.match(preview.context.overview, /Handoffs:/);
    assert.match(preview.context.overview, /orchestrator -> research: execution plan/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("TokenStreamingRuntime includes compact recent history in context previews", async () => {
  const repoRoot = await createRepo();
  try {
    await writeSessionLog(repoRoot, "ses_previous", [
      {
        id: "evt_1",
        sessionId: "ses_previous",
        timestamp: "2026-06-20T00:00:00.000Z",
        type: "user.message",
        message: "fix checkout payment failure"
      },
      {
        id: "evt_2",
        sessionId: "ses_previous",
        timestamp: "2026-06-20T00:00:01.000Z",
        type: "tool.finished",
        toolName: "test.run",
        ok: false,
        output: {
          command: "pnpm test checkout",
          exitCode: 1,
          outputSummary: "checkout.test failed"
        }
      },
      {
        id: "evt_3",
        sessionId: "ses_previous",
        timestamp: "2026-06-20T00:00:02.000Z",
        type: "run.failed",
        error: "Verification failed at pnpm test checkout."
      }
    ]);

    const provider = new RecordingProvider();
    const preview = await new TokenStreamingRuntime({ repoRoot, modelProvider: provider }).previewPlan("continue checkout fix");

    assert.equal(provider.requests.length, 0);
    assert.equal(preview.context.recentHistory.length, 1);
    assert.equal(preview.context.recentHistory[0]?.sessionId, "ses_previous");
    assert.equal(preview.context.recentHistory[0]?.status, "failed");
    assert.equal(preview.context.recentHistory[0]?.toolResults[0]?.toolName, "test.run");
    assert.match(preview.context.overview, /## Recent History/);
    assert.match(preview.context.overview, /fix checkout payment failure/);
    assert.match(preview.context.overview, /checkout\.test failed/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

class RecordingProvider {
  name = "recording";
  requests = [];
  response;

  constructor(response = {}) {
    this.response = response;
  }

  async generate(input) {
    this.requests.push(input);
    return {
      content: this.response.content ?? "Recorded response.",
      provider: this.name,
      model: "recording-model",
      usage: this.response.usage
    };
  }
}

class SequenceProvider {
  name = "sequence";
  requests = [];
  index = 0;

  constructor(responses) {
    this.responses = responses;
  }

  async generate(input) {
    this.requests.push(input);
    const response = this.responses[this.index] ?? this.responses.at(-1);
    this.index += 1;
    return {
      content: response.content,
      provider: this.name,
      model: "sequence-model",
      usage: response.usage
    };
  }
}

class ThrowingProvider {
  name = "throwing";

  async generate() {
    throw new Error("provider exploded");
  }
}

async function createRepo(scripts = {}) {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-extension-"));
  await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ scripts }, null, 2), "utf8");
  return repoRoot;
}

async function writeSessionLog(repoRoot, sessionId, events) {
  const sessionDir = path.join(repoRoot, ".token-streaming", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, `${sessionId}.jsonl`), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

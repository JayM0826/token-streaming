import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckpointStore } from "../../../packages/storage/dist/index.js";

const repoRoot = path.resolve(".");
const cliPath = path.join(repoRoot, "apps", "cli", "dist", "index.js");

test("CLI exposes manifest commands as JSON", async () => {
  const cwd = await createManifestRepo();
  const output = runCli(["-C", cwd, "commands", "list", "--json"]);

  assert.equal(output.kind, "commands-list");
  assert.deepEqual(output.groups, [
    {
      name: "build",
      commands: ["pnpm build"]
    },
    {
      name: "test",
      commands: ["pnpm test"]
    }
  ]);
});

test("CLI initializes AI manifest as JSON", async () => {
  const cwd = await createPlainRepo();
  const output = runCli(["-C", cwd, "manifest", "init", "--json"]);

  assert.equal(output.kind, "manifest-init");
  assert.equal(output.force, false);
  assert.equal(output.created.length, 10);
  assert.equal(output.skipped.length, 0);
  assert.equal(path.basename(output.root), ".ai");
  await assertFileExists(path.join(cwd, ".ai", "project.md"));
  await assertFileExists(path.join(cwd, ".ai", "commands.yaml"));
  await assertFileExists(path.join(cwd, ".ai", "ownership.yaml"));
  await assertFileExists(path.join(cwd, ".ai", "playbooks", "fix-failing-test.md"));
});

test("CLI manifest init JSON reports skipped files without overwriting", async () => {
  const cwd = await createPlainRepo();
  await mkdir(path.join(cwd, ".ai"), { recursive: true });
  await writeFile(path.join(cwd, ".ai", "project.md"), "custom project\n", "utf8");

  const output = runCli(["-C", cwd, "manifest", "init", "--json"]);
  const project = await readFile(path.join(cwd, ".ai", "project.md"), "utf8");

  assert.equal(output.kind, "manifest-init");
  assert.equal(output.force, false);
  assert.equal(output.skipped.some((file) => file.endsWith("project.md")), true);
  assert.equal(project, "custom project\n");
});

test("CLI manifest init JSON reports force overwrites", async () => {
  const cwd = await createPlainRepo();
  await mkdir(path.join(cwd, ".ai"), { recursive: true });
  await writeFile(path.join(cwd, ".ai", "project.md"), "custom project\n", "utf8");

  const output = runCli(["-C", cwd, "manifest", "init", "--force", "--json"]);
  const project = await readFile(path.join(cwd, ".ai", "project.md"), "utf8");

  assert.equal(output.kind, "manifest-init");
  assert.equal(output.force, true);
  assert.equal(output.skipped.length, 0);
  assert.equal(output.created.some((file) => file.endsWith("project.md")), true);
  assert.match(project, /# Project/);
  assert.doesNotMatch(project, /custom project/);
});

test("CLI generates and inspects fallback manifests as JSON", async () => {
  const cwd = await createPlainRepo();
  const generated = runCli(["-C", cwd, "manifest", "generate", "--json"]);
  const inspected = runCli(["-C", cwd, "manifest", "inspect", "--json"]);

  assert.equal(generated.kind, "manifest-generate");
  assert.equal(path.basename(generated.root), "generated");
  assert.equal(generated.force, false);
  assert.equal(generated.files.length, 5);
  assert.equal(generated.created.length, 5);
  assert.equal(generated.skipped.length, 0);
  assert.equal(generated.manifest.generated, true);
  assert.equal(generated.manifest.hasProject, true);
  assert.equal(generated.manifest.hasArchitecture, true);
  assert.equal(generated.validation.ok, true);
  assert.equal(generated.validation.counts.errors, 0);
  assert.equal(generated.validation.counts.warnings > 0, true);
  assert.equal(inspected.kind, "manifest-inspection");
  assert.equal(inspected.source, ".ai/generated");
  assert.equal(inspected.officialManifestPresent, false);
  assert.equal(inspected.coverage.project, true);
  assert.equal(inspected.coverage.conventions, false);
  assert.equal(inspected.commandGroups.some((group) => group.name === "build" && group.commands.includes("npm run build")), true);
  assert.equal(inspected.commandGroups.some((group) => group.name === "test" && group.commands.includes("npm run test")), true);
});

test("CLI manifest generate JSON reports skipped files and force overwrites", async () => {
  const cwd = await createPlainRepo();
  runCli(["-C", cwd, "manifest", "generate", "--json"]);
  await writeFile(path.join(cwd, ".ai", "generated", "project.md"), "custom generated\n", "utf8");

  const skipped = runCli(["-C", cwd, "manifest", "generate", "--json"]);
  const preservedProject = await readFile(path.join(cwd, ".ai", "generated", "project.md"), "utf8");

  assert.equal(skipped.kind, "manifest-generate");
  assert.equal(skipped.force, false);
  assert.equal(skipped.skipped.some((file) => file.endsWith("project.md")), true);
  assert.equal(preservedProject, "custom generated\n");

  const forced = runCli(["-C", cwd, "manifest", "generate", "--force", "--json"]);
  const overwrittenProject = await readFile(path.join(cwd, ".ai", "generated", "project.md"), "utf8");

  assert.equal(forced.kind, "manifest-generate");
  assert.equal(forced.force, true);
  assert.equal(forced.skipped.length, 0);
  assert.equal(forced.created.some((file) => file.endsWith("project.md")), true);
  assert.match(overwrittenProject, /# Generated Project Summary/);
  assert.doesNotMatch(overwrittenProject, /custom generated/);
});

test("CLI inspects official manifests as JSON", async () => {
  const cwd = await createManifestRepo();
  const output = runCli(["-C", cwd, "manifest", "inspect", "--json"]);

  assert.equal(output.kind, "manifest-inspection");
  assert.equal(output.source, ".ai");
  assert.equal(output.officialManifestPresent, true);
  assert.equal(output.coverage.ownership, true);
  assert.equal(output.coverage.modules, 1);
  assert.equal(output.coverage.workflows, 1);
  assert.equal(output.coverage.playbooks, 1);
  assert.equal(output.modules[0].name, "payment");
  assert.equal(output.workflows[0].name, "checkout");
  assert.equal(output.validation.ok, true);
});

test("CLI exposes playbook summaries and content as JSON", async () => {
  const cwd = await createManifestRepo();
  const list = runCli(["-C", cwd, "playbooks", "list", "--json"]);
  const detail = runCli(["-C", cwd, "playbooks", "show", "add-endpoint", "--json"]);

  assert.equal(list.kind, "playbooks-list");
  assert.equal(list.playbooks.length, 1);
  assert.equal(list.playbooks[0].name, "add-endpoint");
  assert.equal(list.playbooks[0].title, "Add Endpoint");
  assert.equal(detail.kind, "playbook");
  assert.equal(detail.playbook.name, "add-endpoint");
  assert.match(detail.playbook.content, /Add route/);
});

test("CLI exposes workflow summaries and details as JSON", async () => {
  const cwd = await createManifestRepo();
  const list = runCli(["-C", cwd, "workflows", "list", "--json"]);
  const detail = runCli(["-C", cwd, "workflows", "show", "checkout", "--json"]);

  assert.equal(list.kind, "workflows-list");
  assert.equal(list.workflows.length, 1);
  assert.equal(list.workflows[0].name, "checkout");
  assert.equal(list.workflows[0].description, "Checkout flow across order and payment boundaries.");
  assert.equal(list.workflows[0].stepCount, 3);
  assert.deepEqual(list.workflows[0].touches, ["packages/payment"]);
  assert.deepEqual(list.workflows[0].risks, ["Payment failure must not leave inventory reserved."]);
  assert.equal(detail.kind, "workflow");
  assert.equal(detail.workflow.name, "checkout");
  assert.equal(detail.workflow.description, "Checkout flow across order and payment boundaries.");
  assert.deepEqual(detail.workflow.steps, ["create order", "authorize payment", "confirm order"]);
  assert.deepEqual(detail.workflow.testCommands, ["pnpm test workflows/checkout"]);
  assert.deepEqual(detail.workflow.risks, ["Payment failure must not leave inventory reserved."]);
});

test("CLI validates complete manifests as JSON", async () => {
  const cwd = await createManifestRepo();
  const output = runCli(["-C", cwd, "manifest", "validate", "--json"]);

  assert.equal(output.kind, "manifest-validation");
  assert.equal(output.ok, true);
  assert.equal(output.counts.errors, 0);
  assert.equal(output.counts.warnings, 0);
  assert.equal(output.manifest.modules, 1);
  assert.equal(output.manifest.hasOwnership, true);
});

test("CLI validates incomplete manifests as JSON with a non-zero exit code", async () => {
  const cwd = await createIncompleteManifestRepo();
  const result = runCliRaw(["-C", cwd, "manifest", "validate", "--json"]);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(output.kind, "manifest-validation");
  assert.equal(output.ok, false);
  assert.equal(output.counts.errors > 0, true);
  assert.equal(output.issues.some((issue) => issue.code === "root.architecture.missing"), true);
});

test("CLI exposes strategy catalog as JSON", () => {
  const output = runCli(["strategies", "list", "--json"]);

  assert.equal(output.kind, "strategies-list");
  assert.equal(output.selected, "default");
  assert.deepEqual(output.strategies, [
    {
      id: "default",
      default: true,
      implemented: true
    }
  ]);
});

test("CLI exposes effective configuration as JSON", async () => {
  const cwd = await createManifestRepo();
  await writeFile(path.join(cwd, ".ai", "models.yaml"), "default_provider: stub\nauto_model: balanced-model\n", "utf8");
  await writeFile(
    path.join(cwd, ".ai", "safety.yaml"),
    "sensitive_paths:\n  - secrets/**\nprotected_patterns:\n  - OPENAI_API_KEY\\s*=\napproval_required_commands:\n  - npm publish\nforbidden_commands:\n  - git reset --hard\nrequires_review:\n  - provider auth changes\n",
    "utf8"
  );

  const output = runCli(["-C", cwd, "--mode", "auto", "--api-protocol", "chat-completions", "config", "inspect", "--json"], {
    OPENAI_API_KEY: ""
  });

  assert.equal(output.kind, "config-inspection");
  assert.equal(output.cwd, cwd);
  assert.equal(output.mode, "auto");
  assert.equal(output.strategy, "default");
  assert.equal(output.strategyAvailable, true);
  assert.deepEqual(output.availableStrategies, ["default"]);
  assert.equal(output.apiProtocol, "chat-completions");
  assert.equal(output.modelSelection.provider, "auto");
  assert.equal(output.modelSelection.model, "balanced-model");
  assert.equal(output.effectiveProvider, "stub");
  assert.equal(output.manifest.hasModels, true);
  assert.equal(output.safety.present, true);
  assert.equal(output.safety.sensitivePaths, 1);
  assert.equal(output.safety.forbiddenCommands, 1);
  assert.equal(output.safety.approvalRequiredCommands, 1);
  assert.equal(output.safety.requiresReview, 1);
  assert.equal(output.safety.protectedPatterns, 1);
});

test("CLI exposes tool catalog as JSON", () => {
  const output = runCli(["tools", "list", "--json"]);

  assert.equal(output.kind, "tools-list");
  assert.equal(output.tools.length, 8);
  assert.equal(output.tools[0].name, "repo.scan");
  assert.equal(output.tools.find((tool) => tool.name === "repo.search").risk, "read");
  assert.equal(output.tools.find((tool) => tool.name === "command.run").risk, "execute");
  assert.equal(output.tools.find((tool) => tool.name === "patch.apply").risk, "write");
  assert.equal(output.tools[0].inputSchema.type, "object");
});

test("CLI runs read-only tools as JSON", async () => {
  const cwd = await createManifestRepo();
  const output = runCli(["-C", cwd, "tools", "run", "repo.search", "--json", JSON.stringify({ query: "authorizePayment", maxMatches: 1 })]);

  assert.equal(output.kind, "tool-run");
  assert.equal(output.tool, "repo.search");
  assert.equal(output.risk, "read");
  assert.equal(output.ok, true);
  assert.equal(output.policy.target, "tool");
  assert.equal(output.policy.allowed, true);
  assert.equal(output.output.matches.length, 1);
  assert.equal(output.output.matches[0].path, "src/payment.ts");
});

test("CLI runs read-only tools from an input file", async () => {
  const cwd = await createManifestRepo();
  const inputPath = path.join(cwd, "tool-input.json");
  await writeFile(inputPath, JSON.stringify({ path: "src/payment.ts" }), "utf8");

  const output = runCli(["-C", cwd, "tools", "run", "file.read", "--json", "--input-file", inputPath]);

  assert.equal(output.kind, "tool-run");
  assert.equal(output.tool, "file.read");
  assert.match(output.output.content, /authorizePayment/);
});

test("CLI records tool runs as session events when requested", async () => {
  const cwd = await createManifestRepo();
  const output = runCli(["-C", cwd, "tools", "run", "repo.search", "--record", "--json", JSON.stringify({ query: "authorizePayment" })]);
  const session = runCli(["-C", cwd, "sessions", "show", output.session.id, "--json"]);

  assert.equal(output.kind, "tool-run");
  assert.equal(typeof output.session.id, "string");
  assert.match(output.session.logPath, /sessions/);
  assert.equal(session.kind, "session");
  assert.equal(session.events[0].type, "run.started");
  assert.equal(session.events[0].task, "tools run repo.search");
  assert.equal(session.events.some((event) => event.type === "permission.checked" && event.decision.target === "tool"), true);
  assert.equal(session.events.some((event) => event.type === "tool.started" && event.toolName === "repo.search"), true);
  assert.equal(session.events.some((event) => event.type === "tool.finished" && event.toolName === "repo.search" && event.ok === true), true);
  assert.equal(session.events.some((event) => event.type === "run.completed"), true);
});

test("CLI rejects non-read tools through tools run", async () => {
  const cwd = await createManifestRepo();
  const result = runCliRaw(["-C", cwd, "tools", "run", "patch.apply", "--json", "{}"]);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(output.kind, "error");
  assert.equal(output.command, "tools-run");
  assert.match(output.message, /runtime permission boundaries/);
});

test("CLI recorded tool policy failures expose error artifacts", async () => {
  const cwd = await createManifestRepo();
  const result = runCliRaw(["-C", cwd, "tools", "run", "patch.apply", "--record", "--json", "{}"]);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(output.kind, "error");
  assert.equal(output.command, "tools-run");
  assert.match(output.message, /runtime permission boundaries/);
  assert.match(output.artifacts.sessionId, /^ses_/);
  assert.match(output.artifacts.eventLogPath, /sessions/);
  assert.match(output.artifacts.reportPath, /reports/);
  assert.match(output.artifacts.commands.session, /sessions show ses_/);
  assert.match(output.artifacts.commands.report, /reports show ses_/);
  await assertFileExists(output.artifacts.eventLogPath);
  await assertFileExists(output.artifacts.reportPath);

  const session = runCli(["-C", cwd, "sessions", "show", output.artifacts.sessionId, "--json"]);
  const report = await readFile(output.artifacts.reportPath, "utf8");
  const reportDetail = runCli(["-C", cwd, "reports", "show", output.artifacts.sessionId, "--json"]);
  assert.equal(session.events.some((event) => event.type === "run.failed" && /runtime permission boundaries/.test(event.error)), true);
  assert.equal(session.summary.failureCategory, "tool-policy");
  assert.equal(reportDetail.summary.failureCategory, "tool-policy");
  assert.match(report, /Run failed: Tool risk "write" must pass through runtime permission boundaries\./);
  assert.match(report, /patch\.apply: failed/);
});

test("CLI recorded tool execution failures expose error artifacts", async () => {
  const cwd = await createManifestRepo();
  const result = runCliRaw(["-C", cwd, "tools", "run", "file.read", "--record", "--json", JSON.stringify({ path: "../outside.txt" })]);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(output.kind, "error");
  assert.equal(output.command, "tools-run");
  assert.match(output.message, /Path escapes repository root/);
  assert.match(output.artifacts.sessionId, /^ses_/);
  assert.match(output.artifacts.eventLogPath, /sessions/);
  assert.match(output.artifacts.reportPath, /reports/);
  await assertFileExists(output.artifacts.eventLogPath);
  await assertFileExists(output.artifacts.reportPath);

  const session = runCli(["-C", cwd, "sessions", "show", output.artifacts.sessionId, "--json"]);
  const report = await readFile(output.artifacts.reportPath, "utf8");
  const reportDetail = runCli(["-C", cwd, "reports", "show", output.artifacts.sessionId, "--json"]);
  assert.equal(session.events.some((event) => event.type === "tool.started" && event.toolName === "file.read"), true);
  assert.equal(session.events.some((event) => event.type === "tool.finished" && event.toolName === "file.read" && event.ok === false), true);
  assert.equal(session.events.some((event) => event.type === "run.failed" && /Path escapes repository root/.test(event.error)), true);
  assert.equal(session.summary.failureCategory, "tool-execution");
  assert.equal(reportDetail.summary.failureCategory, "tool-execution");
  assert.match(report, /Run failed: Path escapes repository root/);
  assert.match(report, /file\.read: failed/);
});

test("CLI runs manifest-declared test.run tool as JSON", async () => {
  const cwd = await createManifestRepo();
  await writeFile(path.join(cwd, ".ai", "tests.yaml"), "default:\n  - node -e \"process.exit(0)\"\n", "utf8");

  const output = runCli(["-C", cwd, "tools", "run", "test.run", "--json", JSON.stringify({ command: "node -e \"process.exit(0)\"" })]);

  assert.equal(output.kind, "tool-run");
  assert.equal(output.tool, "test.run");
  assert.equal(output.risk, "execute");
  assert.equal(output.policy.allowed, true);
  assert.equal(output.output.exitCode, 0);
});

test("CLI rejects undeclared test.run commands", async () => {
  const cwd = await createManifestRepo();
  const result = runCliRaw(["-C", cwd, "tools", "run", "test.run", "--json", JSON.stringify({ command: "node -e \"console.log('undeclared')\"" })]);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(output.kind, "error");
  assert.equal(output.command, "tools-run");
  assert.match(output.message, /not declared/);
});

test("CLI exposes plan previews as JSON", async () => {
  const cwd = await createManifestRepo();
  const output = runCli(["-C", cwd, "plan", "--json", "fix payment checkout"]);

  assert.equal(output.kind, "plan-preview");
  assert.equal(output.task, "fix payment checkout");
  assert.equal(output.plan.strategy, "default");
  assert.equal(output.plan.mode, "auto");
  assert.equal(output.plan.requiredAgents.includes("coder"), true);
  assert.equal(output.context.relevantModules.includes("payment"), true);
  assert.equal(output.context.relevantWorkflows.includes("checkout"), true);
  assert.equal(output.context.selectionReasons.some((reason) => reason.kind === "module" && reason.target === "payment"), true);
  assert.equal(output.context.selectionReasons.some((reason) => reason.kind === "workflow" && reason.target === "checkout"), true);
  assert.equal(output.context.sourceSnippets[0].path, "src/payment.ts");
  assert.equal(typeof output.context.sourceSnippets[0].characters, "number");
});

test("CLI exposes full context inspection as JSON", async () => {
  const cwd = await createManifestRepo();
  const output = runCli(["-C", cwd, "context", "inspect", "--json", "fix payment checkout"]);

  assert.equal(output.kind, "context-inspection");
  assert.equal(output.plan.strategy, "default");
  assert.equal(output.context.relevantModules.includes("payment"), true);
  assert.equal(output.context.relevantWorkflows.includes("checkout"), true);
  assert.equal(output.context.selectionReasons.some((reason) => reason.kind === "source" && reason.target === "src/payment.ts"), true);
  assert.equal(output.context.sourceSnippets[0].path, "src/payment.ts");
  assert.match(output.context.sourceSnippets[0].content, /authorizePayment/);
  assert.match(output.context.overview, /Runtime Context/);
  assert.match(output.context.overview, /Selection Reasons/);
});

test("CLI exposes git diff state as JSON", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "token-streaming-cli-diff-"));
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  await writeFile(path.join(cwd, "note.txt"), "hello\n", "utf8");

  const output = runCli(["-C", cwd, "diff", "--json"]);

  assert.equal(output.kind, "diff");
  assert.equal(output.clean, false);
  assert.match(output.status, /\?\? note\.txt/);
  assert.equal(output.diff, "");
});

test("CLI searches repository files as JSON", async () => {
  const cwd = await createManifestRepo();
  const output = runCli(["-C", cwd, "search", "authorizePayment", "--json"]);

  assert.equal(output.kind, "search");
  assert.equal(output.query, "authorizePayment");
  assert.equal(output.matchCount, 1);
  assert.deepEqual(output.matches[0], {
    path: "src/payment.ts",
    line: 1,
    column: 17,
    text: "export function authorizePayment() {"
  });
});

test("CLI verifies manifest default commands as JSON", async () => {
  const cwd = await createManifestRepo();
  await writeFile(path.join(cwd, ".ai", "tests.yaml"), "default:\n  - node -e \"require('fs').writeFileSync('verify-ran.txt', 'ok')\"\n", "utf8");

  const output = runCli(["-C", cwd, "verify", "--json"]);
  const marker = await readFile(path.join(cwd, "verify-ran.txt"), "utf8");

  assert.equal(output.kind, "verification");
  assert.equal(output.ok, true);
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].ok, true);
  assert.equal(output.results[0].exitCode, 0);
  assert.equal(output.results[0].policy.allowed, true);
  assert.equal(marker, "ok");
});

test("CLI verify falls back to conservatively inferred Python commands", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "token-streaming-python-verify-"));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "module.py"), "VALUE = 1\n", "utf8");

  const output = runCli(["-C", cwd, "verify", "--json"]);

  assert.equal(output.kind, "verification");
  assert.equal(output.ok, true);
  assert.deepEqual(output.commands, ["python -m compileall src"]);
  assert.equal(output.results[0].exitCode, 0);
});

test("CLI blocks forbidden verification commands as JSON", async () => {
  const cwd = await createManifestRepo();
  const command = "node -e \"require('fs').writeFileSync('blocked-ran.txt', 'bad')\"";
  await writeFile(path.join(cwd, ".ai", "tests.yaml"), `default:\n  - ${command}\n`, "utf8");
  await writeFile(path.join(cwd, ".ai", "safety.yaml"), `forbidden_commands:\n  - ${command}\n`, "utf8");

  const result = runCliRaw(["-C", cwd, "verify", "--json"]);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(output.kind, "verification");
  assert.equal(output.ok, false);
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].blocked, true);
  assert.equal(output.results[0].policy.allowed, false);
  await assert.rejects(readFile(path.join(cwd, "blocked-ran.txt"), "utf8"), /ENOENT/);
});

test("CLI blocks approval-required verification commands by default", async () => {
  const cwd = await createManifestRepo();
  const command = "node -e \"require('fs').writeFileSync('approval-ran.txt', 'ok')\"";
  await writeFile(path.join(cwd, ".ai", "tests.yaml"), `default:\n  - ${command}\n`, "utf8");
  await writeFile(path.join(cwd, ".ai", "safety.yaml"), `approval_required_commands:\n  - ${command}\n`, "utf8");

  const result = runCliRaw(["-C", cwd, "verify", "--json"]);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(output.kind, "verification");
  assert.equal(output.ok, false);
  assert.equal(output.results[0].blocked, true);
  assert.equal(output.results[0].policy.requiresApproval, true);
  assert.equal(output.results[0].approvalResponse.approved, false);
  await assert.rejects(readFile(path.join(cwd, "approval-ran.txt"), "utf8"), /ENOENT/);
});

test("CLI approves approval-required verification commands when explicitly allowed", async () => {
  const cwd = await createManifestRepo();
  const command = "node -e \"require('fs').writeFileSync('approval-ran.txt', 'ok')\"";
  await writeFile(path.join(cwd, ".ai", "tests.yaml"), `default:\n  - ${command}\n`, "utf8");
  await writeFile(path.join(cwd, ".ai", "safety.yaml"), `approval_required_commands:\n  - ${command}\n`, "utf8");

  const output = runCli(["-C", cwd, "--approval", "allow", "verify", "--json"]);
  const marker = await readFile(path.join(cwd, "approval-ran.txt"), "utf8");

  assert.equal(output.kind, "verification");
  assert.equal(output.ok, true);
  assert.equal(output.results[0].policy.requiresApproval, true);
  assert.equal(output.results[0].approvalResponse.approved, true);
  assert.equal(output.results[0].ok, true);
  assert.equal(marker, "ok");
});

test("CLI exposes rollback results as JSON", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "token-streaming-cli-rollback-"));
  const filePath = path.join(cwd, "sample.txt");
  await writeFile(filePath, "before", "utf8");
  const checkpoint = await new CheckpointStore(cwd).create(["sample.txt"]);
  await writeFile(filePath, "after", "utf8");

  const detail = runCli(["-C", cwd, "checkpoints", "show", checkpoint.id, "--json"]);
  const preview = runCli(["-C", cwd, "rollback", "latest", "--dry-run", "--json"]);

  assert.equal(detail.kind, "checkpoint");
  assert.equal(detail.checkpoint.id, checkpoint.id);
  assert.equal(detail.checkpoint.files[0].path, "sample.txt");
  assert.equal(detail.checkpoint.files[0].existed, true);
  assert.equal(detail.checkpoint.files[0].characters, "before".length);
  assert.equal(detail.checkpoint.files[0].preview, "before");
  assert.equal(preview.kind, "rollback-preview");
  assert.equal(preview.dryRun, true);
  assert.equal(preview.checkpointId, checkpoint.id);
  assert.deepEqual(preview.restoreFiles, ["sample.txt"]);
  assert.deepEqual(preview.deleteFiles, []);
  assert.equal(await readFile(filePath, "utf8"), "after");
  const output = runCli(["-C", cwd, "rollback", "latest", "--json"]);
  const restoredContent = await readFile(filePath, "utf8");
  assert.equal(output.kind, "rollback");
  assert.equal(output.dryRun, false);
  assert.equal(output.checkpointId, checkpoint.id);
  assert.deepEqual(output.restoredFiles, ["sample.txt"]);
  assert.equal(restoredContent, "before");
});

test("CLI exposes run results as JSON", async () => {
  const cwd = await createManifestRepo();
  const output = runCli(["-C", cwd, "--provider", "stub", "--strategy", "default", "--dry-run", "--json", "summarize this repo"]);
  const checkpoints = runCli(["-C", cwd, "checkpoints", "list", "--json"]);

  assert.equal(output.kind, "run");
  assert.equal(output.mode, "auto");
  assert.equal(output.requestedStrategy, "default");
  assert.equal(output.strategy, "default");
  assert.equal(output.dryRun, true);
  assert.equal(output.apply, false);
  assert.equal(output.modelSelection.provider, "stub");
  assert.equal(output.session.strategy, "default");
  assert.equal(output.plan.strategy, "default");
  assert.equal(output.plan.mode, "auto");
  assert.equal(output.manifest.generated, false);
  assert.equal(output.patchProposal, undefined);
  assert.equal(output.verificationResults.length, 0);
  assert.equal(output.modelCalls.length, 1);
  assert.equal(output.modelCalls[0].purpose, "planning");
  assert.equal(output.review.verificationStatus, "not-run");
  assert.equal(output.review.recommendation, "Ready for human review.");
  assert.deepEqual(output.context.recentHistory, []);
  assert.match(output.summary, /Stub provider response/);
  assert.equal(checkpoints.checkpoints.length, 0);
  await assertFileExists(output.eventLogPath);
  await assertFileExists(output.reportPath);
});

test("CLI run JSON exposes optional parallel agent runs", async () => {
  const cwd = await createManifestRepo();
  const output = runCli(["-C", cwd, "--provider", "stub", "--parallel-agents", "--dry-run", "--json", "fix failing test"]);

  assert.equal(output.kind, "run");
  assert.equal(output.parallelAgents, true);
  assert.deepEqual(
    output.agentRuns.map((run) => run.role).sort(),
    ["coder", "researcher", "reviewer", "tester"]
  );
  assert.equal(output.agentRuns.every((run) => run.ok), true);
  assert.equal(output.modelCalls.filter((call) => call.purpose === "agent").length, 4);
  assert.equal(output.modelCalls.filter((call) => call.purpose === "planning").length, 1);
  assert.match(output.summary, /Parallel agent artifacts: 4/);

  const session = runCli(["-C", cwd, "sessions", "show", output.session.id, "--json"]);
  assert.equal(session.events.filter((event) => event.type === "agent.started").length, 4);
  assert.equal(session.events.filter((event) => event.type === "agent.finished" && event.ok).length, 4);
});

test("CLI run JSON exposes compact recent history after previous sessions", async () => {
  const cwd = await createManifestRepo();
  runCli(["-C", cwd, "--provider", "stub", "--dry-run", "--json", "summarize first run"]);
  const output = runCli(["-C", cwd, "--provider", "stub", "--dry-run", "--json", "summarize second run"]);

  assert.equal(output.kind, "run");
  assert.equal(output.context.recentHistory.length, 1);
  assert.equal(output.context.recentHistory[0].status, "completed");
  assert.equal(output.context.recentHistory[0].task, "summarize first run");
  assert.match(output.context.recentHistory[0].summary, /Session/);
});

test("CLI exposes session, report, and checkpoint inspection as JSON", async () => {
  const cwd = await createManifestRepo();
  const run = runCli(["-C", cwd, "--provider", "stub", "--dry-run", "--json", "summarize this repo"]);
  const seededCheckpoint = await new CheckpointStore(cwd).create([]);

  const history = runCli(["-C", cwd, "history", "summary", "--json"]);
  const sessions = runCli(["-C", cwd, "sessions", "list", "--json"]);
  const session = runCli(["-C", cwd, "sessions", "show", run.session.id, "--json"]);
  const sessionStream = runCliJsonLines(["-C", cwd, "sessions", "stream", run.session.id, "--jsonl"]);
  const reports = runCli(["-C", cwd, "reports", "list", "--json"]);
  const report = runCli(["-C", cwd, "reports", "show", run.session.id, "--json"]);
  const checkpoints = runCli(["-C", cwd, "checkpoints", "list", "--json"]);
  const checkpoint = runCli(["-C", cwd, "checkpoints", "show", checkpoints.checkpoints[0].id, "--json"]);
  const latestSession = runCli(["-C", cwd, "sessions", "show", "latest", "--json"]);
  const latestReport = runCli(["-C", cwd, "reports", "show", "latest", "--json"]);
  const latestCheckpoint = runCli(["-C", cwd, "checkpoints", "show", "latest", "--json"]);

  assert.equal(history.kind, "history-summary");
  assert.equal(history.summary.sessions.count, 1);
  assert.equal(history.summary.sessions.latest.sessionId, run.session.id);
  assert.equal(history.summary.sessions.latest.status, "completed");
  assert.equal(history.summary.reports.count, 1);
  assert.equal(history.summary.reports.latest.status, "completed");
  assert.equal(history.summary.checkpoints.count, 1);
  assert.equal(history.summary.models.totalCalls, 1);
  assert.equal(sessions.kind, "sessions-list");
  assert.equal(sessions.sessions[0].sessionId, run.session.id);
  assert.equal(sessions.sessions[0].status, "completed");
  assert.equal(session.kind, "session");
  assert.equal(session.sessionId, run.session.id);
  assert.equal(session.summary.sessionId, run.session.id);
  assert.equal(session.summary.status, "completed");
  assert.equal(session.eventCount, session.events.length);
  assert.equal(session.events[0].type, "run.started");
  assert.equal(session.events.some((event) => event.type === "context.built"), true);
  assert.equal(session.events.some((event) => event.type === "run.completed"), true);
  assert.equal(sessionStream[0].kind, "session-stream");
  assert.equal(sessionStream[0].phase, "start");
  assert.equal(sessionStream[0].sessionId, run.session.id);
  assert.equal(sessionStream[1].phase, "summary");
  assert.equal(sessionStream.some((entry) => entry.phase === "event" && entry.event.type === "run.completed"), true);
  assert.equal(sessionStream.at(-1).phase, "end");
  assert.equal(sessionStream.at(-1).eventCount, session.eventCount);
  assert.equal(reports.kind, "reports-list");
  assert.equal(reports.reports[0].status, "completed");
  assert.equal(reports.reports[0].sessionId, run.session.id);
  assert.equal(report.kind, "report");
  assert.equal(report.sessionId, run.session.id);
  assert.equal(report.summary.sessionId, run.session.id);
  assert.equal(report.summary.status, "completed");
  assert.match(report.content, /Token Streaming Run/);
  assert.equal(checkpoints.kind, "checkpoints-list");
  assert.equal(checkpoints.checkpoints.length, 1);
  assert.equal(checkpoints.checkpoints[0].id, seededCheckpoint.id);
  assert.equal(checkpoints.checkpoints[0].fileCount, 0);
  assert.equal(checkpoint.kind, "checkpoint");
  assert.equal(checkpoint.checkpoint.id, checkpoints.checkpoints[0].id);
  assert.equal(checkpoint.checkpoint.fileCount, 0);
  assert.equal(latestSession.sessionId, run.session.id);
  assert.equal(latestReport.sessionId, run.session.id);
  assert.equal(latestCheckpoint.checkpoint.id, checkpoints.checkpoints[0].id);
});

test("CLI rejects storage ids that attempt path traversal", async () => {
  const cwd = await createManifestRepo();
  const sessionResult = runCliRaw(["-C", cwd, "sessions", "show", "../../outside", "--json"]);
  const reportResult = runCliRaw(["-C", cwd, "reports", "show", "../../outside", "--json"]);
  const checkpointResult = runCliRaw(["-C", cwd, "checkpoints", "show", "../../outside", "--json"]);

  assert.equal(sessionResult.status, 1);
  assert.match(JSON.parse(sessionResult.stdout).message, /Invalid session id/);
  assert.equal(reportResult.status, 1);
  assert.match(JSON.parse(reportResult.stdout).message, /Invalid report id/);
  assert.equal(checkpointResult.status, 1);
  assert.match(JSON.parse(checkpointResult.stdout).message, /Invalid checkpoint id/);
});

test("CLI previews history pruning as JSON without deleting history", async () => {
  const cwd = await createManifestRepo();
  runCli(["-C", cwd, "--provider", "stub", "--dry-run", "--json", "summarize this repo"]);
  await new CheckpointStore(cwd).create([]);
  runCli(["-C", cwd, "--provider", "stub", "--dry-run", "--json", "summarize this repo again"]);
  await new CheckpointStore(cwd).create([]);

  const preview = runCli(["-C", cwd, "history", "prune", "--dry-run", "--keep", "1", "--json"]);
  const history = runCli(["-C", cwd, "history", "summary", "--json"]);

  assert.equal(preview.kind, "history-prune-preview");
  assert.equal(preview.dryRun, true);
  assert.equal(preview.keep, 1);
  assert.equal(preview.counts.sessions, 1);
  assert.equal(preview.counts.reports, 1);
  assert.equal(preview.counts.checkpoints, 1);
  assert.equal(preview.counts.total, 3);
  assert.equal(history.summary.sessions.count, 2);
  assert.equal(history.summary.reports.count, 2);
  assert.equal(history.summary.checkpoints.count, 2);
});

test("CLI prunes old history files while keeping newest items", async () => {
  const cwd = await createManifestRepo();
  runCli(["-C", cwd, "--provider", "stub", "--dry-run", "--json", "summarize this repo"]);
  await new CheckpointStore(cwd).create([]);
  runCli(["-C", cwd, "--provider", "stub", "--dry-run", "--json", "summarize this repo again"]);
  await new CheckpointStore(cwd).create([]);

  const pruned = runCli(["-C", cwd, "history", "prune", "--keep", "1", "--json"]);
  const history = runCli(["-C", cwd, "history", "summary", "--json"]);

  assert.equal(pruned.kind, "history-prune");
  assert.equal(pruned.dryRun, false);
  assert.equal(pruned.counts.sessions, 1);
  assert.equal(pruned.counts.reports, 1);
  assert.equal(pruned.counts.checkpoints, 1);
  assert.equal(pruned.deleted.total, 3);
  assert.equal(pruned.deleted.sessions.length, 1);
  assert.equal(pruned.deleted.reports.length, 1);
  assert.equal(pruned.deleted.checkpoints.length, 1);
  assert.equal(history.summary.sessions.count, 1);
  assert.equal(history.summary.reports.count, 1);
  assert.equal(history.summary.checkpoints.count, 1);
  await assert.rejects(readFile(pruned.deleted.sessions[0], "utf8"), /ENOENT/);
  await assert.rejects(readFile(pruned.deleted.reports[0], "utf8"), /ENOENT/);
  await assert.rejects(readFile(pruned.deleted.checkpoints[0], "utf8"), /ENOENT/);
});

test("CLI exposes model telemetry stats as JSON", async () => {
  const cwd = await createManifestRepo();
  runCli(["-C", cwd, "--provider", "stub", "--dry-run", "--json", "summarize this repo"]);
  const malformedPatchPath = path.join(cwd, "malformed-patch.md");
  await writeFile(malformedPatchPath, '```json\n{"summary":"Broken patch","files":[\n```', "utf8");
  const failed = runCliRaw(["-C", cwd, "--provider", "stub", "--patch-file", malformedPatchPath, "--dry-run", "--json", "apply malformed patch"]);
  assert.equal(failed.status, 1);

  const output = runCli(["-C", cwd, "stats", "models", "--json"]);

  assert.equal(output.kind, "model-stats");
  assert.equal(output.summary.totalSessions, 2);
  assert.equal(output.summary.completedSessions, 1);
  assert.equal(output.summary.totalCalls, 2);
  assert.equal(output.summary.failedSessions, 1);
  assert.equal(output.summary.runningSessions, 0);
  assert.equal(output.summary.failureRate, 0.5);
  assert.equal(output.summary.byProvider[0].key, "stub");
  assert.equal(output.summary.byProvider[0].calls, 2);
  assert.equal(output.summary.byProvider[0].sessions, 2);
  assert.equal(output.summary.byProvider[0].failedSessions, 1);
  assert.equal(output.summary.byProvider[0].failureRate, 0.5);
  assert.equal(output.summary.byModel[0].key, "stub");
  assert.equal(output.summary.byMode[0].key, "auto");
  assert.equal(output.summary.byPurpose[0].key, "planning");
  assert.equal(output.summary.byPurpose[0].calls, 2);
  assert.deepEqual(output.summary.byFailureCategory.map((group) => [group.key, group.sessions]), [["patch-proposal", 1]]);
  assert.equal(output.summary.recommendations.length, 2);
  assert.deepEqual(
    output.summary.recommendations.map((recommendation) => [
      recommendation.model,
      recommendation.mode,
      recommendation.purpose,
      recommendation.taskKind,
      recommendation.recommendation
    ]),
    [
      ["stub", "auto", "planning", "understanding", "prefer"],
      ["stub", "auto", "planning", "bugfix", "avoid"]
    ]
  );
});

test("CLI exposes manifest model routing as JSON", async () => {
  const cwd = await createManifestRepo();
  await writeFile(
    path.join(cwd, ".ai", "models.yaml"),
    ["default_provider: stub", "economy_model: cheap-model", "auto_model: balanced-model", "max_model: strong-model"].join("\n"),
    "utf8"
  );

  const output = runCli(["-C", cwd, "--mode", "economy", "models", "select", "--json"]);

  assert.equal(output.kind, "model-selection");
  assert.equal(output.mode, "economy");
  assert.equal(output.selection.provider, "auto");
  assert.equal(output.selection.model, "cheap-model");
  assert.equal(output.selection.source, "scored");
  assert.equal(output.selection.scoring.objective, "cost");
  assert.equal(output.selection.scoring.selected.model, "cheap-model");
  assert.equal(output.selection.scoring.candidates.length, 3);
  assert.equal(output.policy.default_provider, "stub");
  assert.equal(output.policy.economy_model, "cheap-model");
  assert.equal(output.telemetry.totalCalls, 0);
});

test("CLI model routing scores explicit manifest candidates as JSON", async () => {
  const cwd = await createManifestRepo();
  await writeFile(
    path.join(cwd, ".ai", "models.yaml"),
    [
      "default_provider: auto",
      "model_candidates:",
      "  - cheap-model;provider=openai;quality=0.65;cost=0.15;latency=0.2;tags=economy",
      "  - strong-model;provider=openai;quality=0.96;cost=0.9;latency=0.7;tags=max"
    ].join("\n"),
    "utf8"
  );

  const output = runCli(["-C", cwd, "--mode", "max", "models", "select", "--json"]);

  assert.equal(output.kind, "model-selection");
  assert.equal(output.selection.source, "scored");
  assert.equal(output.selection.model, "strong-model");
  assert.equal(output.selection.scoring.objective, "quality");
  assert.equal(output.selection.scoring.candidates.length, 2);
  assert.equal(output.policy.model_candidates.length, 2);
});

test("CLI model routing uses task-specific telemetry recommendations as JSON", async () => {
  const cwd = await createManifestRepo();
  await writeFile(
    path.join(cwd, ".ai", "models.yaml"),
    [
      "default_provider: auto",
      "model_candidates:",
      "  - steady-model;provider=openai;quality=0.8;cost=0.5;latency=0.5;tags=balanced",
      "  - risky-model;provider=openai;quality=0.8;cost=0.5;latency=0.5;tags=balanced"
    ].join("\n"),
    "utf8"
  );
  await appendModelTelemetrySession(cwd, {
    sessionId: "ses_steady",
    task: "fix failing test",
    model: "steady-model",
    provider: "openai",
    mode: "auto",
    status: "completed"
  });
  await appendModelTelemetrySession(cwd, {
    sessionId: "ses_risky",
    task: "fix failing test",
    model: "risky-model",
    provider: "openai",
    mode: "auto",
    status: "failed"
  });

  const output = runCli(["-C", cwd, "--mode", "auto", "models", "select", "fix", "failing", "test", "--json"]);

  assert.equal(output.kind, "model-selection");
  assert.equal(output.task, "fix failing test");
  assert.equal(output.selection.scoring.taskKind, "test-fix");
  assert.equal(output.selection.model, "steady-model");
  assert.equal(output.selection.scoring.selected.feedback.recommendation, "prefer");
  assert.equal(output.selection.scoring.candidates.at(-1).model, "risky-model");
  assert.equal(output.selection.scoring.candidates.at(-1).feedback.recommendation, "avoid");
  assert.equal(output.telemetry.recommendations.length, 2);
});

test("CLI exposes model override routing as JSON", async () => {
  const cwd = await createManifestRepo();
  await writeFile(path.join(cwd, ".ai", "models.yaml"), "auto_model: balanced-model\n", "utf8");

  const output = runCli(["-C", cwd, "--provider", "openai", "--model", "explicit-model", "models", "select", "--json"]);

  assert.equal(output.kind, "model-selection");
  assert.equal(output.request.provider, "openai");
  assert.equal(output.request.model, "explicit-model");
  assert.equal(output.selection.provider, "openai");
  assert.equal(output.selection.model, "explicit-model");
  assert.equal(output.selection.source, "cli");
});

test("CLI exposes model doctor warnings as JSON", async () => {
  const cwd = await createManifestRepo();
  const output = runCli(["-C", cwd, "doctor", "models", "--json"], { OPENAI_API_KEY: "" });

  assert.equal(output.kind, "model-doctor");
  assert.equal(output.ok, true);
  assert.equal(output.effectiveProvider, "stub");
  assert.equal(output.counts.errors, 0);
  assert.equal(output.counts.warnings, 1);
  assert.equal(output.counts.skipped, 1);
  assert.equal(output.checks.some((check) => check.name === "openai-api-key" && check.status === "warning"), true);
  assert.equal(output.checks.some((check) => check.name === "probe" && check.status === "skipped"), true);
});

test("CLI exposes model doctor errors as JSON with a non-zero exit code", async () => {
  const cwd = await createManifestRepo();
  const result = runCliRaw(["-C", cwd, "--provider", "openai", "doctor", "models", "--json"], { OPENAI_API_KEY: "" });
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(output.kind, "model-doctor");
  assert.equal(output.ok, false);
  assert.equal(output.effectiveProvider, "openai");
  assert.equal(output.counts.errors, 1);
  assert.equal(output.checks.some((check) => check.name === "openai-api-key" && check.status === "error"), true);
});

test("CLI exposes repository doctor readiness as JSON", async () => {
  const cwd = await createManifestRepo();
  const run = runCli(["-C", cwd, "--provider", "stub", "--dry-run", "--json", "summarize this repo"]);
  const output = runCli(["-C", cwd, "doctor", "repo", "--json"], { OPENAI_API_KEY: "" });

  assert.equal(output.kind, "repository-doctor");
  assert.equal(output.ok, true);
  assert.equal(output.manifest.ok, true);
  assert.equal(output.manifest.counts.errors, 0);
  assert.equal(output.models.ok, true);
  assert.equal(output.models.effectiveProvider, "stub");
  assert.equal(output.models.counts.warnings, 1);
  assert.equal(output.models.counts.skipped, 1);
  assert.equal(output.liveSmoke.provider, "openai");
  assert.equal(output.liveSmoke.status, "missing-api-key");
  assert.equal(output.liveSmoke.verified, false);
  assert.deepEqual(output.liveSmoke.requiredEnv, ["OPENAI_API_KEY"]);
  assert.deepEqual(output.liveSmoke.optionalEnv, ["OPENAI_BASE_URL", "OPENAI_API_PROTOCOL"]);
  assert.equal(output.liveSmoke.apiProtocol, "responses");
  assert.equal(output.liveSmoke.endpoint, "https://api.openai.com/v1/responses");
  assert.equal(output.liveSmoke.command, "npx pnpm@9.15.0 smoke:openai");
  assert.equal(typeof output.git.clean, "boolean");
  assert.equal(typeof output.storage.sessions, "number");
  assert.equal(typeof output.storage.reports, "number");
  assert.equal(typeof output.storage.checkpoints, "number");
  assert.equal(output.storage.latestSessionId, run.session.id);
  assert.equal(output.storage.latestSession.sessionId, run.session.id);
  assert.equal(output.storage.latestSession.status, "completed");
  assert.equal(output.storage.latestReportSessionId, run.session.id);
  assert.equal(output.storage.latestReport.sessionId, run.session.id);
  assert.equal(output.storage.latestReport.status, "completed");
  assert.equal(output.storage.latestCommands.session, "token-streaming sessions show latest --json");
  assert.equal(output.storage.latestCommands.report, "token-streaming reports show latest --json");
  assert.equal(output.storage.latestCommands.checkpoint, "token-streaming checkpoints show latest --json");
  assert.equal(output.tools.total, 8);
  assert.equal(output.tools.byRisk.read, 5);
  assert.equal(output.tools.byRisk.write, 1);
  assert.equal(output.tools.byRisk.execute, 2);
  assert.equal(output.tools.names.includes("test.run"), true);
});

test("CLI exposes repository doctor manifest errors as JSON with a non-zero exit code", async () => {
  const cwd = await createIncompleteManifestRepo();
  const result = runCliRaw(["-C", cwd, "doctor", "repo", "--json"], { OPENAI_API_KEY: "" });
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(output.kind, "repository-doctor");
  assert.equal(output.ok, false);
  assert.equal(output.manifest.ok, false);
  assert.equal(output.manifest.counts.errors > 0, true);
  assert.equal(output.manifest.issues.some((issue) => issue.code === "root.architecture.missing"), true);
  assert.equal(output.models.ok, true);
});

test("CLI applies patch proposals and exposes applied files as JSON", async () => {
  const cwd = await createManifestRepo();
  const proposalPath = path.join(cwd, "proposal.json");
  await writePatchProposal(proposalPath, "Create generated note.", "notes/generated.md", "# Generated\n");

  const output = runCli([
    "-C",
    cwd,
    "--provider",
    "stub",
    "--patch-file",
    proposalPath,
    "--apply",
    "--dry-run",
    "--json",
    "add generated note"
  ]);
  const writtenContent = await readFile(path.join(cwd, "notes", "generated.md"), "utf8");
  const report = await readFile(output.reportPath, "utf8");
  const session = runCli(["-C", cwd, "sessions", "show", output.session.id, "--json"]);
  const eventTypes = session.events.map((event) => event.type);

  assert.equal(output.kind, "run");
  assert.equal(output.apply, true);
  assert.deepEqual(output.appliedFiles, ["notes/generated.md"]);
  assert.equal(output.patchProposal.summary, "Create generated note.");
  assert.deepEqual(output.patchProposal.files, [
    {
      path: "notes/generated.md",
      characters: "# Generated\n".length
    }
  ]);
  assert.equal(output.verificationResults.length, 0);
  assert.equal(writtenContent, "# Generated\n");
  assert.equal(eventTypes.indexOf("permission.checked") < eventTypes.indexOf("checkpoint.created"), true);
  assert.equal(eventTypes.indexOf("checkpoint.created") < eventTypes.indexOf("patch.applied"), true);
  assert.match(report, /## Changes/);
  assert.match(report, /applied files: notes\/generated\.md/);
  assert.match(report, /checkpoint: chk_/);
});

test("CLI blocks sensitive patch proposals without explicit approval", async () => {
  const cwd = await createManifestRepo();
  await writeFile(path.join(cwd, ".ai", "safety.yaml"), "sensitive_paths:\n  - secrets\n", "utf8");
  const proposalPath = path.join(cwd, "proposal.json");
  await writePatchProposal(proposalPath, "Write sensitive config.", "secrets/config.md", "# Secret\n");

  const result = runCliRaw(["-C", cwd, "--provider", "stub", "--patch-file", proposalPath, "--apply", "--dry-run", "--json", "write secret"]);
  const error = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(error.kind, "error");
  assert.equal(error.command, "run");
  assert.match(error.message, /Patch blocked by approval/);
  assert.match(error.artifacts.sessionId, /^ses_/);
  assert.match(error.artifacts.eventLogPath, /sessions/);
  assert.match(error.artifacts.reportPath, /reports/);
  assert.match(error.artifacts.commands.session, /sessions show ses_/);
  assert.match(error.artifacts.commands.report, /reports show ses_/);
  assert.equal(result.stderr, "");
  await assertFileExists(error.artifacts.eventLogPath);
  const failureReport = await readFile(error.artifacts.reportPath, "utf8");
  assert.match(failureReport, /Run failed: Patch blocked by approval/);
  const sessions = runCli(["-C", cwd, "sessions", "list", "--json"]);
  const session = runCli(["-C", cwd, "sessions", "show", sessions.sessions[0].sessionId, "--json"]);
  const checkpoints = runCli(["-C", cwd, "checkpoints", "list", "--json"]);
  assert.equal(error.artifacts.sessionId, sessions.sessions[0].sessionId);
  assert.equal(session.events.some((event) => event.type === "run.failed" && /Patch blocked by approval/.test(event.error)), true);
  assert.equal(session.events.some((event) => event.type === "checkpoint.created"), false);
  assert.equal(checkpoints.checkpoints.length, 0);
  await assert.rejects(readFile(path.join(cwd, "secrets", "config.md"), "utf8"), /ENOENT/);
});

test("CLI blocks protected patch content without explicit approval", async () => {
  const cwd = await createManifestRepo();
  await writeFile(path.join(cwd, ".ai", "safety.yaml"), "protected_patterns:\n  - OPENAI_API_KEY\\s*=\n", "utf8");
  const proposalPath = path.join(cwd, "proposal.json");
  await writePatchProposal(proposalPath, "Accidentally add a secret.", "notes/config.md", "OPENAI_API_KEY=sk-test\n");

  const result = runCliRaw(["-C", cwd, "--provider", "stub", "--patch-file", proposalPath, "--apply", "--dry-run", "--json", "write config"]);
  const error = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(error.kind, "error");
  assert.equal(error.command, "run");
  assert.match(error.message, /Patch blocked by approval/);
  assert.match(error.artifacts.sessionId, /^ses_/);
  await assertFileExists(error.artifacts.eventLogPath);
  const failureReport = await readFile(error.artifacts.reportPath, "utf8");
  assert.match(failureReport, /protected pattern/i);
  await assert.rejects(readFile(path.join(cwd, "notes", "config.md"), "utf8"), /ENOENT/);
});

test("CLI allows sensitive patch proposals with explicit approval and records policy decision", async () => {
  const cwd = await createManifestRepo();
  await writeFile(path.join(cwd, ".ai", "safety.yaml"), "sensitive_paths:\n  - secrets\n", "utf8");
  const proposalPath = path.join(cwd, "proposal.json");
  await writePatchProposal(proposalPath, "Write sensitive config.", "secrets/config.md", "# Secret\n");

  const output = runCli([
    "-C",
    cwd,
    "--provider",
    "stub",
    "--patch-file",
    proposalPath,
    "--apply",
    "--allow-sensitive",
    "--dry-run",
    "--json",
    "write secret"
  ]);
  const writtenContent = await readFile(path.join(cwd, "secrets", "config.md"), "utf8");

  assert.deepEqual(output.appliedFiles, ["secrets/config.md"]);
  assert.equal(output.permissionDecisions.length, 1);
  assert.equal(output.permissionDecisions[0].allowed, true);
  assert.equal(output.permissionDecisions[0].severity, "high");
  assert.equal(output.permissionDecisions[0].requiresApproval, true);
  assert.equal(output.approvalResponses.length, 0);
  assert.equal(writtenContent, "# Secret\n");
});

async function createManifestRepo() {
  const cwd = await mkdtemp(path.join(tmpdir(), "token-streaming-cli-json-"));
  await mkdir(path.join(cwd, ".ai", "playbooks"), { recursive: true });
  await mkdir(path.join(cwd, "packages", "payment"), { recursive: true });
  await mkdir(path.join(cwd, "src", "workflows", "checkout"), { recursive: true });
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, ".ai", "project.md"), "# Test Project\n", "utf8");
  await writeFile(path.join(cwd, ".ai", "architecture.md"), "# Architecture\n\nPayment module owns authorization.\n", "utf8");
  await writeFile(path.join(cwd, ".ai", "conventions.md"), "# Conventions\n\nKeep module manifests current.\n", "utf8");
  await writeFile(path.join(cwd, ".ai", "commands.yaml"), "test:\n  - pnpm test\nbuild:\n  - pnpm build\n", "utf8");
  await writeFile(path.join(cwd, ".ai", "tests.yaml"), "default:\n  - node -e \"process.exit(0)\"\n", "utf8");
  await writeFile(
    path.join(cwd, ".ai", "models.yaml"),
    [
      "default_provider: auto",
      "economy_model: cheap-model",
      "auto_model: balanced-model",
      "max_model: strong-model",
      "model_candidates:",
      "  - cheap-model;provider=openai;quality=0.65;cost=0.15;latency=0.2;tags=economy,fast",
      "  - balanced-model;provider=openai;quality=0.85;cost=0.55;latency=0.45;tags=balanced",
      "  - strong-model;provider=openai;quality=0.96;cost=0.9;latency=0.7;tags=max"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(cwd, ".ai", "ownership.yaml"),
    "default_owner: platform\nowned_paths:\n  - packages/payment/**: payments\n",
    "utf8"
  );
  await writeFile(path.join(cwd, ".ai", "playbooks", "add-endpoint.md"), "# Add Endpoint\n\n1. Add route.\n", "utf8");
  await writeFile(
    path.join(cwd, "packages", "payment", "module.yaml"),
    [
      "name: payment",
      "description: Handles payment authorization.",
      "public_api:",
      "  - src/payment.ts",
      "test_commands:",
      "  - pnpm test payment"
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(cwd, "src", "payment.ts"), "export function authorizePayment() {\n  return true;\n}\n", "utf8");
  await writeFile(
    path.join(cwd, "src", "workflows", "checkout", "flow.yaml"),
    [
      "name: checkout",
      "description: Checkout flow across order and payment boundaries.",
      "steps:",
      "  - create order",
      "  - authorize payment",
      "  - confirm order",
      "touches:",
      "  - packages/payment",
      "test_commands:",
      "  - pnpm test workflows/checkout",
      "risks:",
      "  - Payment failure must not leave inventory reserved."
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(cwd, "src", "workflows", "checkout", "README.md"), "# Checkout workflow\n", "utf8");
  return cwd;
}

async function createIncompleteManifestRepo() {
  const cwd = await mkdtemp(path.join(tmpdir(), "token-streaming-cli-incomplete-"));
  await mkdir(path.join(cwd, ".ai"), { recursive: true });
  await writeFile(path.join(cwd, ".ai", "project.md"), "# Incomplete Project\n", "utf8");
  await writeFile(path.join(cwd, ".ai", "commands.yaml"), "test:\n  - pnpm test\n", "utf8");
  return cwd;
}

async function appendModelTelemetrySession(cwd, input) {
  const sessionsDir = path.join(cwd, ".token-streaming", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const events = [
    {
      id: `${input.sessionId}_user`,
      sessionId: input.sessionId,
      timestamp,
      type: "user.message",
      message: input.task
    },
    {
      id: `${input.sessionId}_model`,
      sessionId: input.sessionId,
      timestamp,
      type: "model.called",
      call: {
        purpose: "planning",
        provider: input.provider,
        model: input.model,
        mode: input.mode,
        reasoningEffort: "medium",
        inputTokens: input.status === "completed" ? 800 : 2000,
        outputTokens: input.status === "completed" ? 120 : 900,
        responseCharacters: input.status === "completed" ? 1200 : 8000
      }
    },
    input.status === "completed"
      ? {
          id: `${input.sessionId}_done`,
          sessionId: input.sessionId,
          timestamp,
          type: "run.completed",
          summary: "ok"
        }
      : {
          id: `${input.sessionId}_failed`,
          sessionId: input.sessionId,
          timestamp,
          type: "run.failed",
          error: "Tests failed"
        }
  ];
  await writeFile(path.join(sessionsDir, `${input.sessionId}.jsonl`), events.map((event) => JSON.stringify(event)).join("\n"), "utf8");
}

async function createPlainRepo() {
  const cwd = await mkdtemp(path.join(tmpdir(), "token-streaming-cli-plain-"));
  await writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify(
      {
        scripts: {
          build: "tsc",
          test: "node test.js"
        }
      },
      null,
      2
    ),
    "utf8"
  );
  return cwd;
}

async function writePatchProposal(filePath, summary, targetPath, content) {
  await writeFile(
    filePath,
    JSON.stringify(
      {
        summary,
        files: [
          {
            path: targetPath,
            content
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );
}

function runCli(args, env = {}) {
  const stdout = execFileSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(stdout);
}

function runCliJsonLines(args, env = {}) {
  const stdout = execFileSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runCliRaw(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function assertFileExists(filePath) {
  await assert.doesNotReject(access(filePath));
}

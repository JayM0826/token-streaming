import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AllowApprovalHost, TokenStreamingRuntime } from "../dist/index.js";
import { CheckpointStore } from "../../storage/dist/index.js";

test("headless runtime exposes planning, context, manifest, and tool APIs", async () => {
  const repoRoot = await createHeadlessRepo();
  try {
    const runtime = new TokenStreamingRuntime({ repoRoot });
    const plan = await runtime.planTask({ task: "fix payment endpoint" });
    const context = await runtime.inspectContext("fix payment endpoint");
    const validation = await runtime.validateManifest();
    const tools = runtime.listTools();
    const toolResult = await runtime.runTool({
      name: "file.read",
      input: { path: "src/payment.ts", repoRoot: path.dirname(repoRoot) }
    });

    assert.equal(plan.risk, plan.riskLevel);
    assert.deepEqual(plan.verificationCommands, plan.testCommands);
    assert.deepEqual(plan.context.moduleNames, ["payment"]);
    assert.deepEqual(context.relevantModules, ["payment"]);
    assert.equal(validation.ok, true);
    assert.equal(tools.some((tool) => tool.name === "patch.apply" && tool.risk === "write"), true);
    assert.equal(toolResult.permission.allowed, true);
    assert.match(toolResult.output.content, /authorizePayment/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("headless runtime keeps unsafe tools blocked and gates declared tests", async () => {
  const repoRoot = await createHeadlessRepo({ approvalRequiredTest: true });
  try {
    const denyRuntime = new TokenStreamingRuntime({ repoRoot });
    await assert.rejects(
      () => denyRuntime.runTool({ name: "patch.apply", input: {} }),
      /Tool blocked by runtime policy/
    );
    await assert.rejects(
      () => denyRuntime.runTool({ name: "test.run", input: { command: "node -e \"process.exit(0)\"" } }),
      /Tool blocked by approval/
    );
    await assert.rejects(
      () => denyRuntime.runTool({ name: "test.run", input: { command: "node -e \"process.exit(7)\"" } }),
      /not declared/
    );

    const allowRuntime = new TokenStreamingRuntime({ repoRoot, approvalHost: new AllowApprovalHost() });
    const result = await allowRuntime.runTool({
      name: "test.run",
      input: { command: "node -e \"process.exit(0)\"" }
    });

    assert.equal(result.permission.allowed, false);
    assert.equal(result.permission.requiresApproval, true);
    assert.equal(result.approval?.approved, true);
    assert.equal(result.output.exitCode, 0);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("headless runtime previews and performs rollback", async () => {
  const repoRoot = await createHeadlessRepo();
  try {
    const filePath = path.join(repoRoot, "src", "payment.ts");
    const checkpoint = await new CheckpointStore(repoRoot).create(["src/payment.ts", "src/new-file.ts"]);
    await writeFile(filePath, "export const authorizePayment = false;\n", "utf8");
    await writeFile(path.join(repoRoot, "src", "new-file.ts"), "temporary\n", "utf8");

    const runtime = new TokenStreamingRuntime({ repoRoot });
    const preview = await runtime.rollback("latest", { dryRun: true });
    const result = await runtime.rollback(checkpoint.id);

    assert.equal(preview.kind, "rollback-preview");
    assert.deepEqual(preview.restoreFiles, ["src/payment.ts"]);
    assert.deepEqual(preview.deleteFiles, ["src/new-file.ts"]);
    assert.equal(result.kind, "rollback");
    assert.deepEqual(result.restoredFiles, ["src/payment.ts", "src/new-file.ts"]);
    assert.match(await readFile(filePath, "utf8"), /authorizePayment = true/);
    await assert.rejects(readFile(path.join(repoRoot, "src", "new-file.ts"), "utf8"), /ENOENT/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

async function createHeadlessRepo(options = {}) {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-headless-"));
  await mkdir(path.join(repoRoot, ".ai", "playbooks"), { recursive: true });
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
    "utf8"
  );
  await writeFile(path.join(repoRoot, "src", "payment.ts"), "export const authorizePayment = true;\n", "utf8");
  await writeFile(path.join(repoRoot, ".ai", "project.md"), "# Project\nHeadless API fixture.\n", "utf8");
  await writeFile(path.join(repoRoot, ".ai", "architecture.md"), "# Architecture\nOne module.\n", "utf8");
  await writeFile(path.join(repoRoot, ".ai", "conventions.md"), "# Conventions\nKeep APIs explicit.\n", "utf8");
  await writeFile(path.join(repoRoot, ".ai", "commands.yaml"), "test:\n  - npm run test\n", "utf8");
  await writeFile(path.join(repoRoot, ".ai", "tests.yaml"), 'default:\n  - node -e "process.exit(0)"\n', "utf8");
  await writeFile(path.join(repoRoot, ".ai", "models.yaml"), "default_provider: stub\n", "utf8");
  await writeFile(path.join(repoRoot, ".ai", "ownership.yaml"), "default_owner: platform\n", "utf8");
  await writeFile(
    path.join(repoRoot, ".ai", "safety.yaml"),
    options.approvalRequiredTest ? 'approval_required_commands:\n  - node -e "process.exit(0)"\n' : "forbidden_commands:\n  - git reset --hard\n",
    "utf8"
  );
  await writeFile(path.join(repoRoot, ".ai", "playbooks", "change.md"), "# Change\nInspect before editing.\n", "utf8");
  await writeFile(
    path.join(repoRoot, "src", "module.yaml"),
    "name: ignored-root-module\ndescription: Not discovered outside src/modules.\n",
    "utf8"
  );
  await mkdir(path.join(repoRoot, "src", "modules", "payment"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "modules", "payment", "module.yaml"),
    [
      "name: payment",
      "description: Payment authorization.",
      "owners:",
      "  - platform",
      "public_api:",
      "  - src/payment.ts",
      "test_commands:",
      '  - node -e "process.exit(0)"',
      "rules:",
      "  - Keep payment endpoint stable."
    ].join("\n") + "\n",
    "utf8"
  );
  return repoRoot;
}

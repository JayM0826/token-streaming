import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { generateFallbackManifest, scaffoldOfficialManifest } from "../dist/generator.js";

test("scaffoldOfficialManifest creates the official AI manifest surface", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-manifest-"));
  try {
    const result = await scaffoldOfficialManifest(repoRoot, createSummary(repoRoot));

    assert.equal(result.created.length, 10);
    assert.equal(result.skipped.length, 0);
    assert.equal(existsSync(path.join(repoRoot, ".ai", "project.md")), true);
    assert.equal(existsSync(path.join(repoRoot, ".ai", "architecture.md")), true);
    assert.equal(existsSync(path.join(repoRoot, ".ai", "conventions.md")), true);
    assert.equal(existsSync(path.join(repoRoot, ".ai", "commands.yaml")), true);
    assert.equal(existsSync(path.join(repoRoot, ".ai", "tests.yaml")), true);
    assert.equal(existsSync(path.join(repoRoot, ".ai", "models.yaml")), true);
    assert.equal(existsSync(path.join(repoRoot, ".ai", "ownership.yaml")), true);
    assert.equal(existsSync(path.join(repoRoot, ".ai", "safety.yaml")), true);
    assert.equal(existsSync(path.join(repoRoot, ".ai", "glossary.md")), true);
    assert.equal(existsSync(path.join(repoRoot, ".ai", "playbooks", "fix-failing-test.md")), true);

    const testsYaml = await readFile(path.join(repoRoot, ".ai", "tests.yaml"), "utf8");
    assert.match(testsYaml, /npm run test/);
    assert.match(testsYaml, /npm run typecheck/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("scaffoldOfficialManifest skips existing files by default", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-manifest-"));
  try {
    await mkdir(path.join(repoRoot, ".ai"), { recursive: true });
    await writeFile(path.join(repoRoot, ".ai", "project.md"), "custom project\n", "utf8");

    const result = await scaffoldOfficialManifest(repoRoot, createSummary(repoRoot));

    assert.equal(result.skipped.some((file) => file.endsWith("project.md")), true);
    assert.equal(await readFile(path.join(repoRoot, ".ai", "project.md"), "utf8"), "custom project\n");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("scaffoldOfficialManifest overwrites existing files when requested", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-manifest-"));
  try {
    await mkdir(path.join(repoRoot, ".ai"), { recursive: true });
    await writeFile(path.join(repoRoot, ".ai", "project.md"), "custom project\n", "utf8");

    const result = await scaffoldOfficialManifest(repoRoot, createSummary(repoRoot), { overwrite: true });
    const project = await readFile(path.join(repoRoot, ".ai", "project.md"), "utf8");

    assert.equal(result.skipped.length, 0);
    assert.match(project, /# Project/);
    assert.doesNotMatch(project, /custom project/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("generateFallbackManifest writes command and test groups agents can consume", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-generated-manifest-"));
  try {
    const result = await generateFallbackManifest(repoRoot, createSummary(repoRoot));
    const commandsYaml = await readFile(path.join(result.root, "commands.yaml"), "utf8");
    const testsYaml = await readFile(path.join(result.root, "tests.yaml"), "utf8");
    const repoMap = JSON.parse(await readFile(path.join(result.root, "repo-map.json"), "utf8"));

    assert.equal(result.created.length, 5);
    assert.equal(result.skipped.length, 0);
    assert.match(commandsYaml, /test:/);
    assert.match(commandsYaml, /npm run test/);
    assert.match(commandsYaml, /typecheck:/);
    assert.match(testsYaml, /default:/);
    assert.match(testsYaml, /npm run test/);
    assert.match(testsYaml, /npm run typecheck/);
    assert.deepEqual(repoMap.notes.length, 2);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("generateFallbackManifest infers module and workflow candidates for foreign repos", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-generated-manifest-"));
  try {
    const result = await generateFallbackManifest(repoRoot, {
      ...createSummary(repoRoot),
      trackedFiles: [
        "package.json",
        "src/modules/payment/api.ts",
        "src/modules/payment/service.ts",
        "src/modules/payment/tests/payment.test.ts",
        "src/modules/order/api.ts",
        "src/workflows/checkout/checkout.service.ts",
        "src/workflows/checkout/checkout.test.ts",
        "tests/checkout.e2e.test.ts"
      ],
      sourceDirectories: ["src"]
    });
    const repoMap = JSON.parse(await readFile(path.join(result.root, "repo-map.json"), "utf8"));

    assert.equal(repoMap.inferredModules.some((candidate) => candidate.root === "src/modules/payment"), true);
    assert.equal(repoMap.inferredWorkflows.some((candidate) => candidate.root === "src/workflows/checkout"), true);
    assert.equal(
      repoMap.testMappings.some(
        (mapping) => mapping.target === "src/modules/payment" && mapping.tests.includes("src/modules/payment/tests/payment.test.ts")
      ),
      true
    );
    assert.match(repoMap.inferredModules.find((candidate) => candidate.root === "src/modules/payment").evidence.join("\n"), /public API-like/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("generateFallbackManifest skips existing generated files by default", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-generated-manifest-"));
  try {
    await mkdir(path.join(repoRoot, ".ai", "generated"), { recursive: true });
    await writeFile(path.join(repoRoot, ".ai", "generated", "project.md"), "custom generated\n", "utf8");

    const result = await generateFallbackManifest(repoRoot, createSummary(repoRoot));
    const project = await readFile(path.join(repoRoot, ".ai", "generated", "project.md"), "utf8");

    assert.equal(result.skipped.some((file) => file.endsWith("project.md")), true);
    assert.equal(project, "custom generated\n");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("generateFallbackManifest overwrites existing generated files when requested", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-generated-manifest-"));
  try {
    await mkdir(path.join(repoRoot, ".ai", "generated"), { recursive: true });
    await writeFile(path.join(repoRoot, ".ai", "generated", "project.md"), "custom generated\n", "utf8");

    const result = await generateFallbackManifest(repoRoot, createSummary(repoRoot), { overwrite: true });
    const project = await readFile(path.join(repoRoot, ".ai", "generated", "project.md"), "utf8");

    assert.equal(result.skipped.length, 0);
    assert.equal(result.created.some((file) => file.endsWith("project.md")), true);
    assert.match(project, /# Generated Project Summary/);
    assert.doesNotMatch(project, /custom generated/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

function createSummary(root) {
  return {
    root,
    packageManager: "npm",
    scripts: {
      test: "node test.js",
      typecheck: "tsc --noEmit"
    },
    trackedFiles: ["package.json", "src/index.ts"],
    sourceDirectories: ["src"],
    moduleManifestPaths: [],
    workflowManifestPaths: [],
    aiManifestPresent: false
  };
}

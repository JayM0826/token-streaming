import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRepoManifest } from "../dist/loader.js";

test("loadRepoManifest reads models.yaml as root model policy", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-loader-"));
  try {
    await mkdir(path.join(repoRoot, ".ai"), { recursive: true });
    await writeFile(path.join(repoRoot, ".ai", "project.md"), "# Project\n", "utf8");
    await writeFile(
      path.join(repoRoot, ".ai", "models.yaml"),
      ["default_provider: auto", "economy_model: small-model", "max_model: strong-model"].join("\n"),
      "utf8"
    );

    const manifest = await loadRepoManifest(repoRoot);

    assert.equal(manifest.generated, false);
    assert.equal(manifest.models?.default_provider, "auto");
    assert.equal(manifest.models?.economy_model, "small-model");
    assert.equal(manifest.models?.max_model, "strong-model");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("loadRepoManifest reads ownership.yaml as root ownership policy", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-loader-"));
  try {
    await mkdir(path.join(repoRoot, ".ai"), { recursive: true });
    await writeFile(path.join(repoRoot, ".ai", "project.md"), "# Project\n", "utf8");
    await writeFile(
      path.join(repoRoot, ".ai", "ownership.yaml"),
      ["default_owner: platform", "owned_paths:", "  - src/**: engineering", "  - .ai/**: agent-platform"].join("\n"),
      "utf8"
    );

    const manifest = await loadRepoManifest(repoRoot);

    assert.equal(manifest.generated, false);
    assert.equal(manifest.ownership?.default_owner, "platform");
    assert.deepEqual(manifest.ownership?.owned_paths, ["src/**: engineering", ".ai/**: agent-platform"]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("loadRepoManifest reads workflow descriptions and risks", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-loader-"));
  try {
    await mkdir(path.join(repoRoot, ".ai"), { recursive: true });
    await mkdir(path.join(repoRoot, "src", "workflows", "checkout"), { recursive: true });
    await writeFile(path.join(repoRoot, ".ai", "project.md"), "# Project\n", "utf8");
    await writeFile(
      path.join(repoRoot, "src", "workflows", "checkout", "flow.yaml"),
      [
        "name: checkout",
        "description: Checkout crosses payment and inventory.",
        "steps:",
        "  - reserve inventory",
        "  - authorize payment",
        "touches:",
        "  - src/modules/payment",
        "test_commands:",
        "  - pnpm test checkout",
        "risks:",
        "  - Failed payment must release inventory."
      ].join("\n"),
      "utf8"
    );

    const manifest = await loadRepoManifest(repoRoot);

    assert.equal(manifest.workflows.length, 1);
    assert.equal(manifest.workflows[0].description, "Checkout crosses payment and inventory.");
    assert.deepEqual(manifest.workflows[0].risks, ["Failed payment must release inventory."]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("loadRepoManifest maps generated repo candidates into runtime metadata", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-generated-loader-"));
  try {
    const generatedRoot = path.join(repoRoot, ".ai", "generated");
    await mkdir(generatedRoot, { recursive: true });
    await writeFile(path.join(generatedRoot, "tests.yaml"), "default:\n  - python -m compileall app src\n", "utf8");
    await writeFile(
      path.join(generatedRoot, "repo-map.json"),
      JSON.stringify({
        inferredModules: [
          {
            name: "models",
            root: "src/models",
            confidence: "high",
            evidence: ["8 file(s) under src/models"],
            publicApiCandidates: ["src/models/encoder.py"]
          }
        ],
        inferredWorkflows: [
          {
            name: "training",
            root: "app/training",
            confidence: "medium",
            evidence: ["training entrypoint detected"],
            touches: ["src/models"]
          }
        ]
      }),
      "utf8"
    );

    const manifest = await loadRepoManifest(repoRoot);

    assert.equal(manifest.generated, true);
    assert.equal(manifest.modules.length, 1);
    assert.equal(manifest.modules[0]?.name, "models");
    assert.equal(manifest.modules[0]?.generated, true);
    assert.deepEqual(manifest.modules[0]?.publicApi, ["src/models/encoder.py"]);
    assert.deepEqual(manifest.modules[0]?.testCommands, ["python -m compileall app src"]);
    assert.match(manifest.modules[0]?.description ?? "", /high confidence/);
    assert.equal(manifest.workflows.length, 1);
    assert.equal(manifest.workflows[0]?.name, "training");
    assert.equal(manifest.workflows[0]?.generated, true);
    assert.deepEqual(manifest.workflows[0]?.touches, ["src/models"]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

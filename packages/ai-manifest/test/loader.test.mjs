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

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateRepoManifest } from "../dist/index.js";

test("validateRepoManifest accepts a complete AI manifest", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-validator-"));
  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "api.ts"), "export {};\n", "utf8");

    const result = await validateRepoManifest(repoRoot, {
      project: "# Project\n",
      architecture: "# Architecture\n",
      conventions: "# Conventions\n",
      commands: {
        test: ["pnpm test"]
      },
      tests: {
        default: ["pnpm test"]
      },
      ownership: {
        default_owner: "platform",
        owned_paths: ["src/**: platform"]
      },
      models: {
        default_provider: "auto",
        model_candidates: [
          "gpt-5.5-mini;provider=openai;quality=0.72;cost=0.25;latency=0.25;tags=economy,fast",
          "gpt-5.5;provider=openai;quality=0.94;cost=0.75;latency=0.55;tags=balanced,max"
        ]
      },
      playbooks: [
        {
          name: "add-feature",
          path: path.join(repoRoot, ".ai", "playbooks", "add-feature.md"),
          content: "# Add Feature\n"
        }
      ],
      modules: [
        {
          path: path.join(repoRoot, "src", "module.yaml"),
          name: "core",
          description: "Core module",
          owners: ["platform"],
          publicApi: ["src/api.ts"],
          dependsOn: [],
          usedBy: [],
          testCommands: ["pnpm test core"],
          rules: []
        }
      ],
      workflows: [
        {
          path: path.join(repoRoot, "src", "workflows", "checkout", "flow.yaml"),
          name: "checkout",
          description: "Checkout flow",
          steps: ["authorize payment"],
          touches: ["src/api.ts"],
          testCommands: ["pnpm test checkout"],
          risks: ["Payment failure must be reversible"]
        }
      ],
      generated: false
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("validateRepoManifest reports missing root, command, test, and module metadata", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-validator-"));
  try {
    const result = await validateRepoManifest(repoRoot, {
      playbooks: [
        {
          name: "untitled",
          path: path.join(repoRoot, ".ai", "playbooks", "untitled.md"),
          content: "No heading\n"
        }
      ],
      modules: [
        {
          path: path.join(repoRoot, "packages", "empty", "module.yaml"),
          name: "empty",
          owners: [],
          publicApi: ["packages/empty/index.ts"],
          dependsOn: [],
          usedBy: [],
          testCommands: [],
          rules: []
        }
      ],
      workflows: [
        {
          path: path.join(repoRoot, "src", "workflows", "empty", "flow.yaml"),
          name: "empty",
          steps: [],
          touches: [],
          testCommands: [],
          risks: []
        }
      ],
      generated: true
    });

    assert.equal(result.ok, false);
    assert.match(
      result.issues.map((issue) => issue.code).join("\n"),
      /root\.project\.missing/
    );
    assert.match(
      result.issues.map((issue) => issue.code).join("\n"),
      /commands\.empty/
    );
    assert.match(
      result.issues.map((issue) => issue.code).join("\n"),
      /tests\.default\.missing/
    );
    assert.match(
      result.issues.map((issue) => issue.code).join("\n"),
      /ownership\.missing/
    );
    assert.match(
      result.issues.map((issue) => issue.code).join("\n"),
      /models\.missing/
    );
    assert.match(
      result.issues.map((issue) => issue.code).join("\n"),
      /module\.test_commands\.missing/
    );
    assert.match(
      result.issues.map((issue) => issue.code).join("\n"),
      /module\.public_api\.not_found/
    );
    assert.match(
      result.issues.map((issue) => issue.code).join("\n"),
      /playbook\.title\.missing/
    );
    assert.match(
      result.issues.map((issue) => issue.code).join("\n"),
      /workflow\.description\.missing/
    );
    assert.match(
      result.issues.map((issue) => issue.code).join("\n"),
      /workflow\.risks\.missing/
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("validateRepoManifest reports invalid model routing metadata", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-validator-"));
  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "api.ts"), "export {};\n", "utf8");

    const result = await validateRepoManifest(repoRoot, {
      project: "# Project\n",
      architecture: "# Architecture\n",
      conventions: "# Conventions\n",
      commands: {
        test: ["pnpm test"]
      },
      tests: {
        default: ["pnpm test"]
      },
      ownership: {
        default_owner: "platform"
      },
      models: {
        default_provider: "bad-provider",
        economy_model: "",
        model_candidates: [
          "broken-model;provider=bad;quality=2;cost=nope;latency=0.2;unknown=value",
          "missing-metrics;provider=openai"
        ]
      },
      playbooks: [
        {
          name: "add-feature",
          path: path.join(repoRoot, ".ai", "playbooks", "add-feature.md"),
          content: "# Add Feature\n"
        }
      ],
      modules: [
        {
          path: path.join(repoRoot, "src", "module.yaml"),
          name: "core",
          description: "Core module",
          owners: ["platform"],
          publicApi: ["src/api.ts"],
          dependsOn: [],
          usedBy: [],
          testCommands: ["pnpm test core"],
          rules: []
        }
      ],
      workflows: [],
      generated: false
    });

    const codes = result.issues.map((issue) => issue.code).join("\n");

    assert.equal(result.ok, false);
    assert.match(codes, /models\.default_provider\.invalid/);
    assert.match(codes, /models\.economy_model\.invalid/);
    assert.match(codes, /models\.model_candidate\.provider\.invalid/);
    assert.match(codes, /models\.model_candidate\.quality\.invalid/);
    assert.match(codes, /models\.model_candidate\.cost\.invalid/);
    assert.match(codes, /models\.model_candidate\.field\.unknown/);
    assert.match(codes, /models\.model_candidate\.quality\.missing/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("validateRepoManifest treats incomplete generated fallback metadata as warnings", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-generated-validation-"));
  try {
    const result = await validateRepoManifest(repoRoot, {
      project: "# Generated project",
      architecture: "# Generated architecture",
      commands: {},
      tests: { default: [] },
      playbooks: [],
      modules: [
        {
          path: path.join(repoRoot, "src", "models", "module.yaml"),
          generated: true,
          name: "models",
          description: "Generated module candidate.",
          owners: [],
          publicApi: [],
          dependsOn: [],
          usedBy: [],
          testCommands: [],
          rules: []
        }
      ],
      workflows: [],
      generated: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.issues.some((issue) => issue.severity === "error"), false);
    assert.equal(result.issues.some((issue) => issue.code === "manifest.generated"), true);
    assert.equal(result.issues.some((issue) => issue.code === "root.conventions.missing" && issue.severity === "warning"), true);
    assert.equal(result.issues.some((issue) => issue.code === "module.public_api.missing" && issue.severity === "warning"), true);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

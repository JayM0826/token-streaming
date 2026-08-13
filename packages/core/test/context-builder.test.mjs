import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRuntimeContext } from "../dist/context/context-builder.js";

test("buildRuntimeContext includes ownership metadata in the overview", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-context-"));
  try {
    const context = await buildRuntimeContext(
      "summarize checkout ownership",
      {
        root: repoRoot,
        packageManager: "pnpm",
        scripts: {},
        trackedFiles: [],
        sourceDirectories: [],
        moduleManifestPaths: [],
        workflowManifestPaths: [],
        aiManifestPresent: true
      },
      {
        project: "# Project\n",
        architecture: "# Architecture\n",
        conventions: "# Conventions\n",
        ownership: {
          default_owner: "platform",
          owned_paths: ["packages/core/**: runtime-core"]
        },
        playbooks: [],
        modules: [],
        workflows: [
          {
            path: path.join(repoRoot, "src", "workflows", "checkout", "flow.yaml"),
            name: "checkout",
            description: "Checkout crosses payment and inventory.",
            steps: ["reserve inventory", "authorize payment"],
            touches: ["packages/payment"],
            testCommands: ["pnpm test checkout"],
            risks: ["Failed payment must release inventory."]
          }
        ],
        generated: false
      },
      {
        strategy: "default",
        mode: "auto",
        task: "summarize checkout ownership",
        riskLevel: "low",
        phases: [],
        requiredAgents: [],
        handoffs: [],
        testCommands: [],
        notes: []
      },
      {
        recentHistory: [
          {
            sessionId: "ses_previous",
            status: "failed",
            task: "fix checkout payment failure",
            error: "Verification failed",
            failureCategory: "verification",
            toolResults: [{ toolName: "test.run", ok: false, summary: "checkout.test failed" }]
          }
        ]
      }
    );

    assert.match(context.overview, /## Ownership/);
    assert.match(context.overview, /default_owner: platform/);
    assert.match(context.overview, /packages\/core\/\*\*: runtime-core/);
    assert.match(context.overview, /Checkout crosses payment and inventory/);
    assert.match(context.overview, /Failed payment must release inventory/);
    assert.equal(context.selectionReasons.some((reason) => reason.kind === "workflow" && reason.target === "checkout"), true);
    assert.match(context.overview, /Selection Reasons/);
    assert.equal(context.recentHistory.length, 1);
    assert.match(context.overview, /## Recent History/);
    assert.match(context.overview, /ses_previous: failed \(verification\)/);
    assert.match(context.overview, /test\.run:failed:checkout\.test failed/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("buildRuntimeContext can select Python source snippets by task words", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-context-python-"));
  try {
    await mkdir(path.join(repoRoot, "app", "vjepa"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "app", "vjepa", "train.py"),
      "def train_model():\n    return 'training loop'\n",
      "utf8"
    );

    const context = await buildRuntimeContext(
      "summarize training loop",
      {
        root: repoRoot,
        packageManager: undefined,
        scripts: {},
        trackedFiles: ["app/vjepa/train.py"],
        sourceDirectories: ["app"],
        moduleManifestPaths: [],
        workflowManifestPaths: [],
        aiManifestPresent: false
      },
      {
        project: undefined,
        architecture: undefined,
        conventions: undefined,
        ownership: undefined,
        playbooks: [],
        modules: [],
        workflows: [],
        generated: true
      },
      {
        strategy: "default",
        mode: "auto",
        task: "summarize training loop",
        riskLevel: "low",
        phases: [],
        requiredAgents: [],
        handoffs: [],
        testCommands: [],
        notes: []
      }
    );

    assert.equal(context.sourceSnippets.some((snippet) => snippet.path === "app/vjepa/train.py"), true);
    assert.match(context.overview, /training loop/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("buildRuntimeContext selects modules from Chinese rule keywords", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-context-chinese-"));
  try {
    const context = await buildRuntimeContext(
      "修复退款幂等性",
      {
        root: repoRoot,
        scripts: {},
        trackedFiles: [],
        sourceDirectories: [],
        moduleManifestPaths: [],
        workflowManifestPaths: [],
        aiManifestPresent: true
      },
      {
        playbooks: [],
        modules: [
          {
            path: path.join(repoRoot, "src", "modules", "refunds", "module.yaml"),
            name: "refunds",
            owners: [],
            publicApi: [],
            dependsOn: [],
            usedBy: [],
            testCommands: [],
            rules: ["退款逻辑必须幂等"]
          }
        ],
        workflows: [],
        generated: false
      },
      {
        strategy: "default",
        mode: "auto",
        task: "修复退款幂等性",
        risk: "low",
        riskLevel: "low",
        context: {
          moduleNames: [],
          workflowNames: [],
          publicApiPaths: [],
          maxSourceFiles: 6,
          maxSourceCharacters: 4_000
        },
        phases: [],
        requiredAgents: [],
        handoffs: [],
        verificationCommands: [],
        testCommands: [],
        notes: []
      }
    );

    assert.deepEqual(context.relevantModules, ["refunds"]);
    assert.match(context.selectionReasons[0]?.reason ?? "", /退款逻辑必须幂等/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("buildRuntimeContext clamps untrusted plan context budgets", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-context-budget-"));
  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    const files = Array.from({ length: 15 }, (_, index) => `src/file-${index}.ts`);
    await Promise.all(files.map((file) => writeFile(path.join(repoRoot, file), "x".repeat(10_000), "utf8")));

    const context = await buildRuntimeContext(
      "inspect bounded context",
      {
        root: repoRoot,
        scripts: {},
        trackedFiles: files,
        sourceDirectories: ["src"],
        moduleManifestPaths: [],
        workflowManifestPaths: [],
        aiManifestPresent: true
      },
      { playbooks: [], modules: [], workflows: [], generated: false },
      {
        strategy: "custom",
        mode: "max",
        task: "inspect bounded context",
        risk: "low",
        riskLevel: "low",
        context: {
          moduleNames: [],
          workflowNames: [],
          publicApiPaths: files,
          maxSourceFiles: 10_000,
          maxSourceCharacters: 10_000_000
        },
        phases: [],
        requiredAgents: [],
        handoffs: [],
        verificationCommands: [],
        testCommands: [],
        notes: []
      }
    );

    assert.equal(context.sourceSnippets.length, 12);
    assert.equal(context.sourceSnippets.every((snippet) => snippet.content.length <= 8_000), true);
    assert.equal(context.sourceSnippets.every((snippet) => snippet.truncated), true);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

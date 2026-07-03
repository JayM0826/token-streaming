import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

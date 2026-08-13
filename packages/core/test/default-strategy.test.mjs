import assert from "node:assert/strict";
import test from "node:test";
import { DefaultStrategy } from "../dist/strategy/default-strategy.js";

test("DefaultStrategy creates handoffs for understanding tasks", async () => {
  const plan = await new DefaultStrategy().createPlan(createInput("summarize this repo"));

  assert.deepEqual(
    plan.phases.map((phase) => phase.id),
    ["orchestrate", "research"]
  );
  assert.deepEqual(
    plan.handoffs.map((handoff) => [handoff.from, handoff.to ?? "final", handoff.artifact]),
    [
      ["orchestrator", "research", "execution plan"],
      ["research", "final", "repository context brief"]
    ]
  );
});

test("DefaultStrategy creates coder, tester, and reviewer handoffs for change tasks", async () => {
  const plan = await new DefaultStrategy().createPlan(createInput("fix payment failure"));

  assert.deepEqual(
    plan.phases.map((phase) => phase.id),
    ["orchestrate", "research", "code-change", "tests", "review"]
  );
  assert.deepEqual(
    plan.handoffs.map((handoff) => [handoff.from, handoff.to ?? "final", handoff.artifact]),
    [
      ["orchestrator", "research", "execution plan"],
      ["research", "coder", "repository context brief"],
      ["coder", "tester", "structured patch proposal"],
      ["tester", "reviewer", "verification result"],
      ["reviewer", "final", "risk and diff review"]
    ]
  );
});

test("DefaultStrategy uses root tests.yaml default commands when no targeted manifest matches", async () => {
  const plan = await new DefaultStrategy().createPlan(
    createInput("fix checkout failure", {
      repo: {
        scripts: {
          test: "node test.js"
        }
      },
      manifest: {
        tests: {
          default: ["pnpm build", "pnpm test"]
        },
        modules: [
          {
            path: "/repo/packages/payment/module.yaml",
            name: "payment",
            description: "Payment module",
            owners: [],
            publicApi: [],
            dependsOn: [],
            usedBy: [],
            testCommands: ["pnpm test payment"],
            rules: []
          }
        ]
      }
    })
  );

  assert.deepEqual(plan.testCommands, ["pnpm build", "pnpm test"]);
});

test("DefaultStrategy falls back to scanner verification commands when generated tests are empty", async () => {
  const plan = await new DefaultStrategy().createPlan(
    createInput("fix Python syntax", {
      repo: {
        verificationCommands: ["python -m compileall app src"]
      },
      manifest: {
        generated: true,
        tests: {
          default: []
        }
      }
    })
  );

  assert.deepEqual(plan.testCommands, ["python -m compileall app src"]);
});

test("DefaultStrategy prefers targeted module commands over root defaults", async () => {
  const plan = await new DefaultStrategy().createPlan(
    createInput("fix payment refund failure", {
      manifest: {
        tests: {
          default: ["pnpm build", "pnpm test"]
        },
        modules: [
          {
            path: "/repo/packages/payment/module.yaml",
            name: "payment",
            description: "Payment module",
            owners: [],
            publicApi: [],
            dependsOn: [],
            usedBy: [],
            testCommands: ["pnpm test payment"],
            rules: ["Refund logic must be idempotent"]
          }
        ]
      }
    })
  );

  assert.deepEqual(plan.testCommands, ["pnpm test payment"]);
});

test("DefaultStrategy raises risk when a matched workflow declares high-risk failure modes", async () => {
  const plan = await new DefaultStrategy().createPlan(
    createInput("fix checkout failure", {
      manifest: {
        workflows: [
          {
            path: "/repo/src/workflows/checkout/flow.yaml",
            name: "checkout",
            description: "Checkout crosses payment and inventory.",
            steps: ["reserve inventory", "authorize payment"],
            touches: ["packages/payment"],
            testCommands: ["pnpm test checkout"],
            risks: ["Payment failure must not cause data loss and must rollback inventory."]
          }
        ]
      }
    })
  );

  assert.equal(plan.riskLevel, "high");
  assert.deepEqual(plan.testCommands, ["pnpm test checkout"]);
});

test("DefaultStrategy treats matched workflows without high-risk keywords as medium risk", async () => {
  const plan = await new DefaultStrategy().createPlan(
    createInput("summarize checkout flow", {
      manifest: {
        workflows: [
          {
            path: "/repo/src/workflows/checkout/flow.yaml",
            name: "checkout",
            description: "Checkout crosses order status updates.",
            steps: ["create order", "confirm order"],
            touches: ["packages/order"],
            testCommands: ["pnpm test checkout"],
            risks: ["Status transitions must stay idempotent."]
          }
        ]
      }
    })
  );

  assert.equal(plan.riskLevel, "medium");
  assert.deepEqual(
    plan.phases.map((phase) => phase.id),
    ["orchestrate", "research", "review"]
  );
});

test("DefaultStrategy does not raise unrelated tasks merely because approvals are configured", async () => {
  const strategy = new DefaultStrategy();
  const plan = await strategy.createPlan(
    createInput("summarize repository layout", {
      manifest: {
      safety: {
        approval_required_commands: ["npm publish"],
        sensitive_paths: ["src/modules/payment/**"],
        requires_review: ["payment provider changes"]
      }
      }
    })
  );

  assert.equal(plan.riskLevel, "low");
  assert.equal(plan.requiredAgents.includes("reviewer"), false);
});

test("DefaultStrategy raises risk when task text matches a safety review term", async () => {
  const strategy = new DefaultStrategy();
  const plan = await strategy.createPlan(
    createInput("update provider integration", {
      manifest: {
        safety: {
          requires_review: ["provider integration changes"]
        }
      }
    })
  );

  assert.equal(plan.riskLevel, "high");
  assert.equal(plan.requiredAgents.includes("reviewer"), true);
});

function createInput(task, overrides = {}) {
  const repo = {
    root: "/repo",
    packageManager: "pnpm",
    scripts: {},
    trackedFiles: [],
    sourceDirectories: [],
    moduleManifestPaths: [],
    workflowManifestPaths: [],
    aiManifestPresent: true,
    ...(overrides.repo ?? {})
  };
  const manifest = {
    playbooks: [],
    modules: [],
    workflows: [],
    generated: false,
    ...(overrides.manifest ?? {})
  };

  return {
    task,
    mode: "auto",
    repo,
    manifest
  };
}

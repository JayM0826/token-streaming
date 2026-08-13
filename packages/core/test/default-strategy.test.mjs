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
      ["orchestrator", "researcher", "execution plan"],
      ["researcher", "final", "repository context brief"]
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
      ["orchestrator", "researcher", "execution plan"],
      ["researcher", "coder", "repository context brief"],
      ["coder", "tester", "structured patch proposal"],
      ["tester", "reviewer", "verification result"],
      ["reviewer", "final", "risk and diff review"]
    ]
  );
  assert.deepEqual(plan.requiredAgents, ["orchestrator", "researcher", "coder", "tester", "reviewer"]);
  assert.equal(plan.risk, plan.riskLevel);
  assert.deepEqual(plan.verificationCommands, plan.testCommands);
  assert.equal(plan.context.maxSourceFiles, 6);
  assert.equal(plan.context.maxSourceCharacters, 4_000);
});

test("DefaultStrategy varies context budgets by product mode", async () => {
  const strategy = new DefaultStrategy();
  const economy = await strategy.createPlan({ ...createInput("summarize repo"), mode: "economy" });
  const max = await strategy.createPlan({ ...createInput("summarize repo"), mode: "max" });

  assert.deepEqual(
    [economy.context.maxSourceFiles, economy.context.maxSourceCharacters],
    [3, 2_000]
  );
  assert.deepEqual([max.context.maxSourceFiles, max.context.maxSourceCharacters], [8, 6_000]);
});

test("DefaultStrategy makes economy verification lighter and max review mandatory", async () => {
  const strategy = new DefaultStrategy();
  const input = createInput("summarize repository layout", {
    manifest: {
      tests: {
        default: ["pnpm test", "pnpm lint", "pnpm typecheck"]
      }
    }
  });
  const economy = await strategy.createPlan({ ...input, mode: "economy" });
  const auto = await strategy.createPlan({ ...input, mode: "auto" });
  const max = await strategy.createPlan({ ...input, mode: "max" });

  assert.deepEqual(economy.verificationCommands, ["pnpm test"]);
  assert.deepEqual(auto.verificationCommands, ["pnpm test", "pnpm lint", "pnpm typecheck"]);
  assert.deepEqual(max.verificationCommands, auto.verificationCommands);
  assert.equal(auto.phases.some((phase) => phase.role === "reviewer"), false);
  assert.equal(max.phases.find((phase) => phase.role === "reviewer")?.required, true);
  assert.equal(max.requiredAgents.includes("reviewer"), true);
});

test("DefaultStrategy keeps optional low-risk review out of required agents", async () => {
  const plan = await new DefaultStrategy().createPlan(createInput("fix implementation"));

  assert.equal(plan.phases.find((phase) => phase.role === "reviewer")?.required, false);
  assert.equal(plan.requiredAgents.includes("reviewer"), false);
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

test("DefaultStrategy ignores npm placeholder test scripts", async () => {
  const plan = await new DefaultStrategy().createPlan(
    createInput("fix implementation", {
      repo: {
        packageManager: "npm",
        scripts: {
          test: 'echo "Error: no test specified" && exit 1'
        }
      }
    })
  );

  assert.deepEqual(plan.testCommands, []);
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
  assert.deepEqual(plan.context.moduleNames, ["payment"]);
  assert.deepEqual(plan.context.publicApiPaths, []);
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

test("DefaultStrategy matches Chinese manifest rules and safety review terms", async () => {
  const plan = await new DefaultStrategy().createPlan(
    createInput("修改发布流程并确保退款幂等性", {
      manifest: {
        modules: [
          {
            path: "/repo/src/modules/refunds/module.yaml",
            name: "refunds",
            description: "Refund processing",
            owners: [],
            publicApi: [],
            dependsOn: [],
            usedBy: [],
            testCommands: [],
            rules: ["退款逻辑必须幂等"]
          }
        ],
        safety: {
          requires_review: ["发布流程变更"]
        }
      }
    })
  );

  assert.deepEqual(plan.context.moduleNames, ["refunds"]);
  assert.deepEqual(plan.verificationCommands, []);
  assert.equal(plan.risk, "high");
  assert.equal(plan.requiredAgents.includes("reviewer"), true);
});

test("DefaultStrategy classifies Chinese destructive tasks as high-risk changes", async () => {
  const plan = await new DefaultStrategy().createPlan(createInput("删除生产数据"));

  assert.equal(plan.risk, "high");
  assert.equal(plan.phases.some((phase) => phase.role === "coder" && phase.required), true);
  assert.equal(plan.requiredAgents.includes("reviewer"), true);
});

test("DefaultStrategy targets verification from manifest descriptions and workflow steps", async () => {
  const plan = await new DefaultStrategy().createPlan(
    createInput("fix inventory reservation after authorization", {
      manifest: {
        tests: { default: ["pnpm test"] },
        modules: [
          {
            path: "/repo/src/modules/stock/module.yaml",
            name: "stock",
            description: "Owns inventory reservation.",
            owners: [],
            publicApi: [],
            dependsOn: [],
            usedBy: [],
            testCommands: ["pnpm test stock"],
            rules: []
          }
        ],
        workflows: [
          {
            path: "/repo/src/workflows/checkout/flow.yaml",
            name: "checkout",
            description: "Checkout flow",
            steps: ["authorize payment"],
            touches: [],
            testCommands: ["pnpm test checkout"],
            risks: []
          }
        ]
      }
    })
  );

  assert.deepEqual(plan.context.moduleNames, ["stock"]);
  assert.deepEqual(plan.context.workflowNames, ["checkout"]);
  assert.deepEqual(plan.verificationCommands, ["pnpm test checkout", "pnpm test stock"]);
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

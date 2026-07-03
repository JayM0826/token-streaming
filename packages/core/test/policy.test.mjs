import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCommandPolicy, evaluatePatchPolicy, evaluateToolPolicy } from "../dist/index.js";

test("evaluateToolPolicy allows read tools", () => {
  assert.deepEqual(evaluateToolPolicy({ name: "repo.search", risk: "read" }), {
    target: "tool",
    action: "repo.search",
    allowed: true,
    severity: "low",
    reasons: [],
    requiresApproval: false
  });
});

test("evaluateToolPolicy blocks write and execute tools from direct execution", () => {
  const writeDecision = evaluateToolPolicy({ name: "patch.apply", risk: "write" });
  const executeDecision = evaluateToolPolicy({ name: "command.run", risk: "execute" });

  assert.equal(writeDecision.allowed, false);
  assert.equal(writeDecision.severity, "high");
  assert.equal(writeDecision.requiresApproval, true);
  assert.match(writeDecision.reasons[0], /runtime permission boundaries/);
  assert.equal(executeDecision.allowed, false);
  assert.equal(executeDecision.severity, "medium");
  assert.equal(executeDecision.requiresApproval, true);
});

test("evaluatePatchPolicy requires approval when patch content matches protected patterns", () => {
  const decision = evaluatePatchPolicy(
    {
      safety: {
        protected_patterns: ["OPENAI_API_KEY\\s*="]
      },
      playbooks: [],
      modules: [],
      workflows: [],
      generated: false
    },
    {
      summary: "Add accidental secret",
      files: [
        {
          path: "notes/config.md",
          content: "OPENAI_API_KEY=sk-test\n"
        }
      ]
    }
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.severity, "high");
  assert.equal(decision.requiresApproval, true);
  assert.match(decision.reasons[0], /protected pattern/);
});

test("evaluatePatchPolicy records approved protected patterns when explicitly allowed", () => {
  const decision = evaluatePatchPolicy(
    {
      safety: {
        protected_patterns: ["BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY"]
      },
      playbooks: [],
      modules: [],
      workflows: [],
      generated: false
    },
    {
      summary: "Add test fixture",
      files: [
        {
          path: "fixtures/key.txt",
          content: "-----BEGIN OPENSSH PRIVATE KEY-----\n"
        }
      ]
    },
    { allowSensitive: true }
  );

  assert.equal(decision.allowed, true);
  assert.equal(decision.severity, "high");
  assert.equal(decision.requiresApproval, true);
  assert.match(decision.reasons[0], /Protected pattern approved/);
});

test("evaluateCommandPolicy requires approval for configured command patterns", () => {
  const decision = evaluateCommandPolicy(
    {
      safety: {
        approval_required_commands: ["npm publish"]
      },
      playbooks: [],
      modules: [],
      workflows: [],
      generated: false
    },
    "npm publish --dry-run"
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.severity, "medium");
  assert.equal(decision.requiresApproval, true);
  assert.match(decision.reasons[0], /requires approval/);
});

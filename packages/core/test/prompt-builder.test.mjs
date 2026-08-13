import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntimePrompt } from "../dist/context/prompt-builder.js";

test("buildRuntimePrompt includes handoff discipline for summary tasks", () => {
  const prompt = buildRuntimePrompt(createPromptInput({ wantsPatch: false }));

  assert.match(prompt.system, /Respect the role handoffs/);
  assert.match(prompt.user, /Handoffs:/);
  assert.match(prompt.user, /orchestrator -> researcher: execution plan/);
  assert.match(prompt.user, /researcher -> final: repository context brief/);
});

test("buildRuntimePrompt includes handoff discipline for patch tasks", () => {
  const prompt = buildRuntimePrompt(createPromptInput({ wantsPatch: true }));

  assert.match(prompt.system, /research context informs coding/);
  assert.match(prompt.user, /coder -> tester: structured patch proposal/);
  assert.match(prompt.user, /Return only a fenced JSON patch proposal/);
});

function createPromptInput({ wantsPatch }) {
  const phases = wantsPatch
    ? [
        { id: "orchestrate", role: "orchestrator", title: "Create execution plan", description: "", required: true },
        { id: "research", role: "researcher", title: "Research repository context", description: "", required: true },
        { id: "code-change", role: "coder", title: "Prepare code change", description: "", required: true },
        { id: "tests", role: "tester", title: "Run verification", description: "", required: true }
      ]
    : [
        { id: "orchestrate", role: "orchestrator", title: "Create execution plan", description: "", required: true },
        { id: "research", role: "researcher", title: "Research repository context", description: "", required: true }
      ];

  return {
    task: wantsPatch ? "fix checkout bug" : "summarize repo",
    repo: {
      root: "/repo",
      packageManager: "pnpm",
      scripts: {},
      trackedFiles: [],
      sourceDirectories: [],
      moduleManifestPaths: [],
      workflowManifestPaths: [],
      aiManifestPresent: true
    },
    manifest: {
      playbooks: [],
      modules: [],
      workflows: [],
      generated: false
    },
    plan: {
      strategy: "default",
      mode: "auto",
      task: wantsPatch ? "fix checkout bug" : "summarize repo",
      riskLevel: "low",
      phases,
      requiredAgents: [...new Set(phases.map((phase) => phase.role))],
      handoffs: wantsPatch
        ? [
            { from: "orchestrator", to: "researcher", artifact: "execution plan", description: "" },
            { from: "researcher", to: "coder", artifact: "repository context brief", description: "" },
            { from: "coder", to: "tester", artifact: "structured patch proposal", description: "" },
            { from: "tester", artifact: "verification result", description: "" }
          ]
        : [
            { from: "orchestrator", to: "researcher", artifact: "execution plan", description: "" },
            { from: "researcher", artifact: "repository context brief", description: "" }
          ],
      testCommands: [],
      notes: []
    },
    context: {
      overview: renderOverview(
        wantsPatch
          ? [
              { from: "orchestrator", to: "researcher", artifact: "execution plan" },
              { from: "researcher", to: "coder", artifact: "repository context brief" },
              { from: "coder", to: "tester", artifact: "structured patch proposal" },
              { from: "tester", artifact: "verification result" }
            ]
          : [
              { from: "orchestrator", to: "researcher", artifact: "execution plan" },
              { from: "researcher", artifact: "repository context brief" }
            ]
      ),
      relevantModules: [],
      relevantWorkflows: [],
      sourceSnippets: [],
      testCommands: []
    }
  };
}

function renderOverview(handoffs) {
  return ["# Runtime Context", "", "## Plan", "Handoffs:", ...handoffs.map((handoff) => `- ${handoff.from} -> ${handoff.to ?? "final"}: ${handoff.artifact}`)].join("\n");
}

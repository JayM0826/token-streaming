import type { AgentHandoff, AgentRole, ExecutionPhase, ExecutionPlan, StrategyInput } from "@token-streaming/protocol";
import type { OrchestrationStrategy } from "./types.js";

export class DefaultStrategy implements OrchestrationStrategy {
  readonly id = "default";

  async createPlan(input: StrategyInput): Promise<ExecutionPlan> {
    const taskKind = classifyTask(input.task);
    const riskLevel = detectRisk(input);
    const phases = createPhases(taskKind, riskLevel);
    const requiredAgents = [...new Set(phases.map((phase) => phase.role))];

    return {
      strategy: this.id,
      mode: input.mode,
      task: input.task,
      riskLevel,
      phases,
      requiredAgents,
      handoffs: createHandoffs(phases),
      testCommands: selectTestCommands(input),
      notes: createNotes(input, taskKind, riskLevel)
    };
  }
}

type TaskKind = "question" | "understanding" | "change";

function classifyTask(task: string): TaskKind {
  const normalized = task.toLowerCase();
  if (/(implement|add|fix|change|modify|refactor|create|update|delete|rename|生成|实现|修复|修改|重构)/i.test(normalized)) {
    return "change";
  }
  if (/(explain|summarize|inspect|analyze|review|理解|分析|解释|总结)/i.test(normalized)) {
    return "understanding";
  }
  return "question";
}

function detectRisk(input: StrategyInput): ExecutionPlan["riskLevel"] {
  const task = input.task.toLowerCase();
  const sensitiveNames = input.manifest.modules
    .filter((module) => /auth|payment|billing|permission|security/i.test(module.name))
    .map((module) => module.name.toLowerCase());
  const safetyTerms = extractSafetyTerms(input.manifest.safety);

  if (/(auth|payment|billing|security|permission|delete|migration|prod|secret|token)/i.test(task)) {
    return "high";
  }

  if (sensitiveNames.some((name) => task.includes(name)) || safetyTerms.some((term) => task.includes(term))) {
    return "high";
  }

  const matchingWorkflow = input.manifest.workflows.find(
    (workflow) => task.includes(workflow.name.toLowerCase()) || workflow.touches.some((touch) => task.includes(touch.toLowerCase()))
  );
  if (matchingWorkflow) {
    const riskText = matchingWorkflow.risks.join(" ").toLowerCase();
    return /(auth|payment|billing|security|permission|delete|migration|prod|secret|token|irreversible|data loss|rollback)/i.test(riskText)
      ? "high"
      : "medium";
  }

  return "low";
}

function extractSafetyTerms(safety: Record<string, unknown> | undefined): string[] {
  const values = [...stringArrayFromRecord(safety, "sensitive_paths"), ...stringArrayFromRecord(safety, "requires_review")];
  return [
    ...new Set(
      values.flatMap((value) =>
        value
          .toLowerCase()
          .split(/[^a-z0-9_-]+/)
          .filter((term) => term.length > 3 && !["src", "packages", "apps", "files", "changes"].includes(term))
      )
    )
  ];
}

function createPhases(taskKind: TaskKind, riskLevel: ExecutionPlan["riskLevel"]): ExecutionPhase[] {
  const phases: ExecutionPhase[] = [
    {
      id: "research",
      role: "research",
      title: "Research repository context",
      description: "Load explicit metadata first, then inspect source and test boundaries.",
      required: taskKind !== "question"
    }
  ];

  if (taskKind === "change") {
    phases.push({
      id: "code-change",
      role: "coder",
      title: "Prepare code change",
      description: "Produce patchable edits through the patch engine boundary.",
      required: true
    });
    phases.push({
      id: "tests",
      role: "tester",
      title: "Run verification",
      description: "Run manifest-declared tests when available, otherwise use detected scripts.",
      required: true
    });
  }

  if (taskKind === "change" || riskLevel !== "low") {
    phases.push({
      id: "review",
      role: "reviewer",
      title: "Review resulting diff",
      description: "Review risk, module rules, workflow rules, and safety constraints.",
      required: riskLevel !== "low"
    });
  }

  phases.unshift({
    id: "orchestrate",
    role: "orchestrator",
    title: "Create execution plan",
    description: "Resolve strategy, product mode, manifest context, and required phases.",
    required: true
  });

  return phases;
}

function createHandoffs(phases: ExecutionPhase[]): AgentHandoff[] {
  return phases.map((phase, index) => {
    const nextPhase = phases[index + 1];
    return {
      from: phase.role,
      to: nextPhase?.role,
      artifact: artifactForPhase(phase),
      description: handoffDescription(phase, nextPhase)
    };
  });
}

function artifactForPhase(phase: ExecutionPhase): string {
  if (phase.id === "orchestrate") return "execution plan";
  if (phase.id === "research") return "repository context brief";
  if (phase.id === "code-change") return "structured patch proposal";
  if (phase.id === "tests") return "verification result";
  if (phase.id === "review") return "risk and diff review";
  return `${phase.title.toLowerCase()} artifact`;
}

function handoffDescription(phase: ExecutionPhase, nextPhase: ExecutionPhase | undefined): string {
  const target = nextPhase ? `${nextPhase.role} phase` : "final run summary";
  return `${phase.title} produces ${artifactForPhase(phase)} for the ${target}.`;
}

function selectTestCommands(input: StrategyInput): string[] {
  const taskText = input.task.toLowerCase();
  const workflowCommands = input.manifest.workflows
    .filter(
      (workflow) =>
        taskText.includes(workflow.name.toLowerCase()) || workflow.touches.some((touch) => taskText.includes(touch.toLowerCase()))
    )
    .flatMap((workflow) => workflow.testCommands);
  const moduleCommands = input.manifest.modules
    .filter((module) => taskText.includes(module.name.toLowerCase()))
    .flatMap((module) => module.testCommands);
  const targetedCommands = [...workflowCommands, ...moduleCommands];

  if (targetedCommands.length > 0) {
    return [...new Set(targetedCommands)];
  }

  const manifestDefaultCommands = stringArrayFromRecord(input.manifest.tests, "default");
  if (manifestDefaultCommands.length > 0) {
    return manifestDefaultCommands;
  }

  if (input.repo.verificationCommands?.length) {
    return input.repo.verificationCommands;
  }

  const scripts = input.repo.scripts;
  const candidates = ["test", "typecheck", "lint"].filter((script) => scripts[script]);
  return candidates.map((script) => `${input.repo.packageManager ?? "pnpm"} run ${script}`);
}

function createNotes(input: StrategyInput, taskKind: TaskKind, riskLevel: ExecutionPlan["riskLevel"]): string[] {
  return [
    `Classified task as ${taskKind}.`,
    `Risk level is ${riskLevel}.`,
    input.manifest.generated
      ? "Using generated fallback metadata because no root .ai manifest was found."
      : "Using repository-provided .ai metadata.",
    `Loaded ${input.manifest.modules.length} module manifests and ${input.manifest.workflows.length} workflow manifests.`
  ];
}

function stringArrayFromRecord(record: Record<string, unknown> | undefined, key: string): string[] {
  const value = record?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

import type { AgentHandoff, AgentRole, ExecutionPhase, ExecutionPlan, ExecutionPlanContext, StrategyInput } from "@token-streaming/protocol";
import { matchModuleToTask, matchWorkflowToTask } from "../context/manifest-relevance.js";
import { extractSearchTerms } from "../context/search-terms.js";
import type { OrchestrationStrategy } from "./types.js";

export class DefaultStrategy implements OrchestrationStrategy {
  readonly id = "default";

  async createPlan(input: StrategyInput): Promise<ExecutionPlan> {
    const taskKind = classifyTask(input.task);
    const riskLevel = detectRisk(input);
    const phases = createPhases(taskKind, riskLevel, input.mode);
    const requiredAgents = [...new Set(phases.filter((phase) => phase.required).map((phase) => phase.role))];
    const verificationCommands = selectVerificationCommands(input);

    return {
      strategy: this.id,
      mode: input.mode,
      task: input.task,
      risk: riskLevel,
      riskLevel,
      context: createPlanContext(input),
      phases,
      requiredAgents,
      handoffs: createHandoffs(phases),
      verificationCommands,
      testCommands: verificationCommands,
      notes: createNotes(input, taskKind, riskLevel)
    };
  }
}

function createPlanContext(input: StrategyInput): ExecutionPlanContext {
  const taskText = input.task.toLowerCase();
  const selectedModules = input.manifest.modules.filter((module) => matchModuleToTask(taskText, module));
  const selectedWorkflows = input.manifest.workflows.filter((workflow) => matchWorkflowToTask(taskText, workflow));
  const publicApiModules = selectedModules.length > 0 ? selectedModules : input.manifest.modules;
  const budget = contextBudget(input.mode);

  return {
    moduleNames: selectedModules.map((module) => module.name),
    workflowNames: selectedWorkflows.map((workflow) => workflow.name),
    publicApiPaths: [...new Set(publicApiModules.flatMap((module) => module.publicApi))],
    ...budget
  };
}

function contextBudget(mode: StrategyInput["mode"]): Pick<ExecutionPlanContext, "maxSourceFiles" | "maxSourceCharacters"> {
  if (mode === "economy") {
    return { maxSourceFiles: 3, maxSourceCharacters: 2_000 };
  }
  if (mode === "max") {
    return { maxSourceFiles: 8, maxSourceCharacters: 6_000 };
  }
  return { maxSourceFiles: 6, maxSourceCharacters: 4_000 };
}

type TaskKind = "question" | "understanding" | "change";

function classifyTask(task: string): TaskKind {
  const normalized = task.toLowerCase();
  if (/(implement|add|fix|change|modify|refactor|create|update|delete|rename|生成|实现|修复|修改|重构|新增|添加|创建|更新|删除|重命名)/i.test(normalized)) {
    return "change";
  }
  if (/(explain|summarize|inspect|analyze|review|理解|分析|解释|总结|检查|审查)/i.test(normalized)) {
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

  if (containsHighRiskTerms(task)) {
    return "high";
  }

  if (sensitiveNames.some((name) => task.includes(name)) || safetyTerms.some((term) => task.includes(term))) {
    return "high";
  }

  const matchingWorkflow = input.manifest.workflows.find((workflow) => matchWorkflowToTask(task, workflow));
  if (matchingWorkflow) {
    const riskText = matchingWorkflow.risks.join(" ").toLowerCase();
    return containsHighRiskTerms(riskText) ? "high" : "medium";
  }

  return "low";
}

function containsHighRiskTerms(value: string): boolean {
  return /(auth|payment|billing|security|permission|delete|migration|prod|secret|token|irreversible|data loss|rollback|认证|鉴权|支付|账单|安全|权限|删除|迁移|生产|密钥|秘密|令牌|不可逆|数据丢失|回滚)/i.test(value);
}

function extractSafetyTerms(safety: Record<string, unknown> | undefined): string[] {
  const values = [...stringArrayFromRecord(safety, "sensitive_paths"), ...stringArrayFromRecord(safety, "requires_review")];
  return [...new Set(values.flatMap(extractSearchTerms))];
}

function createPhases(
  taskKind: TaskKind,
  riskLevel: ExecutionPlan["riskLevel"],
  mode: StrategyInput["mode"]
): ExecutionPhase[] {
  const phases: ExecutionPhase[] = [
    {
      id: "research",
      role: "researcher",
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

  if (taskKind === "change" || riskLevel !== "low" || mode === "max") {
    phases.push({
      id: "review",
      role: "reviewer",
      title: "Review resulting diff",
      description: "Review risk, module rules, workflow rules, and safety constraints.",
      required: riskLevel !== "low" || mode === "max"
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

function selectVerificationCommands(input: StrategyInput): string[] {
  const taskText = input.task.toLowerCase();
  const workflowCommands = input.manifest.workflows
    .filter((workflow) => matchWorkflowToTask(taskText, workflow))
    .flatMap((workflow) => workflow.testCommands);
  const moduleCommands = input.manifest.modules
    .filter((module) => matchModuleToTask(taskText, module))
    .flatMap((module) => module.testCommands);
  const targetedCommands = [...workflowCommands, ...moduleCommands];

  let commands: string[];
  if (targetedCommands.length > 0) {
    commands = [...new Set(targetedCommands)];
  } else {
    const manifestDefaultCommands = stringArrayFromRecord(input.manifest.tests, "default");
    if (manifestDefaultCommands.length > 0) {
      commands = manifestDefaultCommands;
    } else if (input.repo.verificationCommands?.length) {
      commands = input.repo.verificationCommands;
    } else {
      const scripts = input.repo.scripts;
      const candidates = ["test", "typecheck", "lint"].filter(
        (script) => scripts[script] && !(script === "test" && isPlaceholderTestScript(scripts[script] ?? ""))
      );
      commands = candidates.map((script) => `${input.repo.packageManager ?? "pnpm"} run ${script}`);
    }
  }

  return input.mode === "economy" ? commands.slice(0, 1) : commands;
}

function isPlaceholderTestScript(command: string): boolean {
  const normalized = command.toLowerCase().replace(/\s+/g, " ");
  return normalized.includes("no test specified") || normalized.includes("no tests specified") || normalized.includes("no test configured");
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

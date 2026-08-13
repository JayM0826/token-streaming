import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModuleManifest, RepoManifest, WorkflowManifest } from "@token-streaming/protocol";
import { listManifestCommandGroups } from "./commands.js";

export type ManifestValidationSeverity = "error" | "warning";

export interface ManifestValidationIssue {
  severity: ManifestValidationSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface ManifestValidationResult {
  ok: boolean;
  issues: ManifestValidationIssue[];
}

export async function validateRepoManifest(repoRoot: string, manifest: RepoManifest): Promise<ManifestValidationResult> {
  const issues: ManifestValidationIssue[] = [];

  validateRootManifest(manifest, issues);
  await validateModules(repoRoot, manifest.modules, issues);
  validateWorkflows(manifest.workflows, issues);
  validatePlaybooks(manifest, issues);

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues
  };
}

function validateRootManifest(manifest: RepoManifest, issues: ManifestValidationIssue[]): void {
  const missingSeverity: ManifestValidationSeverity = manifest.generated ? "warning" : "error";
  if (manifest.generated) {
    issues.push({
      severity: "warning",
      code: "manifest.generated",
      message: "Using generated fallback metadata; run manifest init for a first-class .ai manifest."
    });
  }

  for (const [field, file] of [
    ["project", ".ai/project.md"],
    ["architecture", ".ai/architecture.md"],
    ["conventions", ".ai/conventions.md"]
  ] as const) {
    if (!hasText(manifest[field])) {
      issues.push({
        severity: missingSeverity,
        code: `root.${field}.missing`,
        message: `Missing required root manifest content in ${file}.`,
        path: file
      });
    }
  }

  if (listManifestCommandGroups(manifest).length === 0) {
    issues.push({
      severity: missingSeverity,
      code: "commands.empty",
      message: "No executable command catalog found in .ai/commands.yaml.",
      path: ".ai/commands.yaml"
    });
  }

  const defaultTests = stringArray(manifest.tests?.default);
  if (defaultTests.length === 0) {
    issues.push({
      severity: missingSeverity,
      code: "tests.default.missing",
      message: "Missing default verification commands in .ai/tests.yaml.",
      path: ".ai/tests.yaml"
    });
  }

  if (!manifest.ownership || Object.keys(manifest.ownership).length === 0) {
    issues.push({
      severity: "warning",
      code: "ownership.missing",
      message: "Missing .ai/ownership.yaml; agents cannot map code areas to default owners or review boundaries.",
      path: ".ai/ownership.yaml"
    });
  }

  validateModelsPolicy(manifest.models, issues);
}

function validateModelsPolicy(models: Record<string, unknown> | undefined, issues: ManifestValidationIssue[]): void {
  if (!models || Object.keys(models).length === 0) {
    issues.push({
      severity: "warning",
      code: "models.missing",
      message: "Missing .ai/models.yaml; model routing will rely on provider defaults.",
      path: ".ai/models.yaml"
    });
    return;
  }

  const provider = models.default_provider;
  if (provider !== undefined && provider !== "auto" && provider !== "openai" && provider !== "stub") {
    issues.push({
      severity: "error",
      code: "models.default_provider.invalid",
      message: "default_provider must be one of: auto, openai, stub.",
      path: ".ai/models.yaml"
    });
  }

  for (const key of ["economy_model", "auto_model", "max_model", "default_model"]) {
    if (models[key] !== undefined && !hasText(models[key])) {
      issues.push({
        severity: "error",
        code: `models.${key}.invalid`,
        message: `${key} must be a non-empty string when present.`,
        path: ".ai/models.yaml"
      });
    }
  }

  const candidates = models.model_candidates;
  if (candidates === undefined) {
    return;
  }

  if (!Array.isArray(candidates)) {
    issues.push({
      severity: "error",
      code: "models.model_candidates.invalid",
      message: "model_candidates must be a list of candidate specs.",
      path: ".ai/models.yaml"
    });
    return;
  }

  for (const candidate of candidates) {
    if (!hasText(candidate)) {
      issues.push({
        severity: "error",
        code: "models.model_candidate.invalid",
        message: "Each model candidate must be a non-empty string.",
        path: ".ai/models.yaml"
      });
      continue;
    }
    validateModelCandidate(candidate, issues);
  }
}

function validateModelCandidate(candidate: string, issues: ManifestValidationIssue[]): void {
  const [model, ...parts] = candidate.split(";").map((part) => part.trim()).filter(Boolean);
  if (!model) {
    issues.push({
      severity: "error",
      code: "models.model_candidate.model.missing",
      message: `Model candidate is missing a model name: ${candidate}`,
      path: ".ai/models.yaml"
    });
    return;
  }

  const allowedFields = new Set(["provider", "quality", "cost", "latency", "tags"]);
  const fields = new Map<string, string>();
  for (const part of parts) {
    const [key, ...rawValue] = part.split("=");
    const normalizedKey = key?.trim();
    const value = rawValue.join("=").trim();
    if (!normalizedKey || !value) {
      issues.push({
        severity: "error",
        code: "models.model_candidate.field.invalid",
        message: `Candidate "${model}" has an invalid field segment: ${part}`,
        path: ".ai/models.yaml"
      });
      continue;
    }
    if (!allowedFields.has(normalizedKey)) {
      issues.push({
        severity: "warning",
        code: "models.model_candidate.field.unknown",
        message: `Candidate "${model}" has an unknown field: ${normalizedKey}`,
        path: ".ai/models.yaml"
      });
    }
    fields.set(normalizedKey, value);
  }

  const provider = fields.get("provider");
  if (provider !== undefined && provider !== "auto" && provider !== "openai" && provider !== "stub") {
    issues.push({
      severity: "error",
      code: "models.model_candidate.provider.invalid",
      message: `Candidate "${model}" provider must be one of: auto, openai, stub.`,
      path: ".ai/models.yaml"
    });
  }

  for (const metric of ["quality", "cost", "latency"]) {
    const value = fields.get(metric);
    if (value === undefined) {
      issues.push({
        severity: "warning",
        code: `models.model_candidate.${metric}.missing`,
        message: `Candidate "${model}" is missing ${metric}; router will use a fallback value.`,
        path: ".ai/models.yaml"
      });
      continue;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      issues.push({
        severity: "error",
        code: `models.model_candidate.${metric}.invalid`,
        message: `Candidate "${model}" ${metric} must be a number between 0 and 1.`,
        path: ".ai/models.yaml"
      });
    }
  }
}

async function validateModules(repoRoot: string, modules: ModuleManifest[], issues: ManifestValidationIssue[]): Promise<void> {
  if (modules.length === 0) {
    issues.push({
      severity: "warning",
      code: "modules.empty",
      message: "No module.yaml files were discovered; agents will rely on broader repository scanning."
    });
    return;
  }

  for (const module of modules) {
    if (!hasText(module.name)) {
      issues.push(issueForModule(module, "module.name.missing", "Module manifest is missing a name."));
    }
    if (!hasText(module.description)) {
      issues.push(issueForModule(module, "module.description.missing", `Module "${module.name}" is missing a description.`));
    }
    if (module.publicApi.length === 0) {
      issues.push(issueForModule(module, "module.public_api.missing", `Module "${module.name}" has no public_api entries.`));
    }
    if (module.testCommands.length === 0) {
      issues.push(issueForModule(module, "module.test_commands.missing", `Module "${module.name}" has no test_commands entries.`));
    }

    for (const apiPath of module.publicApi) {
      if (!(await exists(path.join(repoRoot, apiPath)))) {
        issues.push(issueForModule(module, "module.public_api.not_found", `Public API path does not exist: ${apiPath}.`));
      }
    }
  }
}

function validateWorkflows(workflows: WorkflowManifest[], issues: ManifestValidationIssue[]): void {
  for (const workflow of workflows) {
    if (!hasText(workflow.description)) {
      issues.push(issueForWorkflow(workflow, "workflow.description.missing", `Workflow "${workflow.name}" is missing a description.`));
    }
    if (workflow.steps.length === 0) {
      issues.push(issueForWorkflow(workflow, "workflow.steps.missing", `Workflow "${workflow.name}" has no steps.`));
    }
    if (workflow.touches.length === 0) {
      issues.push(issueForWorkflow(workflow, "workflow.touches.missing", `Workflow "${workflow.name}" has no touches entries.`));
    }
    if (workflow.testCommands.length === 0) {
      issues.push(issueForWorkflow(workflow, "workflow.test_commands.missing", `Workflow "${workflow.name}" has no test_commands entries.`));
    }
    if (workflow.risks.length === 0) {
      issues.push(issueForWorkflow(workflow, "workflow.risks.missing", `Workflow "${workflow.name}" has no risks entries.`));
    }
  }
}

function validatePlaybooks(manifest: RepoManifest, issues: ManifestValidationIssue[]): void {
  if (manifest.playbooks.length === 0) {
    issues.push({
      severity: "warning",
      code: "playbooks.empty",
      message: "No playbooks found in .ai/playbooks/."
    });
    return;
  }

  for (const playbook of manifest.playbooks) {
    if (!playbook.content.split(/\r?\n/).some((line) => line.trim().startsWith("# "))) {
      issues.push({
        severity: "warning",
        code: "playbook.title.missing",
        message: `Playbook "${playbook.name}" has no top-level markdown title.`,
        path: playbook.path
      });
    }
  }
}

function issueForModule(module: ModuleManifest, code: string, message: string): ManifestValidationIssue {
  return {
    severity: module.generated ? "warning" : "error",
    code,
    message,
    path: module.path
  };
}

function issueForWorkflow(workflow: WorkflowManifest, code: string, message: string): ManifestValidationIssue {
  return {
    severity: "warning",
    code,
    message,
    path: workflow.path
  };
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

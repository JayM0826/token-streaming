import path from "node:path";
import type { ExecutionPlan, RepoManifest, RepoSummary } from "@token-streaming/protocol";
import { readTextFile } from "@token-streaming/tools";
import { matchModuleToTask, matchWorkflowToTask } from "./manifest-relevance.js";
import { taskTextIncludesSearchTerms } from "./search-terms.js";

export interface RuntimeContextBundle {
  overview: string;
  relevantModules: string[];
  relevantWorkflows: string[];
  selectionReasons: ContextSelectionReason[];
  sourceSnippets: SourceSnippet[];
  testCommands: string[];
  recentHistory: RecentHistoryItem[];
}

export interface ContextSelectionReason {
  kind: "module" | "workflow" | "source";
  target: string;
  reason: string;
}

export interface SourceSnippet {
  path: string;
  content: string;
  truncated: boolean;
}

export interface RecentHistoryItem {
  sessionId: string;
  status: "completed" | "failed" | "running";
  task?: string;
  summary?: string;
  error?: string;
  failureCategory?: string;
  toolResults: RecentToolResult[];
}

export interface RecentToolResult {
  toolName: string;
  ok: boolean;
  summary: string;
}

export interface RuntimeContextOptions {
  recentHistory?: RecentHistoryItem[];
}

const DEFAULT_MAX_SOURCE_SNIPPETS = 6;
const DEFAULT_MAX_SNIPPET_CHARS = 4_000;

export async function buildRuntimeContext(
  task: string,
  repo: RepoSummary,
  manifest: RepoManifest,
  plan: ExecutionPlan,
  options: RuntimeContextOptions = {}
): Promise<RuntimeContextBundle> {
  const taskText = task.toLowerCase();
  const moduleSelection = mergePlannedSelections(selectRelevantModules(taskText, manifest), plan.context?.moduleNames ?? [], "module");
  const workflowSelection = mergePlannedSelections(
    selectRelevantWorkflows(taskText, manifest),
    plan.context?.workflowNames ?? [],
    "workflow"
  );
  const relevantModules = moduleSelection.map((selection) => selection.target);
  const relevantWorkflows = workflowSelection.map((selection) => selection.target);
  const sourceSelection = selectSourceCandidates(
    taskText,
    repo,
    manifest,
    relevantModules,
    relevantWorkflows,
    plan.context?.publicApiPaths ?? []
  );
  const maxSourceFiles = boundedBudget(plan.context?.maxSourceFiles, DEFAULT_MAX_SOURCE_SNIPPETS, 12);
  const maxSourceCharacters = boundedBudget(plan.context?.maxSourceCharacters, DEFAULT_MAX_SNIPPET_CHARS, 8_000);
  const sourceSnippets = await loadSourceSnippets(
    repo,
    sourceSelection.candidates,
    maxSourceFiles,
    maxSourceCharacters
  );
  const loadedSnippetPaths = new Set(sourceSnippets.map((snippet) => snippet.path));
  const sourceReasons = sourceSelection.reasons.filter((reason) => loadedSnippetPaths.has(reason.target));
  const selectionReasons = [...moduleSelection, ...workflowSelection, ...sourceReasons];

  return {
    overview: renderOverview(repo, manifest, plan, relevantModules, relevantWorkflows, selectionReasons, sourceSnippets, options.recentHistory ?? []),
    relevantModules,
    relevantWorkflows,
    selectionReasons,
    sourceSnippets,
    testCommands: plan.verificationCommands ?? plan.testCommands ?? [],
    recentHistory: options.recentHistory ?? []
  };
}

function renderOverview(
  repo: RepoSummary,
  manifest: RepoManifest,
  plan: ExecutionPlan,
  relevantModules: string[],
  relevantWorkflows: string[],
  selectionReasons: ContextSelectionReason[],
  sourceSnippets: SourceSnippet[],
  recentHistory: RecentHistoryItem[]
): string {
  const lines = [
    "# Runtime Context",
    "",
    "## Repository",
    `Root: ${repo.root}`,
    `Package manager: ${repo.packageManager ?? "unknown"}`,
    `Source directories: ${repo.sourceDirectories.join(", ") || "none detected"}`,
    `Manifest source: ${manifest.generated ? ".ai/generated" : ".ai"}`,
    "",
    "## Project",
    trimTo(manifest.project ?? "No project manifest provided.", 1_200),
    "",
    "## Architecture",
    trimTo(manifest.architecture ?? "No architecture manifest provided.", 1_200),
    "",
    "## Conventions",
    trimTo(manifest.conventions ?? "No conventions manifest provided.", 1_000),
    "",
    "## Ownership",
    renderYamlRecord(manifest.ownership, "No ownership manifest provided."),
    "",
    "## Modules",
    ...manifest.modules.map((module) =>
      [
        `- ${module.name}: ${module.description ?? "No description."}`,
        module.publicApi.length ? `  public_api: ${module.publicApi.join(", ")}` : undefined,
        module.dependsOn.length ? `  depends_on: ${module.dependsOn.join(", ")}` : undefined,
        module.rules.length ? `  rules: ${module.rules.join(" | ")}` : undefined
      ]
        .filter(Boolean)
        .join("\n")
    ),
    "",
    "## Workflows",
    ...(manifest.workflows.length
      ? manifest.workflows.map((workflow) =>
          [
            `- ${workflow.name}: ${workflow.description ?? (workflow.steps.join(" -> ") || "No description.")}`,
            workflow.steps.length ? `  steps: ${workflow.steps.join(" -> ")}` : undefined,
            workflow.touches.length ? `  touches: ${workflow.touches.join(", ")}` : undefined,
            workflow.risks.length ? `  risks: ${workflow.risks.join(" | ")}` : undefined
          ]
            .filter(Boolean)
            .join("\n")
        )
      : ["- none"]),
    "",
    "## Plan",
    `Risk: ${plan.risk ?? plan.riskLevel}`,
    `Phases: ${plan.phases.map((phase) => phase.id).join(", ")}`,
    "Handoffs:",
    ...(plan.handoffs.length
      ? plan.handoffs.map((handoff) => `- ${handoff.from} -> ${handoff.to ?? "final"}: ${handoff.artifact}`)
      : ["- none"]),
    `Relevant modules: ${relevantModules.join(", ") || "none inferred"}`,
    `Relevant workflows: ${relevantWorkflows.join(", ") || "none inferred"}`,
    `Test commands: ${(plan.verificationCommands ?? plan.testCommands ?? []).join(", ") || "none"}`,
    "",
    "## Selection Reasons",
    ...(selectionReasons.length ? selectionReasons.map((reason) => `- ${reason.kind}:${reason.target}: ${reason.reason}`) : ["- none"]),
    "",
    "## Recent History",
    ...renderRecentHistory(recentHistory),
    "",
    "## Source Snippets",
    ...(sourceSnippets.length
      ? sourceSnippets.map((snippet) =>
          [
            `### ${snippet.path}${snippet.truncated ? " (truncated)" : ""}`,
            "```text",
            snippet.content,
            "```"
          ].join("\n")
        )
      : ["No source snippets selected."])
  ];

  return lines.join("\n");
}

function renderRecentHistory(history: RecentHistoryItem[]): string[] {
  if (history.length === 0) {
    return ["- none"];
  }

  return history.map((item) =>
    [
      `- ${item.sessionId}: ${item.status}${item.failureCategory ? ` (${item.failureCategory})` : ""}`,
      item.task ? `  task: ${item.task}` : undefined,
      item.summary ? `  summary: ${item.summary}` : undefined,
      item.error ? `  error: ${item.error}` : undefined,
      item.toolResults.length
        ? `  tools: ${item.toolResults.map((tool) => `${tool.toolName}:${tool.ok ? "ok" : "failed"}:${tool.summary}`).join(" | ")}`
        : undefined
    ]
      .filter(Boolean)
      .join("\n")
  );
}

async function loadSourceSnippets(
  repo: RepoSummary,
  candidates: string[],
  maxSourceFiles: number,
  maxSourceCharacters: number
): Promise<SourceSnippet[]> {
  const snippets: SourceSnippet[] = [];

  for (const candidate of candidates) {
    if (snippets.length >= maxSourceFiles) {
      break;
    }

    try {
      const content = await readTextFile(repo.root, candidate);
      snippets.push({
        path: candidate,
        content: trimTo(content, maxSourceCharacters),
        truncated: content.trim().length > maxSourceCharacters
      });
    } catch {
      // Candidate selection is best-effort; missing or binary-looking files should not stop planning.
    }
  }

  return snippets;
}

function selectRelevantModules(taskText: string, manifest: RepoManifest): ContextSelectionReason[] {
  const selections: ContextSelectionReason[] = [];
  for (const module of manifest.modules) {
    const match = matchModuleToTask(taskText, module);
    if (match) {
      selections.push({
        kind: "module",
        target: module.name,
        reason:
          match.field === "name"
            ? `Task text mentions module name "${module.name}".`
            : `Task text overlaps module ${match.field} "${match.value}".`
      });
    }
  }
  return selections;
}

function selectRelevantWorkflows(taskText: string, manifest: RepoManifest): ContextSelectionReason[] {
  const selections: ContextSelectionReason[] = [];
  for (const workflow of manifest.workflows) {
    const match = matchWorkflowToTask(taskText, workflow);
    if (match) {
      selections.push({
        kind: "workflow",
        target: workflow.name,
        reason:
          match.field === "name"
            ? `Task text mentions workflow name "${workflow.name}".`
            : `Task text overlaps workflow ${match.field} "${match.value}".`
      });
    }
  }
  return selections;
}

function selectSourceCandidates(
  taskText: string,
  repo: RepoSummary,
  manifest: RepoManifest,
  relevantModules: string[],
  relevantWorkflows: string[],
  plannedPublicApiPaths: string[]
): { candidates: string[]; reasons: ContextSelectionReason[] } {
  const candidates = new Set<string>();
  const reasons = new Map<string, ContextSelectionReason>();
  const relevantModuleSet = new Set(relevantModules);
  const relevantWorkflowSet = new Set(relevantWorkflows);

  for (const apiPath of plannedPublicApiPaths) {
    const normalized = normalizeRepoPath(apiPath);
    candidates.add(normalized);
    reasons.set(normalized, {
      kind: "source",
      target: normalized,
      reason: "Execution plan selected this declared public API file."
    });
  }

  for (const module of manifest.modules) {
    if (relevantModuleSet.has(module.name) || relevantModuleSet.size === 0) {
      for (const apiPath of module.publicApi) {
        candidates.add(apiPath);
        reasons.set(apiPath, {
          kind: "source",
          target: apiPath,
          reason: relevantModuleSet.has(module.name)
            ? `Module "${module.name}" was selected, and this file is declared in public_api.`
            : `No module was specifically inferred, so public_api from module "${module.name}" was included.`
        });
      }
      for (const neighbor of ["README.md", "index.ts", "api.ts"]) {
        const candidate = toRelativeManifestNeighbor(repo.root, module.path, neighbor);
        candidates.add(candidate);
        reasons.set(candidate, {
          kind: "source",
          target: candidate,
          reason: `Neighbor file near module manifest "${module.name}" helps explain module boundaries.`
        });
      }
    }
  }

  for (const workflow of manifest.workflows) {
    if (relevantWorkflowSet.has(workflow.name)) {
      for (const neighbor of ["README.md", `${workflow.name}.service.ts`]) {
        const candidate = toRelativeManifestNeighbor(repo.root, workflow.path, neighbor);
        candidates.add(candidate);
        reasons.set(candidate, {
          kind: "source",
          target: candidate,
          reason: `Workflow "${workflow.name}" was selected, so nearby workflow source was included.`
        });
      }
    }
  }

  for (const file of repo.trackedFiles) {
    const normalizedFile = normalizeRepoPath(file);
    if (!isReadableSourceFile(normalizedFile)) {
      continue;
    }

    if (taskTextIncludesSearchTerms(taskText, normalizedFile)) {
      candidates.add(normalizedFile);
      reasons.set(normalizedFile, {
        kind: "source",
        target: normalizedFile,
        reason: "Task text overlaps searchable words from this file path."
      });
    }
  }

  const normalizedCandidates = [...candidates].map(normalizeRepoPath).filter(isReadableSourceFile);
  return {
    candidates: normalizedCandidates,
    reasons: normalizedCandidates
      .map((candidate) => reasons.get(candidate))
      .filter((reason): reason is ContextSelectionReason => reason !== undefined)
  };
}

function mergePlannedSelections(
  inferred: ContextSelectionReason[],
  plannedTargets: string[],
  kind: "module" | "workflow"
): ContextSelectionReason[] {
  const selections = new Map(inferred.map((selection) => [selection.target, selection]));
  for (const target of plannedTargets) {
    if (!selections.has(target)) {
      selections.set(target, {
        kind,
        target,
        reason: "Execution strategy selected this context boundary."
      });
    }
  }
  return [...selections.values()];
}

function boundedBudget(value: number | undefined, fallback: number, upperBound: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), upperBound);
}

function toRelativeManifestNeighbor(repoRoot: string, manifestPath: string, fileName: string): string {
  const normalized = manifestPath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index === -1) {
    return fileName;
  }
  const absoluteCandidate = `${normalized.slice(0, index)}/${fileName}`;
  return path.relative(repoRoot, absoluteCandidate).replace(/\\/g, "/");
}

function isReadableSourceFile(file: string): boolean {
  const normalized = normalizeRepoPath(file);
  if (normalized.includes("node_modules/") || normalized.includes("dist/") || normalized.includes(".token-streaming/")) {
    return false;
  }

  return /\.(ts|tsx|js|jsx|mjs|cjs|py|json|md|yaml|yml|txt)$/.test(normalized);
}

function normalizeRepoPath(file: string): string {
  return file.replace(/\\/g, "/");
}

function trimTo(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const marker = "\n... truncated ...";
  if (maxLength <= marker.length) {
    return marker.slice(0, maxLength);
  }
  return `${normalized.slice(0, maxLength - marker.length)}${marker}`;
}

function renderYamlRecord(value: Record<string, unknown> | undefined, fallback: string): string {
  if (!value || Object.keys(value).length === 0) {
    return fallback;
  }

  return Object.entries(value)
    .map(([key, entry]) => {
      if (Array.isArray(entry)) {
        return [`${key}:`, ...entry.map((item) => `- ${String(item)}`)].join("\n");
      }
      return `${key}: ${String(entry ?? "")}`;
    })
    .join("\n");
}

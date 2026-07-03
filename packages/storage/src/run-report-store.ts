import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ApprovalResponse,
  AgentRole,
  ExecutionPlan,
  ModelCallRecord,
  PermissionDecision,
  RepoManifest,
  RepoSummary,
  ReviewSummary,
  Session,
  VerificationResult
} from "@token-streaming/protocol";
import { classifyFailure, type FailureCategory } from "./failure-category.js";

export interface RunReportInput {
  session: Session;
  repo: RepoSummary;
  manifest: RepoManifest;
  plan: ExecutionPlan;
  context?: {
    relevantModules: string[];
    relevantWorkflows: string[];
    sourceSnippets?: Array<{ path: string }>;
    testCommands: string[];
  };
  summary: string;
  eventLogPath: string;
  verificationResults?: VerificationResult[];
  permissionDecisions?: PermissionDecision[];
  approvalResponses?: ApprovalResponse[];
  agentRuns?: AgentRunSummary[];
  modelCalls?: ModelCallRecord[];
  toolCalls?: ToolCallSummary[];
  review?: ReviewSummary;
  changes?: ChangeSummary;
}

export interface AgentRunSummary {
  role: AgentRole;
  phaseId: string;
  artifact: string;
  ok: boolean;
  summary: string;
}

export interface ToolCallSummary {
  name: string;
  ok: boolean;
  inputSummary?: string;
  outputSummary?: string;
}

export interface ChangeSummary {
  patchProposalFiles: string[];
  repairProposalFiles: string[];
  appliedFiles: string[];
  checkpointId?: string;
  gitStatus?: string;
  gitDiff?: string;
}

export interface RunReportSummary {
  sessionId: string;
  status: "completed" | "failed" | "unknown";
  failureCategory?: FailureCategory;
  title: string;
  createdAt?: string;
  sizeBytes: number;
  path: string;
}

export class RunReportStore {
  constructor(private readonly repoRoot: string) {}

  async write(input: RunReportInput): Promise<string> {
    const filePath = this.getReportPath(input.session.id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, renderReport(input), "utf8");
    return filePath;
  }

  async list(): Promise<RunReportSummary[]> {
    const directory = this.getReportsDirectory();
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const reports = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".md"))
        .map(async (entry) => {
          const filePath = path.join(directory, entry);
          const content = await fs.readFile(filePath, "utf8");
          const stats = await fs.stat(filePath);
          return summarizeReport(entry.slice(0, -".md".length), filePath, content, stats.size);
        })
    );

    return reports.sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  }

  async read(sessionId: string): Promise<string> {
    return fs.readFile(this.getReportPath(sessionId), "utf8");
  }

  getReportPath(sessionId: string): string {
    return path.join(this.getReportsDirectory(), `${sessionId}.md`);
  }

  private getReportsDirectory(): string {
    return path.join(this.repoRoot, ".token-streaming", "reports");
  }
}

function summarizeReport(sessionId: string, filePath: string, content: string, sizeBytes: number): RunReportSummary {
  return {
    sessionId,
    status: readReportStatus(content),
    failureCategory: readReportFailureCategory(content),
    title: content.split(/\r?\n/).find((line) => line.startsWith("# "))?.replace(/^#\s+/, "") ?? sessionId,
    createdAt: readLineValue(content, "Started"),
    sizeBytes,
    path: filePath
  };
}

function readReportFailureCategory(content: string): FailureCategory | undefined {
  const failure = content
    .split(/\r?\n/)
    .find((line) => line.startsWith("Run failed: "))
    ?.slice("Run failed: ".length);
  return failure ? classifyFailure(failure) : undefined;
}

function readReportStatus(content: string): RunReportSummary["status"] {
  if (/^Run failed:/m.test(content)) {
    return "failed";
  }
  if (/^## Summary\s*$/m.test(content)) {
    return "completed";
  }
  return "unknown";
}

function readLineValue(content: string, key: string): string | undefined {
  const prefix = `${key}: `;
  return content
    .split(/\r?\n/)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length);
}

function renderReport(input: RunReportInput): string {
  return [
    `# Token Streaming Run ${input.session.id}`,
    "",
    `Started: ${input.session.startedAt}`,
    `Mode: ${input.session.mode}`,
    `Strategy: ${input.session.strategy}`,
    `Repository: ${input.repo.root}`,
    `Event log: ${input.eventLogPath}`,
    "",
    "## Plan",
    "",
    `Risk: ${input.plan.riskLevel}`,
    `Agents: ${input.plan.requiredAgents.join(", ") || "none"}`,
    "",
    ...input.plan.phases.map((phase) => `- ${phase.id}: ${phase.title}`),
    "",
    "## Agent Handoffs",
    "",
    ...(input.plan.handoffs.length ? input.plan.handoffs.map(renderHandoff) : ["- none"]),
    "",
    "## Agent Runs",
    "",
    ...(input.agentRuns?.length ? input.agentRuns.map(renderAgentRun) : ["- not enabled"]),
    "",
    "## Manifest",
    "",
    `Source: ${input.manifest.generated ? ".ai/generated" : ".ai"}`,
    `Modules: ${input.manifest.modules.length}`,
    `Workflows: ${input.manifest.workflows.length}`,
    `Playbooks: ${input.manifest.playbooks.length}`,
    "",
    "## Context",
    "",
    `Relevant modules: ${input.context?.relevantModules.join(", ") || "none inferred"}`,
    `Relevant workflows: ${input.context?.relevantWorkflows.join(", ") || "none inferred"}`,
    `Source snippets: ${input.context?.sourceSnippets?.map((snippet) => snippet.path).join(", ") || "none"}`,
    `Test commands: ${input.context?.testCommands.join(", ") || "none"}`,
    "",
    "## Model Calls",
    "",
    ...(input.modelCalls?.length ? input.modelCalls.map(renderModelCall) : ["- no model calls recorded"]),
    "",
    "## Tools",
    "",
    ...(input.toolCalls?.length ? input.toolCalls.map(renderToolCall) : ["- no tool calls recorded"]),
    "",
    "## Changes",
    "",
    ...renderChanges(input.changes),
    "",
    "## Verification",
    "",
    ...(input.verificationResults?.length
      ? input.verificationResults.map((result) => `- ${result.command}: ${result.ok ? "ok" : "failed"} (${result.exitCode ?? "unknown"})`)
      : ["- not run"]),
    "",
    "## Review",
    "",
    ...renderReview(input.review),
    "",
    "## Permissions",
    "",
    ...(input.permissionDecisions?.length
      ? input.permissionDecisions.map((decision) =>
          `- ${decision.target} ${decision.allowed ? "allowed" : "blocked"} (${decision.severity}): ${decision.action}${
            decision.reasons.length ? `; ${decision.reasons.join("; ")}` : ""
          }`
        )
      : ["- no checks run"]),
    "",
    "## Approvals",
    "",
    ...(input.approvalResponses?.length
      ? input.approvalResponses.map((response) => `- ${response.requestId}: ${response.approved ? "approved" : "rejected"} (${response.mode})`)
      : ["- no approvals requested"]),
    "",
    "## Summary",
    "",
    input.summary
  ].join("\n");
}

function renderReview(review: ReviewSummary | undefined): string[] {
  if (!review) {
    return ["- no review recorded"];
  }

  return [
    `Risk: ${review.riskLevel}`,
    `Verification: ${review.verificationStatus}`,
    `Repository changes: ${review.hasRepositoryChanges ? "yes" : "no"}`,
    `Applied files: ${review.appliedFiles.length ? review.appliedFiles.join(", ") : "none"}`,
    `Permission checks: ${review.permissionChecks}`,
    `Approvals: ${review.approvals}`,
    "Findings:",
    ...review.findings.map((finding) => `- ${finding}`),
    `Recommendation: ${review.recommendation}`
  ];
}

function renderHandoff(handoff: ExecutionPlan["handoffs"][number]): string {
  return `- ${handoff.from}${handoff.to ? ` -> ${handoff.to}` : " -> final"}: ${handoff.artifact}; ${handoff.description}`;
}

function renderAgentRun(run: AgentRunSummary): string {
  return `- ${run.role}/${run.phaseId}: ${run.ok ? "ok" : "failed"}; artifact=${run.artifact}; ${summarizeReportText(run.summary)}`;
}

function renderModelCall(call: ModelCallRecord): string {
  const tokens = [
    call.inputTokens !== undefined ? `input=${call.inputTokens}` : undefined,
    call.outputTokens !== undefined ? `output=${call.outputTokens}` : undefined
  ]
    .filter(Boolean)
    .join(", ");
  return `- ${call.purpose}: ${call.provider}${call.model ? `/${call.model}` : ""} ${call.mode} reasoning=${
    call.reasoningEffort ?? "default"
  } chars=${call.responseCharacters}${tokens ? ` tokens(${tokens})` : ""}`;
}

function renderToolCall(call: ToolCallSummary): string {
  const details = [call.inputSummary ? `input=${call.inputSummary}` : undefined, call.outputSummary ? `output=${call.outputSummary}` : undefined]
    .filter(Boolean)
    .join("; ");
  return `- ${call.name}: ${call.ok ? "ok" : "failed"}${details ? ` (${details})` : ""}`;
}

function renderChanges(changes: ChangeSummary | undefined): string[] {
  if (!changes) {
    return ["- no change summary recorded"];
  }

  return [
    `- patch proposal files: ${changes.patchProposalFiles.length ? changes.patchProposalFiles.join(", ") : "none"}`,
    `- repair proposal files: ${changes.repairProposalFiles.length ? changes.repairProposalFiles.join(", ") : "none"}`,
    `- applied files: ${changes.appliedFiles.length ? changes.appliedFiles.join(", ") : "none"}`,
    `- checkpoint: ${changes.checkpointId ?? "none"}`,
    `- git status: ${changes.gitStatus?.trim() || "clean"}`,
    `- git diff: ${changes.gitDiff?.trim() ? summarizeReportText(changes.gitDiff) : "no diff"}`
  ];
}

function summarizeReportText(value: string): string {
  const normalized = value.trim().replace(/\r?\n/g, "\\n");
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}...`;
}

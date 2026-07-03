#!/usr/bin/env node
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  findPlaybook,
  generateFallbackManifest,
  listManifestCommandGroups,
  listPlaybookSummaries,
  loadRepoManifest,
  scaffoldOfficialManifest,
  validateRepoManifest,
  type ManifestValidationIssue
} from "@token-streaming/ai-manifest";
import {
  AllowApprovalHost,
  DenyApprovalHost,
  SessionManager,
  StrategyRegistry,
  TokenStreamingRuntime,
  evaluateCommandPolicy,
  evaluateToolPolicy,
  type ApprovalHost
} from "@token-streaming/core";
import {
  createModelProvider,
  diagnoseModelProvider,
  resolveModelSelection,
  type ModelDoctorResult,
  type ProviderName
} from "@token-streaming/providers";
import type {
  ApprovalRequest,
  ApprovalResponse,
  Checkpoint,
  ExecutionPlan,
  ModuleManifest,
  PatchProposal,
  PermissionDecision,
  ProductMode,
  Session,
  SessionEvent,
  StrategyId,
  WorkflowManifest
} from "@token-streaming/protocol";
import {
  CheckpointStore,
  RunReportStore,
  SessionHistoryStore,
  TelemetryStore,
  type ModelTelemetryGroup,
  type ModelTelemetryRecommendation,
  type ModelTelemetrySummary,
  type SessionHistorySummary
} from "@token-streaming/storage";
import { getGitDiff, getGitStatus, listToolCatalog, runTestCommand, runTool, scanRepo, searchRepo } from "@token-streaming/tools";

const CLI_VERSION = "0.1.0";

interface ParsedArgs {
  command:
    | "run"
    | "manifest-init"
    | "manifest-validate"
    | "manifest-generate"
    | "manifest-inspect"
    | "sessions-list"
    | "sessions-show"
    | "sessions-stream"
    | "history-summary"
    | "history-prune"
    | "reports-list"
    | "reports-show"
    | "commands-list"
    | "config-inspect"
    | "tools-list"
    | "tools-run"
    | "playbooks-list"
    | "playbooks-show"
    | "workflows-list"
    | "workflows-show"
    | "strategies-list"
    | "checkpoints-list"
    | "checkpoints-show"
    | "rollback"
    | "diff"
    | "search"
    | "verify"
    | "plan"
    | "context-inspect"
    | "models-select"
    | "stats-models"
    | "doctor-repo"
    | "doctor-models";
  task: string;
  cwd: string;
  mode: ProductMode;
  strategy: StrategyId;
  provider: ProviderName;
  model?: string;
  dryRun: boolean;
  apply: boolean;
  repair: boolean;
  parallelAgents: boolean;
  allowSensitive: boolean;
  approval: ApprovalMode;
  force: boolean;
  probe: boolean;
  json: boolean;
  jsonl: boolean;
  record: boolean;
  keep: number;
  patchFile?: string;
  toolInputFile?: string;
  sessionId?: string;
  checkpointId?: string;
  playbookName?: string;
  workflowName?: string;
  toolName?: string;
}

type ApprovalMode = "deny" | "allow" | "prompt";

interface WorkflowSummary {
  name: string;
  path: string;
  description?: string;
  stepCount: number;
  touches: string[];
  testCommands: string[];
  risks: string[];
}

interface HistoryPruneCandidates {
  sessions: Array<{ id: string; path: string; lastEventAt?: string }>;
  reports: Array<{ id: string; path: string; createdAt?: string; sizeBytes: number }>;
  checkpoints: Array<{ id: string; path: string; createdAt: string; fileCount: number }>;
}

interface LiveSmokeReadiness {
  provider: "openai";
  command: string;
  status: "missing-api-key" | "ready" | "verified" | "failed";
  verified: boolean;
  requiredEnv: string[];
  message: string;
  lastProbeStatus?: ModelDoctorResult["checks"][number]["status"];
}

let activeArgs: ParsedArgs | undefined;

async function main(): Promise<void> {
  if (process.argv.slice(2).some((arg) => arg === "--version" || arg === "-v")) {
    printVersion();
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  activeArgs = args;

  if (args.command === "sessions-list") {
    await printSessions(args.cwd, args);
    return;
  }

  if (args.command === "sessions-show") {
    await printSession(args.cwd, requireValue(args.sessionId, "Missing session id."), args);
    return;
  }

  if (args.command === "sessions-stream") {
    await streamSession(args.cwd, requireValue(args.sessionId, "Missing session id."), args);
    return;
  }

  if (args.command === "history-summary") {
    await printHistorySummary(args.cwd, args);
    return;
  }

  if (args.command === "history-prune") {
    await printHistoryPrune(args.cwd, args);
    return;
  }

  if (args.command === "reports-list") {
    await printReports(args.cwd, args);
    return;
  }

  if (args.command === "reports-show") {
    await printReport(args.cwd, requireValue(args.sessionId, "Missing report session id."), args);
    return;
  }

  if (args.command === "manifest-generate") {
    await printManifestGenerate(args.cwd, args);
    return;
  }

  if (args.command === "manifest-inspect") {
    await printManifestInspection(args.cwd, args);
    return;
  }

  if (args.command === "commands-list") {
    await printManifestCommands(args.cwd, args);
    return;
  }

  if (args.command === "config-inspect") {
    await printConfigInspection(args);
    return;
  }

  if (args.command === "tools-list") {
    printTools(args);
    return;
  }

  if (args.command === "tools-run") {
    await printToolRun(args);
    return;
  }

  if (args.command === "playbooks-list") {
    await printPlaybooks(args.cwd, args);
    return;
  }

  if (args.command === "playbooks-show") {
    await printPlaybook(args.cwd, requireValue(args.playbookName, "Missing playbook name."), args);
    return;
  }

  if (args.command === "workflows-list") {
    await printWorkflows(args.cwd, args);
    return;
  }

  if (args.command === "workflows-show") {
    await printWorkflow(args.cwd, requireValue(args.workflowName, "Missing workflow name."), args);
    return;
  }

  if (args.command === "strategies-list") {
    printStrategies(args);
    return;
  }

  if (args.command === "checkpoints-list") {
    await printCheckpoints(args.cwd, args);
    return;
  }

  if (args.command === "checkpoints-show") {
    await printCheckpoint(args.cwd, requireValue(args.checkpointId, "Missing checkpoint id."), args);
    return;
  }

  if (args.command === "rollback") {
    await rollbackCheckpoint(args.cwd, requireValue(args.checkpointId, "Missing checkpoint id."), args);
    return;
  }

  if (args.command === "diff") {
    await printDiff(args.cwd, args);
    return;
  }

  if (args.command === "search") {
    await printSearch(args.cwd, args);
    return;
  }

  if (args.command === "plan") {
    await printPlanPreview(args);
    return;
  }

  if (args.command === "context-inspect") {
    await printContextInspection(args);
    return;
  }

  if (args.command === "manifest-init") {
    await initializeManifest(args.cwd, args);
    return;
  }

  if (args.command === "manifest-validate") {
    await validateManifest(args.cwd, args);
    return;
  }

  if (args.command === "stats-models") {
    await printModelStats(args.cwd, args);
    return;
  }

  const manifest = await loadRepoManifest(args.cwd);

  if (args.command === "verify") {
    await runManifestVerification(args.cwd, manifest, args);
    return;
  }

  if (args.command === "models-select") {
    await printModelSelection(args, manifest);
    return;
  }

  if (args.command === "doctor-models") {
    await printModelDoctor(args.cwd, args, manifest);
    return;
  }

  if (args.command === "doctor-repo") {
    await printRepoDoctor(args, manifest);
    return;
  }

  const modelSelection = resolveModelSelection({
    mode: args.mode,
    requestedProvider: args.provider,
    requestedModel: args.model,
    manifest,
    telemetry: await new TelemetryStore(args.cwd).summarizeModelCalls(),
    task: args.task
  });
  const modelProvider = createModelProvider({
    provider: modelSelection.provider,
    model: modelSelection.model
  });

  const runtime = new TokenStreamingRuntime({
    repoRoot: args.cwd,
    mode: args.mode,
    strategy: args.strategy,
    modelProvider,
    approvalHost: createApprovalHost(args.approval)
  });

  const result = await runtime.runTask({
    task: args.task,
    dryRun: args.dryRun,
    apply: args.apply,
    repair: args.repair,
    parallelAgents: args.parallelAgents,
    allowSensitive: args.allowSensitive,
    patchProposalText: args.patchFile ? await readFile(args.patchFile, "utf8") : undefined
  });

  if (args.json) {
    printJson({
      kind: "run",
      session: result.session,
      mode: args.mode,
      requestedStrategy: args.strategy,
      strategy: result.plan.strategy,
      dryRun: args.dryRun,
      apply: args.apply,
      repair: args.repair,
      parallelAgents: args.parallelAgents,
      modelSelection,
      repo: summarizeRepo(result.repo),
      manifest: summarizeManifest(result.manifest),
      plan: result.plan,
      context: summarizeContext(result.context),
      eventLogPath: result.eventLogPath,
      reportPath: result.reportPath,
      patchProposal: result.patchProposal ? summarizePatchProposal(result.patchProposal) : undefined,
      repairPatchProposal: result.repairPatchProposal ? summarizePatchProposal(result.repairPatchProposal) : undefined,
      appliedFiles: result.appliedFiles,
      verificationResults: result.verificationResults,
      permissionDecisions: result.permissionDecisions,
      approvalResponses: result.approvalResponses,
      modelCalls: result.modelCalls,
      agentRuns: result.agentRuns,
      review: result.review,
      summary: result.summary
    });
    return;
  }

  console.log(result.summary);
  console.log("");
  console.log(
    `Model selection: provider=${modelSelection.provider}, model=${modelSelection.model ?? "provider default"}, source=${modelSelection.source}`
  );
  console.log(`Parallel agents: ${args.parallelAgents ? `${result.agentRuns.length} completed` : "disabled"}`);
  console.log(`Event log: ${result.eventLogPath}`);
  console.log(`Report: ${result.reportPath}`);
  if (result.patchProposal) {
    console.log(`Patch proposal files: ${result.patchProposal.files.map((file) => file.path).join(", ")}`);
    console.log(`Patch applied: ${result.appliedFiles.length > 0 ? result.appliedFiles.join(", ") : "no"}`);
  }
  if (result.repairPatchProposal) {
    console.log(`Repair proposal files: ${result.repairPatchProposal.files.map((file) => file.path).join(", ")}`);
  }
  if (result.verificationResults.length > 0) {
    console.log(
      `Verification: ${result.verificationResults.map((verification) => `${verification.command} => ${verification.exitCode}`).join("; ")}`
    );
  }
  if (result.permissionDecisions.length > 0) {
    console.log(
      `Permissions: ${result.permissionDecisions
        .map((decision) => `${decision.target}:${decision.allowed ? "allowed" : "blocked"}`)
        .join("; ")}`
    );
  }
  if (result.approvalResponses.length > 0) {
    console.log(
      `Approvals: ${result.approvalResponses.map((response) => `${response.mode}:${response.approved ? "approved" : "rejected"}`).join("; ")}`
    );
  }
  console.log(`Relevant modules: ${result.context.relevantModules.join(", ") || "none inferred"}`);
  console.log(`Source snippets: ${result.context.sourceSnippets.map((snippet) => snippet.path).join(", ") || "none"}`);
  console.log(`Modules loaded: ${result.manifest.modules.length}`);
  console.log(`Workflows loaded: ${result.manifest.workflows.length}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.filter((arg) => arg !== "--");
  const parsed: ParsedArgs = {
    command: "run",
    task: "summarize this repository",
    cwd: process.env.INIT_CWD ?? process.cwd(),
    mode: "auto",
    strategy: "default",
    provider: "auto",
    dryRun: false,
    apply: false,
    repair: false,
    parallelAgents: false,
    allowSensitive: false,
    approval: "deny",
    force: false,
    probe: false,
    json: false,
    jsonl: false,
    record: false,
    keep: 20
  };

  claimCommand(args, parsed);

  const taskParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--apply") {
      parsed.apply = true;
      continue;
    }

    if (arg === "--repair") {
      parsed.repair = true;
      continue;
    }

    if (arg === "--parallel-agents") {
      parsed.parallelAgents = true;
      continue;
    }

    if (arg === "--allow-sensitive") {
      parsed.allowSensitive = true;
      parsed.approval = "allow";
      continue;
    }

    if (arg === "--force") {
      parsed.force = true;
      continue;
    }

    if (arg === "--probe") {
      parsed.probe = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg === "--jsonl") {
      parsed.jsonl = true;
      continue;
    }

    if (arg === "--record") {
      parsed.record = true;
      continue;
    }

    if (arg === "--keep" && args[index + 1]) {
      parsed.keep = parseKeepCount(args[index + 1] ?? "20");
      index += 1;
      continue;
    }

    if (arg === "--approval" && args[index + 1]) {
      parsed.approval = parseApprovalMode(args[index + 1] ?? "deny");
      index += 1;
      continue;
    }

    if ((arg === "-C" || arg === "--cwd") && args[index + 1]) {
      parsed.cwd = args[index + 1] ?? parsed.cwd;
      index += 1;
      continue;
    }

    if (arg === "--mode" && args[index + 1]) {
      parsed.mode = parseMode(args[index + 1] ?? "auto");
      index += 1;
      continue;
    }

    if (arg === "--strategy" && args[index + 1]) {
      parsed.strategy = parseStrategy(args[index + 1] ?? "default");
      index += 1;
      continue;
    }

    if (arg === "--provider" && args[index + 1]) {
      parsed.provider = parseProvider(args[index + 1] ?? "auto");
      index += 1;
      continue;
    }

    if (arg === "--model" && args[index + 1]) {
      parsed.model = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--patch-file" && args[index + 1]) {
      parsed.patchFile = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--input-file" && args[index + 1]) {
      parsed.toolInputFile = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg) {
      taskParts.push(arg);
    }
  }

  if (taskParts.length > 0) {
    parsed.task = taskParts.join(" ");
  }

  return parsed;
}

function claimCommand(args: string[], parsed: ParsedArgs): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (takesValue(arg)) {
      index += 1;
      continue;
    }

    if (arg === "manifest" && args[index + 1] === "init") {
      parsed.command = "manifest-init";
      parsed.task = "initialize generated AI manifest for this repository";
      parsed.mode = "economy";
      parsed.dryRun = true;
      args.splice(index, 2);
      return;
    }

    if (arg === "manifest" && args[index + 1] === "validate") {
      parsed.command = "manifest-validate";
      parsed.task = "validate AI manifest for this repository";
      parsed.mode = "economy";
      parsed.dryRun = true;
      args.splice(index, 2);
      return;
    }

    if (arg === "manifest" && args[index + 1] === "generate") {
      parsed.command = "manifest-generate";
      parsed.task = "generate fallback AI manifest mapping for this repository";
      parsed.mode = "economy";
      parsed.dryRun = true;
      args.splice(index, 2);
      return;
    }

    if (arg === "manifest" && args[index + 1] === "inspect") {
      parsed.command = "manifest-inspect";
      parsed.task = "inspect AI manifest coverage for this repository";
      parsed.mode = "economy";
      parsed.dryRun = true;
      args.splice(index, 2);
      return;
    }

    if (arg === "sessions" && args[index + 1] === "list") {
      parsed.command = "sessions-list";
      args.splice(index, 2);
      return;
    }

    if (arg === "sessions" && args[index + 1] === "show") {
      parsed.command = "sessions-show";
      parsed.sessionId = args[index + 2];
      args.splice(index, 3);
      return;
    }

    if (arg === "sessions" && args[index + 1] === "stream") {
      parsed.command = "sessions-stream";
      parsed.sessionId = args[index + 2];
      args.splice(index, 3);
      return;
    }

    if (arg === "history" && args[index + 1] === "summary") {
      parsed.command = "history-summary";
      args.splice(index, 2);
      return;
    }

    if (arg === "history" && args[index + 1] === "prune") {
      parsed.command = "history-prune";
      args.splice(index, 2);
      return;
    }

    if (arg === "reports" && args[index + 1] === "list") {
      parsed.command = "reports-list";
      args.splice(index, 2);
      return;
    }

    if (arg === "reports" && args[index + 1] === "show") {
      parsed.command = "reports-show";
      parsed.sessionId = args[index + 2];
      args.splice(index, 3);
      return;
    }

    if (arg === "commands" && args[index + 1] === "list") {
      parsed.command = "commands-list";
      args.splice(index, 2);
      return;
    }

    if (arg === "config" && args[index + 1] === "inspect") {
      parsed.command = "config-inspect";
      args.splice(index, 2);
      return;
    }

    if (arg === "tools" && args[index + 1] === "list") {
      parsed.command = "tools-list";
      args.splice(index, 2);
      return;
    }

    if (arg === "tools" && args[index + 1] === "run") {
      parsed.command = "tools-run";
      parsed.toolName = args[index + 2];
      args.splice(index, 3);
      return;
    }

    if (arg === "playbooks" && args[index + 1] === "list") {
      parsed.command = "playbooks-list";
      args.splice(index, 2);
      return;
    }

    if (arg === "playbooks" && args[index + 1] === "show") {
      parsed.command = "playbooks-show";
      parsed.playbookName = args[index + 2];
      args.splice(index, 3);
      return;
    }

    if (arg === "workflows" && args[index + 1] === "list") {
      parsed.command = "workflows-list";
      args.splice(index, 2);
      return;
    }

    if (arg === "workflows" && args[index + 1] === "show") {
      parsed.command = "workflows-show";
      parsed.workflowName = args[index + 2];
      args.splice(index, 3);
      return;
    }

    if (arg === "strategies" && args[index + 1] === "list") {
      parsed.command = "strategies-list";
      args.splice(index, 2);
      return;
    }

    if (arg === "checkpoints" && args[index + 1] === "list") {
      parsed.command = "checkpoints-list";
      args.splice(index, 2);
      return;
    }

    if (arg === "checkpoints" && args[index + 1] === "show") {
      parsed.command = "checkpoints-show";
      parsed.checkpointId = args[index + 2];
      args.splice(index, 3);
      return;
    }

    if (arg === "rollback") {
      parsed.command = "rollback";
      parsed.checkpointId = args[index + 1];
      args.splice(index, 2);
      return;
    }

    if (arg === "diff") {
      parsed.command = "diff";
      args.splice(index, 1);
      return;
    }

    if (arg === "verify") {
      parsed.command = "verify";
      args.splice(index, 1);
      return;
    }

    if (arg === "plan") {
      parsed.command = "plan";
      args.splice(index, 1);
      return;
    }

    if (arg === "context" && args[index + 1] === "inspect") {
      parsed.command = "context-inspect";
      args.splice(index, 2);
      return;
    }

    if (arg === "stats" && args[index + 1] === "models") {
      parsed.command = "stats-models";
      args.splice(index, 2);
      return;
    }

    if (arg === "models" && args[index + 1] === "select") {
      parsed.command = "models-select";
      args.splice(index, 2);
      return;
    }

    if (arg === "doctor" && args[index + 1] === "models") {
      parsed.command = "doctor-models";
      args.splice(index, 2);
      return;
    }

    if (arg === "doctor" && args[index + 1] === "repo") {
      parsed.command = "doctor-repo";
      args.splice(index, 2);
      return;
    }

    if (arg === "search") {
      parsed.command = "search";
      args.splice(index, 1);
      return;
    }
  }
}

function takesValue(arg: string | undefined): boolean {
  return (
    arg === "--approval" ||
    arg === "-C" ||
    arg === "--cwd" ||
    arg === "--mode" ||
    arg === "--strategy" ||
    arg === "--provider" ||
    arg === "--model" ||
    arg === "--patch-file" ||
    arg === "--input-file" ||
    arg === "--keep"
  );
}

function parseMode(value: string): ProductMode {
  if (value === "economy" || value === "max" || value === "auto") {
    return value;
  }
  throw new Error(`Invalid mode "${value}". Use economy, max, or auto.`);
}

function parseStrategy(value: string): StrategyId {
  if (value.trim().length > 0) {
    return value;
  }
  throw new Error("Strategy id must be non-empty.");
}

function parseProvider(value: string): ProviderName {
  if (value === "stub" || value === "openai" || value === "auto") {
    return value;
  }
  throw new Error(`Invalid provider "${value}". Use stub, openai, or auto.`);
}

function parseKeepCount(value: string): number {
  const count = Number(value);
  if (Number.isInteger(count) && count >= 0) {
    return count;
  }
  throw new Error(`Invalid keep count "${value}". Use a non-negative integer.`);
}

function printHelp(): void {
  console.log(`Token Streaming CLI

Usage:
  token-streaming [options] [task...]
  token-streaming manifest init [options]
  token-streaming manifest validate [options]
  token-streaming manifest generate [options]
  token-streaming manifest inspect [options]
  token-streaming commands list [options]
  token-streaming config inspect [options]
  token-streaming tools list [options]
  token-streaming tools run <name> [json-input] [options]
  token-streaming playbooks list [options]
  token-streaming playbooks show <name> [options]
  token-streaming workflows list [options]
  token-streaming workflows show <name> [options]
  token-streaming strategies list [options]
  token-streaming history summary [options]
  token-streaming history prune [options]
  token-streaming sessions list [options]
  token-streaming sessions show <session-id|latest> [options]
  token-streaming sessions stream <session-id|latest> [options]
  token-streaming reports list [options]
  token-streaming reports show <session-id|latest> [options]
  token-streaming checkpoints list [options]
  token-streaming checkpoints show <checkpoint-id|latest> [options]
  token-streaming rollback <checkpoint-id> [options]
  token-streaming diff [options]
  token-streaming search [options] <query...>
  token-streaming verify [options]
  token-streaming plan [options] [task...]
  token-streaming context inspect [options] [task...]
  token-streaming models select [options] [task...]
  token-streaming stats models [options]
  token-streaming doctor repo [options]
  token-streaming doctor models [options]

Options:
  -C, --cwd <path>       Repository root
  --mode <mode>          Product mode: economy, max, auto
  --strategy <id>        Orchestration strategy id, default: default
  --provider <provider>  Provider: auto, openai, stub
  --model <model>        Model name for the selected provider
  --patch-file <path>    Load a structured patch proposal from a JSON file
  --input-file <path>    Load JSON input for tools run
  --apply                Apply a parsed patch proposal after checkpointing
  --repair               Try one model repair patch if verification fails
  --parallel-agents      Run non-orchestrator role agents concurrently before the main model call
  --force                Overwrite existing files for commands that support it
  --probe                Send a minimal provider request for doctor commands
  --json                 Emit JSON for supported commands
  --jsonl                Emit newline-delimited JSON for stream commands
  --record               Record tools run calls as a local session event log
  --keep <count>         Keep this many newest history items for prune previews
  --allow-sensitive      Allow patching paths marked sensitive in .ai/safety.yaml
  --approval <mode>      Approval mode: deny, allow, prompt
  --dry-run              Skip verification commands
  -v, --version          Show CLI version
  -h, --help             Show help
`);
}

function printVersion(): void {
  console.log(`token-streaming ${CLI_VERSION}`);
}

function parseApprovalMode(value: string): ApprovalMode {
  if (value === "deny" || value === "allow" || value === "prompt") {
    return value;
  }
  throw new Error(`Invalid approval mode "${value}". Use deny, allow, or prompt.`);
}

function createApprovalHost(mode: ApprovalMode): ApprovalHost {
  if (mode === "allow") {
    return new AllowApprovalHost();
  }
  if (mode === "prompt") {
    return new PromptApprovalHost();
  }
  return new DenyApprovalHost();
}

class PromptApprovalHost implements ApprovalHost {
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    const rl = createInterface({ input, output });
    try {
      console.log(`Approval required for ${request.target}: ${request.action}`);
      for (const reason of request.reasons) {
        console.log(`- ${reason}`);
      }
      const answer = (await rl.question("Approve? [y/N] ")).trim().toLowerCase();
      const approved = answer === "y" || answer === "yes";
      return {
        requestId: request.id,
        approved,
        mode: "prompt",
        reason: approved ? "Approved by CLI prompt." : "Rejected by CLI prompt."
      };
    } finally {
      rl.close();
    }
  }
}

async function printSessions(repoRoot: string, args: ParsedArgs): Promise<void> {
  const sessions = await new SessionHistoryStore(repoRoot).list();
  if (args.json) {
    printJson({
      kind: "sessions-list",
      sessions
    });
    return;
  }

  if (sessions.length === 0) {
    console.log("No Token Streaming sessions found.");
    return;
  }

  for (const session of sessions) {
    console.log(formatSessionSummary(session));
  }
}

async function printSession(repoRoot: string, sessionId: string, args: ParsedArgs): Promise<void> {
  const store = new SessionHistoryStore(repoRoot);
  const resolvedSessionId = await resolveSessionId(store, sessionId);
  const events = await store.read(resolvedSessionId);
  const summary = (await store.list()).find((session) => session.sessionId === resolvedSessionId);
  if (args.json) {
    printJson({
      kind: "session",
      sessionId: resolvedSessionId,
      summary,
      eventCount: events.length,
      logPath: store.getSessionPath(resolvedSessionId),
      events
    });
    return;
  }

  console.log(`Session: ${resolvedSessionId}`);
  console.log(`Events: ${events.length}`);
  console.log(`Log: ${store.getSessionPath(resolvedSessionId)}`);
  console.log("");
  for (const event of events) {
    console.log(formatEvent(event));
  }
}

async function streamSession(repoRoot: string, sessionId: string, args: ParsedArgs): Promise<void> {
  const store = new SessionHistoryStore(repoRoot);
  const resolvedSessionId = await resolveSessionId(store, sessionId);
  const [events, summaries] = await Promise.all([store.read(resolvedSessionId), store.list()]);
  const summary = summaries.find((session) => session.sessionId === resolvedSessionId);
  const logPath = store.getSessionPath(resolvedSessionId);
  const envelopes = [
    {
      kind: "session-stream",
      phase: "start",
      sessionId: resolvedSessionId,
      logPath,
      eventCount: events.length
    },
    {
      kind: "session-stream",
      phase: "summary",
      sessionId: resolvedSessionId,
      summary
    },
    ...events.map((event, index) => ({
      kind: "session-stream",
      phase: "event",
      sessionId: resolvedSessionId,
      index,
      event
    })),
    {
      kind: "session-stream",
      phase: "end",
      sessionId: resolvedSessionId,
      eventCount: events.length
    }
  ];

  if (args.jsonl) {
    for (const envelope of envelopes) {
      console.log(JSON.stringify(envelope));
    }
    return;
  }

  console.log(`Session stream: ${resolvedSessionId}`);
  console.log(`Events: ${events.length}`);
  console.log(`Log: ${logPath}`);
  console.log("");
  for (const event of events) {
    console.log(formatEvent(event));
  }
}

async function printHistorySummary(repoRoot: string, args: ParsedArgs): Promise<void> {
  const [sessions, reports, checkpoints, modelStats] = await Promise.all([
    new SessionHistoryStore(repoRoot).list(),
    new RunReportStore(repoRoot).list(),
    new CheckpointStore(repoRoot).list(),
    new TelemetryStore(repoRoot).summarizeModelCalls()
  ]);
  const summary = {
    sessions: {
      count: sessions.length,
      latest: sessions[0]
    },
    reports: {
      count: reports.length,
      latest: reports[0]
    },
    checkpoints: {
      count: checkpoints.length,
      latest: checkpoints[0] ? summarizeCheckpoint(checkpoints[0]) : undefined
    },
    models: {
      totalCalls: modelStats.totalCalls,
      totalInputTokens: modelStats.totalInputTokens,
      totalOutputTokens: modelStats.totalOutputTokens,
      totalResponseCharacters: modelStats.totalResponseCharacters,
      topProviders: modelStats.byProvider.slice(0, 3),
      topModels: modelStats.byModel.slice(0, 3)
    }
  };

  if (args.json) {
    printJson({
      kind: "history-summary",
      summary
    });
    return;
  }

  console.log("History summary");
  console.log(`Sessions: ${summary.sessions.count}`);
  console.log(`Latest session: ${summary.sessions.latest?.sessionId ?? "none"}`);
  console.log(`Reports: ${summary.reports.count}`);
  console.log(`Latest report: ${summary.reports.latest?.sessionId ?? "none"}`);
  console.log(`Checkpoints: ${summary.checkpoints.count}`);
  console.log(`Latest checkpoint: ${summary.checkpoints.latest?.id ?? "none"}`);
  console.log(`Model calls: ${summary.models.totalCalls}`);
  console.log(`Top providers: ${summary.models.topProviders.map((provider) => `${provider.key} (${provider.calls})`).join(", ") || "none"}`);
}

async function printHistoryPrune(repoRoot: string, args: ParsedArgs): Promise<void> {
  const [sessions, reports, checkpoints] = await Promise.all([
    new SessionHistoryStore(repoRoot).list(),
    new RunReportStore(repoRoot).list(),
    new CheckpointStore(repoRoot).list()
  ]);
  const keep = args.keep;
  const candidates = buildHistoryPruneCandidates(repoRoot, keep, sessions, reports, checkpoints);
  const summary = {
    keep,
    dryRun: args.dryRun,
    counts: {
      sessions: candidates.sessions.length,
      reports: candidates.reports.length,
      checkpoints: candidates.checkpoints.length,
      total: candidates.sessions.length + candidates.reports.length + candidates.checkpoints.length
    },
    candidates
  };

  if (!args.dryRun) {
    const deleted = await deleteHistoryPruneCandidates(repoRoot, candidates);
    if (args.json) {
      printJson({
        kind: "history-prune",
        ...summary,
        deleted
      });
      return;
    }

    console.log("History pruned");
    console.log(`Keep newest: ${keep}`);
    console.log(`Deleted: ${deleted.total}`);
    console.log(`- sessions: ${deleted.sessions.length}`);
    console.log(`- reports: ${deleted.reports.length}`);
    console.log(`- checkpoints: ${deleted.checkpoints.length}`);
    return;
  }

  if (args.json) {
    printJson({
      kind: "history-prune-preview",
      ...summary
    });
    return;
  }

  console.log("History prune preview");
  console.log(`Keep newest: ${keep}`);
  console.log(`Candidates: ${summary.counts.total}`);
  console.log(`- sessions: ${summary.counts.sessions}`);
  console.log(`- reports: ${summary.counts.reports}`);
  console.log(`- checkpoints: ${summary.counts.checkpoints}`);
}

function buildHistoryPruneCandidates(
  repoRoot: string,
  keep: number,
  sessions: Awaited<ReturnType<SessionHistoryStore["list"]>>,
  reports: Awaited<ReturnType<RunReportStore["list"]>>,
  checkpoints: Awaited<ReturnType<CheckpointStore["list"]>>
): HistoryPruneCandidates {
  return {
    sessions: sessions.slice(keep).map((session) => ({
      id: session.sessionId,
      path: session.logPath,
      lastEventAt: session.lastEventAt
    })),
    reports: reports.slice(keep).map((report) => ({
      id: report.sessionId,
      path: report.path,
      createdAt: report.createdAt,
      sizeBytes: report.sizeBytes
    })),
    checkpoints: checkpoints.slice(keep).map((checkpoint) => ({
      id: checkpoint.id,
      path: path.join(repoRoot, ".token-streaming", "checkpoints", `${checkpoint.id}.json`),
      createdAt: checkpoint.createdAt,
      fileCount: checkpoint.files.length
    }))
  };
}

async function deleteHistoryPruneCandidates(repoRoot: string, candidates: HistoryPruneCandidates): Promise<{
  sessions: string[];
  reports: string[];
  checkpoints: string[];
  total: number;
}> {
  const deleted = {
    sessions: await deleteHistoryFiles(repoRoot, candidates.sessions.map((candidate) => candidate.path)),
    reports: await deleteHistoryFiles(repoRoot, candidates.reports.map((candidate) => candidate.path)),
    checkpoints: await deleteHistoryFiles(repoRoot, candidates.checkpoints.map((candidate) => candidate.path))
  };

  return {
    ...deleted,
    total: deleted.sessions.length + deleted.reports.length + deleted.checkpoints.length
  };
}

async function deleteHistoryFiles(repoRoot: string, files: string[]): Promise<string[]> {
  const historyRoot = path.resolve(repoRoot, ".token-streaming");
  const deleted: string[] = [];
  for (const file of files) {
    const resolved = path.resolve(file);
    if (!isWithinPath(historyRoot, resolved)) {
      throw new Error(`Refusing to prune history file outside .token-streaming: ${file}`);
    }
    await rm(resolved, { force: true });
    deleted.push(file);
  }
  return deleted;
}

function isWithinPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function printReports(repoRoot: string, args: ParsedArgs): Promise<void> {
  const reports = await new RunReportStore(repoRoot).list();
  if (args.json) {
    printJson({
      kind: "reports-list",
      reports
    });
    return;
  }

  if (reports.length === 0) {
    console.log("No Token Streaming reports found.");
    return;
  }

  for (const report of reports) {
    console.log(`${report.sessionId}  created=${report.createdAt ?? "unknown"}  bytes=${report.sizeBytes}  title="${report.title}"`);
  }
}

async function printReport(repoRoot: string, sessionId: string, args: ParsedArgs): Promise<void> {
  const store = new RunReportStore(repoRoot);
  const resolvedSessionId = await resolveReportSessionId(store, sessionId);
  const content = await store.read(resolvedSessionId);
  const summary = (await store.list()).find((report) => report.sessionId === resolvedSessionId);
  if (args.json) {
    printJson({
      kind: "report",
      sessionId: resolvedSessionId,
      summary,
      path: store.getReportPath(resolvedSessionId),
      content
    });
    return;
  }

  console.log(content.trimEnd());
}

async function printCheckpoints(repoRoot: string, args: ParsedArgs): Promise<void> {
  const checkpoints = await new CheckpointStore(repoRoot).list();
  if (args.json) {
    printJson({
      kind: "checkpoints-list",
      checkpoints: checkpoints.map(summarizeCheckpoint)
    });
    return;
  }

  if (checkpoints.length === 0) {
    console.log("No Token Streaming checkpoints found.");
    return;
  }

  for (const checkpoint of checkpoints) {
    console.log(formatCheckpoint(checkpoint));
  }
}

async function printCheckpoint(repoRoot: string, checkpointId: string, args: ParsedArgs): Promise<void> {
  const store = new CheckpointStore(repoRoot);
  const resolvedCheckpointId = await resolveCheckpointId(store, checkpointId);
  const checkpoint = await store.load(resolvedCheckpointId);
  const detail = summarizeCheckpointDetail(checkpoint);
  if (args.json) {
    printJson({
      kind: "checkpoint",
      checkpoint: detail
    });
    return;
  }

  console.log(`Checkpoint: ${checkpoint.id}`);
  console.log(`Created: ${checkpoint.createdAt}`);
  console.log(`Files: ${checkpoint.files.length}`);
  for (const file of detail.files as Array<Record<string, unknown>>) {
    console.log(
      `- ${file.path}  existed=${file.existed ? "yes" : "no"}  characters=${file.characters}${
        file.preview ? `  preview="${file.preview}"` : ""
      }`
    );
  }
}

async function resolveSessionId(store: SessionHistoryStore, sessionId: string): Promise<string> {
  if (sessionId !== "latest") {
    return sessionId;
  }
  const latest = (await store.list())[0];
  if (!latest) {
    throw new Error("No Token Streaming sessions found.");
  }
  return latest.sessionId;
}

async function resolveReportSessionId(store: RunReportStore, sessionId: string): Promise<string> {
  if (sessionId !== "latest") {
    return sessionId;
  }
  const latest = (await store.list())[0];
  if (!latest) {
    throw new Error("No Token Streaming reports found.");
  }
  return latest.sessionId;
}

async function resolveCheckpointId(store: CheckpointStore, checkpointId: string): Promise<string> {
  if (checkpointId !== "latest") {
    return checkpointId;
  }
  const latest = (await store.list())[0];
  if (!latest) {
    throw new Error("No Token Streaming checkpoints found.");
  }
  return latest.id;
}

async function rollbackCheckpoint(repoRoot: string, checkpointId: string, args: ParsedArgs): Promise<void> {
  const store = new CheckpointStore(repoRoot);
  const resolvedCheckpointId = await resolveCheckpointId(store, checkpointId);
  if (args.dryRun) {
    const preview = await store.previewRollback(resolvedCheckpointId);
    if (args.json) {
      printJson({
        kind: "rollback-preview",
        dryRun: true,
        ...preview
      });
      return;
    }

    console.log(`Rollback preview for checkpoint ${resolvedCheckpointId}.`);
    console.log(`Restore files: ${preview.restoreFiles.length > 0 ? preview.restoreFiles.join(", ") : "none"}`);
    console.log(`Delete files: ${preview.deleteFiles.length > 0 ? preview.deleteFiles.join(", ") : "none"}`);
    return;
  }

  const restored = await store.rollback(resolvedCheckpointId);
  if (args.json) {
    printJson({
      kind: "rollback",
      dryRun: false,
      checkpointId: resolvedCheckpointId,
      restoredFiles: restored
    });
    return;
  }

  console.log(`Rolled back checkpoint ${resolvedCheckpointId}.`);
  console.log(`Restored files: ${restored.length > 0 ? restored.join(", ") : "none"}`);
}

async function printDiff(repoRoot: string, args: ParsedArgs): Promise<void> {
  const [status, diff] = await Promise.all([getGitStatus(repoRoot), getGitDiff(repoRoot)]);
  if (args.json) {
    printJson({
      kind: "diff",
      status,
      diff,
      clean: status.length === 0 && diff.length === 0
    });
    return;
  }

  console.log("Git status:");
  console.log(status || "clean");
  console.log("");
  console.log("Git diff:");
  console.log(diff || "no diff");
}

async function printSearch(repoRoot: string, args: ParsedArgs): Promise<void> {
  if (args.task === "summarize this repository") {
    throw new Error("Missing search query.");
  }

  const matches = await searchRepo(repoRoot, args.task);
  if (args.json) {
    printJson({
      kind: "search",
      query: args.task,
      matchCount: matches.length,
      matches
    });
    return;
  }

  console.log(`Search: ${args.task}`);
  if (matches.length === 0) {
    console.log("No matches found.");
    return;
  }

  for (const match of matches) {
    console.log(`${match.path}:${match.line}:${match.column}: ${match.text}`);
  }
}

async function printManifestCommands(repoRoot: string, args: ParsedArgs): Promise<void> {
  const manifest = await loadRepoManifest(repoRoot);
  const groups = listManifestCommandGroups(manifest);
  if (args.json) {
    printJson({
      kind: "commands-list",
      groups
    });
    return;
  }

  if (groups.length === 0) {
    console.log("No commands declared in .ai/commands.yaml.");
    return;
  }

  console.log("Manifest commands");
  for (const group of groups) {
    console.log("");
    console.log(`${group.name}:`);
    for (const command of group.commands) {
      console.log(`- ${command}`);
    }
  }
}

async function printPlaybooks(repoRoot: string, args: ParsedArgs): Promise<void> {
  const manifest = await loadRepoManifest(repoRoot);
  const playbooks = listPlaybookSummaries(manifest);
  if (args.json) {
    printJson({
      kind: "playbooks-list",
      playbooks
    });
    return;
  }

  if (playbooks.length === 0) {
    console.log("No playbooks declared in .ai/playbooks/.");
    return;
  }

  console.log("Playbooks");
  for (const playbook of playbooks) {
    console.log(`- ${playbook.name}: ${playbook.title} (${playbook.path})`);
  }
}

async function printPlaybook(repoRoot: string, name: string, args: ParsedArgs): Promise<void> {
  const manifest = await loadRepoManifest(repoRoot);
  const playbook = findPlaybook(manifest, name);
  if (!playbook) {
    const available = listPlaybookSummaries(manifest).map((summary) => summary.name);
    throw new Error(`Unknown playbook "${name}". Available playbooks: ${available.join(", ") || "none"}.`);
  }

  if (args.json) {
    printJson({
      kind: "playbook",
      playbook: {
        name: playbook.name,
        path: playbook.path,
        content: playbook.content
      }
    });
    return;
  }

  console.log(playbook.content.trimEnd());
}

async function printWorkflows(repoRoot: string, args: ParsedArgs): Promise<void> {
  const manifest = await loadRepoManifest(repoRoot);
  const workflows = manifest.workflows.map(summarizeWorkflow);
  if (args.json) {
    printJson({
      kind: "workflows-list",
      workflows
    });
    return;
  }

  if (workflows.length === 0) {
    console.log("No workflows declared in src/workflows/*/flow.yaml.");
    return;
  }

  console.log("Workflows");
  for (const workflow of workflows) {
    console.log(
      `- ${workflow.name}: ${workflow.description ?? "No description."} steps=${workflow.stepCount} risks=${workflow.risks.length} (${workflow.path})`
    );
  }
}

async function printWorkflow(repoRoot: string, name: string, args: ParsedArgs): Promise<void> {
  const manifest = await loadRepoManifest(repoRoot);
  const workflow = findWorkflow(manifest.workflows, name);
  if (!workflow) {
    throw new Error(`Unknown workflow "${name}". Available workflows: ${manifest.workflows.map((item) => item.name).join(", ") || "none"}.`);
  }

  if (args.json) {
    printJson({
      kind: "workflow",
      workflow
    });
    return;
  }

  console.log(`Workflow: ${workflow.name}`);
  console.log(`Path: ${workflow.path}`);
  if (workflow.description) {
    console.log(`Description: ${workflow.description}`);
  }
  console.log("Steps:");
  for (const step of workflow.steps) {
    console.log(`- ${step}`);
  }
  console.log(`Touches: ${workflow.touches.join(", ") || "none"}`);
  console.log("Risks:");
  for (const risk of workflow.risks) {
    console.log(`- ${risk}`);
  }
  console.log("Test commands:");
  for (const command of workflow.testCommands) {
    console.log(`- ${command}`);
  }
}

function findWorkflow(workflows: WorkflowManifest[], name: string): WorkflowManifest | undefined {
  const normalized = name.toLowerCase();
  return workflows.find((workflow) => workflow.name.toLowerCase() === normalized);
}

function summarizeWorkflow(workflow: WorkflowManifest): WorkflowSummary {
  return {
    name: workflow.name,
    path: workflow.path,
    description: workflow.description,
    stepCount: workflow.steps.length,
    touches: workflow.touches,
    testCommands: workflow.testCommands,
    risks: workflow.risks
  };
}

function printStrategies(args: ParsedArgs): void {
  const registry = new StrategyRegistry();
  const strategies = registry.available().map((id) => ({
    id,
    default: id === "default",
    implemented: true
  }));

  if (args.json) {
    printJson({
      kind: "strategies-list",
      selected: args.strategy,
      strategies
    });
    return;
  }

  console.log("Strategies");
  for (const strategy of strategies) {
    const marker = strategy.id === args.strategy ? "selected" : strategy.default ? "default" : "available";
    console.log(`- ${strategy.id} (${marker})`);
  }
}

async function printConfigInspection(args: ParsedArgs): Promise<void> {
  const [repo, manifest] = await Promise.all([scanRepo(args.cwd), loadRepoManifest(args.cwd)]);
  const registry = new StrategyRegistry();
  const strategies = registry.available();
  const modelSelection = resolveModelSelection({
    mode: args.mode,
    requestedProvider: args.provider,
    requestedModel: args.model,
    manifest
  });
  const safety = summarizeSafetyPolicy(manifest.safety);
  const config = {
    kind: "config-inspection",
    cwd: args.cwd,
    mode: args.mode,
    strategy: args.strategy,
    strategyAvailable: strategies.includes(args.strategy),
    availableStrategies: strategies,
    provider: args.provider,
    requestedModel: args.model,
    modelSelection,
    effectiveProvider: resolveEffectiveProvider(modelSelection.provider),
    repo: summarizeRepo(repo),
    manifest: summarizeManifest(manifest),
    safety
  };

  if (args.json) {
    printJson(config);
    return;
  }

  console.log("Config inspection");
  console.log(`Repository: ${repo.root}`);
  console.log(`Mode: ${args.mode}`);
  console.log(`Strategy: ${args.strategy} (${config.strategyAvailable ? "available" : "missing"})`);
  console.log(`Provider: ${args.provider}`);
  console.log(`Model selection: provider=${modelSelection.provider}, model=${modelSelection.model ?? "provider default"}, source=${modelSelection.source}`);
  console.log(`Manifest source: ${manifest.generated ? ".ai/generated or inferred" : ".ai"}`);
  console.log(`Modules: ${manifest.modules.length}`);
  console.log(`Workflows: ${manifest.workflows.length}`);
  console.log(`Playbooks: ${manifest.playbooks.length}`);
  console.log(`Safety: sensitive_paths=${safety.sensitivePaths}, forbidden_commands=${safety.forbiddenCommands}`);
}

function printTools(args: ParsedArgs): void {
  const tools = listToolCatalog();
  if (args.json) {
    printJson({
      kind: "tools-list",
      tools
    });
    return;
  }

  console.log("Tools");
  for (const tool of tools) {
    console.log(`- ${tool.name} (${tool.risk}): ${tool.description}`);
  }
}

async function printToolRun(args: ParsedArgs): Promise<void> {
  const toolName = requireValue(args.toolName, "Missing tool name.");
  const tool = listToolCatalog().find((entry) => entry.name === toolName);
  if (!tool) {
    throw new Error(`Unknown tool "${toolName}".`);
  }

  const rawInput = args.toolInputFile ? await readFile(args.toolInputFile, "utf8") : args.task;
  const input = {
    ...parseToolJsonInput(rawInput),
    repoRoot: args.cwd
  };
  const policy = toolName === "test.run" ? evaluateTestRunPolicy(await loadRepoManifest(args.cwd), input) : evaluateToolPolicy(tool);
  const sessionManager = args.record ? new SessionManager() : undefined;
  const session = sessionManager?.create(args.cwd, { mode: args.mode, strategy: args.strategy });
  const eventLog = session && sessionManager ? sessionManager.createEventLog(session) : undefined;

  if (session && sessionManager && eventLog) {
    await eventLog.append(
      sessionManager.createEvent({
        type: "user.message",
        sessionId: session.id,
        message: `tools run ${toolName}`
      })
    );
    await eventLog.append(
      sessionManager.createEvent({
        type: "permission.checked",
        sessionId: session.id,
        decision: policy
      })
    );
  }

  if (!policy.allowed) {
    const errorMessage = policy.reasons[0] ?? `Tool "${toolName}" is blocked by policy.`;
    if (session && sessionManager && eventLog) {
      await eventLog.append(
        sessionManager.createEvent({
          type: "run.failed",
          sessionId: session.id,
          error: errorMessage
        })
      );
      await writeToolFailureReport(args, toolName, tool.risk, policy, session, eventLog.path, errorMessage);
    }
    throw new Error(errorMessage);
  }

  if (session && sessionManager && eventLog) {
    await eventLog.append(
      sessionManager.createEvent({
        type: "tool.started",
        sessionId: session.id,
        toolName,
        input: redactToolInput(input)
      })
    );
  }

  let output: unknown;
  try {
    output = await runTool(toolName, input);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (session && sessionManager && eventLog) {
      await eventLog.append(
        sessionManager.createEvent({
          type: "tool.finished",
          sessionId: session.id,
          toolName,
          ok: false,
          output: {
            error: errorMessage
          }
        })
      );
      await eventLog.append(
        sessionManager.createEvent({
          type: "run.failed",
          sessionId: session.id,
          error: errorMessage
        })
      );
      await writeToolFailureReport(args, toolName, tool.risk, policy, session, eventLog.path, errorMessage);
    }
    throw error;
  }

  if (session && sessionManager && eventLog) {
    await eventLog.append(
      sessionManager.createEvent({
        type: "tool.finished",
        sessionId: session.id,
        toolName,
        ok: true,
        output: summarizeToolOutput(output)
      })
    );
    await eventLog.append(
      sessionManager.createEvent({
        type: "run.completed",
        sessionId: session.id,
        summary: `Tool ${toolName} completed.`
      })
    );
  }

  if (args.json) {
    printJson({
      kind: "tool-run",
      tool: toolName,
      risk: tool.risk,
      ok: true,
      policy,
      output,
      session: session
        ? {
            id: session.id,
            logPath: eventLog?.path
          }
        : undefined
    });
    return;
  }

  console.log(`Tool: ${toolName}`);
  console.log(`Risk: ${tool.risk}`);
  console.log(`Policy: ${policy.allowed ? "allowed" : "blocked"}`);
  if (session) {
    console.log(`Session: ${session.id}`);
    console.log(`Log: ${eventLog?.path}`);
  }
  console.log(JSON.stringify(output, null, 2));
}

async function writeToolFailureReport(
  args: ParsedArgs,
  toolName: string,
  risk: "read" | "write" | "execute",
  policy: PermissionDecision,
  session: Session,
  eventLogPath: string,
  errorMessage: string
): Promise<void> {
  const [repo, manifest] = await Promise.all([scanRepo(args.cwd), loadRepoManifest(args.cwd)]);
  const plan: ExecutionPlan = {
    strategy: args.strategy,
    mode: args.mode,
    task: `tools run ${toolName}`,
    riskLevel: policy.severity,
    phases: [
      {
        id: "tool-policy",
        role: "orchestrator",
        title: "Tool policy check",
        description: `Evaluate whether ${toolName} can run directly from the CLI tool surface.`,
        required: true
      }
    ],
    requiredAgents: ["orchestrator"],
    handoffs: [],
    testCommands: [],
    notes: [`Tool risk: ${risk}`, `Policy: ${policy.allowed ? "allowed" : "blocked"}`]
  };

  await new RunReportStore(args.cwd).write({
    session,
    repo,
    manifest,
    plan,
    summary: `Run failed: ${errorMessage}`,
    eventLogPath,
    permissionDecisions: [policy],
    toolCalls: [
      {
        name: toolName,
        ok: false,
        inputSummary: "blocked before execution",
        outputSummary: errorMessage
      }
    ],
    changes: {
      patchProposalFiles: [],
      repairProposalFiles: [],
      appliedFiles: []
    }
  });
}

async function printPlanPreview(args: ParsedArgs): Promise<void> {
  const runtime = new TokenStreamingRuntime({
    repoRoot: args.cwd,
    mode: args.mode,
    strategy: args.strategy
  });
  const result = await runtime.previewPlan(args.task);

  if (args.json) {
    printJson({
      kind: "plan-preview",
      task: args.task,
      repo: summarizeRepo(result.repo),
      manifest: summarizeManifest(result.manifest),
      plan: result.plan,
      context: summarizeContext(result.context)
    });
    return;
  }

  console.log("Plan preview");
  console.log(`Repository: ${result.repo.root}`);
  console.log(`Mode: ${result.plan.mode}`);
  console.log(`Strategy: ${result.plan.strategy}`);
  console.log(`Risk: ${result.plan.riskLevel}`);
  console.log(`Manifest source: ${result.manifest.generated ? ".ai/generated or inferred" : ".ai"}`);
  console.log(`Modules: ${result.manifest.modules.length}`);
  console.log(`Workflows: ${result.manifest.workflows.length}`);
  console.log("");
  console.log("Phases:");
  for (const phase of result.plan.phases) {
    console.log(`- ${phase.id} (${phase.role}): ${phase.title}`);
  }
  console.log("");
  console.log("Required agents:");
  console.log(result.plan.requiredAgents.length ? result.plan.requiredAgents.map((agent) => `- ${agent}`).join("\n") : "- none");
  console.log("");
  console.log("Handoffs:");
  console.log(
    result.plan.handoffs.length
      ? result.plan.handoffs
          .map((handoff) => `- ${handoff.from} -> ${handoff.to ?? "final"}: ${handoff.artifact} (${handoff.description})`)
          .join("\n")
      : "- none"
  );
  console.log("");
  console.log("Verification commands:");
  console.log(result.plan.testCommands.length ? result.plan.testCommands.map((command) => `- ${command}`).join("\n") : "- none");
  console.log("");
  console.log("Relevant context:");
  console.log(`- modules: ${result.context.relevantModules.join(", ") || "none inferred"}`);
  console.log(`- workflows: ${result.context.relevantWorkflows.join(", ") || "none inferred"}`);
  console.log(`- source snippets: ${result.context.sourceSnippets.map((snippet) => snippet.path).join(", ") || "none"}`);
}

async function printContextInspection(args: ParsedArgs): Promise<void> {
  const runtime = new TokenStreamingRuntime({
    repoRoot: args.cwd,
    mode: args.mode,
    strategy: args.strategy
  });
  const result = await runtime.previewPlan(args.task);

  if (args.json) {
    printJson({
      kind: "context-inspection",
      task: args.task,
      repo: summarizeRepo(result.repo),
      manifest: summarizeManifest(result.manifest),
      plan: result.plan,
      context: result.context
    });
    return;
  }

  console.log("Context inspection");
  console.log(`Task: ${args.task}`);
  console.log(`Mode: ${result.plan.mode}`);
  console.log(`Strategy: ${result.plan.strategy}`);
  console.log(`Risk: ${result.plan.riskLevel}`);
  console.log(`Source snippets: ${result.context.sourceSnippets.length}`);
  console.log("");
  console.log(result.context.overview);
}

async function initializeManifest(repoRoot: string, args: ParsedArgs): Promise<void> {
  const repo = await scanRepo(repoRoot);
  const result = await scaffoldOfficialManifest(repoRoot, repo, { overwrite: args.force });
  if (args.json) {
    printJson({
      kind: "manifest-init",
      root: result.root,
      force: args.force,
      created: result.created,
      skipped: result.skipped
    });
    return;
  }

  console.log(`AI manifest initialized at ${result.root}`);
  console.log(`Created files: ${result.created.length > 0 ? result.created.join(", ") : "none"}`);
  console.log(`Skipped files: ${result.skipped.length > 0 ? result.skipped.join(", ") : "none"}`);
}

async function validateManifest(repoRoot: string, args: ParsedArgs): Promise<void> {
  const manifest = await loadRepoManifest(repoRoot);
  const result = await validateRepoManifest(repoRoot, manifest);
  const errors = result.issues.filter((issue) => issue.severity === "error").length;
  const warnings = result.issues.filter((issue) => issue.severity === "warning").length;

  if (args.json) {
    printJson({
      kind: "manifest-validation",
      ok: result.ok,
      counts: {
        errors,
        warnings
      },
      manifest: summarizeManifest(manifest),
      issues: result.issues
    });
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  console.log("Manifest validation");
  console.log(`Status: ${result.ok ? "ok" : "error"}`);
  console.log(`Issues: errors=${errors}, warnings=${warnings}`);
  if (result.issues.length > 0) {
    console.log("");
    for (const issue of result.issues) {
      console.log(formatManifestIssue(issue));
    }
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function printManifestGenerate(repoRoot: string, args: ParsedArgs): Promise<void> {
  const repo = await scanRepo(repoRoot);
  const result = await generateFallbackManifest(repoRoot, repo, { overwrite: args.force });
  const manifest = await loadRepoManifest(repoRoot);
  const validation = await validateRepoManifest(repoRoot, manifest);

  if (args.json) {
    printJson({
      kind: "manifest-generate",
      root: result.root,
      force: args.force,
      files: result.files,
      created: result.created,
      skipped: result.skipped,
      manifest: summarizeManifest(manifest),
      validation: summarizeManifestValidation(validation)
    });
    return;
  }

  console.log(`Generated fallback manifest at ${result.root}`);
  console.log(`Created files: ${result.created.length > 0 ? result.created.join(", ") : "none"}`);
  console.log(`Skipped files: ${result.skipped.length > 0 ? result.skipped.join(", ") : "none"}`);
  console.log(`Validation: ${validation.ok ? "ok" : "issues found"}`);
}

async function printManifestInspection(repoRoot: string, args: ParsedArgs): Promise<void> {
  const [repo, manifest] = await Promise.all([scanRepo(repoRoot), loadRepoManifest(repoRoot)]);
  const validation = await validateRepoManifest(repoRoot, manifest);
  const inspection = {
    kind: "manifest-inspection",
    source: manifest.generated ? ".ai/generated" : ".ai",
    officialManifestPresent: repo.aiManifestPresent,
    repo: summarizeRepo(repo),
    coverage: {
      project: Boolean(manifest.project),
      architecture: Boolean(manifest.architecture),
      conventions: Boolean(manifest.conventions),
      commands: Boolean(manifest.commands),
      tests: Boolean(manifest.tests),
      safety: Boolean(manifest.safety),
      models: Boolean(manifest.models),
      ownership: Boolean(manifest.ownership),
      glossary: Boolean(manifest.glossary),
      modules: manifest.modules.length,
      workflows: manifest.workflows.length,
      playbooks: manifest.playbooks.length
    },
    commandGroups: listManifestCommandGroups(manifest),
    modules: manifest.modules.map(summarizeModule),
    workflows: manifest.workflows.map(summarizeWorkflow),
    playbooks: listPlaybookSummaries(manifest),
    validation: summarizeManifestValidation(validation)
  };

  if (args.json) {
    printJson(inspection);
    return;
  }

  console.log("Manifest inspection");
  console.log(`Source: ${inspection.source}`);
  console.log(`Official manifest present: ${inspection.officialManifestPresent ? "yes" : "no"}`);
  console.log(`Coverage: modules=${inspection.coverage.modules}, workflows=${inspection.coverage.workflows}, playbooks=${inspection.coverage.playbooks}`);
  console.log(`Validation: ${validation.ok ? "ok" : "issues found"}`);
  for (const issue of validation.issues) {
    console.log(formatManifestIssue(issue));
  }
}

async function runManifestVerification(
  repoRoot: string,
  manifest: Awaited<ReturnType<typeof loadRepoManifest>>,
  args: ParsedArgs
): Promise<void> {
  const commands = stringArrayFromRecord(manifest.tests, "default");
  const results: Array<Record<string, unknown>> = [];
  const isJson = args.json;

  if (commands.length === 0 && !isJson) {
    console.log("Verification");
    console.log("No default verification commands found in .ai/tests.yaml.");
    process.exitCode = 1;
    return;
  }

  if (commands.length === 0 && isJson) {
    printJson({
      kind: "verification",
      ok: false,
      commands: [],
      results,
      error: "No default verification commands found in .ai/tests.yaml."
    });
    process.exitCode = 1;
    return;
  }

  if (isJson) {
    for (const command of commands) {
      const decision = evaluateCommandPolicy(manifest, command);
      if (!decision.allowed) {
        const approvalResponse = decision.requiresApproval ? await requestCliApproval(args, decision) : undefined;
        if (approvalResponse?.approved) {
          const result = await runTestCommand(repoRoot, command);
          const ok = result.exitCode === 0;
          results.push({
            command: result.command,
            policy: decision,
            approvalResponse,
            ok,
            exitCode: result.exitCode,
            outputSummary: summarizeCommandOutput(result.stdout, result.stderr)
          });
          if (!ok) {
            printJson({
              kind: "verification",
              ok: false,
              commands,
              results
            });
            process.exitCode = result.exitCode ?? 1;
            return;
          }
          continue;
        }

        results.push({
          command,
          policy: decision,
          approvalResponse,
          ok: false,
          blocked: true
        });
        printJson({
          kind: "verification",
          ok: false,
          commands,
          results
        });
        process.exitCode = 1;
        return;
      }

      const result = await runTestCommand(repoRoot, command);
      const ok = result.exitCode === 0;
      results.push({
        command: result.command,
        policy: decision,
        ok,
        exitCode: result.exitCode,
        outputSummary: summarizeCommandOutput(result.stdout, result.stderr)
      });
      if (!ok) {
        printJson({
          kind: "verification",
          ok: false,
          commands,
          results
        });
        process.exitCode = result.exitCode ?? 1;
        return;
      }
    }

    printJson({
      kind: "verification",
      ok: true,
      commands,
      results
    });
    return;
  }

  console.log("Verification");
  if (commands.length === 0) {
    console.log("No default verification commands found in .ai/tests.yaml.");
    process.exitCode = 1;
    return;
  }

  for (const command of commands) {
    const decision = evaluateCommandPolicy(manifest, command);
    if (!decision.allowed) {
      const approvalResponse = decision.requiresApproval ? await requestCliApproval(args, decision) : undefined;
      if (!approvalResponse?.approved) {
        console.log(`- blocked ${command}: ${approvalResponse?.reason ?? decision.reasons.join("; ")}`);
        process.exitCode = 1;
        return;
      }
      console.log(`- approved ${command}`);
    }

    console.log(`- running ${command}`);
    const result = await runTestCommand(repoRoot, command);
    console.log(`  exitCode: ${result.exitCode}`);
    const summary = summarizeCommandOutput(result.stdout, result.stderr);
    if (summary) {
      console.log(indent(summary, "  "));
    }
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode ?? 1;
      return;
    }
  }

  console.log("Status: ok");
}

async function requestCliApproval(args: ParsedArgs, decision: PermissionDecision): Promise<ApprovalResponse> {
  const request: ApprovalRequest = {
    id: createLocalId("apr"),
    target: decision.target,
    action: decision.action,
    severity: decision.severity,
    reasons: decision.reasons
  };
  return createApprovalHost(args.approval).requestApproval(request);
}

async function printModelStats(repoRoot: string, args: ParsedArgs): Promise<void> {
  const summary = await new TelemetryStore(repoRoot).summarizeModelCalls();
  if (args.json) {
    printJson({
      kind: "model-stats",
      summary
    });
    return;
  }

  if (summary.totalCalls === 0) {
    console.log("No model telemetry found.");
    return;
  }

  console.log(formatModelTelemetrySummary(summary));
}

function formatManifestIssue(issue: ManifestValidationIssue): string {
  const location = issue.path ? ` ${issue.path}` : "";
  return `- ${issue.severity.toUpperCase()} ${issue.code}${location}: ${issue.message}`;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function createLocalId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function summarizeRepo(repo: Awaited<ReturnType<typeof scanRepo>>): Record<string, unknown> {
  return {
    root: repo.root,
    packageManager: repo.packageManager,
    scripts: repo.scripts,
    sourceDirectories: repo.sourceDirectories,
    moduleManifestPaths: repo.moduleManifestPaths,
    workflowManifestPaths: repo.workflowManifestPaths,
    aiManifestPresent: repo.aiManifestPresent
  };
}

function summarizeManifest(manifest: Awaited<ReturnType<typeof loadRepoManifest>>): Record<string, unknown> {
  return {
    generated: manifest.generated,
    modules: manifest.modules.length,
    workflows: manifest.workflows.length,
    playbooks: manifest.playbooks.length,
    hasProject: Boolean(manifest.project),
    hasArchitecture: Boolean(manifest.architecture),
    hasConventions: Boolean(manifest.conventions),
    hasCommands: Boolean(manifest.commands),
    hasTests: Boolean(manifest.tests),
    hasSafety: Boolean(manifest.safety),
    hasModels: Boolean(manifest.models),
    hasOwnership: Boolean(manifest.ownership)
  };
}

function summarizeManifestValidation(result: Awaited<ReturnType<typeof validateRepoManifest>>): Record<string, unknown> {
  return {
    ok: result.ok,
    counts: {
      errors: result.issues.filter((issue) => issue.severity === "error").length,
      warnings: result.issues.filter((issue) => issue.severity === "warning").length
    },
    issues: result.issues
  };
}

function summarizeModule(module: ModuleManifest): Record<string, unknown> {
  return {
    name: module.name,
    path: module.path,
    description: module.description,
    owners: module.owners,
    publicApi: module.publicApi,
    dependsOn: module.dependsOn,
    usedBy: module.usedBy,
    testCommands: module.testCommands,
    rules: module.rules
  };
}

function summarizeContext(context: Awaited<ReturnType<TokenStreamingRuntime["previewPlan"]>>["context"]): Record<string, unknown> {
  return {
    relevantModules: context.relevantModules,
    relevantWorkflows: context.relevantWorkflows,
    selectionReasons: context.selectionReasons,
    testCommands: context.testCommands,
    sourceSnippets: context.sourceSnippets.map((snippet) => ({
      path: snippet.path,
      truncated: snippet.truncated,
      characters: snippet.content.length
    })),
    recentHistory: context.recentHistory
  };
}

function summarizeSafetyPolicy(safety: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    present: Boolean(safety),
    sensitivePaths: stringArrayFromRecord(safety, "sensitive_paths").length,
    forbiddenCommands: stringArrayFromRecord(safety, "forbidden_commands").length,
    approvalRequiredCommands: stringArrayFromRecord(safety, "approval_required_commands").length,
    requiresReview: stringArrayFromRecord(safety, "requires_review").length,
    protectedPatterns: stringArrayFromRecord(safety, "protected_patterns").length
  };
}

function resolveEffectiveProvider(provider: ProviderName): "stub" | "openai" {
  if (provider === "openai") {
    return "openai";
  }
  if (provider === "stub") {
    return "stub";
  }
  return process.env.OPENAI_API_KEY ? "openai" : "stub";
}

function parseToolJsonInput(raw: string): Record<string, unknown> {
  if (raw === "summarize this repository") {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Tool input must be a JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool input must be a JSON object.");
  }

  return parsed as Record<string, unknown>;
}

function evaluateTestRunPolicy(manifest: Awaited<ReturnType<typeof loadRepoManifest>>, input: Record<string, unknown>): PermissionDecision {
  const command = stringOrUndefined(input.command);
  if (!command) {
    return {
      target: "tool",
      action: "test.run",
      allowed: false,
      severity: "medium",
      reasons: ['Tool input requires non-empty string field "command".'],
      requiresApproval: false
    };
  }

  const declaredCommands = listDeclaredTestCommands(manifest);
  if (!declaredCommands.includes(command)) {
    return {
      target: "tool",
      action: "test.run",
      allowed: false,
      severity: "medium",
      reasons: [`Test command is not declared in .ai/tests.yaml, module.yaml, or flow.yaml: ${command}`],
      requiresApproval: false
    };
  }

  const commandDecision = evaluateCommandPolicy(manifest, command);
  if (!commandDecision.allowed) {
    return {
      ...commandDecision,
      target: "tool",
      action: "test.run",
      reasons: commandDecision.reasons
    };
  }

  return {
    target: "tool",
    action: "test.run",
    allowed: true,
    severity: "medium",
    reasons: [`Manifest-declared test command approved: ${command}`],
    requiresApproval: false
  };
}

function listDeclaredTestCommands(manifest: Awaited<ReturnType<typeof loadRepoManifest>>): string[] {
  return [
    ...stringArrayFromRecord(manifest.tests, "default"),
    ...manifest.modules.flatMap((module) => module.testCommands),
    ...manifest.workflows.flatMap((workflow) => workflow.testCommands)
  ].filter((command, index, commands) => command.trim().length > 0 && commands.indexOf(command) === index);
}

function redactToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const { repoRoot: _repoRoot, ...rest } = input;
  return rest;
}

function summarizeToolOutput(output: unknown): unknown {
  if (!output || typeof output !== "object") {
    return output;
  }

  const record = output as Record<string, unknown>;
  if (typeof record.content === "string") {
    return {
      ...record,
      content: summarizeText(record.content)
    };
  }
  if (typeof record.diff === "string") {
    return {
      ...record,
      diff: summarizeText(record.diff)
    };
  }
  if (typeof record.status === "string") {
    return {
      ...record,
      status: summarizeText(record.status)
    };
  }
  return output;
}

function summarizeText(value: string): string {
  return value.length <= 1_200 ? value : `${value.slice(0, 1_200)}\n... output truncated ...`;
}

function summarizePatchProposal(proposal: PatchProposal): Record<string, unknown> {
  return {
    summary: proposal.summary,
    files: proposal.files.map((file) => ({
      path: file.path,
      characters: file.content.length
    }))
  };
}

function summarizeCheckpoint(checkpoint: Checkpoint): Record<string, unknown> {
  return {
    id: checkpoint.id,
    createdAt: checkpoint.createdAt,
    fileCount: checkpoint.files.length,
    files: checkpoint.files.map((file) => ({
      path: file.path,
      existed: file.content !== null
    }))
  };
}

function summarizeCheckpointDetail(checkpoint: Checkpoint): Record<string, unknown> {
  return {
    id: checkpoint.id,
    createdAt: checkpoint.createdAt,
    fileCount: checkpoint.files.length,
    files: checkpoint.files.map((file) => ({
      path: file.path,
      existed: file.content !== null,
      characters: file.content?.length ?? 0,
      preview: file.content ? shorten(file.content.replace(/\r?\n/g, "\\n"), 120) : undefined
    }))
  };
}

function summarizeToolCatalog(tools: ReturnType<typeof listToolCatalog>): {
  total: number;
  names: string[];
  byRisk: { read: number; write: number; execute: number };
} {
  return {
    total: tools.length,
    names: tools.map((tool) => tool.name),
    byRisk: {
      read: tools.filter((tool) => tool.risk === "read").length,
      write: tools.filter((tool) => tool.risk === "write").length,
      execute: tools.filter((tool) => tool.risk === "execute").length
    }
  };
}

function stringArrayFromRecord(record: Record<string, unknown> | undefined, key: string): string[] {
  const value = record?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function summarizeCommandOutput(stdout: string, stderr: string): string {
  const output = `${stdout}\n${stderr}`.trim();
  if (output.length <= 1_200) {
    return output;
  }
  return `${output.slice(0, 1_200)}\n... output truncated ...`;
}

function indent(value: string, prefix: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatModelTelemetrySummary(summary: ModelTelemetrySummary): string {
  return [
    "Model telemetry",
    `Total sessions: ${summary.totalSessions}`,
    `Completed sessions: ${summary.completedSessions}`,
    `Running sessions: ${summary.runningSessions}`,
    `Total calls: ${summary.totalCalls}`,
    `Failed sessions: ${summary.failedSessions}`,
    `Failure rate: ${formatRate(summary.failureRate)}`,
    `Total tokens: input=${summary.totalInputTokens}, output=${summary.totalOutputTokens}`,
    `Total response characters: ${summary.totalResponseCharacters}`,
    "",
    "By provider:",
    ...formatTelemetryGroups(summary.byProvider),
    "",
    "By model:",
    ...formatTelemetryGroups(summary.byModel),
    "",
    "By mode:",
    ...formatTelemetryGroups(summary.byMode),
    "",
    "By purpose:",
    ...formatTelemetryGroups(summary.byPurpose),
    "",
    "By failure category:",
    ...summary.byFailureCategory.map((group) => `- ${group.key}: sessions=${group.sessions}`),
    "",
    "Recommendations:",
    ...formatModelRecommendations(summary.recommendations)
  ].join("\n");
}

function formatTelemetryGroups(groups: ModelTelemetryGroup[]): string[] {
  return groups.map(
    (group) =>
      `- ${group.key}: sessions=${group.sessions}, failed=${group.failedSessions}, failureRate=${formatRate(group.failureRate)}, calls=${group.calls}, input=${group.inputTokens}, output=${group.outputTokens}, chars=${group.responseCharacters}`
  );
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatModelRecommendations(recommendations: ModelTelemetryRecommendation[]): string[] {
  if (recommendations.length === 0) {
    return ["- none"];
  }
  return recommendations.slice(0, 8).map((item) =>
    [
      `- ${item.mode}/${item.purpose}/${item.taskKind}: ${item.provider}/${item.model}`,
      `recommendation=${item.recommendation}`,
      `confidence=${item.confidence}`,
      `score=${item.efficiencyScore}`,
      `sessions=${item.sessions}`,
      `failureRate=${formatRate(item.failureRate)}`,
      `avgTokens=${item.averageTokens}`
    ].join(", ")
  );
}

async function printModelSelection(args: ParsedArgs, manifest: Awaited<ReturnType<typeof loadRepoManifest>>): Promise<void> {
  const telemetry = await new TelemetryStore(args.cwd).summarizeModelCalls();
  const selection = resolveModelSelection({
    mode: args.mode,
    requestedProvider: args.provider,
    requestedModel: args.model,
    manifest,
    telemetry,
    task: args.task
  });
  const policy = manifest.models ?? {};

  if (args.json) {
    printJson({
      kind: "model-selection",
      mode: args.mode,
      task: args.task,
      request: {
        provider: args.provider,
        model: args.model
      },
      selection,
      manifest: summarizeManifest(manifest),
      policy: {
        default_provider: stringOrUndefined(policy.default_provider),
        economy_model: stringOrUndefined(policy.economy_model),
        auto_model: stringOrUndefined(policy.auto_model),
        max_model: stringOrUndefined(policy.max_model),
        default_model: stringOrUndefined(policy.default_model),
        model_candidates: stringArrayFromRecord(policy, "model_candidates")
      },
      telemetry: {
        totalSessions: telemetry.totalSessions,
        totalCalls: telemetry.totalCalls,
        byModel: telemetry.byModel,
        recommendations: telemetry.recommendations
      }
    });
    return;
  }

  console.log("Model selection");
  console.log(`Mode: ${args.mode}`);
  console.log(`Task: ${args.task}`);
  console.log(`Requested provider: ${args.provider}`);
  console.log(`Requested model: ${args.model ?? "none"}`);
  console.log(`Selected provider: ${selection.provider}`);
  console.log(`Selected model: ${selection.model ?? "provider default"}`);
  console.log(`Source: ${selection.source}`);
  if (selection.scoring) {
    console.log(`Routing objective: ${selection.scoring.objective}`);
    console.log(`Routing risk: ${selection.scoring.riskLevel}`);
    console.log("Scored candidates:");
    for (const candidate of selection.scoring.candidates) {
      console.log(
        `- ${candidate.model}: score=${candidate.score}, provider=${candidate.provider}, failureRate=${formatRate(candidate.failureRate)}, source=${candidate.source}, feedback=${candidate.feedback?.recommendation ?? "none"}`
      );
    }
  }
  console.log("");
  console.log("Manifest policy:");
  console.log(`- default_provider: ${formatPolicyValue(policy.default_provider)}`);
  console.log(`- economy_model: ${formatPolicyValue(policy.economy_model)}`);
  console.log(`- auto_model: ${formatPolicyValue(policy.auto_model)}`);
  console.log(`- max_model: ${formatPolicyValue(policy.max_model)}`);
  console.log(`- default_model: ${formatPolicyValue(policy.default_model)}`);
  console.log(`- model_candidates: ${stringArrayFromRecord(policy, "model_candidates").join(" | ") || "unset"}`);
}

async function printModelDoctor(repoRoot: string, args: ParsedArgs, manifest: Awaited<ReturnType<typeof loadRepoManifest>>): Promise<void> {
  const result = await diagnoseModelProvider({
    mode: args.mode,
    requestedProvider: args.provider,
    requestedModel: args.model,
    manifest,
    probe: args.probe
  });
  if (args.json) {
    printJson({
      kind: "model-doctor",
      ok: result.ok,
      repoRoot,
      mode: args.mode,
      request: {
        provider: args.provider,
        model: args.model,
        probe: args.probe
      },
      selection: result.selection,
      effectiveProvider: result.effectiveProvider,
      counts: countModelDoctorChecks(result),
      checks: result.checks
    });
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  console.log(formatModelDoctorResult(repoRoot, result));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function printRepoDoctor(args: ParsedArgs, manifest: Awaited<ReturnType<typeof loadRepoManifest>>): Promise<void> {
  const [repo, manifestValidation, modelDoctor, gitStatus, sessions, reports, checkpoints] = await Promise.all([
    scanRepo(args.cwd),
    validateRepoManifest(args.cwd, manifest),
    diagnoseModelProvider({
      mode: args.mode,
      requestedProvider: args.provider,
      requestedModel: args.model,
      manifest,
      probe: args.probe
    }),
    getGitStatus(args.cwd),
    new SessionHistoryStore(args.cwd).list(),
    new RunReportStore(args.cwd).list(),
    new CheckpointStore(args.cwd).list()
  ]);
  const manifestErrors = manifestValidation.issues.filter((issue) => issue.severity === "error").length;
  const manifestWarnings = manifestValidation.issues.filter((issue) => issue.severity === "warning").length;
  const modelErrors = modelDoctor.checks.filter((check) => check.status === "error").length;
  const modelWarnings = modelDoctor.checks.filter((check) => check.status === "warning").length;
  const modelSkipped = modelDoctor.checks.filter((check) => check.status === "skipped").length;
  const toolSummary = summarizeToolCatalog(listToolCatalog());
  const latestCommands = buildLatestInspectionCommands();
  const liveSmoke = buildLiveSmokeReadiness(args, modelDoctor);
  const ok = manifestValidation.ok && modelDoctor.ok;

  if (args.json) {
    printJson({
      kind: "repository-doctor",
      ok,
      repo: summarizeRepo(repo),
      manifest: {
        ok: manifestValidation.ok,
        summary: summarizeManifest(manifest),
        counts: {
          errors: manifestErrors,
          warnings: manifestWarnings
        },
        issues: manifestValidation.issues
      },
      models: {
        ok: modelDoctor.ok,
        selection: modelDoctor.selection,
        effectiveProvider: modelDoctor.effectiveProvider,
        counts: {
          errors: modelErrors,
          warnings: modelWarnings,
          skipped: modelSkipped
        },
        checks: modelDoctor.checks
      },
      liveSmoke,
      git: {
        clean: gitStatus.length === 0,
        status: gitStatus
      },
      storage: {
        sessions: sessions.length,
        reports: reports.length,
        checkpoints: checkpoints.length,
        latestSessionId: sessions[0]?.sessionId,
        latestSession: sessions[0],
        latestReportSessionId: reports[0]?.sessionId,
        latestReport: reports[0],
        latestCheckpointId: checkpoints[0]?.id,
        latestCommands
      },
      tools: toolSummary
    });
    if (!ok) {
      process.exitCode = 1;
    }
    return;
  }

  console.log("Repository doctor");
  console.log(`Status: ${ok ? "ok" : "error"}`);
  console.log(`Repository: ${repo.root}`);
  console.log(`Package manager: ${repo.packageManager ?? "unknown"}`);
  console.log(`Scripts: ${Object.keys(repo.scripts).join(", ") || "none"}`);
  console.log(`Source directories: ${repo.sourceDirectories.join(", ") || "none detected"}`);
  console.log(`Modules: ${manifest.modules.length}`);
  console.log(`Workflows: ${manifest.workflows.length}`);
  console.log(`Playbooks: ${manifest.playbooks.length}`);
  console.log("");
  console.log("Manifest:");
  console.log(`- status: ${manifestValidation.ok ? "ok" : "error"}`);
  console.log(`- issues: errors=${manifestErrors}, warnings=${manifestWarnings}`);
  for (const issue of manifestValidation.issues) {
    console.log(formatManifestIssue(issue));
  }
  console.log("");
  console.log("Models:");
  console.log(`- status: ${modelDoctor.ok ? "ok" : "error"}`);
  console.log(`- selection: provider=${modelDoctor.selection.provider}, model=${modelDoctor.selection.model ?? "provider default"}, source=${modelDoctor.selection.source}`);
  console.log(`- effective provider: ${modelDoctor.effectiveProvider}`);
  console.log(`- issues: errors=${modelErrors}, warnings=${modelWarnings}, skipped=${modelSkipped}`);
  for (const check of modelDoctor.checks) {
    console.log(`- ${check.status.toUpperCase()} ${check.name}: ${check.message}`);
  }
  console.log("");
  console.log("OpenAI live smoke:");
  console.log(`- status: ${liveSmoke.status}`);
  console.log(`- verified: ${liveSmoke.verified ? "yes" : "no"}`);
  console.log(`- command: ${liveSmoke.command}`);
  console.log(`- message: ${liveSmoke.message}`);
  console.log("");
  console.log("Git:");
  console.log(gitStatus ? gitStatus : "clean");
  console.log("");
  console.log("Storage:");
  console.log(`- sessions: ${sessions.length}`);
  console.log(`- reports: ${reports.length}`);
  console.log(`- checkpoints: ${checkpoints.length}`);
  console.log(`- latest session: ${latestCommands.session}`);
  console.log(`- latest report: ${latestCommands.report}`);
  console.log(`- latest checkpoint: ${latestCommands.checkpoint}`);
  console.log("");
  console.log("Tools:");
  console.log(`- total: ${toolSummary.total}`);
  console.log(`- read: ${toolSummary.byRisk.read}`);
  console.log(`- write: ${toolSummary.byRisk.write}`);
  console.log(`- execute: ${toolSummary.byRisk.execute}`);

  if (!ok) {
    process.exitCode = 1;
  }
}

function buildLatestInspectionCommands(): { session: string; report: string; checkpoint: string } {
  return {
    session: "token-streaming sessions show latest --json",
    report: "token-streaming reports show latest --json",
    checkpoint: "token-streaming checkpoints show latest --json"
  };
}

function buildLiveSmokeReadiness(args: ParsedArgs, modelDoctor: ModelDoctorResult): LiveSmokeReadiness {
  const command = "npx pnpm@9.15.0 smoke:openai";
  const probe = modelDoctor.checks.find((check) => check.name === "probe");
  const hasApiKey = Boolean(process.env.OPENAI_API_KEY);
  const verified = Boolean(args.probe && modelDoctor.effectiveProvider === "openai" && probe?.status === "ok");
  const failed = Boolean(args.probe && modelDoctor.effectiveProvider === "openai" && probe?.status === "error");

  if (verified) {
    return {
      provider: "openai",
      command,
      status: "verified",
      verified: true,
      requiredEnv: ["OPENAI_API_KEY"],
      message: "OpenAI live probe completed successfully.",
      lastProbeStatus: probe?.status
    };
  }

  if (failed) {
    return {
      provider: "openai",
      command,
      status: "failed",
      verified: false,
      requiredEnv: ["OPENAI_API_KEY"],
      message: probe?.message ?? "OpenAI live probe failed.",
      lastProbeStatus: probe?.status
    };
  }

  if (!hasApiKey) {
    return {
      provider: "openai",
      command,
      status: "missing-api-key",
      verified: false,
      requiredEnv: ["OPENAI_API_KEY"],
      message: "OPENAI_API_KEY is not set, so the OpenAI live smoke test cannot run.",
      lastProbeStatus: probe?.status
    };
  }

  return {
    provider: "openai",
    command,
    status: "ready",
    verified: false,
    requiredEnv: ["OPENAI_API_KEY"],
    message: "OPENAI_API_KEY is available. Run the smoke command to verify the live OpenAI path.",
    lastProbeStatus: probe?.status
  };
}

function formatPolicyValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "not set";
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatModelDoctorResult(repoRoot: string, result: ModelDoctorResult): string {
  return [
    "Model doctor",
    `Repository: ${repoRoot}`,
    `Selection: provider=${result.selection.provider}, model=${result.selection.model ?? "provider default"}, source=${result.selection.source}`,
    `Effective provider: ${result.effectiveProvider}`,
    `Status: ${result.ok ? "ok" : "error"}`,
    "",
    ...result.checks.map((check) => `- ${check.status} ${check.name}: ${check.message}`)
  ].join("\n");
}

function countModelDoctorChecks(result: ModelDoctorResult): Record<string, number> {
  return {
    errors: result.checks.filter((check) => check.status === "error").length,
    warnings: result.checks.filter((check) => check.status === "warning").length,
    skipped: result.checks.filter((check) => check.status === "skipped").length,
    ok: result.checks.filter((check) => check.status === "ok").length
  };
}

function formatSessionSummary(session: SessionHistorySummary): string {
  return [
    session.sessionId,
    `status=${session.status}`,
    `events=${session.eventCount}`,
    `last=${session.lastEventAt ?? "unknown"}`,
    session.error ? `error="${shorten(session.error, 80)}"` : undefined,
    session.task ? `task="${shorten(session.task, 80)}"` : undefined
  ]
    .filter(Boolean)
    .join("  ");
}

function formatCheckpoint(checkpoint: Checkpoint): string {
  const paths = checkpoint.files.map((file) => `${file.path}${file.content === null ? " (new)" : ""}`).join(", ");
  return `${checkpoint.id}  created=${checkpoint.createdAt}  files=${paths || "none"}`;
}

function formatEvent(event: SessionEvent): string {
  const prefix = `${event.timestamp}  ${event.type}`;
  if (event.type === "user.message") {
    return `${prefix}  ${shorten(event.message, 120)}`;
  }
  if (event.type === "plan.created") {
    return `${prefix}  risk=${event.plan.riskLevel} phases=${event.plan.phases.map((phase) => phase.id).join(",")} handoffs=${
      event.plan.handoffs.length
    }`;
  }
  if (event.type === "manifest.loaded") {
    return `${prefix}  modules=${event.manifest.moduleCount} workflows=${event.manifest.workflowCount} generated=${event.manifest.generated}`;
  }
  if (event.type === "patch.proposed") {
    return `${prefix}  files=${event.files.join(", ") || "none"}`;
  }
  if (event.type === "checkpoint.created") {
    return `${prefix}  checkpoint=${event.checkpointId} files=${event.files.join(", ") || "none"}`;
  }
  if (event.type === "patch.applied") {
    return `${prefix}  checkpoint=${event.checkpointId ?? "unknown"} files=${event.files.join(", ") || "none"}`;
  }
  if (event.type === "permission.checked") {
    return `${prefix}  ${event.decision.target}:${event.decision.allowed ? "allowed" : "blocked"} ${event.decision.action}`;
  }
  if (event.type === "approval.resolved") {
    return `${prefix}  ${event.response.mode}:${event.response.approved ? "approved" : "rejected"}`;
  }
  if (event.type === "model.called") {
    return `${prefix}  ${event.call.purpose} ${event.call.provider}${event.call.model ? `/${event.call.model}` : ""} ${
      event.call.reasoningEffort ?? "default"
    } chars=${event.call.responseCharacters}`;
  }
  if (event.type === "tests.finished") {
    return `${prefix}  ${event.command ?? "unknown"} => ${event.exitCode ?? "unknown"}`;
  }
  if (event.type === "review.completed") {
    return `${prefix}  ${event.review.verificationStatus} risk=${event.review.riskLevel} recommendation=${shorten(event.review.recommendation, 80)}`;
  }
  if (event.type === "run.completed") {
    return `${prefix}  ${shorten(event.summary, 120)}`;
  }
  if (event.type === "run.failed") {
    return `${prefix}  ${shorten(event.error, 120)}`;
  }
  return prefix;
}

function requireValue(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function shorten(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (activeArgs?.json) {
    printJson({
      kind: "error",
      command: activeArgs.command,
      message,
      artifacts: await buildErrorArtifacts(activeArgs, message)
    });
  } else {
    console.error(message);
  }
  process.exitCode = 1;
});

async function buildErrorArtifacts(
  args: ParsedArgs,
  message: string
): Promise<
  | {
      sessionId: string;
      eventLogPath: string;
      reportPath?: string;
      commands: {
        session: string;
        report?: string;
      };
    }
  | undefined
> {
  try {
    const sessionStore = new SessionHistoryStore(args.cwd);
    const latestSession = (await sessionStore.list())[0];
    if (!latestSession) {
      return undefined;
    }

    const events = await sessionStore.read(latestSession.sessionId);
    const failure = [...events].reverse().find((event) => event.type === "run.failed");
    if (!failure || !messagesReferToSameFailure(failure.error, message)) {
      return undefined;
    }

    const report = (await new RunReportStore(args.cwd).list()).find((entry) => entry.sessionId === latestSession.sessionId);
    return {
      sessionId: latestSession.sessionId,
      eventLogPath: latestSession.logPath,
      reportPath: report?.path,
      commands: {
        session: `token-streaming sessions show ${latestSession.sessionId} --json`,
        report: report ? `token-streaming reports show ${latestSession.sessionId} --json` : undefined
      }
    };
  } catch {
    return undefined;
  }
}

function messagesReferToSameFailure(recorded: string, surfaced: string): boolean {
  return recorded === surfaced || recorded.includes(surfaced) || surfaced.includes(recorded);
}

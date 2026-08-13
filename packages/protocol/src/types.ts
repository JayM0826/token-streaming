export type ProductMode = "economy" | "max" | "auto";

export type AgentRole = "orchestrator" | "researcher" | "coder" | "tester" | "reviewer";

export type StrategyId = "default" | (string & {});

export interface Session {
  id: string;
  repoRoot: string;
  startedAt: string;
  mode: ProductMode;
  strategy: StrategyId;
}

export type SessionEvent =
  | RunStartedEvent
  | UserMessageEvent
  | RepoScannedEvent
  | ManifestLoadedEvent
  | ContextBuiltEvent
  | PlanCreatedEvent
  | AgentStartedEvent
  | AgentFinishedEvent
  | PermissionCheckedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ModelCalledEvent
  | ToolStartedEvent
  | ToolFinishedEvent
  | PatchProposedEvent
  | PatchAppliedEvent
  | TestsFinishedEvent
  | ReviewCompletedEvent
  | CheckpointCreatedEvent
  | RunCompletedEvent
  | RunFailedEvent;

export interface BaseEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  type: string;
}

export interface RunStartedEvent extends BaseEvent {
  type: "run.started";
  task: string;
  repoRoot: string;
  mode: ProductMode;
  strategy: StrategyId;
}

export interface UserMessageEvent extends BaseEvent {
  type: "user.message";
  message: string;
}

export interface RepoScannedEvent extends BaseEvent {
  type: "repo.scanned";
  summary: RepoSummary;
}

export interface ManifestLoadedEvent extends BaseEvent {
  type: "manifest.loaded";
  manifest: LoadedManifestSummary;
}

export interface ContextBuiltEvent extends BaseEvent {
  type: "context.built";
  relevantModules: string[];
  relevantWorkflows: string[];
  sourceFiles: string[];
  testCommands: string[];
  recentHistoryCount: number;
}

export interface PlanCreatedEvent extends BaseEvent {
  type: "plan.created";
  plan: ExecutionPlan;
}

export interface AgentStartedEvent extends BaseEvent {
  type: "agent.started";
  role: AgentRole;
  phaseId: string;
  artifact: string;
}

export interface AgentFinishedEvent extends BaseEvent {
  type: "agent.finished";
  role: AgentRole;
  phaseId: string;
  artifact: string;
  ok: boolean;
  summary: string;
}

export interface PermissionCheckedEvent extends BaseEvent {
  type: "permission.checked";
  decision: PermissionDecision;
}

export interface ApprovalRequestedEvent extends BaseEvent {
  type: "approval.requested";
  request: ApprovalRequest;
}

export interface ApprovalResolvedEvent extends BaseEvent {
  type: "approval.resolved";
  response: ApprovalResponse;
}

export interface ModelCalledEvent extends BaseEvent {
  type: "model.called";
  call: ModelCallRecord;
}

export interface ToolStartedEvent extends BaseEvent {
  type: "tool.started";
  toolName: string;
  input: unknown;
}

export interface ToolFinishedEvent extends BaseEvent {
  type: "tool.finished";
  toolName: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface PatchProposedEvent extends BaseEvent {
  type: "patch.proposed";
  files: string[];
  proposal?: PatchProposal;
}

export interface PatchAppliedEvent extends BaseEvent {
  type: "patch.applied";
  files: string[];
  checkpointId?: string;
}

export interface TestsFinishedEvent extends BaseEvent {
  type: "tests.finished";
  ok: boolean;
  command?: string;
  exitCode?: number;
  outputSummary?: string;
}

export interface ReviewCompletedEvent extends BaseEvent {
  type: "review.completed";
  review: ReviewSummary;
}

export interface CheckpointCreatedEvent extends BaseEvent {
  type: "checkpoint.created";
  checkpointId: string;
  files: string[];
}

export interface RunCompletedEvent extends BaseEvent {
  type: "run.completed";
  summary: string;
}

export interface RunFailedEvent extends BaseEvent {
  type: "run.failed";
  error: string;
}

export interface RepoSummary {
  root: string;
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
  scripts: Record<string, string>;
  trackedFiles: string[];
  sourceDirectories: string[];
  moduleManifestPaths: string[];
  workflowManifestPaths: string[];
  aiManifestPresent: boolean;
  verificationCommands?: string[];
}

export interface LoadedManifestSummary {
  hasRootManifest: boolean;
  moduleCount: number;
  workflowCount: number;
  playbookCount: number;
  generated: boolean;
}

export interface RepoManifest {
  project?: string;
  architecture?: string;
  conventions?: string;
  commands?: Record<string, unknown>;
  tests?: Record<string, unknown>;
  safety?: Record<string, unknown>;
  models?: Record<string, unknown>;
  ownership?: Record<string, unknown>;
  glossary?: string;
  playbooks: PlaybookManifest[];
  modules: ModuleManifest[];
  workflows: WorkflowManifest[];
  generated: boolean;
}

export interface PlaybookManifest {
  name: string;
  path: string;
  content: string;
}

export interface ModuleManifest {
  path: string;
  generated?: boolean;
  name: string;
  description?: string;
  owners: string[];
  publicApi: string[];
  dependsOn: string[];
  usedBy: string[];
  testCommands: string[];
  rules: string[];
}

export interface WorkflowManifest {
  path: string;
  generated?: boolean;
  name: string;
  description?: string;
  steps: string[];
  touches: string[];
  testCommands: string[];
  risks: string[];
}

export interface StrategyInput {
  task: string;
  mode: ProductMode;
  repo: RepoSummary;
  manifest: RepoManifest;
}

export interface ExecutionPlan {
  strategy: StrategyId;
  mode: ProductMode;
  task: string;
  riskLevel: "low" | "medium" | "high";
  phases: ExecutionPhase[];
  requiredAgents: AgentRole[];
  handoffs: AgentHandoff[];
  testCommands: string[];
  notes: string[];
}

export interface ExecutionPhase {
  id: string;
  role: AgentRole;
  title: string;
  description: string;
  required: boolean;
}

export interface AgentHandoff {
  from: AgentRole;
  to?: AgentRole;
  artifact: string;
  description: string;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  risk: "read" | "write" | "execute";
  run(input: Input): Promise<Output>;
}

export interface PatchProposal {
  summary: string;
  files: ProposedFilePatch[];
}

export interface ProposedFilePatch {
  path: string;
  content: string;
}

export interface VerificationResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  outputSummary: string;
}

export interface ReviewSummary {
  riskLevel: ExecutionPlan["riskLevel"];
  verificationStatus: "not-run" | "passed" | "failed";
  hasRepositoryChanges: boolean;
  appliedFiles: string[];
  permissionChecks: number;
  approvals: number;
  findings: string[];
  recommendation: string;
}

export interface PermissionDecision {
  target: "patch" | "command" | "tool";
  action: string;
  allowed: boolean;
  severity: "low" | "medium" | "high";
  reasons: string[];
  requiresApproval: boolean;
}

export interface ApprovalRequest {
  id: string;
  target: PermissionDecision["target"];
  action: string;
  severity: PermissionDecision["severity"];
  reasons: string[];
}

export interface ApprovalResponse {
  requestId: string;
  approved: boolean;
  mode: "deny" | "allow" | "prompt";
  reason?: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  mode: ProductMode;
  reasoningEffort?: "low" | "medium" | "high";
  maxOutputTokens?: number;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ModelResponse {
  content: string;
  model?: string;
  provider?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface ModelProvider {
  name: string;
  generate(input: ModelRequest): Promise<ModelResponse>;
}

export type ModelCallPurpose = "planning" | "repair" | "agent";

export interface ModelCallRecord {
  purpose: ModelCallPurpose;
  provider: string;
  model?: string;
  mode: ProductMode;
  reasoningEffort?: ModelRequest["reasoningEffort"];
  inputTokens?: number;
  outputTokens?: number;
  responseCharacters: number;
}

export interface Checkpoint {
  id: string;
  createdAt: string;
  files: CheckpointFile[];
}

export interface CheckpointFile {
  path: string;
  content: string | null;
}

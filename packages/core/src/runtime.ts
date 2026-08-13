import path from "node:path";
import { generateFallbackManifest, loadRepoManifest } from "@token-streaming/ai-manifest";
import type {
  AgentRole,
  ApprovalResponse,
  ExecutionPlan,
  ModelCallPurpose,
  ModelCallRecord,
  ModelRequest,
  ModelProvider,
  ModelResponse,
  PatchProposal,
  PermissionDecision,
  ProductMode,
  RepoManifest,
  RepoSummary,
  ReviewSummary,
  Session,
  SessionEvent,
  StrategyId,
  VerificationResult
} from "@token-streaming/protocol";
import { StubModelProvider } from "@token-streaming/providers";
import { CheckpointStore, RunReportStore, SessionHistoryStore, type ToolCallSummary } from "@token-streaming/storage";
import { applyFilePatches, getGitDiff, getGitStatus, parsePatchProposal, runTool, scanRepo, type CommandResult } from "@token-streaming/tools";
import { buildRuntimeContext, type RecentHistoryItem, type RuntimeContextBundle } from "./context/context-builder.js";
import { buildRepairPrompt, buildRuntimePrompt } from "./context/prompt-builder.js";
import { resolveModeProfile, type ModeProfile } from "./modes/mode-profile.js";
import { DenyApprovalHost, type ApprovalHost } from "./permissions/approval.js";
import { evaluateCommandPolicy, evaluatePatchPolicy } from "./permissions/policy.js";
import { SessionManager } from "./session/session-manager.js";
import { StrategyRegistry } from "./strategy/registry.js";
import type { OrchestrationStrategy } from "./strategy/types.js";

export interface RuntimeOptions {
  repoRoot: string;
  mode?: ProductMode;
  strategy?: StrategyId;
  strategies?: OrchestrationStrategy[];
  modelProvider?: ModelProvider;
  approvalHost?: ApprovalHost;
}

export interface RunTaskOptions {
  task: string;
  dryRun?: boolean;
  apply?: boolean;
  repair?: boolean;
  parallelAgents?: boolean;
  allowSensitive?: boolean;
  patchProposalText?: string;
}

export interface AgentRunResult {
  role: AgentRole;
  phaseId: string;
  artifact: string;
  ok: boolean;
  summary: string;
}

export interface RunTaskResult {
  session: Session;
  repo: RepoSummary;
  manifest: RepoManifest;
  plan: ExecutionPlan;
  summary: string;
  eventLogPath: string;
  reportPath: string;
  patchProposal?: PatchProposal;
  repairPatchProposal?: PatchProposal;
  appliedFiles: string[];
  verificationResults: VerificationResult[];
  permissionDecisions: PermissionDecision[];
  approvalResponses: ApprovalResponse[];
  modelCalls: ModelCallRecord[];
  agentRuns: AgentRunResult[];
  review: ReviewSummary;
  context: RuntimeContextBundle;
}

export interface PlanPreviewResult {
  repo: RepoSummary;
  manifest: RepoManifest;
  plan: ExecutionPlan;
  context: RuntimeContextBundle;
}

export class TokenStreamingRuntime {
  private readonly sessionManager = new SessionManager();
  private readonly strategy: OrchestrationStrategy;
  private readonly modelProvider: ModelProvider;
  private readonly approvalHost: ApprovalHost;
  private readonly repoRoot: string;
  private readonly mode: ProductMode;
  private readonly modeProfile: ModeProfile;

  constructor(options: RuntimeOptions) {
    this.repoRoot = path.resolve(options.repoRoot);
    this.mode = options.mode ?? "auto";
    this.modeProfile = resolveModeProfile(this.mode);
    this.strategy = new StrategyRegistry(options.strategies).resolve(options.strategy ?? "default");
    this.modelProvider = options.modelProvider ?? new StubModelProvider();
    this.approvalHost = options.approvalHost ?? new DenyApprovalHost();
  }

  async previewPlan(task: string): Promise<PlanPreviewResult> {
    const repo = await scanRepo(this.repoRoot);
    const manifest = await loadRepoManifest(this.repoRoot);
    const plan = await this.strategy.createPlan({
      task,
      mode: this.mode,
      repo,
      manifest
    });
    const recentHistory = await this.loadRecentHistoryContext();
    const context = await buildRuntimeContext(task, repo, manifest, plan, { recentHistory });

    return {
      repo,
      manifest,
      plan,
      context
    };
  }

  async runTask(options: RunTaskOptions): Promise<RunTaskResult> {
    const session = this.sessionManager.create(this.repoRoot, { mode: this.mode, strategy: this.strategy.id });
    const eventLog = this.sessionManager.createEventLog(session);
    const checkpointStore = new CheckpointStore(this.repoRoot);
    const reportStore = new RunReportStore(this.repoRoot);

    await eventLog.append(
      this.sessionManager.createEvent({
        type: "user.message",
        sessionId: session.id,
        message: options.task
      })
    );

    let initialized: Awaited<ReturnType<TokenStreamingRuntime["initializeTask"]>>;
    try {
      initialized = await this.initializeTask(options.task, session, eventLog);
    } catch (error) {
      await this.writeInitializationFailureReport(options.task, session, eventLog, reportStore, error);
      throw error;
    }
    const { repo, manifest, plan, context } = initialized;

    const verificationResults: VerificationResult[] = [];
    const permissionDecisions: PermissionDecision[] = [];
    const approvalResponses: ApprovalResponse[] = [];
    const modelCalls: ModelCallRecord[] = [];
    const agentRuns: AgentRunResult[] = [];
    const toolCalls: ToolCallSummary[] = [];
    const appliedFiles: string[] = [];
    let patchProposal: PatchProposal | undefined;
    let repairPatchProposal: PatchProposal | undefined;
    let checkpointId: string | undefined;
    let reviewRecorded = false;

    const writeFailureReport = async (error: unknown): Promise<void> => {
      const failureMessage = formatErrorMessage(error);
      const [diff, status] = await Promise.all([safeGitDiff(this.repoRoot), safeGitStatus(this.repoRoot)]);
      const review = buildReviewSummary({
        plan,
        verificationResults,
        appliedFiles,
        permissionDecisions,
        approvalResponses,
        patchProposal,
        diff,
        status,
        failureMessage
      });

      if (!reviewRecorded) {
        await eventLog.append(
          this.sessionManager.createEvent({
            type: "review.completed",
            sessionId: session.id,
            review
          })
        );
        reviewRecorded = true;
      }

      await reportStore.write({
        session,
        repo,
        manifest,
        plan,
        context,
        summary: `Run failed: ${failureMessage}`,
        eventLogPath: eventLog.path,
        verificationResults,
        permissionDecisions,
        approvalResponses,
        modelCalls,
        agentRuns,
        toolCalls,
        review,
        changes: {
          patchProposalFiles: patchProposal?.files.map((file) => file.path) ?? [],
          repairProposalFiles: repairPatchProposal?.files.map((file) => file.path) ?? [],
          appliedFiles,
          checkpointId
        }
      });
    };

    if (options.parallelAgents) {
      try {
        agentRuns.push(
          ...(await this.runParallelAgents({
            sessionId: session.id,
            eventLog,
            task: options.task,
            repo,
            manifest,
            plan,
            context,
            modelCalls
          }))
        );
      } catch (error) {
        await writeFailureReport(error);
        throw error;
      }
    }

    const basePrompt = buildRuntimePrompt({
      task: options.task,
      repo,
      manifest,
      plan,
      context
    });
    const prompt = {
      system: basePrompt.system,
      user: [basePrompt.user, renderAgentArtifacts(agentRuns)].filter(Boolean).join("\n\n")
    };

    let modelResponse: ModelResponse;
    try {
      modelResponse = await this.callModel({
        sessionId: session.id,
        eventLog,
        purpose: "planning",
        request: {
          mode: this.mode,
          reasoningEffort: this.modeProfile.planningReasoningEffort,
          messages: [
            {
              role: "system",
              content: prompt.system
            },
            {
              role: "user",
              content: prompt.user
            }
          ]
        },
        modelCalls
      });
    } catch (error) {
      await writeFailureReport(error);
      throw error;
    }

    try {
      patchProposal = parsePatchProposal(options.patchProposalText ?? modelResponse.content);

      checkpointId = await this.handlePatchProposal({
        session,
        eventLog,
        checkpointStore,
        proposal: patchProposal,
        apply: options.apply,
        allowSensitive: options.allowSensitive,
        manifest,
        permissionDecisions,
        approvalResponses,
        appliedFiles
      });

      if (!checkpointId) {
        const checkpoint = await checkpointStore.create([]);
        checkpointId = checkpoint.id;
        await eventLog.append(
          this.sessionManager.createEvent({
            type: "checkpoint.created",
            sessionId: session.id,
            checkpointId,
            files: []
          })
        );
      }

      const shouldSkipTests = options.dryRun || (patchProposal !== undefined && !options.apply);
      verificationResults.push(
        ...(await this.runVerification(
          session.id,
          eventLog,
          manifest,
          plan.testCommands,
          shouldSkipTests,
          permissionDecisions,
          approvalResponses,
          toolCalls
        ))
      );

      const failedVerification = verificationResults.find((verification) => !verification.ok);
      if (options.repair && options.apply && failedVerification) {
        const repairPrompt = buildRepairPrompt({
          task: options.task,
          context,
          verification: failedVerification
        });
        const repairResponse = await this.callModel({
          sessionId: session.id,
          eventLog,
          purpose: "repair",
          request: {
            mode: this.mode,
            reasoningEffort: this.modeProfile.repairReasoningEffort,
            messages: [
              { role: "system", content: repairPrompt.system },
              { role: "user", content: repairPrompt.user }
            ]
          },
          modelCalls
        });

        repairPatchProposal = parsePatchProposal(repairResponse.content);
        const repairCheckpointId = await this.handlePatchProposal({
          session,
          eventLog,
          checkpointStore,
          proposal: repairPatchProposal,
          apply: true,
          allowSensitive: options.allowSensitive,
          manifest,
          permissionDecisions,
          approvalResponses,
          appliedFiles
        });
        checkpointId = repairCheckpointId ?? checkpointId;

        verificationResults.push(
          ...(await this.runVerification(
            session.id,
            eventLog,
            manifest,
            plan.testCommands,
            false,
            permissionDecisions,
            approvalResponses,
            toolCalls
          ))
        );
      }
    } catch (error) {
      if (!isRecordedRuntimeFailure(error)) {
        await this.appendRunFailed(eventLog, session.id, formatErrorMessage(error));
      }
      await writeFailureReport(error);
      throw error;
    }

    const diff = await getGitDiff(this.repoRoot);
    const status = await getGitStatus(this.repoRoot);
    const review = buildReviewSummary({
      plan,
      verificationResults,
      appliedFiles,
      permissionDecisions,
      approvalResponses,
      patchProposal,
      diff,
      status
    });
    await eventLog.append(
      this.sessionManager.createEvent({
        type: "review.completed",
        sessionId: session.id,
        review
      })
    );
    reviewRecorded = true;
    const summary = [
      `Session ${session.id} created with ${this.strategy.id} strategy in ${this.mode} mode.`,
      `Plan phases: ${plan.phases.map((phase) => phase.id).join(", ")}.`,
      `Agent handoffs: ${plan.handoffs.map((handoff) => `${handoff.from}->${handoff.to ?? "final"}:${handoff.artifact}`).join("; ")}.`,
      options.parallelAgents ? `Parallel agent artifacts: ${agentRuns.length}.` : "Parallel agent artifacts: disabled.",
      `Mode profile: ${this.modeProfile.description}`,
      `Manifest source: ${manifest.generated ? "generated fallback" : "repository .ai manifest"}.`,
      `Model provider: ${modelResponse.provider ?? this.modelProvider.name}${modelResponse.model ? ` (${modelResponse.model})` : ""}.`,
      modelCalls.length
        ? `Model calls: ${modelCalls
            .map((call) => `${call.purpose}:${call.provider}${call.model ? `/${call.model}` : ""}:${call.reasoningEffort ?? "default"}`)
            .join("; ")}.`
        : "Model calls: none.",
      patchProposal ? `Patch proposal: ${patchProposal.files.length} file(s), ${options.apply ? "applied" : "preview only"}.` : "Patch proposal: none.",
      repairPatchProposal ? `Repair proposal: ${repairPatchProposal.files.length} file(s), applied.` : "Repair proposal: none.",
      checkpointId ? `Checkpoint: ${checkpointId}.` : "Checkpoint: none.",
      `Review: ${review.recommendation}`,
      verificationResults.length
        ? `Verification attempts: ${verificationResults.map((result) => `${result.command} => ${result.exitCode}`).join("; ")}.`
        : "No verification command was run.",
      diff || status ? "Repository has current changes after this run." : "Repository has no current changes after this run.",
      "",
      modelResponse.content
    ].join("\n");

    await eventLog.append(
      this.sessionManager.createEvent({
        type: "run.completed",
        sessionId: session.id,
        summary
      })
    );

    const reportPath = await reportStore.write({
      session,
      repo,
      manifest,
      plan,
      context,
      summary,
      eventLogPath: eventLog.path,
      verificationResults,
      permissionDecisions,
      approvalResponses,
      modelCalls,
      agentRuns,
      toolCalls,
      review,
      changes: {
        patchProposalFiles: patchProposal?.files.map((file) => file.path) ?? [],
        repairProposalFiles: repairPatchProposal?.files.map((file) => file.path) ?? [],
        appliedFiles,
        checkpointId,
        gitStatus: status,
        gitDiff: diff
      }
    });

    return {
      session,
      repo,
      manifest,
      plan,
      summary,
      eventLogPath: eventLog.path,
      reportPath,
      patchProposal,
      repairPatchProposal,
      appliedFiles,
      verificationResults,
      permissionDecisions,
      approvalResponses,
      modelCalls,
      agentRuns,
      review,
      context
    };
  }

  private async initializeTask(
    task: string,
    session: Session,
    eventLog: ReturnType<SessionManager["createEventLog"]>
  ): Promise<{ repo: RepoSummary; manifest: RepoManifest; plan: ExecutionPlan; context: RuntimeContextBundle }> {
    let repo = await scanRepo(this.repoRoot);

    await eventLog.append(
      this.sessionManager.createEvent({
        type: "repo.scanned",
        sessionId: session.id,
        summary: repo
      })
    );

    if (!repo.aiManifestPresent) {
      await generateFallbackManifest(this.repoRoot, repo);
      repo = await scanRepo(this.repoRoot);
    }

    const manifest = await loadRepoManifest(this.repoRoot);
    await eventLog.append(
      this.sessionManager.createEvent({
        type: "manifest.loaded",
        sessionId: session.id,
        manifest: {
          hasRootManifest: repo.aiManifestPresent,
          moduleCount: manifest.modules.length,
          workflowCount: manifest.workflows.length,
          playbookCount: manifest.playbooks.length,
          generated: manifest.generated
        }
      })
    );

    const plan = await this.strategy.createPlan({ task, mode: this.mode, repo, manifest });
    await eventLog.append(
      this.sessionManager.createEvent({
        type: "plan.created",
        sessionId: session.id,
        plan
      })
    );

    const recentHistory = await this.loadRecentHistoryContext(session.id);
    const context = await buildRuntimeContext(task, repo, manifest, plan, { recentHistory });
    return { repo, manifest, plan, context };
  }

  private async writeInitializationFailureReport(
    task: string,
    session: Session,
    eventLog: ReturnType<SessionManager["createEventLog"]>,
    reportStore: RunReportStore,
    error: unknown
  ): Promise<void> {
    const failureMessage = `Run failed during initialization: ${formatErrorMessage(error)}`;
    const repo = emptyRepoSummary(this.repoRoot);
    const manifest = emptyRepoManifest();
    const plan = initializationFailurePlan(task, this.mode, this.strategy.id);
    const context = emptyRuntimeContext();
    const review: ReviewSummary = {
      riskLevel: plan.riskLevel,
      verificationStatus: "not-run",
      hasRepositoryChanges: false,
      appliedFiles: [],
      permissionChecks: 0,
      approvals: 0,
      findings: [failureMessage],
      recommendation: "Resolve the initialization failure before continuing."
    };
    const [gitDiff, gitStatus] = await Promise.all([safeGitDiff(this.repoRoot), safeGitStatus(this.repoRoot)]);

    await this.appendRunFailed(eventLog, session.id, failureMessage);
    await eventLog.append(
      this.sessionManager.createEvent({
        type: "review.completed",
        sessionId: session.id,
        review
      })
    );
    await reportStore.write({
      session,
      repo,
      manifest,
      plan,
      context,
      summary: failureMessage,
      eventLogPath: eventLog.path,
      review,
      changes: {
        patchProposalFiles: [],
        repairProposalFiles: [],
        appliedFiles: [],
        gitDiff,
        gitStatus
      }
    });
  }

  private async callModel(input: {
    sessionId: string;
    eventLog: ReturnType<SessionManager["createEventLog"]>;
    purpose: ModelCallPurpose;
    request: ModelRequest;
    modelCalls: ModelCallRecord[];
  }): Promise<ModelResponse> {
    let response: ModelResponse;
    try {
      response = await this.modelProvider.generate(input.request);
    } catch (error) {
      const failureMessage = `Model call failed during ${input.purpose}: ${formatErrorMessage(error)}`;
      await this.appendRunFailed(input.eventLog, input.sessionId, failureMessage);
      throw new Error(failureMessage);
    }

    const call: ModelCallRecord = {
      purpose: input.purpose,
      provider: response.provider ?? this.modelProvider.name,
      model: response.model,
      mode: input.request.mode,
      reasoningEffort: input.request.reasoningEffort,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      responseCharacters: response.content.length
    };
    input.modelCalls.push(call);
    await input.eventLog.append(
      this.sessionManager.createEvent({
        type: "model.called",
        sessionId: input.sessionId,
        call
      })
    );
    return response;
  }

  private async runParallelAgents(input: {
    sessionId: string;
    eventLog: ReturnType<SessionManager["createEventLog"]>;
    task: string;
    repo: RepoSummary;
    manifest: RepoManifest;
    plan: ExecutionPlan;
    context: RuntimeContextBundle;
    modelCalls: ModelCallRecord[];
  }): Promise<AgentRunResult[]> {
    const phases = input.plan.phases.filter((phase) => phase.role !== "orchestrator");
    return Promise.all(
      phases.map(async (phase) => {
        const handoff = input.plan.handoffs.find((candidate) => candidate.from === phase.role);
        const artifact = handoff?.artifact ?? phase.title;
        await input.eventLog.append(
          this.sessionManager.createEvent({
            type: "agent.started",
            sessionId: input.sessionId,
            role: phase.role,
            phaseId: phase.id,
            artifact
          })
        );

        try {
          const response = await this.callModel({
            sessionId: input.sessionId,
            eventLog: input.eventLog,
            purpose: "agent",
            request: {
              mode: this.mode,
              reasoningEffort: this.agentReasoningEffort(phase.role),
              messages: [
                {
                  role: "system",
                  content: buildAgentSystemPrompt(phase.role)
                },
                {
                  role: "user",
                  content: buildAgentUserPrompt({
                    task: input.task,
                    phase,
                    artifact,
                    repo: input.repo,
                    manifest: input.manifest,
                    plan: input.plan,
                    context: input.context
                  })
                }
              ]
            },
            modelCalls: input.modelCalls
          });
          const result: AgentRunResult = {
            role: phase.role,
            phaseId: phase.id,
            artifact,
            ok: true,
            summary: response.content
          };
          await input.eventLog.append(
            this.sessionManager.createEvent({
              type: "agent.finished",
              sessionId: input.sessionId,
              role: phase.role,
              phaseId: phase.id,
              artifact,
              ok: true,
              summary: trimAgentArtifact(response.content)
            })
          );
          return result;
        } catch (error) {
          const summary = formatErrorMessage(error);
          await input.eventLog.append(
            this.sessionManager.createEvent({
              type: "agent.finished",
              sessionId: input.sessionId,
              role: phase.role,
              phaseId: phase.id,
              artifact,
              ok: false,
              summary: trimAgentArtifact(summary)
            })
          );
          throw error;
        }
      })
    );
  }

  private agentReasoningEffort(role: AgentRole): ModelRequest["reasoningEffort"] {
    if (role === "coder" || role === "reviewer") {
      return this.modeProfile.planningReasoningEffort;
    }
    if (role === "tester") {
      return "medium";
    }
    return "low";
  }

  private async loadRecentHistoryContext(excludeSessionId?: string): Promise<RecentHistoryItem[]> {
    const store = new SessionHistoryStore(this.repoRoot);
    const summaries = (await store.list()).filter((summary) => summary.sessionId !== excludeSessionId).slice(0, 3);
    const history: RecentHistoryItem[] = [];

    for (const summary of summaries) {
      let events: SessionEvent[] = [];
      try {
        events = await store.read(summary.sessionId);
      } catch {
        events = [];
      }

      history.push({
        sessionId: summary.sessionId,
        status: summary.status,
        task: trimHistoryText(summary.task, 180),
        summary: trimHistoryText(summary.summary, 220),
        error: trimHistoryText(summary.error, 220),
        failureCategory: summary.failureCategory,
        toolResults: summarizeRecentToolResults(events)
      });
    }

    return history;
  }

  private async handlePatchProposal(input: {
    session: Session;
    eventLog: ReturnType<SessionManager["createEventLog"]>;
    checkpointStore: CheckpointStore;
    proposal: PatchProposal | undefined;
    apply: boolean | undefined;
    allowSensitive: boolean | undefined;
    manifest: RepoManifest;
    permissionDecisions: PermissionDecision[];
    approvalResponses: ApprovalResponse[];
    appliedFiles: string[];
  }): Promise<string | undefined> {
    if (!input.proposal) {
      return undefined;
    }

    await input.eventLog.append(
      this.sessionManager.createEvent({
        type: "patch.proposed",
        sessionId: input.session.id,
        files: input.proposal.files.map((file) => file.path),
        proposal: input.proposal
      })
    );

    const checkpoint = await input.checkpointStore.create(input.proposal.files.map((file) => file.path));
    await input.eventLog.append(
      this.sessionManager.createEvent({
        type: "checkpoint.created",
        sessionId: input.session.id,
        checkpointId: checkpoint.id,
        files: checkpoint.files.map((file) => file.path)
      })
    );

    if (input.apply) {
      const decision = evaluatePatchPolicy(input.manifest, input.proposal, { allowSensitive: input.allowSensitive });
      input.permissionDecisions.push(decision);
      await input.eventLog.append(
        this.sessionManager.createEvent({
          type: "permission.checked",
          sessionId: input.session.id,
          decision
        })
      );

      if (!decision.allowed) {
        if (!decision.requiresApproval) {
          const error = `Patch blocked by policy: ${decision.reasons.join("; ")}`;
          await this.appendRunFailed(input.eventLog, input.session.id, error);
          throw new Error(error);
        }

        const approvalRequest = {
          id: createId("apr"),
          target: decision.target,
          action: decision.action,
          severity: decision.severity,
          reasons: decision.reasons
        };

        await input.eventLog.append(
          this.sessionManager.createEvent({
            type: "approval.requested",
            sessionId: input.session.id,
            request: approvalRequest
          })
        );

        const approvalResponse = await this.approvalHost.requestApproval(approvalRequest);
        input.approvalResponses.push(approvalResponse);
        await input.eventLog.append(
          this.sessionManager.createEvent({
            type: "approval.resolved",
            sessionId: input.session.id,
            response: approvalResponse
          })
        );

        if (!approvalResponse.approved) {
          const error = `Patch blocked by approval: ${approvalResponse.reason ?? decision.reasons.join("; ")}`;
          await this.appendRunFailed(input.eventLog, input.session.id, error);
          throw new Error(error);
        }
      }

      const patchResult = await applyFilePatches(this.repoRoot, input.proposal.files);
      input.appliedFiles.push(...patchResult.files);
      await input.eventLog.append(
        this.sessionManager.createEvent({
          type: "patch.applied",
          sessionId: input.session.id,
          files: patchResult.files,
          checkpointId: checkpoint.id
        })
      );
    }

    return checkpoint.id;
  }

  private async runVerification(
    sessionId: string,
    eventLog: ReturnType<SessionManager["createEventLog"]>,
    manifest: RepoManifest,
    commands: string[],
    skip: boolean,
    permissionDecisions: PermissionDecision[],
    approvalResponses: ApprovalResponse[],
    toolCalls: ToolCallSummary[]
  ): Promise<VerificationResult[]> {
    if (skip) {
      return [];
    }

    const results: VerificationResult[] = [];

    for (const command of commands) {
      const decision = evaluateCommandPolicy(manifest, command);
      permissionDecisions.push(decision);
      await eventLog.append(
        this.sessionManager.createEvent({
          type: "permission.checked",
          sessionId,
          decision
        })
      );

      if (!decision.allowed) {
        if (!decision.requiresApproval) {
          const error = `Command blocked by policy: ${decision.reasons.join("; ")}`;
          await this.appendRunFailed(eventLog, sessionId, error);
          throw new Error(error);
        }

        const approvalRequest = {
          id: createId("apr"),
          target: decision.target,
          action: decision.action,
          severity: decision.severity,
          reasons: decision.reasons
        };

        await eventLog.append(
          this.sessionManager.createEvent({
            type: "approval.requested",
            sessionId,
            request: approvalRequest
          })
        );

        const approvalResponse = await this.approvalHost.requestApproval(approvalRequest);
        approvalResponses.push(approvalResponse);
        await eventLog.append(
          this.sessionManager.createEvent({
            type: "approval.resolved",
            sessionId,
            response: approvalResponse
          })
        );

        if (!approvalResponse.approved) {
          const error = `Command blocked by approval: ${approvalResponse.reason ?? decision.reasons.join("; ")}`;
          await this.appendRunFailed(eventLog, sessionId, error);
          throw new Error(error);
        }
      }

      await eventLog.append(
        this.sessionManager.createEvent({
          type: "tool.started",
          sessionId,
          toolName: "test.run",
          input: {
            command
          }
        })
      );

      const testResult = (await runTool("test.run", {
        repoRoot: this.repoRoot,
        command
      })) as CommandResult;

      const verification: VerificationResult = {
        ok: testResult.exitCode === 0,
        command: testResult.command,
        exitCode: testResult.exitCode,
        outputSummary: summarizeOutput(testResult.stdout, testResult.stderr)
      };
      toolCalls.push({
        name: "test.run",
        ok: verification.ok,
        inputSummary: command,
        outputSummary: `exit=${verification.exitCode ?? "unknown"}${verification.outputSummary ? ` ${verification.outputSummary}` : ""}`
      });

      await eventLog.append(
        this.sessionManager.createEvent({
          type: "tool.finished",
          sessionId,
          toolName: "test.run",
          ok: verification.ok,
          output: {
            command: verification.command,
            exitCode: verification.exitCode,
            outputSummary: verification.outputSummary
          }
        })
      );

      results.push(verification);
      await eventLog.append(
        this.sessionManager.createEvent({
          type: "tests.finished",
          sessionId,
          ok: verification.ok,
          command: verification.command,
          exitCode: verification.exitCode ?? undefined,
          outputSummary: verification.outputSummary
        })
      );

      if (!verification.ok) {
        break;
      }
    }

    return results;
  }

  private async appendRunFailed(eventLog: ReturnType<SessionManager["createEventLog"]>, sessionId: string, error: string): Promise<void> {
    await eventLog.append(
      this.sessionManager.createEvent({
        type: "run.failed",
        sessionId,
        error
      })
    );
  }
}

function buildReviewSummary(input: {
  plan: ExecutionPlan;
  verificationResults: VerificationResult[];
  appliedFiles: string[];
  permissionDecisions: PermissionDecision[];
  approvalResponses: ApprovalResponse[];
  patchProposal: PatchProposal | undefined;
  diff: string;
  status: string;
  failureMessage?: string;
}): ReviewSummary {
  const failedVerification = input.verificationResults.find((result) => !result.ok);
  const verificationStatus =
    input.verificationResults.length === 0 ? "not-run" : failedVerification ? "failed" : "passed";
  const hasRepositoryChanges = Boolean(input.diff.trim() || input.status.trim());
  const findings = [
    `Risk level: ${input.plan.riskLevel}.`,
    verificationStatus === "passed"
      ? `Verification passed with ${input.verificationResults.length} command(s).`
      : verificationStatus === "failed"
        ? `Verification failed at ${failedVerification?.command ?? "unknown command"}.`
        : "Verification was not run.",
    input.patchProposal && input.appliedFiles.length === 0
      ? "Patch proposal was produced or supplied but not applied."
      : input.appliedFiles.length
        ? `Applied files: ${input.appliedFiles.join(", ")}.`
        : "No files were applied.",
    input.permissionDecisions.length
      ? `Permission checks: ${input.permissionDecisions.length}.`
      : "No permission checks were required.",
    input.approvalResponses.length ? `Approvals resolved: ${input.approvalResponses.length}.` : "No approvals were requested.",
    hasRepositoryChanges ? "Repository has current changes after the run." : "Repository is clean after the run.",
    input.failureMessage ? `Run failed: ${input.failureMessage}.` : undefined
  ].filter((finding): finding is string => typeof finding === "string");

  return {
    riskLevel: input.plan.riskLevel,
    verificationStatus,
    hasRepositoryChanges,
    appliedFiles: input.appliedFiles,
    permissionChecks: input.permissionDecisions.length,
    approvals: input.approvalResponses.length,
    findings,
    recommendation: input.failureMessage
      ? "Inspect the recorded failure before continuing."
      : failedVerification
        ? "Inspect the failing verification output before continuing."
        : input.patchProposal && input.appliedFiles.length === 0
          ? "Review the patch proposal and rerun with --apply when ready."
          : "Ready for human review."
  };
}

function summarizeOutput(stdout: string, stderr: string): string {
  const output = `${stdout}\n${stderr}`.trim();
  if (output.length <= 1_000) {
    return output;
  }
  return `${output.slice(0, 1_000)}\n... output truncated ...`;
}

function buildAgentSystemPrompt(role: AgentRole): string {
  const base = [
    `You are the ${role} specialist inside Token Streaming's optional parallel-agent mode.`,
    "You produce advisory artifacts only. Do not claim that files were changed or commands were run.",
    "Keep the output concise, structured, and useful to the orchestrator."
  ];
  if (role === "research") {
    base.push("Focus on repository context, module/workflow boundaries, and missing information.");
  } else if (role === "coder") {
    base.push("Focus on implementation approach, files likely to change, and patch risks.");
  } else if (role === "tester") {
    base.push("Focus on verification commands, likely failure modes, and test coverage gaps.");
  } else if (role === "reviewer") {
    base.push("Focus on risk, safety policy, ownership, and review concerns.");
  }
  return base.join("\n");
}

function buildAgentUserPrompt(input: {
  task: string;
  phase: ExecutionPlan["phases"][number];
  artifact: string;
  repo: RepoSummary;
  manifest: RepoManifest;
  plan: ExecutionPlan;
  context: RuntimeContextBundle;
}): string {
  return [
    `Task: ${input.task}`,
    `Phase: ${input.phase.id} (${input.phase.title})`,
    `Expected artifact: ${input.artifact}`,
    `Repository: ${input.repo.root}`,
    `Risk: ${input.plan.riskLevel}`,
    `Relevant modules: ${input.context.relevantModules.join(", ") || "none inferred"}`,
    `Relevant workflows: ${input.context.relevantWorkflows.join(", ") || "none inferred"}`,
    `Test commands: ${input.context.testCommands.join(", ") || "none"}`,
    "",
    "## Manifest Summary",
    `Generated manifest: ${input.manifest.generated ? "yes" : "no"}`,
    `Modules: ${input.manifest.modules.map((module) => module.name).join(", ") || "none"}`,
    `Workflows: ${input.manifest.workflows.map((workflow) => workflow.name).join(", ") || "none"}`,
    "",
    "## Runtime Context",
    input.context.overview,
    "",
    "Return a short artifact with:",
    "- Key observations",
    "- Risks or uncertainties",
    "- Recommendation to the orchestrator"
  ].join("\n");
}

function renderAgentArtifacts(agentRuns: AgentRunResult[]): string {
  if (agentRuns.length === 0) {
    return "";
  }
  return [
    "## Parallel Agent Artifacts",
    "",
    ...agentRuns.flatMap((run) => [
      `### ${run.role}/${run.phaseId}: ${run.artifact}`,
      `Status: ${run.ok ? "ok" : "failed"}`,
      "",
      trimAgentArtifact(run.summary),
      ""
    ])
  ].join("\n");
}

function trimAgentArtifact(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 2_000) {
    return normalized;
  }
  return `${normalized.slice(0, 2_000)}\n... agent artifact truncated ...`;
}

async function safeGitDiff(repoRoot: string): Promise<string> {
  try {
    return await getGitDiff(repoRoot);
  } catch {
    return "";
  }
}

async function safeGitStatus(repoRoot: string): Promise<string> {
  try {
    return await getGitStatus(repoRoot);
  } catch {
    return "";
  }
}

function emptyRepoSummary(repoRoot: string): RepoSummary {
  return {
    root: repoRoot,
    scripts: {},
    trackedFiles: [],
    sourceDirectories: [],
    moduleManifestPaths: [],
    workflowManifestPaths: [],
    aiManifestPresent: false
  };
}

function emptyRepoManifest(): RepoManifest {
  return {
    playbooks: [],
    modules: [],
    workflows: [],
    generated: true
  };
}

function initializationFailurePlan(task: string, mode: ProductMode, strategy: StrategyId): ExecutionPlan {
  return {
    strategy,
    mode,
    task,
    riskLevel: "medium",
    phases: [
      {
        id: "initialize",
        role: "orchestrator",
        title: "Initialize repository context",
        description: "Scan the repository and load its manifest before planning work.",
        required: true
      }
    ],
    requiredAgents: ["orchestrator"],
    handoffs: [],
    testCommands: [],
    notes: ["Initialization did not complete."]
  };
}

function emptyRuntimeContext(): RuntimeContextBundle {
  return {
    overview: "Runtime context was unavailable because initialization failed.",
    relevantModules: [],
    relevantWorkflows: [],
    selectionReasons: [],
    sourceSnippets: [],
    testCommands: [],
    recentHistory: []
  };
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeRecentToolResults(events: SessionEvent[]): RecentHistoryItem["toolResults"] {
  return events
    .filter((event) => event.type === "tool.finished")
    .slice(-3)
    .map((event) => ({
      toolName: event.toolName,
      ok: event.ok,
      summary: trimHistoryText(event.error ?? summarizeUnknown(event.output), 180) ?? "no output"
    }));
}

function summarizeUnknown(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function trimHistoryText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}...`;
}

function isRecordedRuntimeFailure(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return (
    message.startsWith("Model call failed during ") ||
    message.startsWith("Patch blocked by policy: ") ||
    message.startsWith("Patch blocked by approval: ") ||
    message.startsWith("Command blocked by policy: ")
  );
}

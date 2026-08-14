# Architecture

Token Streaming is split into a CLI host and a headless runtime.

```text
apps/cli
-> packages/core
-> packages/protocol
-> packages/ai-manifest
-> packages/tools
-> packages/storage
-> packages/providers
```

## Headless Host Contract

`@token-streaming/core` exports `TokenStreamingRuntime` as the shared host boundary. Its public methods are:

- `runTask(input)` for the complete session, model, patch, permission, verification, review, and report lifecycle.
- `planTask(input)` for a side-effect-free `ExecutionPlan`.
- `inspectContext(input)` for the bounded `RuntimeContextBundle` selected for a task.
- `validateManifest()` for the runtime's configured repository.
- `listTools()` and `runTool(input)` for catalog discovery and policy-gated execution.
- `rollback(checkpointId, options)` for rollback preview or restore.

The published-package check imports this API from an isolated tarball installation, so the contract is verified independently of monorepo path aliases. The CLI remains a thin first host; a desktop host can use the same methods and protocol event types.

## Runtime Path

The first version ships only the `default` strategy, selected through a strategy registry. The CLI accepts `--strategy default` and exposes `strategies list` so the strategy dimension is part of the public command surface before additional strategies are implemented.

`plan` is a read-only preview path for the same strategy logic. It scans the repo, loads manifests, creates the execution plan, and builds context without creating a session, writing checkpoints, running commands, or calling a model.

`plan --json`, `context inspect --json`, `config inspect --json`, and `tools list --json` expose read-only runtime surfaces as structured data for automation and future desktop hosts. The main run command also supports `--json`, returning session metadata, model routing, plan, selected context, report paths, verification results, permission decisions, model call records, and compact patch summaries. Failed JSON commands emit a structured `error` envelope while preserving a non-zero exit code.

When a failed JSON command produced a runtime session, the `error` envelope includes artifact pointers for the matching session event log and report, plus direct inspection commands. This gives scripts and future desktop hosts a stable way to open the failure timeline without searching local history.

```text
User task
-> session event log
-> repo scan
-> manifest load or fallback generation
-> strategy registry
-> mode profile
-> execution plan
-> bounded context selection
-> model response or patch file
-> patch proposal
-> permission check
-> checkpoint
-> optional patch apply
-> optional verification
-> summary
```

```text
User task
-> repo scan
-> manifest load
-> effective config inspection
```

```text
User task
-> repo scan
-> manifest load
-> strategy registry
-> mode profile
-> execution plan
-> context preview
```

## Patch Flow

Model or file-sourced changes must enter the runtime as a structured patch proposal.

- Proposals contain a summary and full file contents.
- Malformed structured proposals are recorded as `run.failed` and receive a failure report instead of disappearing as parser errors.
- Proposals are preview-only by default.
- `--apply` is required before the patch engine writes files.
- Preview-only and rejected proposals do not create checkpoints.
- Applied proposals pass permission and approval checks before a checkpoint is created immediately ahead of the write.
- Event logs record `patch.proposed`, `checkpoint.created`, and `patch.applied`.
- `--repair` allows one additional patch proposal after failed verification.

## Verification Feedback

Verification output is reduced to structured feedback before it is reused.

- The runtime runs the plan's canonical `verificationCommands` in order. Deprecated `testCommands` output remains synchronized for V1 JSON compatibility.
- Runtime verification executes declared commands through the `test.run` tool path, so test runs emit `permission.checked`, `tool.started`, `tool.finished`, and `tests.finished`.
- The default strategy prefers targeted workflow or module `test_commands`, falls back to `.ai/tests.yaml` `default`, then falls back to detected package scripts.
- `verify` runs `.ai/tests.yaml` `default` commands directly through the command safety policy without calling a model.
- `verify --json` emits command policy decisions, exit codes, and bounded output summaries as structured data.
- Each command is checked against safety policy before execution.
- Verification stops at the first failing command to avoid noisy follow-on failures.
- The runtime records command, exit code, success status, and a bounded output summary.
- The first failed verification can trigger one repair attempt when `--repair` and `--apply` are both set.
- Repair attempts must return the same structured patch proposal format.
- Verification events are persisted as `tests.finished` events.

## Permission Policy

The runtime evaluates safety policy before file writes and command execution.

- Patch proposals are checked against `.ai/safety.yaml` sensitive paths.
- Patch file contents are checked against `.ai/safety.yaml` protected content patterns before writes.
- Sensitive patch proposals request host approval.
- CLI supports `deny`, `allow`, and `prompt` approval modes.
- Verification commands are checked against forbidden command patterns.
- Verification commands can also match approval-required command patterns, which request host approval before execution.
- Decisions are persisted as `permission.checked` events and copied into run reports.
- Approval requests and responses are persisted as `approval.requested` and `approval.resolved` events.

Permission decisions describe policy risk. Approval responses describe host authorization. A sensitive patch can therefore have a blocked policy decision and still proceed when the host explicitly approves it.

## Tool Runtime

The tools package exposes a stable catalog before exposing arbitrary tool execution.

- `tools list` prints the built-in tool catalog with risk levels.
- `tools list --json` exposes tool names, descriptions, risk categories, and input/output schemas for host UIs and agent planners.
- `tools run <name> <json-input>` executes only read-only catalog tools.
- `tools run <name> --json <json-input>` returns a structured `tool-run` envelope.
- `tools run <name> --input-file <path>` loads structured input from disk for shell-safe host integration.
- `tools run <name> --record --json` creates a session event log for ad-hoc tool calls, including `run.started`, `tool.started`, `tool.finished`, and `run.completed`.
- Recorded tool policy and execution failures write `run.failed`, create a compact report, and surface the matching session/report artifacts through the JSON error envelope.
- Every `tools run` response includes a tool policy decision; recorded runs persist that decision as `permission.checked`.
- `test.run` is the only execute-risk tool exposed through `tools run`, and only when the requested command is explicitly declared in `.ai/tests.yaml`, `module.yaml`, or `flow.yaml` and passes forbidden command policy.
- Tool risk is classified as `read`, `write`, or `execute`.
- The catalog includes repository scan, repository search, file read, git status, git diff, command run, test run, and patch apply.
- Write and execute tools remain behind runtime permission, checkpoint, and verification boundaries.
- Shell execution defaults to a 120-second timeout and a combined 1 MB stdout/stderr capture limit. Timeout and truncation are explicit result fields; either condition makes verification fail and is summarized for repair/review context.

## Session And Rollback

The runtime writes append-only JSONL session logs and checkpoint snapshots.

- `sessions list` reads `.token-streaming/sessions/` and summarizes previous runs.
- `sessions show <session-id|latest>` prints the timeline of persisted events.
- `sessions stream <session-id|latest> --jsonl` emits a host-friendly event stream with start, summary, event, and end envelopes. V1 streams the current persisted timeline as JSONL; the envelope shape leaves room for a future `--follow` mode without changing desktop consumers.
- Runtime policy, approval, verification-command, and model-provider failures append `run.failed` before surfacing the error to the CLI.
- When a plan has been created, failure paths also append `review.completed` and include the same structured review in the failure report.
- Runtime failures after planning starts also write a Markdown report with the selected plan, context, event log path, permissions, tool calls, and failure summary so failed commercial model calls, malformed patch proposals, blocked patches, and blocked verification commands can be inspected through `reports show latest`.
- `history summary` aggregates recent session, report, checkpoint, and model-call state for quick host dashboards.
- `history prune --dry-run --keep <count>` previews old history files that would be deleted while keeping the newest sessions, reports, and checkpoints.
- `history prune --keep <count>` deletes those old session, report, and checkpoint files with path confinement under `.token-streaming`.
- `sessions list --json`, `sessions show <session-id|latest> --json`, and `sessions stream <session-id|latest> --jsonl` expose the same run history and events as structured data for future hosts.
- `reports list` and `reports show <session-id|latest>` expose persisted markdown run reports.
- Session and report list/detail JSON expose structured summaries with status and failure-category fields so hosts can distinguish completed, failed, in-progress, and common failure causes without parsing event logs or Markdown.
- `checkpoints list` reads `.token-streaming/checkpoints/` and shows captured files.
- `checkpoints list --json` exposes checkpoint summaries without returning stored file contents.
- `checkpoints show <checkpoint-id|latest>` exposes file-level checkpoint detail with existence, character count, and short previews.
- `checkpoints show <checkpoint-id|latest> --json` gives future hosts the same rollback inspection surface without dumping full checkpoint contents.
- `rollback <checkpoint-id|latest>` restores the exact file contents saved before a patch write.
- `rollback <checkpoint-id|latest> --dry-run` previews restore/delete actions without mutating files.
- `rollback <checkpoint-id|latest> --json` reports which files were restored after the mutation completes.
- `diff` prints current git status and working tree diff before a user decides to continue, rollback, or commit.
- `diff --json` exposes the same status and diff with a clean flag for automation.
- `search <query>` performs bounded read-only text search across repository files.
- `search <query> --json` exposes match paths, line numbers, columns, and source text so future context builders and desktop hosts can locate evidence without shell-specific parsing.

These commands are intentionally implemented through storage APIs so a future desktop app can reuse the same inspection and rollback surface without shelling out to the CLI.

## Agent Collaboration

V1 represents multi-agent collaboration as role phases plus handoff artifacts, not as always-on worker swarms.

- `orchestrator` produces the execution plan.
- `researcher` produces a repository context brief.
- `coder` produces a structured patch proposal for change tasks.
- `tester` produces verification results.
- `reviewer` produces risk and diff review for change or high-risk tasks.

Each execution plan records handoffs such as `researcher -> coder: repository context brief`, making collaboration visible in reports today and reusable by future multi-worker strategies. `requiredAgents` is derived only from phases marked `required`; optional low-risk review phases therefore do not trigger an extra model call. Every runtime task begins with a structured `run.started` event and records `context.built` after context selection, including selected module, workflow, source-file, test-command, and recent-history counts for future host timelines. Runtime runs also persist a deterministic `review.completed` summary with risk, verification status, repository-change status, findings, and recommendation even when a separate reviewer model call is unnecessary.

`--parallel-agents` optionally activates required non-orchestrator phases as concurrent role agents before the main planning call. These agents produce advisory artifacts only: they do not apply patches, run shell commands, or bypass permission checks. The runtime records `agent.started` and `agent.finished` events, records each sub-agent model call with purpose `agent`, includes the artifacts in the run report, and appends them to the final orchestrator prompt. The default remains disabled to protect everyday cost and latency; `max` and high-risk plans can require reviewer participation while low-risk `auto` plans do not.

The CLI exposes this through `plan`, which lets a user inspect phases, required agents, handoffs, verification commands, and selected context before spending model tokens. `strategies list --json` exposes the currently registered strategy catalog for automation and future host UIs.

## Model Prompting

The default runtime builds prompts from explicit repository context before asking a provider for output.

- Summary tasks request prose.
- Code-change tasks request fenced JSON patch proposals.
- Runtime prompts include role handoff guidance so the model consumes and produces the same artifacts recorded in the execution plan.
- When optional parallel agents run, their bounded artifacts are passed into the main model call as additional context, preserving a single patch/checkpoint/verification authority.
- Patch proposal fences must be marked as `json` or `token-streaming-patch`.
- Markdown code fences in normal context are ignored by the patch parser.

## Model Telemetry

Every successful provider call emits a `model.called` event and appears in the run report. Provider failures emit `run.failed`; runtime failure reports keep failed commercial model calls visible in both session replay and report inspection.

- Telemetry records purpose, provider, model, product mode, reasoning effort, token usage when available, and response character count.
- Telemetry does not persist full prompts or model responses as structured metadata.
- Planning and repair calls are recorded separately so future strategy evaluation can compare cost, repair frequency, and success paths.
- `stats models` aggregates telemetry across session logs by provider, model, mode, purpose, failure category, session status, and failure rate. Provider/model/mode/purpose groups include call totals plus unique session counts, failed session counts, and group failure rates.
- The same aggregate now includes model recommendations grouped by mode, model-call purpose, inferred task kind, provider, and model. Each recommendation carries sample size, confidence, failure rate, average token/response cost proxies, an efficiency score, and a `prefer` / `watch` / `avoid` label.
- `stats models --json` exposes the aggregate and recommendations for dashboards, strategy evaluation, and cost/effectiveness automation.

## Tool Reporting

Run reports include a `Tools` section with compact tool call summaries.

- Tool summaries include tool name, success/failure, compact input, and compact output.
- Runtime verification reports `test.run` calls alongside `Verification` results.
- Full-fidelity tool events remain in the JSONL session log.

## Change Reporting

Run reports include a `Changes` section for patch and rollback context.

- Patch proposal file paths and repair proposal file paths are listed separately.
- Applied files are listed when patch application writes to disk.
- The checkpoint id is surfaced so users can quickly find the rollback point.
- Final git status and a compact git diff summary are included for review.
- A `Review` section records the structured reviewer summary: risk, verification status, repository changes, findings, and recommendation.

## Model Selection

Model selection is policy-driven but still user-overridable.

- CLI `--model` has the highest priority.
- `.ai/models.yaml` can define `economy_model`, `auto_model`, `max_model`, `default_model`, and scored `model_candidates`.
- The model router keeps CLI overrides first, then scores manifest candidates by mode objective, task risk, cost, latency, quality, and local model failure telemetry.
- When a task is available, the router infers a coarse task kind and applies matching telemetry recommendations as a bounded feedback boost or penalty. This lets historical `prefer` / `watch` / `avoid` labels influence routing without overriding explicit CLI choices or manifest candidate quality/cost/latency policy.
- Provider defaults are used when neither CLI nor manifest policy selects a model.
- Provider routing remains separate from strategy execution so cost/effectiveness choices can evolve independently from orchestration.
- `models select [task...]` previews routing without calling a provider and can explain task-specific feedback matches.
- `models select --json` exposes routing decisions, inferred task kind, candidate feedback, and telemetry recommendations as structured data for cost/effectiveness UI and automation.
- `doctor models` validates selection and provider readiness without network calls unless `--probe` is passed. Probe requests use the selected provider/model, low reasoning effort, a small output cap, request timeout handling, safe nested transport diagnostics, one retry for transient connection failures, and structured error reporting for JSON and non-JSON upstream failures. HTTP failures retain the status plus optional upstream `type`, `code`, and request ID while bounding the message and redacting the configured API key.
- `doctor models --json` exposes readiness checks, skipped/warning/error counts, selected model, and effective provider for CI, automation, and future desktop status panels.
- `pnpm smoke:openai` is the explicit live smoke entry point. It requires `OPENAI_API_KEY` and runs `doctor models --probe --json` with `--provider openai` through the built CLI.

## Repository Doctor

`doctor repo` aggregates the read-only health checks that matter before an agent run: repository scan, manifest validation, model readiness, OpenAI live-smoke readiness, current git status, local storage history, and tool catalog readiness. Its JSON output publishes the OpenAI smoke command/status plus latest session/report summaries with status fields and stable `latest` inspection commands for sessions, reports, and checkpoints so a future desktop host can open the newest artifacts without reimplementing CLI routing. It does not run tests, apply patches, create sessions, or call a model unless `--probe` is explicitly passed through to the model doctor.

`doctor repo --json` exposes this aggregate status as structured data for automation and future desktop status panels.

Interactive approval prompts are written to stderr so `--json` stdout remains a single machine-readable document for CLI automation and future desktop hosts. Approval responses and terminal success/failure remain recorded in the session event log and report.

Headless hosts can pass an `onEvent` observer to `TokenStreamingRuntime`. Events are delivered without backpressure only after the append-only JSONL write succeeds, and observer failures are isolated from the durable run so a slow or broken desktop renderer cannot stall or corrupt execution history.

Successful and failed runs emit exactly one terminal event. Reviewer output is persisted before `run.completed` or `run.failed`, so hosts can treat the terminal event as the final event in a session timeline.

## Source Context

The context builder adds a small number of source snippets after manifest metadata.

- Module `public_api` files are preferred.
- Relevant module and workflow neighbor files are considered.
- `context inspect` renders the full runtime context bundle without calling a provider, which makes context selection debuggable before spending model tokens.
- Context inspection includes structured selection reasons for relevant modules, workflows, and source snippets so users and future hosts can explain why a context item was chosen.
- Task words can match tracked source paths.
- `search --json` provides an explicit tool surface for query-driven source evidence outside the prompt-building path.
- Paths are normalized to repository-relative `/` separators.
- Strategy plans publish explicit module, workflow, public-API, file-count, and character budgets through `ExecutionPlan.context`.
- Snippets are capped in count and character length, and plan-provided limits are hard-clamped by the context builder so custom strategies cannot create unbounded prompts.

## Repository Metadata

The context builder treats explicit metadata as more authoritative than raw source layout.

- `.ai/` describes repo-wide intent and rules.
- `.ai/ownership.yaml` maps code areas to default owners and review boundaries for agent handoffs and future host UIs.
- `src/modules/*/module.yaml` describes module boundaries.
- `src/workflows/*/flow.yaml` describes cross-module business flows.
- `.ai/generated/` is generated for foreign repos that do not yet follow the standard.

`manifest init` creates the official `.ai/` surface for repos that should adopt the standard. `manifest init --json` returns the `.ai` root plus created and skipped files so hosts can show exactly what was scaffolded. `manifest generate` writes inferred fallback metadata to `.ai/generated/` for inherited projects, skips existing generated files by default, and only overwrites them with `--force`. `manifest inspect --json` exposes the current source, coverage, modules, workflows, playbooks, command groups, and validation result. Runtime fallback generation also writes to `.ai/generated/` when no official manifest exists, preserving the distinction between first-class agent-native repos and inferred mappings for inherited projects.

The generated fallback `repo-map.json` is intentionally heuristic: it records tracked files, source roots, inferred module candidates, inferred workflow/use-case candidates, test mappings, confidence levels, and evidence strings. Agents should use it as a migration aid, not as authority. Accurate candidates can later be promoted into `module.yaml` or `flow.yaml`.

`manifest validate` checks the root `.ai/` manifest, command catalog, default verification commands, ownership metadata, module manifests, workflow manifests, and playbook headings. Errors are intended to block CI; warnings highlight useful agent context that can still be improved.

`manifest validate --json` emits the same result as structured issue counts and issue records.

Model routing metadata is validated as part of the same manifest gate: `default_provider` must be `auto`, `openai`, or `stub`; mode-specific model fields must be non-empty strings; and `model_candidates` must use bounded `quality`, `cost`, and `latency` values from 0 to 1. This keeps cost/effectiveness routing explainable and prevents malformed candidate scores from silently steering the agent.

`commands list` exposes `.ai/commands.yaml` as a read-only command catalog. It intentionally does not execute the commands; execution remains behind explicit runtime verification or user shell actions so the manifest can be inspected safely by both the CLI and future desktop hosts. `commands list --json` returns the same catalog as structured command groups.

`config inspect` exposes the effective host/runtime configuration: cwd, mode, strategy availability, provider/model routing, repository scan summary, manifest coverage, and safety policy counts. It is intentionally read-only and does not call a model, run commands, create sessions, or write checkpoints.

Runtime context construction follows the agent-native repository order: task, repo manifest, workflow metadata, module metadata, selected source snippets, verification commands, and compact recent history. Recent history is summarized from session event logs as task/status/summary/error plus bounded tool-result summaries; full prompts and full event logs are not replayed into context.

`playbooks list` and `playbooks show <name>` expose `.ai/playbooks/*.md` as task SOPs. They are also read-only, which keeps procedure discovery separate from command execution and lets future hosts render onboarding or task guidance safely. `playbooks list --json` and `playbooks show <name> --json` provide the structured surface for host UIs.

`workflows list` and `workflows show <name>` expose `src/workflows/*/flow.yaml` as task-context metadata, including description, steps, touched modules, risk notes, and targeted tests. This is the CLI surface for the Agent-Native Repository idea: a user request can map to a cross-module flow before the agent chooses source snippets or verification commands. The workflow commands are read-only and return JSON suitable for future host UIs.

## Extension Points

V1 keeps these extension points present but intentionally small:

- strategies: only `default` is built in, but runtime and CLI can resolve registered strategies by id
- product modes: `economy`, `max`, `auto` resolve to explicit reasoning, context-budget, verification-depth, and reviewer-participation behavior
- model providers: OpenAI Responses API provider plus stub fallback
- agent roles: represented as phases in the execution plan
- safety: manifest-aware risk classification and future approval hooks

The strategy registry is the future entry point for alternate orchestration modes such as debug, review, or refactor. Mode profiles are deliberately separate from strategies so cost/effectiveness tuning can evolve without multiplying orchestration implementations. The canonical `ExecutionPlan` contract contains `phases`, `requiredAgents`, `handoffs`, `context`, `verificationCommands`, and `risk`; `riskLevel` and `testCommands` remain synchronized deprecated aliases for V1 consumers.

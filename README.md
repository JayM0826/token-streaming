# Token Streaming

Token Streaming is a CLI-first agentic coding runtime. It is designed to orchestrate commercial foundation models, repository metadata, tools, patches, tests, and checkpoints through a headless core that can later power other hosts such as a desktop app.

The first implementation focuses on one real orchestration strategy: `default`.

## Core Ideas

- Keep the runtime headless and reusable.
- Treat `.ai/`, `module.yaml`, and `flow.yaml` as first-class repository context.
- Use event-sourced sessions so every run can be inspected and replayed, including explicit `run.started` and `context.built` lifecycle records.
- Apply edits through a patch/checkpoint boundary.
- Leave room for future strategies and product modes without implementing them all up front.

See [docs/implementation-plan.md](docs/implementation-plan.md) for the full plan, [docs/codex-build-brief.zh.md](docs/codex-build-brief.zh.md) for the Chinese product/engineering brief, and [docs/v1-acceptance-matrix.md](docs/v1-acceptance-matrix.md) for requirement-by-requirement verification evidence.

## Development

```bash
pnpm install
pnpm clean
pnpm build
pnpm test
pnpm package:check
pnpm package:install-check
pnpm acceptance:check
pnpm cli -- "summarize this repo"
node apps/cli/dist/index.js --version
```

`pnpm test` compiles all workspace packages and then runs the Node.js behavior tests in `packages/**/*.test.mjs` and `apps/**/*.test.mjs` against the compiled `dist` output.
`pnpm package:check` verifies release readiness for the CLI and workspace packages: package metadata, dist entrypoints, type declarations, package file allowlists, Node engine constraints, and CLI bin shebangs.
`pnpm package:install-check` packs all seven workspace packages, installs the tarballs in an isolated offline consumer, verifies the CLI bin shim, and smoke-tests both the installed CLI and the public headless core API.
`pnpm acceptance:check` runs the offline gates and, when `OPENAI_API_KEY` is present, performs its own live provider probe. Without a key, it exits incomplete with a machine-readable `missing-api-key` status.

## Headless Core API

The CLI is only the first host. A future desktop app can import the same runtime from `@token-streaming/core` without shelling out to the CLI:

```ts
import { TokenStreamingRuntime } from "@token-streaming/core";

const runtime = new TokenStreamingRuntime({ repoRoot: process.cwd(), mode: "auto" });
const plan = await runtime.planTask("fix checkout failure");
const context = await runtime.inspectContext("fix checkout failure");
const validation = await runtime.validateManifest();
const tools = runtime.listTools();
const result = await runtime.runTask({ task: "fix checkout failure", dryRun: true });
const rollback = await runtime.rollback("latest", { dryRun: true });
```

`runTool()` exposes read tools plus manifest-declared `test.run` through the same permission and approval policy. Arbitrary command execution and direct patch application remain blocked so hosts cannot bypass the patch/checkpoint/verification boundary.

## CLI Usage

During local development, use `pnpm cli -- ...` or `node apps/cli/dist/index.js ...` after building. After installing or linking the CLI package, use the `token-streaming` binary directly. The `@token-streaming/cli` package also exposes the short `ai` alias for experimentation.

```bash
token-streaming --version
pnpm cli -- --dry-run "summarize this repo"
pnpm cli -- --dry-run --json "summarize this repo"
pnpm cli -- plan "fix checkout failing test"
pnpm cli -- plan --json "fix checkout failing test"
pnpm cli -- context inspect "fix checkout failing test"
pnpm cli -- context inspect --json "fix checkout failing test"
pnpm cli -- manifest init
pnpm cli -- manifest init --json
pnpm cli -- manifest init --force
pnpm cli -- manifest generate
pnpm cli -- manifest generate --json
pnpm cli -- manifest generate --force
pnpm cli -- manifest generate --force --json
pnpm cli -- manifest inspect
pnpm cli -- manifest inspect --json
pnpm cli -- manifest validate
pnpm cli -- manifest validate --json
pnpm cli -- commands list
pnpm cli -- commands list --json
pnpm cli -- config inspect
pnpm cli -- config inspect --json
pnpm cli -- tools list
pnpm cli -- tools list --json
pnpm cli -- tools run repo.scan
pnpm cli -- tools run repo.scan --json
pnpm cli -- tools run repo.scan --record --json
pnpm cli -- tools run repo.search --json --input-file tool-input.json
pnpm cli -- playbooks list
pnpm cli -- playbooks list --json
pnpm cli -- playbooks show add-provider
pnpm cli -- playbooks show add-provider --json
pnpm cli -- workflows list
pnpm cli -- workflows list --json
pnpm cli -- workflows show agent-run
pnpm cli -- workflows show agent-run --json
pnpm cli -- strategies list
pnpm cli -- strategies list --json
pnpm cli -- history summary
pnpm cli -- history summary --json
pnpm cli -- history prune --dry-run --keep 20
pnpm cli -- history prune --dry-run --keep 20 --json
pnpm cli -- history prune --keep 20
pnpm cli -- history prune --keep 20 --json
pnpm cli -- --provider stub "inspect the repo"
pnpm cli -- --strategy default --provider stub "inspect the repo"
pnpm cli -- --provider openai --model gpt-5.5 "plan this change"
pnpm cli -- --parallel-agents --dry-run "fix failing test"
pnpm cli -- --patch-file proposal.json --apply "apply a proposed change"
pnpm cli -- --patch-file proposal.json --apply --repair "apply and try one repair if verification fails"
pnpm cli -- --patch-file proposal.json --apply --allow-sensitive "apply a sensitive-path proposal"
pnpm cli -- --patch-file proposal.json --apply --approval prompt "ask before sensitive writes"
pnpm cli -- sessions list
pnpm cli -- sessions list --json
pnpm cli -- sessions show <session-id>
pnpm cli -- sessions show latest --json
pnpm cli -- sessions show <session-id> --json
pnpm cli -- sessions stream latest --jsonl
pnpm cli -- reports list
pnpm cli -- reports list --json
pnpm cli -- reports show <session-id>
pnpm cli -- reports show latest --json
pnpm cli -- checkpoints list
pnpm cli -- checkpoints list --json
pnpm cli -- checkpoints show <checkpoint-id>
pnpm cli -- checkpoints show latest --json
pnpm cli -- checkpoints show <checkpoint-id> --json
pnpm cli -- rollback <checkpoint-id|latest> --dry-run
pnpm cli -- rollback <checkpoint-id|latest> --dry-run --json
pnpm cli -- rollback <checkpoint-id|latest>
pnpm cli -- rollback <checkpoint-id|latest> --json
pnpm cli -- diff
pnpm cli -- diff --json
pnpm cli -- search authorizePayment
pnpm cli -- search authorizePayment --json
pnpm cli -- verify
pnpm cli -- verify --json
pnpm cli -- models select
pnpm cli -- models select "fix failing test"
pnpm cli -- models select --json
pnpm cli -- --mode economy models select
pnpm cli -- stats models
pnpm cli -- stats models --json
pnpm cli -- doctor repo
pnpm cli -- doctor repo --json
pnpm cli -- doctor models
pnpm cli -- doctor models --json
pnpm cli -- doctor models --probe
pnpm smoke:openai
pnpm acceptance:check -- --json
```

Provider behavior:

- `--provider auto` is the default.
- `auto` uses OpenAI when `OPENAI_API_KEY` is present.
- `auto` falls back to the stub provider when no API key is present.
- `--provider openai` requires `OPENAI_API_KEY`.
- `OPENAI_BASE_URL` optionally points the OpenAI provider at an OpenAI-compatible relay or gateway.
- `OPENAI_API_PROTOCOL` selects `responses` (default) or `chat-completions`; the equivalent CLI option is `--api-protocol`.
- `OPENAI_MODEL` overrides manifest model routing for relay-specific model names; an explicit `--model` still takes precedence.
- `OPENAI_TIMEOUT_MS` sets the OpenAI-compatible request timeout in milliseconds (default `30000`, maximum `600000`).
- A relay must expose either `<base-url>/responses` or `<base-url>/chat/completions`, matching the selected protocol.
- `--model` overrides repository model policy.
- `doctor repo` aggregates repository, manifest, model, git, storage, and tool readiness without running tests or calling a model by default.
- `doctor repo --json` also exposes OpenAI live smoke readiness plus latest session, report, and checkpoint inspection commands for host UIs.
- `doctor repo --json` exposes the same health data for automation and future desktop hosts.
- `doctor models` checks model policy and provider readiness without sending network requests by default.
- `doctor models --json` exposes model readiness checks, skipped/warning/error counts, selected model, and effective provider.
- `doctor models --probe` sends a minimal provider request with low reasoning effort, a small output cap, timeout handling, and structured upstream error reporting.
- `pnpm smoke:openai` requires `OPENAI_API_KEY` and runs the real OpenAI probe path through the built CLI.
- To test a third-party OpenAI-compatible relay, set both environment variables before probing:

```bash
export OPENAI_API_KEY="relay-api-key"
export OPENAI_BASE_URL="https://relay.example/v1"
export OPENAI_API_PROTOCOL="responses"
export OPENAI_MODEL="relay-model"
export OPENAI_TIMEOUT_MS="120000"
pnpm cli -- --provider openai doctor models --probe --json
pnpm smoke:openai
```

For relays that only implement Chat Completions:

```bash
export OPENAI_API_KEY="relay-api-key"
export OPENAI_BASE_URL="https://relay.example/v1"
export OPENAI_API_PROTOCOL="chat-completions"
export OPENAI_MODEL="relay-model"
export OPENAI_TIMEOUT_MS="120000"
pnpm cli -- --provider openai doctor models --probe --json
pnpm acceptance:check -- --json
```
- `pnpm acceptance:check -- --json` is the final acceptance gate: offline quality checks plus OpenAI live-smoke verification.

Mode behavior:

- `economy`, `max`, and `auto` are explicit mode profiles.
- V1 still uses the `default` orchestration strategy.
- `--strategy default` makes the orchestration strategy explicit without implementing speculative strategy variants.
- `strategies list` exposes the registered strategy catalog for scripts and future desktop hosts.
- `economy` uses low reasoning effort, a 3-file/2,000-character-per-file context budget, and only the first most relevant declared verification command.
- `auto` uses a balanced 6-file/4,000-character-per-file context budget and requires reviewer participation when task or manifest risk is elevated.
- `max` uses high reasoning effort, an 8-file/6,000-character-per-file context budget, preserves all selected verification commands, and always requires reviewer participation.
- Modes tune resource posture inside the same `default` strategy; they are not separate orchestration strategies.
- `.ai/models.yaml` can map each mode to a preferred model and optionally declare scored `model_candidates`.
- Model selection priority is CLI `--model`, then scored manifest candidates, then legacy mode fields, then provider default.
- `models select --json` exposes the routing objective, candidate scores, historical failure rates, and selection reasons for cost/effectiveness tuning.
- Agent collaboration is represented as role phases and handoff artifacts in the execution plan; `requiredAgents` contains only phases marked as required.
- `--parallel-agents` optionally runs required non-orchestrator role agents concurrently before the main planning call. Their advisory artifacts are recorded as `agent.started` / `agent.finished` events, included in run reports, and fed into the main model call; they do not apply patches, run commands, or bypass permissions.
- `plan` previews the default strategy, agent handoffs, selected context, and verification commands without calling a model or writing session state.
- `context inspect` prints the full runtime context bundle and structured selection reasons for modules, workflows, source snippets, and compact recent session history, without calling a model.
- `--json` is supported by the main run command, `plan`, `context inspect`, `manifest init/generate/inspect/validate`, `commands list`, `config inspect`, `tools list/run`, `playbooks list/show`, `workflows list/show`, `verify`, `models select`, `stats models`, `strategies list`, `history summary/prune`, `doctor repo`, `doctor models`, reports, checkpoints, rollback, diff, search, and session inspection commands for scripts and future desktop hosts.
- Main run JSON includes session metadata, model routing, plan, selected context, report paths, verification results, permission decisions, model call records, and compact patch summaries.
- Failed `--json` commands emit `{ "kind": "error", "command": "...", "message": "..." }` and still exit non-zero.
- `models select [task...]` previews the provider/model routing decision without calling a model or probing the network. When task text is provided, routing infers a coarse task kind and applies matching historical recommendations as a bounded feedback boost or penalty.

Manifest behavior:

- `manifest init` scaffolds the official `.ai/` repository manifest without calling a model.
- `manifest init --json` returns the `.ai` root plus created and skipped files for host UIs and automation.
- The official root manifest includes `ownership.yaml` so agents and future hosts can map code areas to responsible owners and review boundaries.
- `manifest generate` writes inferred fallback metadata under `.ai/generated/` for inherited repositories that are not ready to adopt the official `.ai/` surface.
- `manifest generate` skips existing generated files by default; pass `--force` only when you intentionally want to refresh inferred fallback metadata.
- Generated `repo-map.json` includes heuristic module candidates, workflow candidates, test mappings, evidence, and confidence levels so inherited repos can be promoted into the official standard incrementally.
- `manifest inspect --json` exposes manifest source, coverage, modules, workflows, playbooks, command groups, and validation results.
- `manifest validate` checks the `.ai/` surface, ownership metadata, module manifests, playbooks, and verification catalog for agent-readable gaps.
- `manifest validate` also checks `.ai/models.yaml` provider names, mode model fields, and scored `model_candidates` quality/cost/latency ranges.
- `manifest validate --json` emits structured issue counts and issue details.
- `commands list` prints the repository-declared standard commands from `.ai/commands.yaml` without executing them.
- `commands list --json` exposes the command catalog as structured command groups.
- `config inspect` prints effective mode, strategy, provider/model routing, repository metadata, manifest coverage, and safety policy counts without calling a model or writing session state.
- `config inspect --json` exposes the same configuration surface for automation and future desktop hosts.
- `tools list` prints the built-in tool runtime catalog with risk levels.
- `tools list --json` exposes tool names, descriptions, risk levels, and input/output schemas without executing tools.
- `tools run <name> <json-input>` executes only read-only tools through the catalog.
- `tools run <name> --json <json-input>` returns a structured `tool-run` envelope with the tool policy decision for agent planners and future hosts.
- `tools run <name> --input-file tool-input.json` avoids shell quoting issues for structured tool input.
- `tools run <name> --record --json` creates a local session event log with `tool.started`, `tool.finished`, and `run.completed` events.
- Recorded tool sessions begin with `run.started`, matching full runtime session timelines.
- Recorded tool policy and execution failures also write `run.failed` and a report, and their JSON error envelope includes artifact links.
- Recorded tool runs also write `permission.checked` so tool risk is auditable in the same event stream as patch and command policy decisions.
- `tools run test.run --json '{"command":"..."}'` is allowed only for commands declared in `.ai/tests.yaml`, `module.yaml`, or `flow.yaml`, and still goes through forbidden command policy.
- Write and execute tools remain unavailable through `tools run`; they must pass through runtime permission, checkpoint, and verification boundaries.
- `playbooks list` and `playbooks show <name>` expose task SOPs from `.ai/playbooks/` without executing them.
- `playbooks list --json` and `playbooks show <name> --json` expose SOP summaries and content for future desktop hosts.
- `workflows list` and `workflows show <name>` expose cross-module task context from `src/workflows/*/flow.yaml`.
- `workflows list --json` and `workflows show <name> --json` expose workflow descriptions, steps, touched modules, risk notes, and targeted verification commands for agent planners and host UIs.
- Existing manifest files are skipped by default.
- `manifest init --force` overwrites existing official manifest files.
- `manifest generate --force` overwrites existing generated fallback files.
- Runtime fallback metadata under `.ai/generated/` is still used for foreign repos that do not have an official `.ai/` manifest.
- Verification planning uses targeted workflow/module `test_commands` first, then `.ai/tests.yaml` `default`, then detected package scripts.
- `verify` runs `.ai/tests.yaml` `default` commands through the same safety command policy and stops at the first failure.
- `verify --json` emits each command result with policy decision, exit code, and bounded output summary.
- Runtime task verification uses the `test.run` tool path and records tool events alongside `tests.finished`.

Each run writes:

- an event log under `.token-streaming/sessions/`
- a markdown report under `.token-streaming/reports/`

Policy, approval, verification-command, malformed patch proposal, and model-provider failures are written to the session event log as `run.failed` before the CLI exits non-zero, so blocked or failed runs remain inspectable.
When `--json` is used and the failure produced a session, the error envelope includes artifact links for the session event log and failure report.

Model calls, optional agent runs, tool calls, review summaries, and change summaries are recorded as metadata in both places. Successful and failed runtime runs both record `review.completed` when a plan exists, so failures still have structured findings and a recommendation. The runtime stores provider, model, purpose, mode, reasoning effort, token usage when available, response length, agent role artifacts, tool names, tool outcomes, compact tool input/output summaries, review findings and recommendation, patch files, applied files, checkpoint id, and final git status/diff summary, but does not persist full prompts as telemetry.

Runtime context includes a compact view of recent sessions: task, status, summary or error, failure category, and bounded tool-result summaries. It intentionally does not replay full event logs or persist full prompts into future prompts.

`models select` explains the current model routing decision for a mode and can consume task-specific telemetry recommendations. `stats models` aggregates model-call telemetry across session logs by provider, model, mode, purpose, failure category, session status, and failure rate. It also emits model recommendations grouped by mode, call purpose, inferred task kind, provider, and model, with confidence, failure rate, average token/response cost proxies, an efficiency score, and a `prefer` / `watch` / `avoid` label. `stats models --json` exposes the same aggregate for dashboards, strategy evaluation, and cost/effectiveness automation.

Session and checkpoint commands make the local agent loop inspectable:

- `history summary` shows recent session, report, checkpoint, and model-call totals.
- `history summary --json` exposes the same aggregate for host dashboards.
- `doctor repo --json` includes latest session/report summaries and status fields in its storage section.
- `history prune --dry-run --keep <count>` previews old sessions, reports, and checkpoints that would be removed while keeping the newest items.
- `history prune --dry-run --keep <count> --json` exposes the same candidate list without deleting anything.
- `history prune --keep <count>` deletes old session, report, and checkpoint files while keeping the newest items.
- `history prune --keep <count> --json` returns the deleted file lists for host UIs and automation.
- `sessions list` shows previous runs.
- `sessions show <session-id|latest>` prints the event timeline for one run.
- `sessions list --json` and `sessions show <session-id|latest> --json` expose run history and event timelines as structured data.
- `sessions stream <session-id|latest> --jsonl` emits start, summary, event, and end envelopes as newline-delimited JSON for future desktop hosts and live timeline viewers.
- `reports list` and `reports show <session-id|latest>` expose markdown run reports written under `.token-streaming/reports/`.
- Session and report list JSON includes structured status fields for completed, failed, and running history entries.
- `checkpoints list` shows rollback points created before patch application.
- `checkpoints list --json` exposes rollback-point summaries without dumping checkpointed file contents.
- `checkpoints show <checkpoint-id|latest>` inspects captured files, existence, size, and a short preview without dumping full checkpoint contents.
- `checkpoints show <checkpoint-id|latest> --json` exposes the same detail for host UIs.
- `rollback <checkpoint-id|latest>` restores the files captured by that checkpoint.
- `rollback <checkpoint-id|latest> --dry-run` previews which files would be restored or deleted without mutating the working tree.
- `rollback <checkpoint-id|latest> --json` returns the restored file list after the rollback has completed.
- `diff` prints current `git status --short` and `git diff -- .`.
- `diff --json` exposes status, diff text, and a clean flag for automation.
- `search <query>` scans repository text files and returns bounded line matches.
- `search <query> --json` exposes match paths, lines, columns, and source text for automation and future context builders.

## Patch Proposal Format

Patch proposals are structured JSON. They are preview-only unless `--apply` is passed.
Preview-only proposals do not create rollback points. Applied proposals pass permission checks first, then create a checkpoint immediately before the patch engine writes files.

```json
{
  "summary": "Add a small generated note.",
  "files": [
    {
      "path": "notes/example.md",
      "content": "# Example\n"
    }
  ]
}
```

`--repair` enables one additional model call after failed verification. The repair response must use the same patch proposal format and still goes through checkpointing and the patch engine.

## Safety Policy

`.ai/safety.yaml` can mark sensitive paths, protected content patterns, and forbidden commands.

- Sensitive paths block patch application unless `--allow-sensitive` is passed.
- Protected content patterns block patch application unless explicitly approved, which helps catch accidental API keys or private keys in proposed file contents.
- Approval-required commands block verification unless approved through `--approval allow` or `--approval prompt`.
- `--approval allow` also approves sensitive writes.
- `--approval prompt` asks the CLI user before sensitive writes.
- Forbidden commands are always blocked.
- Policy checks are written to the session event log and run report.

A `permission.checked` result can say `blocked` for a sensitive patch while a later approval says `approved`. That means policy detected risk and the host explicitly authorized it.

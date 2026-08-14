# V1 Acceptance Matrix

This matrix maps the V1 requirements in `docs/codex-build-brief.zh.md` to current implementation evidence. The current completion decision and exact remaining external condition are recorded in `docs/v1-completion-audit.zh.md`.

The authoritative final gate is:

```bash
pnpm acceptance:check -- --json
```

Without a configured commercial provider key, the gate intentionally reports `missing-api-key` after all offline checks pass, including a deterministic end-to-end stub provider smoke that proves run, review, event-log, and report creation. With an OpenAI, Anthropic, or Gemini key, it performs its own live provider probe and only succeeds when that probe is verified. `--provider` selects the provider explicitly.

## Required Capabilities

| Requirement | Status | Evidence |
| --- | --- | --- |
| CLI host | Complete | `apps/cli/src/index.ts`; CLI JSON tests |
| Headless core | Complete | direct `planTask`/`inspectContext`/`validateManifest`/`listTools`/`runTool`/`rollback` tests, durable `onEvent` host stream test, plus isolated packed-consumer smoke |
| Session Manager | Complete | `packages/core/src/session`; session history tests |
| Repo Scanner | Complete | `packages/tools/src/repo-scanner.ts`; tool tests |
| `.ai/` manifest loader | Complete | `packages/ai-manifest/src/loader.ts`; loader tests |
| Foreign-repo fallback generator | Complete | `packages/ai-manifest/src/generator.ts`; JS and Python inference tests |
| Context Builder | Complete | metadata-first context, reasons, source snippets, recent history tests |
| Default Strategy | Complete | canonical plan fields, task classification, roles, handoffs, context budgets, risk and targeted-verification tests |
| Agent role phases | Complete | required-role activation for `orchestrator`, `researcher`, `coder`, `tester`, and `reviewer`; handoff and advisory parallel-agent tests |
| Tool Runtime | Complete | typed catalog and controlled executor tests |
| Permission System | Complete | patch, command, tool and approval-host tests |
| Patch Engine | Complete | structured proposal parser, repo and symlink boundary tests |
| Command Runner | Complete | bounded shell runner used through policy-checked verification |
| Test Feedback | Complete | pass, fail-fast, policy and approval tests |
| Checkpoint / Rollback | Complete | pre-write snapshots, previews, rollback and tamper-boundary tests |
| Event Log | Complete | append-only JSONL sessions, explicit `run.started` / `context.built` lifecycle events, and event-surface tests |
| Run Report | Complete | success, runtime failure and initialization failure report tests |
| Model Provider interface | Complete | protocol contract in `@token-streaming/protocol` |
| Stub provider | Complete | deterministic offline runtime and CLI tests plus an explicit end-to-end acceptance smoke with review/event-log/report evidence |
| OpenAI provider adapter | Complete | Responses and Chat Completions adapters; mock HTTP probes; bounded and key-redacted diagnostics; live WellAU `gpt-5.5` Chat Completions acceptance passed |
| Anthropic provider adapter | Complete | native Messages request/response translation, native auth/version headers, mock HTTP probe, timeout/retry diagnostics, usage extraction, and key redaction tests |
| Gemini provider adapter | Complete | stable native Interactions request/response translation, native auth header, mock HTTP probe, timeout/retry diagnostics, usage extraction, and key redaction tests |
| Strategy extension point | Complete | registry and injected custom-strategy tests |
| Mode extension point | Complete | economy low-reasoning/light-context/light-verification, auto risk review, and max high-reasoning/required-review tests |
| Module/workflow manifests | Complete | every maintained module has `README.md` plus `module.yaml`; workflows have `README.md` plus `flow.yaml`; loader, validator, context and strategy selection tests |

## Behavioral Acceptance

| Acceptance behavior | Status | Evidence |
| --- | --- | --- |
| `manifest init` creates the standard | Complete | CLI and generator tests |
| `manifest generate` creates fallback mapping | Complete | CLI and generator tests |
| `plan` exposes phases, roles, bounded context and canonical verification commands | Complete | strategy, context-budget and CLI plan JSON tests |
| `context inspect` explains selections | Complete | context JSON and selection-reason tests |
| Model output cannot write directly | Complete | only parsed `PatchProposal` reaches patch handling |
| Checkpoint exists before write | Complete | runtime patch flow and event assertions |
| Sensitive paths and dangerous commands trigger policy | Complete | policy and CLI approval tests |
| Tests run after applied patches | Complete | runtime verification tests |
| One repair pass can follow failure | Complete | repair-call and second-verification tests |
| Every initialized run has session log and report | Complete | success, model failure, malformed patch and initialization failure tests |
| Rollback restores pre-patch state | Complete | checkpoint and CLI rollback tests |
| Core commands expose machine-readable output | Complete | CLI JSON/JSONL surface tests |
| Runtime, manifest, tools, storage and CLI are tested | Complete | full `pnpm test` suite plus packed CLI/headless-core installation smoke |

## Final Verification

Run offline quality gates:

```bash
pnpm lint
pnpm test
pnpm package:check
pnpm package:install-check
```

Run a real provider acceptance probe:

```bash
export OPENAI_API_KEY="..."
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_API_PROTOCOL="responses"
export OPENAI_MODEL="gpt-5.5"
export OPENAI_TIMEOUT_MS="120000"
pnpm acceptance:check -- --json
```

Or select a native provider explicitly:

```bash
export ANTHROPIC_API_KEY="..."
export ANTHROPIC_MODEL="claude-sonnet-5"
pnpm acceptance:check -- --provider anthropic --json

export GEMINI_API_KEY="..."
export GEMINI_MODEL="gemini-3.6-flash"
pnpm acceptance:check -- --provider gemini --json
```

For a relay, set `OPENAI_MODEL` to its exposed model name and raise `OPENAI_TIMEOUT_MS` if generation can exceed 30 seconds. If it only supports Chat Completions, also use `OPENAI_API_PROTOCOL=chat-completions`.

The 2026-08-14 commercial acceptance used WellAU with `gpt-5.5`. Its model catalog exposed that exact name, but its Responses route returned `unknown provider for model gpt-5.5`; the complete gate passed after selecting `OPENAI_API_PROTOCOL=chat-completions`. This relay-specific route limitation does not affect the independently tested Responses adapter.

# V1 Acceptance Matrix

This matrix maps the V1 requirements in `docs/codex-build-brief.zh.md` to current implementation evidence. The authoritative final gate is:

```bash
pnpm acceptance:check -- --json
```

Without `OPENAI_API_KEY`, the gate intentionally reports `missing-api-key` after all offline checks pass. With a key, it performs its own live provider probe and only succeeds when that probe is verified.

## Required Capabilities

| Requirement | Status | Evidence |
| --- | --- | --- |
| CLI host | Complete | `apps/cli/src/index.ts`; CLI JSON tests |
| Headless core | Complete | `TokenStreamingRuntime`, reusable package APIs |
| Session Manager | Complete | `packages/core/src/session`; session history tests |
| Repo Scanner | Complete | `packages/tools/src/repo-scanner.ts`; tool tests |
| `.ai/` manifest loader | Complete | `packages/ai-manifest/src/loader.ts`; loader tests |
| Foreign-repo fallback generator | Complete | `packages/ai-manifest/src/generator.ts`; JS and Python inference tests |
| Context Builder | Complete | metadata-first context, reasons, source snippets, recent history tests |
| Default Strategy | Complete | strategy phases, roles, handoffs, risk and targeted-test tests |
| Tool Runtime | Complete | typed catalog and controlled executor tests |
| Permission System | Complete | patch, command, tool and approval-host tests |
| Patch Engine | Complete | structured proposal parser, repo and symlink boundary tests |
| Command Runner | Complete | bounded shell runner used through policy-checked verification |
| Test Feedback | Complete | pass, fail-fast, policy and approval tests |
| Checkpoint / Rollback | Complete | pre-write snapshots, previews, rollback and tamper-boundary tests |
| Event Log | Complete | append-only JSONL sessions and event-surface tests |
| Run Report | Complete | success, runtime failure and initialization failure report tests |
| Model Provider interface | Complete | protocol contract in `@token-streaming/protocol` |
| Stub provider | Complete | deterministic offline runtime and CLI tests |
| OpenAI provider adapter | Complete, live pending | Responses and Chat Completions adapters; mock HTTP probe passes; external probe needs a key |
| Strategy extension point | Complete | registry and injected custom-strategy tests |
| Mode extension point | Complete | economy/max/auto profiles and routing tests |
| Module/workflow manifests | Complete | loader, validator, context and strategy selection tests |

## Behavioral Acceptance

| Acceptance behavior | Status | Evidence |
| --- | --- | --- |
| `manifest init` creates the standard | Complete | CLI and generator tests |
| `manifest generate` creates fallback mapping | Complete | CLI and generator tests |
| `plan` exposes phases, roles, context and tests | Complete | CLI plan JSON tests |
| `context inspect` explains selections | Complete | context JSON and selection-reason tests |
| Model output cannot write directly | Complete | only parsed `PatchProposal` reaches patch handling |
| Checkpoint exists before write | Complete | runtime patch flow and event assertions |
| Sensitive paths and dangerous commands trigger policy | Complete | policy and CLI approval tests |
| Tests run after applied patches | Complete | runtime verification tests |
| One repair pass can follow failure | Complete | repair-call and second-verification tests |
| Every initialized run has session log and report | Complete | success, model failure, malformed patch and initialization failure tests |
| Rollback restores pre-patch state | Complete | checkpoint and CLI rollback tests |
| Core commands expose machine-readable output | Complete | CLI JSON/JSONL surface tests |
| Runtime, manifest, tools, storage and CLI are tested | Complete | full `pnpm test` suite |

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
pnpm acceptance:check -- --json
```

For a relay that only supports Chat Completions, use `OPENAI_API_PROTOCOL=chat-completions`.

# Model Providers

`@token-streaming/providers` contains the deterministic stub provider, OpenAI Responses and Chat Completions adapters, native Anthropic Messages and Gemini Interactions adapters, the explicit local Codex exec adapter, model routing policy, and provider diagnostics.

## Boundary

Authentication remains outside core. Each provider owns its native wire/process protocol while core consumes one `ModelProvider` interface. Network and model probes are opt-in, time-bounded, safely diagnosed, and separated from offline checks. API providers remain the automatic path; Codex is explicit-only and runs in an ephemeral read-only sandbox. Provider output cannot bypass structured patch, permission, checkpoint, or verification boundaries.

Canonical ownership, dependencies, public API, tests, and rules are declared in [`module.yaml`](module.yaml).

## Verify

```bash
npx pnpm@9.15.0 --filter @token-streaming/providers test
```

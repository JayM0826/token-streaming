# Model Providers

`@token-streaming/providers` contains the deterministic stub provider, OpenAI Responses and Chat Completions adapters, model routing policy, and explicit provider diagnostics.

## Boundary

Authentication remains outside core. Network probes are opt-in, time-bounded, safely diagnosed, and separated from offline checks. Provider output cannot bypass structured patch, permission, checkpoint, or verification boundaries.

Canonical ownership, dependencies, public API, tests, and rules are declared in [`module.yaml`](module.yaml).

## Verify

```bash
npx pnpm@9.15.0 --filter @token-streaming/providers test
```

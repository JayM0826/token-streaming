# AI Manifest

`@token-streaming/ai-manifest` loads, scaffolds, generates, and validates agent-native repository metadata.

## Responsibilities

- Prefer maintained `.ai/`, `module.yaml`, and `flow.yaml` metadata.
- Generate clearly marked `.ai/generated/` fallback mappings for inherited repositories.
- Preserve manually maintained files unless an explicit force option is used.

Canonical ownership, dependencies, public API, tests, and modification rules are declared in [`module.yaml`](module.yaml).

## Verify

```bash
npx pnpm@9.15.0 --filter @token-streaming/ai-manifest test
```

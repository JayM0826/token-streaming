# Storage

`@token-streaming/storage` persists append-only session events, run reports, model telemetry, checkpoints, and rollback state under `.token-streaming/`.

## Boundary

Storage is local and filesystem-backed in V1. Checkpoints preserve original file existence and content so rollback does not depend on git. Telemetry aggregation only reads persisted event data.

Canonical ownership, dependencies, public API, tests, and rules are declared in [`module.yaml`](module.yaml).

## Verify

```bash
npx pnpm@9.15.0 --filter @token-streaming/storage test
```

# Headless Core

`@token-streaming/core` orchestrates sessions, repository context, the default strategy, role handoffs, model calls, permissions, patches, checkpoints, verification, repair, review, and reports without depending on a terminal UI.

## Public Surface

Hosts can plan tasks, inspect context, validate manifests, list and run bounded tools, preview or perform rollback, and execute complete agent runs through `TokenStreamingRuntime`. An optional `onEvent` observer receives each event after it is durably appended, enabling live desktop progress without coupling core to a UI.

## Boundary

V1 has one real strategy, `default`. Product modes adjust cost and quality posture inside that strategy. Optional parallel agents produce advisory artifacts only; all side effects remain under the primary runtime.

Canonical ownership, dependencies, public API, tests, and rules are declared in [`module.yaml`](module.yaml).

## Verify

```bash
npx pnpm@9.15.0 --filter @token-streaming/core test
```

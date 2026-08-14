# Protocol

`@token-streaming/protocol` contains the shared TypeScript contracts for sessions, events, manifests, plans, tools, model calls, reviews, and checkpoints.

## Boundary

This package stays dependency-light and must not import runtime packages. Canonical ownership, dependency direction, public API, tests, and rules are declared in [`module.yaml`](module.yaml).

## Public API

Import contracts from `@token-streaming/protocol`; the source entrypoint is `src/index.ts`.

## Verify

```bash
npx pnpm@9.15.0 --filter @token-streaming/protocol test
```

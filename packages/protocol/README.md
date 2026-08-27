# Protocol

`@token-streaming/protocol` contains the shared TypeScript contracts for sessions, events, manifests, plans, tools, model calls, reviews, checkpoints, and the compute-capacity marketplace.

## Boundary

This package stays dependency-light and must not import runtime packages. Canonical ownership, dependency direction, public API, tests, and rules are declared in [`module.yaml`](module.yaml).

## Public API

Import contracts from `@token-streaming/protocol`; the source entrypoint is `src/index.ts`.

Marketplace contracts treat individual and organization suppliers as first-class peers. They carry only opaque verification and authorization references; credential material is not part of the wire contract. Provider authorizations explicitly bound model, region, data class, validity window, and capacity ceiling so downstream offers cannot silently broaden approved scope.

`marketplace-api.ts` defines the versioned browser/control-plane DTOs and stable error codes. Views intentionally exclude gateway endpoints, encrypted tokens, actor IDs, tenant IDs, and raw evidence documents.

`supplier-gateway.ts` defines the normalized, provider-neutral `gongsuanyun.gateway.v3` node contract. Inference and attestation calls require a bearer credential plus an HMAC-SHA256 signature over the timestamp, nonce, job ID, and exact body digest; provider-native authentication and wire fields stop inside the supplier node. The public readiness response exposes only status and protocol version, while provider/model/capacity claims are returned only through the signed attestation route. Successful inference responses carry canonical signed execution evidence that binds the request, purchased Provider and model, actual served model, content digests, provider request ID, usage, and completion time.

`artifact-task.ts` defines encrypted, resumable large-file uploads and the outbound Supplier Agent worker contract. File bytes stay in chunked object storage and never enter JSON DTOs or D1. Agents claim queued work over signed HTTPS, download tenant-scoped chunks, report monotonic checkpoints, and return aggregate model usage plus canonical artifact execution evidence. Every claimed attempt has a server-enforced six-hour absolute execution deadline that lease renewal cannot extend. Buyer cancellation is an idempotent two-phase command whose `commandId` binds to exactly one task: queued tasks become `cancelled` immediately, while leased tasks expose `cancelling` and keep their reservation until the worker observes cancellation, the lease expires, or the absolute deadline arrives.

The browser/control-plane contract remains `gongsuanyun.artifact.v1`. `cancelling` is an additive, non-terminal projection rather than a persisted status: v1 consumers must display it as still processing with the reservation held, continue polling, and handle future unknown non-terminal values conservatively. A legacy client that exhaustively enumerates only the original statuses must upgrade; the server does not collapse `cancelling` into the financially incorrect `cancelled` state. The independently versioned Supplier Agent contract is `gongsuanyun.artifact-worker.v2`, and v1 workers no longer receive assignments.

`privacy.ts` defines the provider-neutral `standard` and `strict` modes, the public retention summary, and tenant-owned active-content purge commands. Both ordinary inference and artifact-task creation require an explicit acknowledgement that the supplier and upstream Provider process plaintext. `artifact-worker.v2` carries the accepted privacy mode so terminal cleanup is deterministic.

## Verify

```bash
npx pnpm@9.15.0 --filter @token-streaming/protocol test
```

# Architecture

The repository is a pnpm workspace.

```text
apps/cli
apps/web
apps/supplier-node
apps/supplier-agent
packages/core
packages/protocol
packages/marketplace-domain
packages/ai-manifest
packages/tools
packages/storage
packages/providers
```

## Boundaries

- `apps/cli` owns terminal argument parsing, user-facing output, session inspection, and rollback commands.
- `apps/web` owns the Sites deployment composition, responsive presentation, authenticated versioned HTTP routes, D1 repositories and additive race-safe schema bootstrap, buyer-only content access, authenticated privacy retention/purge orchestration, separately encrypted replayable content and R2 artifacts, retryable D1/R2 upload coordination with independent post-metadata deletion tombstones, keyed digest commitments, durable limits, cross-workload reservations, resumable upload orchestration, Agent capability heartbeats, bounded leases and absolute execution deadlines, command-bound two-phase cancellation, server-only signed gateway calls, approval-time live node attestation, per-job execution-evidence signature verification, and guarded evidence/settlement persistence. Gateway credential encryption and its independent lookup HMAC are the first versioned keyring domains: persisted key ids select exact material, old single secrets are dual-read aliases, signed Agent traffic lazily migrates lookup digests, maintenance CAS-rewraps four ciphertexts per round, live references block key retirement, and persistent canaries detect same-id material substitution. Nonce claims cover all readable lookup namespaces in one statement. Authorization review also requires reviewer and supplier tenants to differ. Purge atomically enqueues an object retry and marks the exact immutable chunk generation `deleting` in one D1 batch before R2 deletion, preventing a stale `ready` generation from permanently filtering the queue. Its retention transitions advance at most one artifact and four generations per invocation plus four due queue keys; explicit purge remains retryable until no generation metadata remains, which is the only point an artifact can become `deleted`. These small transitions are not a lower-tier D1 compatibility claim: full maintenance includes schema bootstrap and production requires the Workers Paid 1,000-query-per-invocation quota. Task `content_purged_at` can mean output expiry alone, so full task purge additionally proves the task marker, empty instruction/output state, a purged and deleted associated artifact, and zero generations; the purge route stays reachable after output expiry. Artifact/task final-state retries idempotently backfill missing completion audits using stable action/resource IDs and tenant/action/resource duplicate guards. Independent maintenance validates cryptographic configuration, key canaries, and live key references before cleanup, then exports rotation plus object-deletion, unclaimed-expired-artifact, and pending-generation-tombstone backlogs. Browser components contain no provider credentials or routing policy; supplier, offer, privacy-intent, cancellation, and settlement invariants delegate to the headless marketplace domain and explicit runtime policy objects.
- `apps/supplier-node` owns the headless, deployable supplier gateway, signed-request verification, and replay journal v2. A non-empty durable journal path is mandatory and the runtime never falls back to in-memory replay protection. Journal request records use gateway-token-keyed domain-separated HMAC body commitments, migrate live v1 rows at startup, fsync claims before Provider execution, compact through atomic replacement, and turn readiness plus future claims fail-closed after storage failure. The journal is limited to one active writer per gateway token; active-active HA requires a shared atomic replay-claim store rather than only a shared volume. Bounded in-process result replay, local capacity controls, actual upstream model validation, canonical execution-evidence signing, and the provider-native adapter boundary remain in the node. Its container root is read-only and its dedicated named state volume contains only the replay journal. It never imports or starts the engineering Codex runtime.
- `apps/supplier-agent` owns the cross-platform loopback management GUI/TUI, one-time URL-fragment launch bootstrap followed by an HttpOnly local management session, first-run setup non-overwrite enforcement, passphrase reveal throttling, and a v2 AES-GCM credential vault authenticated against a domain-separated digest of the complete canonical validated profile. Unbound v1 vaults fail closed and require credential rotation plus fresh setup. The Agent also owns the outbound privacy-aware artifact claim host and v2 encrypted resumable checkpoint storage with task/time-bound AAD, a non-sliding six-hour maximum lifetime per attempt, exact platform-confirmed resume, zero-segment fresh-attempt reset with no old runtime state, bounded pre-claim cleanup, and claim-blocking failure if any discovered unsafe file cannot be deleted. A positive resume segment without an exact authenticated checkpoint fails with `ARTIFACT_CHECKPOINT_REQUIRED` before Provider execution. Accepted completion and every other non-retryable terminal path share process-local pending checkpoint deletion; `CHECKPOINT_CLEANUP_FAILED` blocks all later claims until deletion succeeds, while restart safety falls back to the authenticated fixed expiry plus pre-claim cleanup. It composes supplier-node through its public runtime surface and contains no inference or marketplace settlement logic.
- `packages/core` owns runtime orchestration, sessions, strategy registry, mode profiles, strategy execution, and task flow.
- `packages/protocol` owns shared TypeScript contracts.
- `packages/marketplace-domain` owns provider-neutral supplier onboarding, authorization, activation, capacity-offer, privacy-intent/retention, artifact cancellation, and settlement invariants, strict verification of live node attestation against authorization claims, and per-job execution evidence against the purchased service.
- `packages/ai-manifest` owns loading and generating agent-native repository metadata.
- `packages/tools` owns local repo tools such as scan, search, shell, git, tests, and patch application.
- `packages/storage` owns event logs, checkpoints, and run reports.
- `packages/providers` owns model provider adapters.

## Dependency Rules

- CLI may depend on core, providers, protocol, and storage.
- Core may depend on protocol, tools, storage, providers, and ai-manifest.
- Lower-level packages should not depend on core or CLI.
- Protocol should stay dependency-light and must not depend on runtime packages.
- Marketplace domain may depend only on protocol; hosts, storage, and provider adapters depend on its public API rather than the reverse.
- Web may depend on protocol and marketplace-domain. Its client boundary receives only marketplace API DTOs; D1, authenticated identity headers, encrypted gateway material, and provider calls remain server-only.
- Supplier node may depend only on protocol. It accepts normalized signed gateway requests and keeps upstream credentials and native provider fields local to its adapter.
- Supplier Agent may depend on supplier-node only. UI hosts consume safe status and lifecycle methods; credentials never cross into Web marketplace DTOs.

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
- `apps/web` owns the Sites deployment composition, responsive presentation, authenticated versioned HTTP routes, D1 repositories and additive race-safe schema bootstrap, buyer-only content access, privacy retention/purge orchestration, separately encrypted replayable content and R2 artifacts, keyed digest commitments, durable limits, resumable upload orchestration, Agent capability heartbeats and leases, server-only signed gateway calls, approval-time live node attestation, per-job execution-evidence signature verification, and atomic evidence/settlement persistence. Browser components contain no provider credentials or routing policy; supplier, offer, privacy-intent, and settlement invariants delegate to the headless marketplace domain and explicit runtime policy objects.
- `apps/supplier-node` owns the headless, deployable supplier gateway, signed-request verification, replay/idempotency protection, local capacity controls, actual upstream model validation, canonical execution-evidence signing, and provider-native adapter boundary. It never imports or starts the engineering Codex runtime.
- `apps/supplier-agent` owns the cross-platform loopback management GUI/TUI, HttpOnly local management session, passphrase reveal throttling, encrypted local credential vault, outbound privacy-aware artifact claim/checkpoint host, encrypted resumable checkpoint storage, safe lifecycle controls, and supplier onboarding handoff. It composes supplier-node through its public runtime surface and contains no inference or marketplace settlement logic.
- `packages/core` owns runtime orchestration, sessions, strategy registry, mode profiles, strategy execution, and task flow.
- `packages/protocol` owns shared TypeScript contracts.
- `packages/marketplace-domain` owns provider-neutral supplier onboarding, authorization, activation, capacity-offer, privacy-intent/retention and settlement invariants, strict verification of live node attestation against authorization claims, and per-job execution evidence against the purchased service.
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

# Token Streaming

Token Streaming is a CLI-first agentic coding runtime for model orchestration, repository understanding, safe patching, test feedback, and event-sourced execution history.

The project is intentionally headless at the core layer. The CLI is the first host, and a desktop host can later reuse the same runtime contracts.

## V1 Scope

- Implement one real orchestration strategy: `default`.
- Keep product modes represented as `economy`, `max`, and `auto`.
- Treat `.ai/`, `module.yaml`, and `flow.yaml` as first-class repository context.
- Use local Codex exec by default, with explicit API routing for OpenAI, Anthropic, and Gemini and a stub fallback for offline development.
- Persist event logs, checkpoints, and markdown run reports.

## Compute Marketplace Extension

- Treat Token Streaming as the engineering scaffold and source of repository conventions, not as a requirement that customer inference use Codex.
- Use the local Codex project profile in `.codex/config.toml` for AI-assisted planning, implementation, review, and documentation.
- Keep customer inference provider-neutral behind versioned capacity offers and provider adapters; never send customer prompts to the developer's Codex session.
- Build the marketplace as a separate bounded context with protocol-first, headless domain modules and replaceable TUI, desktop, mobile, web, and API hosts.
- Treat individual and organization suppliers as first-class V1 participants under one authorization and metering contract, with KYC/KYB differences expressed as policy.
- Keep P2/P3 capacity fail-closed until dedicated retention, residency, and compliance policy is implemented in the protocol.
- The closed-beta Web deployment uses platform sign-in, D1-backed tenant state, buyer-only content views, explicit standard/strict privacy modes, active content purge, separately encrypted credentials/replayable content/files, keyed digest commitments, durable rate limits, and append-only usage/ledger records.
- The deployable supplier node implements the signed `gongsuanyun.gateway.v3` contract for personal and organization servers, with exact provider/model/data allowlists, replay protection, bounded in-memory idempotency, local capacity enforcement, no prompt/output logging, minimal public readiness, signed approval-time inventory attestation, and node-signed per-job execution evidence. The Web control plane settles only after exact Provider/model/content-digest/usage verification and writes evidence plus ledger postings atomically.
- The cross-platform Supplier Agent is a replaceable local GUI/TUI host over supplier-node. It encrypts Provider and gateway credentials at rest, keeps management loopback-only with an HttpOnly same-site session, reauthenticates and throttles credential reveals, supports safe unlock/drain/lock, and never duplicates inference, signature, capacity, or provider-adapter logic.
- The consumer Web is installable as a PWA on supported desktop and mobile browsers. Native consumer shells remain optional hosts over the same marketplace API rather than a prerequisite for closed-beta use.
- Large text artifacts use a separate async data plane: resumable 4 MiB browser chunks, tenant-bound AES-256-GCM R2 storage, D1 metadata, short-lived outbound Agent capability heartbeats, leases, encrypted checkpoints, bounded map/reduce execution, aggregate exact-model evidence, token-budget reservation, and retention cleanup. The implemented limit is 256 MiB and binary/archive formats fail closed.
- Never describe shared execution as end-to-end confidential: the matched supplier and upstream Provider see plaintext. Strict mode minimizes retention and identifiers; supplier-invisible execution requires a customer node or remotely attested confidential-computing tier.
- Treat promotional beta balance as non-cash test credit; regulated payments, tax/KYC evidence custody, and payouts are external launch dependencies rather than simulated functionality.

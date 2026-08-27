# Web Marketplace

`@token-streaming/web` is the Sites-hosted Web entry point and deployment composition root for the authorized-capacity marketplace. It provides a public sign-in entry, authenticated buyer/supplier workspaces, versioned JSON routes, D1 persistence, and server-only integration with the headless marketplace domain.

## Closed-beta capabilities

- ChatGPT sign-in with server-derived tenant and actor identities.
- Individual and organization supplier registration.
- Encrypted supplier-gateway token submission and administrator authorization review.
- Event-sourced supplier activation and capacity-offer publication through `@token-streaming/marketplace-domain`.
- Durable offers, inference jobs, usage records, audit events, idempotency records, and append-only ledger entries in D1.
- Immutable per-job service evidence that snapshots the purchased Provider/model, actual served model, quoted unit price, measured usage, final charge, provider request ID, and evidence digest.
- Fail-closed P0/P1 matching with capacity, concurrency, validity, balance, and gateway-host controls.
- Input minimization: prompt bodies are not persisted. New content digests are converted to tenant/resource-bound HMAC commitments before persistence, so low-entropy prompts cannot be tested with an offline SHA-256 dictionary. Outputs use a separate AES-256-GCM content key and bounded replay window.
- Explicit privacy intent: `strict` is the UI default, supplier/upstream plaintext visibility requires affirmative acknowledgement, and buyers can actively purge ordinary outputs, files, or file tasks without rewriting append-only financial evidence.
- Buyer-only content views prevent suppliers from reading customer filenames and replayable outputs through the dashboard. Login email/name remain in the identity service instead of being duplicated in market D1.
- Durable D1 rate limits cover authenticated mutations and signed Agent calls; browser writes require same-origin checks and security headers deny caching, framing, referrers, MIME sniffing, and unnecessary device capabilities.
- The automated D1 migration-integrity test applies every migration to a temporary local database, seeds pre-privacy inference and artifact rows before migrations 0004–0005, and verifies that all 19 tables, legacy data, privacy defaults, key/digest versions, and rate-limit indexes survive the upgrade. Runtime bootstrap independently checks every additive column and safely rechecks after a concurrent Worker-isolate migration race.
- Installable consumer PWA metadata and a minimal service worker that never caches authenticated pages or API responses.
- Supplier onboarding guidance for the separate cross-platform Supplier Agent; Provider credentials remain on the supplier device.
- Resumable browser uploads up to 256 MiB in fixed 4 MiB chunks. Each chunk is hashed client-side, authenticated with tenant ownership, encrypted with AES-256-GCM, and stored in R2; D1 stores only metadata, IVs, digests, progress, and evidence.
- Asynchronous artifact scheduling uses short-lived Supplier Agent capability heartbeats, exact offer/authorization/model/media matching, leases, bounded attempts, encrypted instructions, monotonic checkpoints, and a 30-minute queue timeout.
- Standard artifact input is retained for at most 48 hours and results for 24 hours. Strict uploads hide the original filename, keep only a 60-minute waiting window, delete input at terminal state, and retain results for at most 60 minutes. A bounded sweep physically deletes R2 bytes, chunk metadata, raw manifests, instructions, and expired result ciphertext while retaining keyed commitments, audit, and financial evidence.

The browser never receives provider credentials and cannot choose another tenant. Provider-specific wire formats stop at the server-side gateway adapter. Local Codex is used only for engineering and is never a customer inference route.

## Authorized supplier-node contract

An approved HTTPS supplier node receives signed `gongsuanyun.gateway.v3` JSON with `model`, `input`, `data_class`, `max_output_tokens`, and `stream: false`. Every request includes a timestamp, one-time nonce, job ID, and HMAC-SHA256 signature over the exact body digest. Before approval, the control plane sends a signed one-time challenge to `/v3/attestation` and requires the live Provider identity, exact model inventory, P0/P1 scope, and capacity to contain the requested authorization. It returns normalized output and a signed execution-evidence envelope:

```json
{
  "output": "...",
  "usage": {
    "input_tokens": 120,
    "output_tokens": 80,
    "total_tokens": 200
  },
  "execution_evidence": {
    "evidence_version": "gongsuanyun.execution-evidence.v1",
    "request_id": "job-...",
    "provider_id": "authorized-provider",
    "requested_model": "exact-model-id",
    "served_model": "exact-model-id",
    "provider_request_id": "provider-request-...",
    "input_sha256": "64 lowercase hex characters",
    "output_sha256": "64 lowercase hex characters",
    "usage": {
      "input_tokens": 120,
      "output_tokens": 80,
      "total_tokens": 200
    },
    "completed_at": "2026-08-25T00:00:00.000Z"
  },
  "execution_evidence_signature": "HMAC-SHA256 lowercase hex"
}
```

The control plane checks the exact Provider and model, input/output digests, usage, completion window, and HMAC signature before calculating settlement. The verified evidence row, usage record, buyer debit, supplier credit, platform fee, and completed job update are committed as one D1 batch. Any missing, malformed, substituted, or tampered evidence returns `SERVICE_EVIDENCE_FAILED`; the job fails and no financial entries are created.

Production approval requires the gateway hostname in `MARKETPLACE_GATEWAY_HOST_ALLOWLIST` and a successful live attestation. The platform also requires separate 32-byte base64 `MARKETPLACE_CREDENTIAL_KEY`, `MARKETPLACE_CONTENT_KEY`, and `MARKETPLACE_COMMITMENT_KEY` secrets; all are managed by Sites runtime configuration rather than source files.

Artifact storage additionally requires a separate 32-byte base64 `MARKETPLACE_ARTIFACT_KEY` and the `ARTIFACTS` R2 binding. The key is never returned to the browser or Supplier Agent. AES-GCM additional authenticated data binds tenant, artifact, part number, and plaintext digest, and both ciphertext and plaintext digests are checked on every supplier download.

Encryption at rest is not execution secrecy: the matched Supplier Agent and its upstream Provider receive plaintext while running a task. Customers requiring execution-party confidentiality must use a customer-controlled node or a future remotely attested confidential-computing tier.

The current balance is a closed-beta promotional balance. Cash collection, tax invoicing, KYC/KYB evidence storage, and payouts require external regulated providers before public commercial launch.

The `node-signed-provider-response` assurance level proves that the hardened supplier-node observed and signed the upstream response model; it is not independent cryptographic proof from the upstream Provider. Stronger future tiers require official provider-signed receipts, platform-managed provider accounts, or attested confidential-computing workers.

## Verify

```bash
corepack pnpm@9.15.0 --dir apps/web typecheck
node --test "apps/web/test/**/*.test.mjs"
corepack pnpm@9.15.0 --dir apps/web build
corepack pnpm@9.15.0 --dir apps/web lint
```

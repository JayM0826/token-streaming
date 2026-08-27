# Marketplace Domain

`@token-streaming/marketplace-domain` is the headless, provider-neutral domain core for supplier onboarding and capacity offers.

## Public Surface

The package exposes event-sourced supplier commands, rehydration helpers, capacity-offer publication, and stable domain errors. Individual and organization suppliers use the same aggregate and offer contract. Their only policy difference is the required verification set: KYC for individuals and KYB/beneficial-ownership checks for organizations.

Personal `subscription-plan` capacity is a supported source type. It still requires an active provider authorization record and verifiable metering before the supplier can activate or publish an offer. Authorization records cap model, region, data class, time window, and capacity; an offer cannot widen any of those fields.

Activation is not a permanent bypass. New offers re-check current KYC/KYB and provider authorization state. P2/P3 offers fail closed until a dedicated compliance policy is represented in the protocol.

Settlement helpers calculate integer-micro buyer charges, platform fees, and supplier credits without floating-point money. The returned postings are balanced by construction and are consumed by deployment-specific append-only ledger storage.

Signed supplier-node attestation verification compares the approval claim with the live node's protocol, challenge, Provider identity, exact model inventory, P0/P1 scope, and available capacity. A mismatch fails closed before the authorization can activate.

Per-job execution-evidence verification compares the purchased Provider and exact model with the node's served model, input/output SHA-256 digests, provider request ID, normalized usage, and completion window. The host must verify the node signature and persist the verified evidence in the same atomic batch as settlement; an evidence mismatch is never billable.

Artifact-task evidence extends the same invariant across a multi-call job: it binds the immutable artifact manifest, whole-content digest, requested and served exact model, aggregate Provider request-ID digest, segment count, output digest, total usage, and completion window. `estimateArtifactMaximumChargeMicros` reserves the buyer-approved full-task token ceiling using integer micros; actual settlement still uses verified aggregate usage and cannot exceed that reservation.

Privacy intent is also headless policy. `parseMarketplacePrivacyMode`, `assertSupplierProcessingAcknowledged`, and `calculateMarketplacePrivacyRetentionMilliseconds` keep accepted modes, explicit plaintext-processing consent, and standard/strict retention calculations consistent across Web and worker hosts. `decideArtifactTaskCancellation` is the shared two-phase cancellation state machine: queued work releases immediately, but leased work remains reserved until terminal so cancellation cannot race a billable completion.

## Security Boundary

The domain accepts opaque references to identity, payout, tax, and provider authorization evidence. It rejects password, Cookie, API-key, reusable-token, client-secret, unknown fields, malformed structures, and non-serializable values at runtime. Raw documents and credentials belong in dedicated identity or credential systems, never in domain events.

Supplier events use aggregate versions, event IDs, and causation IDs. Persistence must enforce uniqueness and optimistic concurrency; a retry with an existing command/causation ID returns the already-committed result instead of appending a second financial or capacity effect.

## Verify

```bash
npx pnpm@9.15.0 --filter @token-streaming/marketplace-domain test
```

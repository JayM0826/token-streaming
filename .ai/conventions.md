# Conventions

- Use TypeScript with `NodeNext` modules.
- Keep package boundaries explicit and small.
- Prefer no external dependency when Node built-ins are enough.
- Use append-only events for execution history.
- Keep runtime core UI-agnostic.
- Represent future features with narrow interfaces before implementing full behavior.
- Model marketplace state transitions as versioned append-only events and keep personal/organization differences in explicit policy tables.
- Re-check current verification and authorization at every capacity publication; offers may narrow but never widen approved scope.
- Use command/causation IDs plus optimistic aggregate versions for idempotent marketplace writes.
- Sign control-plane to supplier-node calls over the exact body digest, timestamp, nonce, and job ID; reject stale, replayed, or body-mismatched requests.
- Keep public supplier-node readiness minimal; disclose Provider, model, data-class, and capacity inventory only through a signed one-time attestation and compare it with the pending authorization before activation.
- Require every billable supplier response to include canonical signed execution evidence binding the purchased Provider and exact model, actual upstream response model, input/output digests, provider request ID, usage, and completion time. Evidence mismatch fails without settlement.
- Keep supplier-node logs metadata-only and keep provider credentials, prompts, outputs, and native provider fields inside the node boundary.
- Keep Supplier Agent management loopback-only, put its per-process session token only in an HttpOnly SameSite=Strict Cookie, require same-origin writes and passphrase reauthentication for credential reveal, throttle failures, and encrypt local credentials with a user-held passphrase. Public tunnel setup is explicit and never changes host firewall or router state automatically.
- Keep large-file bytes out of JSON, D1, logs, checkpoints, and ordinary work directories. Use fixed resumable chunks in encrypted object storage, verify plaintext and ciphertext digests, and bind encryption AAD to tenant/artifact/part identity.
- Let Supplier Agents advertise file capability through short-lived signed outbound heartbeats. Queue only exact authorization/model/media/size matches; use expiring leases, monotonic checkpoints, bounded attempts, queue timeouts, and fail-closed evidence settlement.
- Treat supplier/upstream plaintext visibility as an explicit product boundary. Require affirmative acknowledgement, keep customer content views buyer-only, default to strict minimal retention, and never claim execution-party confidentiality without attested confidential computing.
- Use independent credential, replayable-content, artifact, and digest-commitment keys. Bind AES-GCM and HMAC commitments to version, purpose, tenant, and resource; clear active manifests with the underlying bytes.
- Preserve ledger, usage, evidence, and audit history during privacy purge; clear only replayable customer content and add purge timestamps/events.
- Keep D1 upgrades additive and backward compatible. Verify every migration against a real temporary legacy database, mirror additive columns in the re-entrant runtime bootstrap, and re-read schema before accepting a concurrent migration race.
- Do not add a second real strategy until `default` is solid.


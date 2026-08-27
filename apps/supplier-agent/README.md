# GongSuanYun Supplier Agent

`@token-streaming/supplier-agent` is the cross-platform local control client for individual and organization suppliers. It hosts a responsive GUI on `127.0.0.1`, while all inference, request-signature, replay, capacity, upstream-host, exact-model, and execution-evidence behavior remains in the headless `@token-streaming/supplier-node` kernel.

## What it provides

- First-run setup for Provider identity, exact models, public gateway address, local capacity limits, and upstream protocol. Once a profile/vault pair exists, setup fails closed instead of overwriting credentials; normal restarts use unlock.
- Version 2 AES-256-GCM credential vault with a 12+ character user passphrase and scrypt key derivation. A domain-separated SHA-256 digest of the complete canonical, validated profile is authenticated as GCM additional data, so changing an endpoint, upstream host allowlist, model, limit, timestamp, or any other profile field makes unlock fail closed. The Provider API key and generated gateway token are never stored in plaintext.
- Loopback-only management UI bootstrapped with a one-time per-process 256-bit launch secret in the URL fragment. Browser fragments are not sent in HTTP requests or Referer headers; the page reads the fragment, immediately erases it with `history.replaceState`, and exchanges it once through same-origin `POST /api/bootstrap` for an `HttpOnly; SameSite=Strict` session Cookie. The server burns the launch secret after the exchange; subsequent state changes also require same-origin checks, strict Host validation, no CORS, no caching, and restrictive browser security headers.
- One-button unlock, online status, safe drain/lock, and metadata-only metrics. Revealing the gateway token requires a fresh passphrase check every time, auto-hides after 60 seconds, and throttles repeated or parallel password failures; the Provider key is never revealed.
- Outbound large-file worker for files up to 256 MiB: it advertises a short-lived capability heartbeat, claims only exact authorized Provider/model work, downloads verified chunks, and reports monotonic progress without exposing a new inbound port.
- Version 2 encrypted local file-task checkpoints support retry and restart without repeating completed model segments. Each envelope has authenticated `createdAt`/`expiresAt` timestamps with a six-hour default and hard maximum lifetime; rewrites within one attempt preserve the original deadline instead of sliding it. The envelope version, task ID, and both timestamps are AES-GCM additional authenticated data. Resume occurs only when local completed segments exactly match the platform assignment. A claimed assignment with `resume_from_segment > 0` must find an authenticated, unexpired checkpoint for the same task whose completed segment matches exactly; missing or mismatched state raises non-retryable `ARTIFACT_CHECKPOINT_REQUIRED`, reports terminal failure, and stops before downloading input or invoking a Provider. When the platform starts a fresh attempt with `resume_from_segment = 0`, the Agent deletes any same-task checkpoint, explicitly passes no old state to the runtime, and gives the new attempt's first checkpoint a fresh fixed six-hour lifetime. Every poll, including the initial poll after startup, performs a bounded cleanup (100 files by default, never more than 1,000) before claiming work and removes expired, legacy-v1, corrupt, and orphaned temporary checkpoints. If any discovered unsafe file cannot be deleted, the Agent raises non-retryable `CHECKPOINT_CLEANUP_FAILED` and sends no claim; the same code also fails closed when an unsafe current-task checkpoint cannot be discarded during read. After the platform has accepted terminal completion, a checkpoint-delete failure is reported as `CHECKPOINT_CLEANUP_FAILED` without sending a contradictory task failure. Every non-retryable terminal failure likewise deletes its checkpoint through the same process-local pending-delete path; if deletion fails, all later claims remain blocked until retry succeeds. That set is process-local; after restart, the authenticated non-sliding expiry still caps checkpoint validity at six hours, and pre-claim cleanup blocks work if the expired file cannot then be removed. Checkpoints never contain the original customer file.
- Windows, macOS, and Linux browser launching without shell interpolation. Node.js 22+ is the only runtime dependency.

The Agent does not automatically open router ports or create third-party tunnel accounts. Real-time short requests still require a stable public HTTPS reverse proxy or named outbound tunnel forwarding `/v3/inference` to `127.0.0.1:<gatewayPort>`. Large-file tasks use outbound-only polling and do not require another public endpoint.

## Run

```bash
corepack pnpm@9.15.0 --filter @token-streaming/supplier-agent build
node apps/supplier-agent/dist/index.js start
```

The client opens the local control center in the default browser. Use `doctor` for a credential-free TUI/automation check:

```bash
node apps/supplier-agent/dist/index.js doctor
```

For a Node-free Windows x64 handoff, build the tested portable ZIP. It bundles the current Node runtime, compiled Agent, supplier-node kernel, protocol package, launchers, and Chinese setup instructions:

```powershell
corepack pnpm@9.15.0 --filter @token-streaming/supplier-agent package:windows-portable
```

## Security notes

- Use only Provider accounts or projects whose terms authorize the intended managed-inference or resale use.
- Do not paste ChatGPT, Codex, browser cookies, OAuth sessions, passwords, or personal subscription login state into the Agent.
- Do not expose management port `8790` to a LAN, tunnel, reverse proxy, or public firewall rule.
- Treat the automatically opened bootstrap URL as a one-time local launch capability: do not copy it, bookmark it, log it, or open it on another machine. The fragment is removed from browser history before the management session is used.
- Existing encrypted configuration is never replaced by the setup endpoint. To rotate credentials or intentionally change the bound profile, first drain/lock the Agent and finish or cancel active file work, run `doctor` to record the exact profile/vault paths, move the complete state directory to a private backup, revoke and rotate both old Provider and gateway credentials, then rerun first-time setup with the new profile and credentials. Do not merely edit `profile.json`: the vault is deliberately bound to its complete canonical contents.
- The passphrase is not recoverable. Losing it requires replacing the local vault and rotating both Provider and gateway credentials.
- Vault version 1 is intentionally not decrypted or migrated in place. Upgrading from a version 1 vault fails closed at unlock and requires the same drain, private-backup, credential-rotation, and fresh-setup procedure above; this prevents an unbound legacy profile from being trusted during migration.
- Marketplace authorization and offers are exact-model records. When one Agent allows multiple models, publish one authorization and one offer for each listed model.
- File contents are treated as untrusted UTF-8 data. Version 0.3 speaks `gongsuanyun.artifact-worker.v2`, propagates strict/standard privacy mode, accepts text, Markdown, CSV/TSV, JSON/NDJSON, and XML, and never extracts archives, runs files, follows embedded URLs, or invokes tools and Shell commands.
- A matched supplier and upstream Provider necessarily process customer plaintext. The Agent limits persistence and exposure, but does not claim confidential execution against the device owner.

## Verify

```bash
corepack pnpm@9.15.0 --filter @token-streaming/supplier-agent test
```

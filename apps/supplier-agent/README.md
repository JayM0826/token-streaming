# GongSuanYun Supplier Agent

`@token-streaming/supplier-agent` is the cross-platform local control client for individual and organization suppliers. It hosts a responsive GUI on `127.0.0.1`, while all inference, request-signature, replay, capacity, upstream-host, exact-model, and execution-evidence behavior remains in the headless `@token-streaming/supplier-node` kernel.

## What it provides

- First-run setup for Provider identity, exact models, public gateway address, local capacity limits, and upstream protocol.
- AES-256-GCM credential vault with a 12+ character user passphrase and scrypt key derivation. The Provider API key and generated gateway token are never stored in plaintext.
- Loopback-only management UI protected by a per-process 256-bit `HttpOnly; SameSite=Strict` session Cookie, same-origin write checks, strict Host validation, no CORS, no caching, and restrictive browser security headers. The session token never enters a URL or frontend JavaScript.
- One-button unlock, online status, safe drain/lock, and metadata-only metrics. Revealing the gateway token requires a fresh passphrase check every time, auto-hides after 60 seconds, and throttles repeated or parallel password failures; the Provider key is never revealed.
- Outbound large-file worker for files up to 256 MiB: it advertises a short-lived capability heartbeat, claims only exact authorized Provider/model work, downloads verified chunks, and reports monotonic progress without exposing a new inbound port.
- Encrypted local file-task checkpoints support retry and restart without repeating completed model segments. The checkpoint is task-bound, deleted after completion, and never contains the original customer file.
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
- The passphrase is not recoverable. Losing it requires replacing the local vault and rotating both Provider and gateway credentials.
- Marketplace authorization and offers are exact-model records. When one Agent allows multiple models, publish one authorization and one offer for each listed model.
- File contents are treated as untrusted UTF-8 data. Version 0.3 speaks `gongsuanyun.artifact-worker.v2`, propagates strict/standard privacy mode, accepts text, Markdown, CSV/TSV, JSON/NDJSON, and XML, and never extracts archives, runs files, follows embedded URLs, or invokes tools and Shell commands.
- A matched supplier and upstream Provider necessarily process customer plaintext. The Agent limits persistence and exposure, but does not claim confidential execution against the device owner.

## Verify

```bash
corepack pnpm@9.15.0 --filter @token-streaming/supplier-agent test
```

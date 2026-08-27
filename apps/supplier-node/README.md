# GongSuanYun Supplier Node

`@token-streaming/supplier-node` is the headless supplier runtime for both individual and organization suppliers. It exposes the signed `gongsuanyun.gateway.v3` HTTPS contract to the marketplace and translates only accepted requests into an authorized upstream model API.

The node never starts local Codex, executes tools or shell commands, follows buyer-provided URLs, reads buyer files, or logs prompt/output bodies. Upstream credentials remain on the supplier server. The marketplace receives only normalized output, provider request ID, opaque receipt reference, and integer usage.

## Security boundary

- Bearer authentication plus HMAC-SHA256 body signatures, a five-minute timestamp window, and one-time nonces for both inference and node attestation.
- Exact model and P0/P1 data-class allowlists; P2/P3 fail closed.
- Fixed public HTTPS upstream base URL, explicit hostname allowlist, and redirects disabled.
- Bounded body/response sizes, RPM/TPM/concurrency/output limits, 60-second default upstream timeout, and graceful draining.
- Fifteen-minute in-memory idempotent replay with request-body conflict detection; no prompt or output persistence on disk.
- Loopback binding by default. The included container composition exposes only Caddy, which obtains and renews public TLS certificates.
- Read-only, non-root supplier container with all Linux capabilities dropped and a small non-executable temporary filesystem.
- Exact comparison between the requested model and the upstream response `model`; successful responses include a signed execution-evidence record binding Provider, model, request ID, input/output digests, usage, and completion time.
- Headless artifact executor for bounded UTF-8 files: verifies the ordered chunk manifest and every SHA-256 digest, uses deterministic segments and hierarchical reduction, isolates file text as untrusted data, enforces a full-task token budget, and signs aggregate evidence.
- Resumable segment checkpoints contain only summaries, aggregate usage, and opaque Provider request IDs. The executor never writes the original file, executes content, follows embedded URLs, or invokes tools.
- `gongsuanyun.artifact-worker.v2` carries the accepted privacy mode. Strict terminal tasks trigger immediate platform-side input deletion; a cancelled assignment fails non-retryably so the Agent removes its encrypted checkpoint.

Bearer and upstream credentials are deployment secrets. Never paste the upstream API key into the marketplace. Only the generated gateway token is submitted through the marketplace authorization form, where the control plane encrypts it.

The node and upstream Provider see plaintext during execution. TLS, encrypted storage, metadata-only logs, and bounded checkpoints reduce exposure but do not provide confidential computing against the supplier device owner.

## Configure and run on a public server

Prerequisites: a Linux server with Docker Compose, ports 80/443 open, and a DNS A/AAAA record for the supplier-node hostname.

1. Copy `.env.example` to `.env` on the server.
2. Build the package and run `node dist/index.js token` once to generate a 256-bit gateway token. Put the same value in `.env` and in the marketplace authorization form.
3. Set an upstream credential belonging to a project/account whose terms explicitly permit the intended managed-inference or resale use.
4. Set exact allowed model names, capacity, data classes, upstream base URL, and upstream hostname allowlist.
5. Run `docker compose up -d --build`, then check `https://<your-host>/healthz`.
6. Submit `https://<your-host>/v3/inference` as the marketplace gateway endpoint. Platform approval still requires that hostname in the production gateway allowlist.

`GET /healthz` exposes only readiness and protocol version. During approval, the marketplace derives `POST /v3/attestation` from the same origin, sends a signed one-time challenge, and verifies the returned Provider identity, exact model inventory, P0/P1 scope, and capacity before activation. The full node inventory is therefore not public.

Run `node dist/index.js doctor` before startup to validate configuration without making a provider request. It reports only the provider identifier, upstream hostname, model/data allowlists, and limits; secret values are never returned.

## Supported upstream protocols

- `responses`: POST to `<base-url>/responses` with `store: false`.
- `chat-completions`: POST to `<base-url>/chat/completions`.

Both adapters require a provider request ID and the actual response model, reject model substitution, and internally normalize usage to `input_tokens`, `output_tokens`, and `total_tokens`. Native provider errors and credential fields do not escape the adapter. Configure exact model IDs: aliases that resolve to a different returned model fail closed until the offer is updated to that exact ID.

The artifact executor uses the same adapters and exact-model check. Adapter calls carry deterministic task/segment idempotency keys, so a retry can resume from the last platform-confirmed segment without silently changing the purchased model.

## Verify

```bash
corepack pnpm@9.15.0 --filter @token-streaming/supplier-node test
```

# Repository instructions

## Two boundaries that must not be mixed

- Engineering plane: use the local Codex installation for AI-assisted planning, implementation, review, and documentation. The repository profile is `gpt-5.6-sol`, `xhigh`, and Codex Fast mode.
- Product data plane: customer inference is provider-neutral and must run through authorized, versioned provider adapters selected from an accepted capacity quote. Never route customer prompts through the developer's local Codex session.

`.codex/config.toml` controls the engineering agent only. `.ai/models.yaml` belongs to the inherited Token Streaming runtime and is not the marketplace's production routing policy.

## Engineering conventions inherited from Token Streaming

- Keep domain/runtime code headless. TUI, desktop, mobile, web, and CLI are replaceable hosts over public protocols and `client-core`.
- Put shared wire types, commands, events, error codes, and schemas in a dependency-light protocol package. Do not import runtime, storage, provider, or UI packages into protocol.
- Keep business logic out of hosts and provider adapters. Provider-specific request shapes, authentication, usage fields, and errors stop at the adapter boundary.
- Treat `.ai/`, each package `README.md` plus `module.yaml`, and workflow `README.md` plus `flow.yaml` as maintained architecture metadata. Update them when ownership, public APIs, dependencies, tests, or invariants change.
- Preserve append-only events and ledger entries. Corrections use compensating events or postings; never rewrite financial history.
- Route file changes through explicit patches and checkpoints. Validate paths remain inside the intended workspace and keep generated artifacts clearly marked.
- Use structured results and stable machine-readable error codes at boundaries. Do not parse business state from display strings.
- Add capabilities through registries/adapters and policy objects, not provider or UI conditionals scattered through the core.
- Keep credentials out of source, prompts, logs, telemetry, fixtures, and client bundles. Tests use stubs by default; live probes must be explicit.
- Maintain strict TypeScript, `noUncheckedIndexedAccess`, NodeNext modules, declarations, and project references unless an accepted ADR changes the stack.

## Change workflow

1. Read the nearest `README.md`, `module.yaml`, and relevant `.ai/` metadata before editing a module.
2. Define or update the protocol and invariants before host-specific implementation.
3. Add tests with each behavior change, including failure, idempotency, authorization, and tenant-isolation cases where relevant.
4. Run the narrow package test first, then the repository gates appropriate to the change.
5. Update architecture documentation and ADRs when a public contract, trust boundary, ownership rule, or financial invariant changes.

## Baseline verification

```powershell
corepack pnpm@9.15.0 test
corepack pnpm@9.15.0 package:check
```

Use `package:install-check` for package/public-surface changes and `acceptance:check` only when its live-provider behavior is intentional.

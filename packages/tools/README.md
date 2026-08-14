# Tool Runtime

`@token-streaming/tools` provides the bounded local tool catalog for repository scanning, search, file reads, git inspection, command execution, verification, and structured patch application. Shell execution has default time and captured-output limits with structured timeout/truncation diagnostics.

## Boundary

Direct catalog execution is read-only. Write and execute operations must pass through core permission, checkpoint, and verification boundaries. Repository paths are validated before access.

Canonical ownership, dependencies, public API, tests, and rules are declared in [`module.yaml`](module.yaml).

## Verify

```bash
npx pnpm@9.15.0 --filter @token-streaming/tools test
```

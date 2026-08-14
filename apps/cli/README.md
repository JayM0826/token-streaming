# CLI Host

`@token-streaming/cli` is the terminal host for the headless Token Streaming runtime. It translates command-line intent into core API calls and exposes stable text, JSON, and JSONL surfaces for people, automation, and a future desktop host.

## Responsibilities

- Parse tasks, product modes, provider options, patch inputs, and approval choices.
- Expose read-only inspection, history, doctor, manifest, tool, verification, and rollback commands.
- Keep interactive approval prompts on stderr so JSON stdout remains machine-readable.

## Boundary

Business logic belongs in `@token-streaming/core`; the CLI should only adapt inputs and present outputs. Canonical ownership, dependencies, tests, and rules are declared in [`module.yaml`](module.yaml).

## Verify

```bash
npx pnpm@9.15.0 --filter @token-streaming/cli test
```

# Add A Model Provider

When adding a model provider:

1. Add the provider implementation under `packages/providers/src`.
2. Export it from `packages/providers/src/index.ts`.
3. Wire selection through `packages/providers/src/factory.ts`.
4. Keep provider-specific auth out of core runtime.
5. Update CLI flags only when the provider needs user-selectable options.
6. Add native request/response contract tests, doctor connection checks, and a provider-specific smoke command.
7. Add the provider key pattern to generated and repository safety policies without logging the key value.
6. Run `npx pnpm@9.15.0 build`.
7. Run `npx pnpm@9.15.0 test`.

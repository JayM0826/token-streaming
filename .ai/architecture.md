# Architecture

The repository is a pnpm workspace.

```text
apps/cli
packages/core
packages/protocol
packages/ai-manifest
packages/tools
packages/storage
packages/providers
```

## Boundaries

- `apps/cli` owns terminal argument parsing, user-facing output, session inspection, and rollback commands.
- `packages/core` owns runtime orchestration, sessions, strategy registry, mode profiles, strategy execution, and task flow.
- `packages/protocol` owns shared TypeScript contracts.
- `packages/ai-manifest` owns loading and generating agent-native repository metadata.
- `packages/tools` owns local repo tools such as scan, search, shell, git, tests, and patch application.
- `packages/storage` owns event logs, checkpoints, and run reports.
- `packages/providers` owns model provider adapters.

## Dependency Rules

- CLI may depend on core, providers, protocol, and storage.
- Core may depend on protocol, tools, storage, providers, and ai-manifest.
- Lower-level packages should not depend on core or CLI.
- Protocol should stay dependency-light and must not depend on runtime packages.

# Token Streaming Implementation Plan

## 1. Product Positioning

Token Streaming is a CLI-first agentic coding runtime for orchestrating commercial foundation models to perform software engineering tasks with high reliability, strong cost control, and clean operational safety.

Its value is not in training a base model. Its value is in:

- understanding model capability boundaries
- routing the right model to the right task
- coordinating agent roles only when needed
- making repositories easier for AI systems to understand and operate
- closing the loop through tools, tests, patching, checkpoints, and rollback

The first version should prioritize a strong and extensible core instead of breadth.

## 2. First-Phase Goal

Build the first usable version of the runtime with these properties:

- CLI-first
- headless reusable core
- one real orchestration strategy: `default`
- extension points for future strategies and product modes
- `.ai/` manifest support
- patch and checkpoint safety
- repo understanding that combines code scanning with explicit repo metadata

This first version must be able to:

1. start a session from the CLI
2. inspect a repository
3. load `.ai/` metadata if present
4. generate fallback metadata for foreign repos
5. build a task-aware execution plan using the `default` strategy
6. read files, search, run commands, apply patches, and run tests
7. summarize results and persist execution history

## 3. Non-Goals For V1

Do not fully implement these in the first phase:

- multiple orchestration strategies beyond `default`
- desktop app UI
- large swarm-style agent systems
- vector database retrieval
- enterprise-grade permission center
- distributed execution
- broad plugin marketplace support

Leave architectural hooks for them, but do not let them complicate the first milestone.

## 4. Core Design Principles

### 4.1 AI does not fear large codebases

AI does not fear code volume. It fears hidden relationships.

The system should optimize for making these relationships explicit:

- module ownership
- public interfaces
- dependency boundaries
- workflow boundaries
- test mappings
- dangerous files and commands
- common task playbooks

### 4.2 Headless core, multiple hosts

The runtime should be UI-agnostic.

- CLI is the first host
- desktop app is a future host
- both should talk to the same core through typed events and contracts

### 4.3 Dynamic agents, not permanent swarms

The runtime should maintain a primary orchestrator and activate specialized agents only when useful.

This keeps:

- startup fast
- cost controlled
- state simpler
- execution easier to reason about

### 4.4 Strategy and mode are different layers

- strategy decides how work is organized
- mode decides cost versus quality posture

V1 only implements `default` strategy, but the architecture must reserve room for:

- strategies: `default`, `review`, `debug`, `manifest`, `refactor`, etc.
- product modes: `economy`, `max`, `auto`

## 5. Runtime Architecture

Recommended stack:

- language: TypeScript
- runtime: Node.js 22 LTS
- package manager: pnpm workspace
- validation: zod
- logging: pino
- tests: vitest

Suggested repo layout:

```text
apps/
  cli/

packages/
  core/
    session/
    orchestrator/
    strategy/
    agents/
    context/
    router/
    permissions/
    patch/
    checkpoints/

  protocol/
    events/
    messages/
    manifests/
    strategies/

  providers/
    openai/

  tools/
    filesystem/
    search/
    shell/
    git/
    tests/

  storage/
    event-log/
    snapshots/

  ai-manifest/
    schema/
    loader/
    generator/
```

## 6. Execution Flow

The V1 execution loop should look like this:

```text
User Task
-> CLI Host
-> Session Manager
-> Repo Scanner
-> Manifest Loader
-> Default Strategy
-> Orchestrator
-> Research Phase
-> Code Change Phase
-> Patch Engine
-> Test Phase
-> Review Pass
-> Final Summary
-> Checkpoint Saved
```

## 7. Agent Model

Keep the model simple in V1:

- `Orchestrator` is the primary long-lived runtime coordinator
- `Research` behavior is activated when repo understanding is needed
- `Coder` behavior is activated when file changes are needed
- `Tester` behavior is activated when verification is required
- `Reviewer` behavior is activated when the task is risky or a diff exists

These do not need to be separate long-running workers in V1. They can be role-specific execution paths inside the core.

This preserves future compatibility with a richer multi-agent design without overbuilding now.

## 8. Strategy Layer

V1 should expose a strategy contract but only implement `default`.

Suggested contract:

```ts
export interface OrchestrationStrategy {
  id: string;
  createPlan(input: StrategyInput): Promise<ExecutionPlan>;
}
```

`default` should behave like this:

- simple question: answer with minimal tool usage
- code understanding task: research first
- code change task: research, patch, test
- risky area or sensitive command: require stronger review path
- if `.ai/playbooks` apply, prefer them

## 9. Product Modes

Keep the API surface ready for:

```ts
export type ProductMode = "economy" | "max" | "auto";
```

V1 implementation guidance:

- `economy`: fewer heavy calls, lower reasoning effort, lighter verification
- `max`: stronger reasoning, more verification, review required
- `auto`: choose based on task risk and complexity

Even if these are lightly implemented at first, they should be represented in config and execution planning.

## 10. Agent-Native Repository Standard

The repository standard has three semantic layers.

### 10.1 Repo layer

Global project context lives in `.ai/`.

```text
.ai/
  project.md
  architecture.md
  conventions.md
  commands.yaml
  tests.yaml
  safety.yaml
  ownership.yaml
  glossary.md
  playbooks/
```

Purpose:

- describe the project
- explain architecture and conventions
- declare commands and test entrypoints
- define safety rules
- map code areas to owners and review boundaries
- capture glossary and common task playbooks

### 10.2 Module layer

Each business module should be self-describing.

Example:

```text
src/modules/payment/
  README.md
  module.yaml
  api.ts
  service.ts
  repository.ts
  errors.ts
  tests/
```

Example `module.yaml`:

```yaml
name: payment
description: Handles payment authorization, capture, refund, and provider callbacks.

owners:
  - backend-platform

public_api:
  - src/modules/payment/api.ts

depends_on:
  - user
  - order
  - billing

used_by:
  - checkout
  - subscription

test_commands:
  - pnpm test src/modules/payment
  - pnpm test tests/e2e/payment-flow.test.ts

rules:
  - Do not call Stripe SDK outside provider/*
  - All provider errors must be normalized to PaymentError
  - Refund logic must be idempotent
```

Purpose:

- define module responsibility
- expose public interfaces
- show dependency relationships
- define test entrypoints
- capture rules and forbidden patterns

### 10.3 Workflow layer

Cross-module business flows should also be explicit.

Example:

```text
src/workflows/checkout/
  README.md
  flow.yaml
  checkout.service.ts
  tests/
```

Example `flow.yaml`:

```yaml
name: checkout
description: Handles order creation, inventory reservation, payment authorization, and notification.

steps:
  - create order
  - reserve inventory
  - authorize payment
  - confirm order
  - send notification

touches:
  - src/modules/order
  - src/modules/inventory
  - src/modules/payment
  - src/modules/notification

test_commands:
  - pnpm test src/workflows/checkout
  - pnpm test e2e/checkout.test.ts

risks:
  - Payment failure must release inventory.
  - Notification failure must not leave the order in an inconsistent state.
```

Purpose:

- define real business flows
- reveal cross-module relationships
- expose workflow-specific failure modes and review risks
- map high-level user tasks to affected code regions

## 11. Repo Scanner And Manifest Generator

The runtime must support both native and foreign repos.

### 11.1 Native repos

If the repo follows the standard:

- load `.ai/*`
- load module manifests
- load workflow manifests
- use them as first-class context

### 11.2 Foreign repos

If the repo does not follow the standard:

- inspect repository structure
- detect package manager and scripts
- infer likely modules and workflows
- generate fallback metadata under `.ai/generated/`

Suggested command:

```bash
ai manifest init
```

Generated artifacts may include:

```text
.ai/generated/project.md
.ai/generated/architecture.md
.ai/generated/commands.yaml
.ai/generated/tests.yaml
.ai/generated/repo-map.json
```

The runtime should prefer official `.ai/` files, then fall back to generated metadata.

## 12. Context Builder Rules

The context builder should follow this order:

1. task description
2. repo-level `.ai/` metadata
3. relevant workflow metadata
4. relevant module metadata
5. source files
6. test files
7. recent tool outputs and session history

This ensures the agent sees intent and boundaries before raw code volume.

## 13. Safety Model

The runtime must never rely on model judgment alone for risky behavior.

Safety should be enforced through:

- permission policies
- dangerous command allowlists or denylists
- patch previews
- checkpointing before edits
- rollback support
- review passes for risky work

`safety.yaml` should support concepts like:

- sensitive paths
- forbidden commands
- commands requiring approval
- modules requiring review

## 14. Checkpoints And Rollback

Every file-editing operation should be mediated by a patch engine and guarded by a checkpoint.

Checkpoint goals:

- save pre-edit file state
- persist patch metadata
- enable rollback without requiring git history
- make execution auditable

This is critical for trust.

## 15. Event-Sourced Sessions

Persist sessions as append-only event logs.

Examples of events:

- user message received
- plan created
- tool started
- tool finished
- patch proposed
- patch applied
- tests started
- tests finished
- review completed
- checkpoint created

This becomes the basis for:

- replay
- debugging
- desktop visualization later
- future telemetry and evals

## 16. Recommended Model Usage

For implementation work on this project, use `gpt-5.5` as the primary model.

Reasoning:

- strong coding ability
- strong architectural reasoning
- better fit for long-context implementation planning
- appropriate for tool-rich agent runtime work

Initial guidance:

- use medium reasoning effort by default
- raise effort for core architecture decisions
- later introduce smaller models for lightweight repo scans, summaries, and low-risk tasks

## 17. V1 Milestones

### Milestone 1: Monorepo skeleton

- create pnpm workspace
- create package boundaries
- wire TypeScript configs
- add CLI entrypoint

### Milestone 2: Core contracts

- protocol types
- strategy interface
- mode enum
- provider interface
- tool interface
- manifest schemas

### Milestone 3: Session and storage

- event log persistence
- session lifecycle
- checkpoint persistence

### Milestone 4: Repo intelligence

- repo scanner
- `.ai/` loader
- generated manifest fallback

### Milestone 5: Tool runtime

- file read
- search
- shell command
- git diff
- test runner
- patch apply

### Milestone 6: Default strategy loop

- create execution plan
- run research phase
- run code change phase
- run tests
- summarize result

### Milestone 7: Hardening

- error handling
- approval hooks
- rollback flow
- baseline tests

## 18. Complete Codex Build Prompt

Use the following prompt to start implementation in Codex.

```text
You are building the first working version of a CLI-first agentic coding runtime called Token Streaming.

Project goal:
Create a headless TypeScript/Node.js core with a CLI host that can inspect a repository, load AI-oriented repo metadata, plan work, use tools, apply patches, run tests, and persist execution history.

This is not a generic chat app. It is the foundation of a multi-model, multi-agent coding system. However, for V1 you must keep the implementation tight and only fully implement one orchestration strategy: `default`.

Key product ideas:
- The product's value is in model orchestration, repo understanding, execution safety, and cost/quality control.
- The architecture must leave room for future strategy variants and product modes.
- The system must support an agent-native repository standard built around `.ai/` metadata plus module-level and workflow-level metadata.

Technical constraints:
- Use TypeScript and Node.js 22 LTS.
- Use a pnpm workspace monorepo.
- Keep the core headless and reusable.
- The CLI is only the first host.
- Use explicit interfaces and simple abstractions.
- Do not overbuild speculative future systems.

What to implement now:
1. Monorepo skeleton with `apps/cli` and reusable packages.
2. Core contracts for:
   - sessions
   - events
   - strategies
   - product modes
   - model providers
   - tools
   - checkpoints
   - manifests
3. A working `default` orchestration strategy.
4. A repo scanner.
5. A manifest loader for:
   - `.ai/project.md`
   - `.ai/architecture.md`
   - `.ai/conventions.md`
   - `.ai/commands.yaml`
   - `.ai/tests.yaml`
   - `.ai/safety.yaml`
   - `.ai/ownership.yaml`
   - `.ai/glossary.md`
   - `.ai/playbooks/*`
6. Support for module-level metadata like `src/modules/*/module.yaml`.
7. Support for workflow-level metadata like `src/workflows/*/flow.yaml`.
8. Fallback metadata generation for repos that do not yet follow the standard, stored under `.ai/generated/`.
9. Tool runtime support for:
   - reading files
   - searching code
   - running shell commands
   - running tests
   - computing diffs
   - applying patches
10. Event-sourced session logging.
11. Checkpoint and rollback interfaces.

Important architectural rules:
- Only one real strategy should be implemented now: `default`.
- Leave extension points for future strategies such as `review`, `debug`, and `manifest`, but do not build them yet.
- Represent product modes in the type system: `economy`, `max`, `auto`.
- Agent roles can exist as internal role-based execution paths rather than full concurrent workers.
- Context building must prioritize explicit metadata before raw source code.
- The system must be safe by construction: patch engine, checkpoints, and permission hooks are required design concepts.

Execution model:
- User task enters through the CLI.
- A session starts.
- The repo is scanned.
- `.ai/` metadata is loaded if present.
- Module and workflow metadata are loaded if present.
- If metadata is missing, generate fallback metadata.
- The `default` strategy creates an execution plan.
- The runtime performs research, code-change, test, and review phases as needed.
- The runtime persists an event log and checkpoint information.

Repository standard expectations:
- `.ai/` holds repo-wide intent and rules.
- `module.yaml` describes module responsibility, public API, dependencies, tests, and rules.
- `flow.yaml` describes cross-module business workflows and related tests.
- The runtime should be able to consume these files as first-class context.

Implementation preferences:
- Favor clarity over cleverness.
- Keep code comments minimal and useful.
- Build thin abstractions that can genuinely carry V2.
- Make the project runnable early, even with stubbed provider internals where necessary.

Expected output:
- Create the repository skeleton.
- Add package manifests and TypeScript configuration.
- Implement the first pass of the core interfaces and runtime wiring.
- Add concise documentation where it helps orient future work.
- Keep the structure clean enough that future strategy expansion is straightforward.
```

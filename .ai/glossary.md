# Glossary

- Agent-native repo: a repository that exposes architecture, rules, commands, tests, and workflows as machine-readable context.
- Default strategy: the only implemented V1 orchestration strategy.
- Product mode: a cost and quality posture such as `economy`, `max`, or `auto`.
- Provider: a model transport adapter for OpenAI, Anthropic, Gemini, explicit local Codex exec, or the deterministic stub.
- Codex exec provider: the default adapter, using the installed Codex CLI and its existing login through an ephemeral read-only subprocess.
- Event log: an append-only JSONL record of a session.
- Checkpoint: a pre-edit file state snapshot used for rollback.

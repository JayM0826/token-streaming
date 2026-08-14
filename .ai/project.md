# Token Streaming

Token Streaming is a CLI-first agentic coding runtime for model orchestration, repository understanding, safe patching, test feedback, and event-sourced execution history.

The project is intentionally headless at the core layer. The CLI is the first host, and a desktop host can later reuse the same runtime contracts.

## V1 Scope

- Implement one real orchestration strategy: `default`.
- Keep product modes represented as `economy`, `max`, and `auto`.
- Treat `.ai/`, `module.yaml`, and `flow.yaml` as first-class repository context.
- Use local Codex exec by default, with explicit API routing for OpenAI, Anthropic, and Gemini and a stub fallback for offline development.
- Persist event logs, checkpoints, and markdown run reports.

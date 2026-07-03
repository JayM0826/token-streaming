# Agent Run Workflow

This workflow describes the cross-module path from a user task to a persisted run result.

It is intentionally stored outside any single package because the runtime path touches CLI parsing, manifest loading, strategy planning, provider calls, tool execution, checkpointing, verification, and reporting.


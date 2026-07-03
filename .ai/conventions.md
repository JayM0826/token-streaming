# Conventions

- Use TypeScript with `NodeNext` modules.
- Keep package boundaries explicit and small.
- Prefer no external dependency when Node built-ins are enough.
- Use append-only events for execution history.
- Keep runtime core UI-agnostic.
- Represent future features with narrow interfaces before implementing full behavior.
- Do not add a second real strategy until `default` is solid.


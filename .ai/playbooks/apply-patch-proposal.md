# Apply A Patch Proposal

When applying a patch proposal:

1. Ensure the proposal is valid JSON with `summary` and `files`.
2. Each file entry must include `path` and full `content`.
3. Run the CLI without `--apply` first to preview and record `patch.proposed`.
4. Re-run with `--apply` only when the proposal should write files.
5. Confirm a checkpoint was created before files changed.
6. Use `--approval prompt` or `--approval allow` only when sensitive paths should be approved.
7. Use `--repair` only when one model-generated repair attempt is acceptable.
8. Run `npx pnpm@9.15.0 build`.
9. Run `npx pnpm@9.15.0 test`.

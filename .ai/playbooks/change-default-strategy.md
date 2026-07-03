# Change Default Strategy

When changing the default strategy:

1. Edit `packages/core/src/strategy/default-strategy.ts`.
2. Keep `default` as the only fully implemented strategy in V1.
3. Preserve the `OrchestrationStrategy` contract.
4. Make task classification, risk detection, and test selection explicit.
5. Run the CLI smoke command from `.ai/tests.yaml`.
6. Check that event logs still include `plan.created`.


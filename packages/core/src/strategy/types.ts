import type { ExecutionPlan, StrategyInput } from "@token-streaming/protocol";

export interface OrchestrationStrategy {
  id: string;
  createPlan(input: StrategyInput): Promise<ExecutionPlan>;
}

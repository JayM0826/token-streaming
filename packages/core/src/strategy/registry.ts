import type { StrategyId } from "@token-streaming/protocol";
import { DefaultStrategy } from "./default-strategy.js";
import type { OrchestrationStrategy } from "./types.js";

export class StrategyRegistry {
  private readonly strategies = new Map<string, OrchestrationStrategy>();

  constructor(strategies: OrchestrationStrategy[] = [new DefaultStrategy()]) {
    for (const strategy of strategies) {
      this.register(strategy);
    }
  }

  register(strategy: OrchestrationStrategy): void {
    if (!strategy.id) {
      throw new Error("Strategy id must be non-empty.");
    }
    this.strategies.set(strategy.id, strategy);
  }

  resolve(id: StrategyId = "default"): OrchestrationStrategy {
    const strategy = this.strategies.get(id);
    if (!strategy) {
      throw new Error(`Unknown strategy "${id}". Available strategies: ${this.available().join(", ") || "none"}.`);
    }
    return strategy;
  }

  available(): string[] {
    return [...this.strategies.keys()].sort();
  }
}

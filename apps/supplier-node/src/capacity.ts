import { SupplierNodeError } from "./errors.js";

interface CapacityEntry {
  occurredAt: number;
  tokens: number;
}

export class CapacityGate {
  private readonly entries: CapacityEntry[] = [];
  private active = 0;

  constructor(
    private readonly requestsPerMinute: number,
    private readonly tokensPerMinute: number,
    private readonly concurrency: number
  ) {}

  acquire(estimatedTokens: number, nowMs = Date.now()): () => void {
    this.prune(nowMs);
    if (this.active >= this.concurrency) {
      throw new SupplierNodeError("CAPACITY_EXCEEDED", "供应节点并发容量已满。", 429, true);
    }
    const usedTokens = this.entries.reduce((sum, entry) => sum + entry.tokens, 0);
    if (this.entries.length >= this.requestsPerMinute || usedTokens + estimatedTokens > this.tokensPerMinute) {
      throw new SupplierNodeError("CAPACITY_EXCEEDED", "供应节点分钟容量已用尽。", 429, true);
    }
    this.entries.push({ occurredAt: nowMs, tokens: estimatedTokens });
    this.active += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active -= 1;
      }
    };
  }

  private prune(nowMs: number): void {
    while (this.entries[0] && this.entries[0].occurredAt <= nowMs - 60_000) {
      this.entries.shift();
    }
  }
}

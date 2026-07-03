import type { ModelRequest, ProductMode } from "@token-streaming/protocol";

export interface ModeProfile {
  mode: ProductMode;
  planningReasoningEffort: NonNullable<ModelRequest["reasoningEffort"]>;
  repairReasoningEffort: NonNullable<ModelRequest["reasoningEffort"]>;
  description: string;
}

export function resolveModeProfile(mode: ProductMode): ModeProfile {
  if (mode === "economy") {
    return {
      mode,
      planningReasoningEffort: "medium",
      repairReasoningEffort: "medium",
      description: "Prefer lower-cost execution while still allowing bounded repair reasoning."
    };
  }

  if (mode === "max") {
    return {
      mode,
      planningReasoningEffort: "high",
      repairReasoningEffort: "high",
      description: "Prefer stronger reasoning for planning, review, and repair paths."
    };
  }

  return {
    mode,
    planningReasoningEffort: "medium",
    repairReasoningEffort: "high",
    description: "Use balanced planning with stronger repair reasoning when verification fails."
  };
}

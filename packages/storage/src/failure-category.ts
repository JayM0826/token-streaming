export type FailureCategory =
  | "model-provider"
  | "patch-proposal"
  | "patch-policy"
  | "approval"
  | "command-policy"
  | "tool-policy"
  | "tool-execution"
  | "unknown";

export function classifyFailure(error: string): FailureCategory {
  if (error.startsWith("Model call failed during ")) {
    return "model-provider";
  }
  if (error.startsWith("Patch blocked by policy: ")) {
    return "patch-policy";
  }
  if (error.startsWith("Patch blocked by approval: ")) {
    return "approval";
  }
  if (error.startsWith("Command blocked by policy: ")) {
    return "command-policy";
  }
  if (error.includes("Patch proposal") || error.includes("Unexpected end of JSON input")) {
    return "patch-proposal";
  }
  if (error.startsWith('Tool risk "') || error.includes("runtime permission boundaries")) {
    return "tool-policy";
  }
  if (error.startsWith("Path escapes repository root: ") || error.startsWith("Tool input ")) {
    return "tool-execution";
  }
  return "unknown";
}

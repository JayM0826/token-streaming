import type { PatchProposal, PermissionDecision, RepoManifest, ToolDefinition } from "@token-streaming/protocol";

export interface PolicyOptions {
  allowSensitive?: boolean;
}

interface SafetyPolicy {
  sensitivePaths: string[];
  forbiddenCommands: string[];
  approvalRequiredCommands: string[];
  protectedPatterns: string[];
}

export function evaluatePatchPolicy(manifest: RepoManifest, proposal: PatchProposal, options: PolicyOptions = {}): PermissionDecision {
  const safety = readSafetyPolicy(manifest);
  const touchedSensitivePaths = proposal.files
    .map((file) => normalizePath(file.path))
    .filter((filePath) => safety.sensitivePaths.some((sensitivePath) => matchesPath(filePath, sensitivePath)));
  const protectedPatternMatches = proposal.files.flatMap((file) =>
    safety.protectedPatterns
      .filter((pattern) => matchesContent(file.content, pattern))
      .map((pattern) => ({ path: normalizePath(file.path), pattern }))
  );

  const requiresApproval = touchedSensitivePaths.length > 0 || protectedPatternMatches.length > 0;

  if (requiresApproval && !options.allowSensitive) {
    return {
      target: "patch",
      action: "apply patch proposal",
      allowed: false,
      severity: "high",
      reasons: [
        ...touchedSensitivePaths.map((filePath) => `Patch touches sensitive path: ${filePath}`),
        ...protectedPatternMatches.map((match) => `Patch content in ${match.path} matches protected pattern: ${match.pattern}`)
      ],
      requiresApproval: true
    };
  }

  return {
    target: "patch",
    action: "apply patch proposal",
    allowed: true,
    severity: requiresApproval ? "high" : "low",
    reasons: requiresApproval
      ? [
          ...touchedSensitivePaths.map((filePath) => `Sensitive path approved: ${filePath}`),
          ...protectedPatternMatches.map((match) => `Protected pattern approved in ${match.path}: ${match.pattern}`)
        ]
      : [],
    requiresApproval
  };
}

export function evaluateCommandPolicy(manifest: RepoManifest, command: string): PermissionDecision {
  const safety = readSafetyPolicy(manifest);
  const normalizedCommand = command.trim().toLowerCase();
  const forbiddenMatch = safety.forbiddenCommands.find((forbiddenCommand) => normalizedCommand.includes(forbiddenCommand.toLowerCase()));

  if (forbiddenMatch) {
    return {
      target: "command",
      action: command,
      allowed: false,
      severity: "high",
      reasons: [`Command matches forbidden pattern: ${forbiddenMatch}`],
      requiresApproval: false
    };
  }

  const approvalRequiredMatch = safety.approvalRequiredCommands.find((approvalCommand) =>
    normalizedCommand.includes(approvalCommand.toLowerCase())
  );

  if (approvalRequiredMatch) {
    return {
      target: "command",
      action: command,
      allowed: false,
      severity: "medium",
      reasons: [`Command requires approval pattern: ${approvalRequiredMatch}`],
      requiresApproval: true
    };
  }

  return {
    target: "command",
    action: command,
    allowed: true,
    severity: "low",
    reasons: [],
    requiresApproval: false
  };
}

export function evaluateToolPolicy(tool: Pick<ToolDefinition, "name" | "risk">): PermissionDecision {
  if (tool.risk === "read") {
    return {
      target: "tool",
      action: tool.name,
      allowed: true,
      severity: "low",
      reasons: [],
      requiresApproval: false
    };
  }

  return {
    target: "tool",
    action: tool.name,
    allowed: false,
    severity: tool.risk === "write" ? "high" : "medium",
    reasons: [`Tool risk "${tool.risk}" must pass through runtime permission boundaries.`],
    requiresApproval: true
  };
}

function readSafetyPolicy(manifest: RepoManifest): SafetyPolicy {
  const safety = manifest.safety ?? {};
  return {
    sensitivePaths: stringArray(safety.sensitive_paths).map(normalizePath),
    forbiddenCommands: stringArray(safety.forbidden_commands),
    approvalRequiredCommands: stringArray(safety.approval_required_commands),
    protectedPatterns: stringArray(safety.protected_patterns)
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function matchesPath(filePath: string, pattern: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  if (normalizedPattern.endsWith("*")) {
    return filePath.startsWith(normalizedPattern.slice(0, -1));
  }
  return filePath === normalizedPattern || filePath.startsWith(`${normalizedPattern}/`);
}

function matchesContent(content: string, pattern: string): boolean {
  if (!pattern.trim()) {
    return false;
  }

  try {
    return new RegExp(pattern, "i").test(content);
  } catch {
    return content.toLowerCase().includes(pattern.toLowerCase());
  }
}

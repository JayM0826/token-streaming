import { readTextFile } from "./filesystem.js";
import { getGitDiff, getGitStatus } from "./git.js";
import { scanRepo } from "./repo-scanner.js";
import { searchRepo } from "./search.js";
import { runTestCommand } from "./test-runner.js";

export type ReadOnlyToolName = "repo.scan" | "repo.search" | "file.read" | "git.status" | "git.diff";
export type RunnableToolName = ReadOnlyToolName | "test.run";

export interface ToolRunInput {
  repoRoot: string;
  [key: string]: unknown;
}

export async function runReadOnlyTool(name: string, input: ToolRunInput): Promise<unknown> {
  if (!["repo.scan", "repo.search", "file.read", "git.status", "git.diff"].includes(name)) {
    throw new Error(`Tool "${name}" is not available through read-only execution.`);
  }

  return runTool(name, input);
}

export async function runTool(name: string, input: ToolRunInput): Promise<unknown> {
  if (name === "repo.scan") {
    return scanRepo(input.repoRoot);
  }

  if (name === "repo.search") {
    const query = requireString(input, "query");
    const maxMatches = optionalNumber(input, "maxMatches");
    return {
      matches: await searchRepo(input.repoRoot, query, maxMatches === undefined ? undefined : { maxMatches })
    };
  }

  if (name === "file.read") {
    return {
      content: await readTextFile(input.repoRoot, requireString(input, "path"))
    };
  }

  if (name === "git.status") {
    return {
      status: await getGitStatus(input.repoRoot)
    };
  }

  if (name === "git.diff") {
    return {
      diff: await getGitDiff(input.repoRoot)
    };
  }

  if (name === "test.run") {
    return runTestCommand(input.repoRoot, requireString(input, "command"));
  }

  throw new Error(`Tool "${name}" is not available through catalog execution.`);
}

function requireString(input: ToolRunInput, key: string): string {
  const value = input[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(`Tool input requires non-empty string field "${key}".`);
}

function optionalNumber(input: ToolRunInput, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`Tool input field "${key}" must be a number when provided.`);
}

import { runCommand } from "./shell.js";

export async function getGitDiff(repoRoot: string): Promise<string> {
  const result = await runCommand("git diff -- .", { cwd: repoRoot, timeoutMs: 30_000 });
  return result.stdout.trim();
}

export async function getGitStatus(repoRoot: string): Promise<string> {
  const result = await runCommand("git status --short", { cwd: repoRoot, timeoutMs: 30_000 });
  return result.stdout.trim();
}

export async function listGitFiles(repoRoot: string): Promise<string[]> {
  const result = await runCommand("git ls-files", { cwd: repoRoot, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

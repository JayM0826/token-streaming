import { runCommand, type CommandResult } from "./shell.js";

export async function runTestCommand(repoRoot: string, command: string): Promise<CommandResult> {
  return runCommand(command, { cwd: repoRoot, timeoutMs: 120_000 });
}

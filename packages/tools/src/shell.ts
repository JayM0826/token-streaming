import { spawn } from "node:child_process";

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
}

export async function runCommand(command: string, options: RunCommandOptions): Promise<CommandResult> {
  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];

  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, { cwd: options.cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill();
        }, options.timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({ command, cwd: options.cwd, exitCode, stdout, stderr });
    });
  });
}

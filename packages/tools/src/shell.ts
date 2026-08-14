import { spawn } from "node:child_process";

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_COMMAND_OUTPUT_BYTES = 1_000_000;

export async function runCommand(command: string, options: RunCommandOptions): Promise<CommandResult> {
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, "timeoutMs");
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_COMMAND_OUTPUT_BYTES, "maxOutputBytes");
  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];

  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, { cwd: options.cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const captured = captureChunk(chunk, maxOutputBytes - capturedBytes);
      stdout += captured.text;
      capturedBytes += captured.bytes;
      if (captured.truncated) {
        stdoutTruncated = true;
        outputLimitExceeded = true;
        child.kill();
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const captured = captureChunk(chunk, maxOutputBytes - capturedBytes);
      stderr += captured.text;
      capturedBytes += captured.bytes;
      if (captured.truncated) {
        stderrTruncated = true;
        outputLimitExceeded = true;
        child.kill();
      }
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ command, cwd: options.cwd, exitCode, stdout, stderr, timedOut, outputLimitExceeded, stdoutTruncated, stderrTruncated });
    });
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function captureChunk(chunk: Buffer, remainingBytes: number): { text: string; bytes: number; truncated: boolean } {
  const bytes = Math.max(0, Math.min(chunk.length, remainingBytes));
  return {
    text: chunk.subarray(0, bytes).toString(),
    bytes,
    truncated: bytes < chunk.length
  };
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse } from "@token-streaming/protocol";

type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

export interface CodexExecProviderOptions {
  executablePath: string;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  environment?: ProviderEnvironment;
  runner?: CodexExecRunner;
}

export interface CodexExecRunOptions {
  executablePath: string;
  args: string[];
  cwd: string;
  prompt: string;
  outputPath: string;
  timeoutMs: number;
  environment: ProviderEnvironment;
}

export interface CodexExecRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  finalMessage?: string;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
}

export type CodexExecRunner = (options: CodexExecRunOptions) => Promise<CodexExecRunResult>;

export interface CodexExecDetection {
  executablePath?: string;
  source: "configured" | "desktop" | "path" | "missing";
  found: boolean;
  searchedPaths: string[];
}

export interface CodexExecInspection {
  runnable: boolean;
  version?: string;
  message: string;
}

export const DEFAULT_CODEX_EXEC_TIMEOUT_MS = 300_000;
export const MAX_CODEX_EXEC_PROMPT_BYTES = 2 * 1024 * 1024;
export const MAX_CODEX_EXEC_OUTPUT_BYTES = 1024 * 1024;

export class CodexExecProvider implements ModelProvider {
  readonly name = "codex";
  private readonly executablePath: string;
  private readonly model?: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly environment: ProviderEnvironment;
  private readonly runner: CodexExecRunner;

  constructor(options: CodexExecProviderOptions) {
    this.executablePath = options.executablePath;
    this.model = validateModel(options.model);
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CODEX_EXEC_TIMEOUT_MS;
    this.environment = options.environment ?? process.env;
    this.runner = options.runner ?? runCodexExec;
  }

  async generate(input: ModelRequest): Promise<ModelResponse> {
    assertNoNestedCodexExec(this.environment);
    const prompt = formatCodexPrompt(input.messages);
    if (Buffer.byteLength(prompt, "utf8") > MAX_CODEX_EXEC_PROMPT_BYTES) {
      throw new Error(`Codex exec prompt exceeds the ${MAX_CODEX_EXEC_PROMPT_BYTES}-byte limit.`);
    }

    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "token-streaming-codex-"));
    const outputPath = path.join(temporaryDirectory, "last-message.txt");
    try {
      const result = await this.runner({
        executablePath: this.executablePath,
        args: buildCodexExecArgs(outputPath, this.model, input.reasoningEffort),
        cwd: this.cwd,
        prompt,
        outputPath,
        timeoutMs: this.timeoutMs,
        environment: childEnvironment(this.environment)
      });
      if (result.timedOut) {
        throw new Error(`Codex exec request timed out after ${this.timeoutMs}ms.`);
      }
      if (result.outputLimitExceeded) {
        throw new Error(`Codex exec output exceeded the ${MAX_CODEX_EXEC_OUTPUT_BYTES}-byte limit.`);
      }
      if (result.exitCode !== 0) {
        throw new Error(formatCodexExecFailure(result));
      }

      const savedMessage = normalizedValue(result.finalMessage) ?? normalizedValue(await readOptionalFile(outputPath));
      const content = (savedMessage ?? extractFinalMessage(result.stdout)).trim();
      if (!content) {
        throw new Error("Codex exec completed without a final assistant message.");
      }
      return {
        provider: this.name,
        model: this.model ?? extractModel(result.stdout) ?? "codex-configured",
        content,
        usage: extractUsage(result.stdout)
      };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export function detectCodexExec(
  options: {
    configuredPath?: string;
    environment?: ProviderEnvironment;
    platform?: NodeJS.Platform;
    fileExists?: (candidate: string) => boolean;
  } = {}
): CodexExecDetection {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? existsSync;
  const searchedPaths: string[] = [];
  const configuredPath = normalizedValue(options.configuredPath ?? environment.CODEX_EXEC_PATH);
  if (configuredPath) {
    const resolved = path.resolve(configuredPath);
    searchedPaths.push(resolved);
    return { executablePath: resolved, source: "configured", found: fileExists(resolved), searchedPaths };
  }

  if (platform === "win32") {
    const localAppData = normalizedValue(environment.LOCALAPPDATA);
    if (localAppData) {
      const desktopPath = path.join(localAppData, "OpenAI", "Codex", "bin", "codex.exe");
      searchedPaths.push(desktopPath);
      if (fileExists(desktopPath)) {
        return { executablePath: desktopPath, source: "desktop", found: true, searchedPaths };
      }
    }
  }

  for (const candidate of pathCandidates(environment, platform)) {
    searchedPaths.push(candidate);
    if (fileExists(candidate)) {
      return { executablePath: candidate, source: "path", found: true, searchedPaths };
    }
  }
  return { source: "missing", found: false, searchedPaths };
}

export async function inspectCodexExec(
  executablePath: string,
  options: { timeoutMs?: number; environment?: ProviderEnvironment } = {}
): Promise<CodexExecInspection> {
  const result = await runProcess({
    executablePath,
    args: ["--version"],
    cwd: process.cwd(),
    prompt: "",
    timeoutMs: options.timeoutMs ?? 5_000,
    environment: options.environment ?? process.env
  });
  if (result.timedOut) {
    return { runnable: false, message: "Codex executable version check timed out." };
  }
  if (result.exitCode !== 0) {
    return { runnable: false, message: formatCodexExecFailure(result, "Codex executable check failed") };
  }
  const version = firstNonEmptyLine(result.stdout) ?? firstNonEmptyLine(result.stderr);
  if (!version || !/^codex(?:-cli)?\b/i.test(version)) {
    return {
      runnable: false,
      message: `Configured executable did not identify itself as Codex CLI${version ? ` (${sanitizeDiagnostic(version)})` : "."}`
    };
  }
  return {
    runnable: true,
    version,
    message: `Codex executable is runnable (${version}).`
  };
}

export async function runCodexExec(options: CodexExecRunOptions): Promise<CodexExecRunResult> {
  const result = await runProcess(options);
  return {
    ...result,
    finalMessage: await readOptionalFile(options.outputPath)
  };
}

function buildCodexExecArgs(outputPath: string, model: string | undefined, effort: ModelRequest["reasoningEffort"]): string[] {
  return [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--json",
    "--output-last-message",
    outputPath,
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--config", `model_reasoning_effort=${effort}`] : []),
    "-"
  ];
}

function formatCodexPrompt(messages: ModelMessage[]): string {
  if (messages.length === 0) {
    throw new Error("Codex exec requires at least one model message.");
  }
  return messages.map((message) => `${formatRole(message.role)}:\n${message.content}`).join("\n\n").trim();
}

function formatRole(role: ModelMessage["role"]): string {
  if (role === "system") return "System";
  if (role === "assistant") return "Assistant";
  if (role === "tool") return "Tool result";
  return "User";
}

async function runProcess(options: Omit<CodexExecRunOptions, "outputPath"> | CodexExecRunOptions): Promise<CodexExecRunResult> {
  return new Promise((resolve) => {
    const invocation = processInvocation(options.executablePath, options.args);
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError: Error | undefined;
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.environment },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_CODEX_EXEC_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        child.kill();
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: spawnError ? 1 : exitCode,
        stdout,
        stderr: spawnError ? `${stderr}\n${spawnError.message}`.trim() : stderr,
        timedOut,
        outputLimitExceeded
      });
    });
    // A process that fails before reading stdin can close the pipe before end() completes.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.prompt);
  });
}

function processInvocation(executablePath: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32" || !executablePath.toLowerCase().endsWith(".cmd")) {
    return { command: executablePath, args };
  }
  const command = [executablePath, ...args].map(quoteWindowsCommandArg).join(" ");
  return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
}

function quoteWindowsCommandArg(value: string): string {
  if (/[\r\n%!]/.test(value)) {
    throw new Error("Codex exec command paths and options cannot contain Windows shell expansion characters.");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function pathCandidates(environment: ProviderEnvironment, platform: NodeJS.Platform): string[] {
  const delimiter = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"];
  return (environment.PATH ?? environment.Path ?? "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .flatMap((entry) => names.map((name) => path.join(entry, name)));
}

function childEnvironment(environment: ProviderEnvironment): ProviderEnvironment {
  const depth = Number(environment.CODEX_EXEC_PROVIDER_DEPTH ?? "0");
  return { ...environment, CODEX_EXEC_PROVIDER_DEPTH: String(Number.isFinite(depth) ? depth + 1 : 1) };
}

function assertNoNestedCodexExec(environment: ProviderEnvironment): void {
  const depth = Number(environment.CODEX_EXEC_PROVIDER_DEPTH ?? "0");
  if (Number.isFinite(depth) && depth >= 1) {
    throw new Error("Nested Codex exec provider calls are disabled to prevent recursive agent invocation.");
  }
}

function validateModel(model: string | undefined): string | undefined {
  const normalized = normalizedValue(model);
  if (normalized && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(normalized)) {
    throw new Error(`Invalid Codex exec model "${model}".`);
  }
  return normalized;
}

function extractFinalMessage(stdout: string): string {
  const events = parseJsonLines(stdout);
  for (const event of events.reverse()) {
    if (event.type === "item.completed") {
      const item = objectValue(event.item);
      if (item?.type === "agent_message" && typeof item.text === "string") return item.text;
    }
    if (event.type === "agent_message" && typeof event.message === "string") return event.message;
  }
  return "";
}

function extractModel(stdout: string): string | undefined {
  for (const event of parseJsonLines(stdout)) {
    const model = event.model ?? objectValue(event.params)?.model;
    if (typeof model === "string" && model.trim()) return model.trim();
  }
  return undefined;
}

function extractUsage(stdout: string): ModelResponse["usage"] {
  for (const event of parseJsonLines(stdout).reverse()) {
    const usage = objectValue(event.usage) ?? objectValue(objectValue(event.params)?.usage);
    if (!usage) continue;
    const inputTokens = numberValue(usage.input_tokens ?? usage.inputTokens);
    const outputTokens = numberValue(usage.output_tokens ?? usage.outputTokens);
    if (inputTokens !== undefined || outputTokens !== undefined) {
      return { inputTokens, outputTokens };
    }
  }
  return undefined;
}

function parseJsonLines(value: string): Array<Record<string, unknown>> {
  return value
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
}

function formatCodexExecFailure(result: CodexExecRunResult, prefix = "Codex exec request failed"): string {
  const details = sanitizeDiagnostic(result.stderr) ?? sanitizeDiagnostic(result.stdout) ?? "No diagnostic output.";
  return `${prefix} with exit code ${result.exitCode ?? "unknown"}: ${details}`;
}

function sanitizeDiagnostic(value: string): string | undefined {
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}...`;
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizedValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

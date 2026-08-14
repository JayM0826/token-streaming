#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const PROVIDERS = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  codex: undefined
};

export function runProviderSmoke(provider) {
  const apiKeyEnv = PROVIDERS[provider];
  if (!(provider in PROVIDERS)) {
    console.error(`Unsupported smoke provider "${provider}". Use openai, anthropic, gemini, or codex.`);
    process.exitCode = 1;
    return;
  }
  if (apiKeyEnv && !process.env[apiKeyEnv]?.trim()) {
    console.error(`${apiKeyEnv} is required for the ${providerLabel(provider)} smoke test.`);
    process.exitCode = 1;
    return;
  }

  const repoRoot = process.cwd();
  const cliPath = path.join(repoRoot, "apps", "cli", "dist", "index.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "--provider", provider, "doctor", "models", "--probe", "--json"],
    { cwd: repoRoot, env: process.env, encoding: "utf8" }
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    console.error(result.error.message);
  }
  process.exitCode = result.status ?? 1;
}

function providerLabel(value) {
  return value === "openai" ? "OpenAI" : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "apps", "cli", "dist", "index.js");

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required for the OpenAI smoke test.");
  process.exitCode = 1;
} else {
  const result = spawnSync(
    process.execPath,
    [cliPath, "--provider", "openai", "doctor", "models", "--probe", "--json"],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8"
    }
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.status ?? 1;
}

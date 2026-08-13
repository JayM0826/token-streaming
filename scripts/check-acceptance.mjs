#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const quick = process.argv.includes("--quick");
const json = process.argv.includes("--json");
const repositoryDoctorArgs = [process.execPath, "apps/cli/dist/index.js", "doctor", "repo"];
if (process.env.OPENAI_API_KEY) {
  repositoryDoctorArgs.push("--provider", "openai", "--probe");
}
repositoryDoctorArgs.push("--json");

const steps = [
  ...(quick
    ? []
    : [
        ["lint", pnpmCommand("lint")],
        ["test", pnpmCommand("test")]
      ]),
  ["package", [process.execPath, "scripts/check-package-readiness.mjs"]],
  ["packed-install", [process.execPath, "scripts/check-packed-install.mjs"]],
  ["manifest", [process.execPath, "apps/cli/dist/index.js", "manifest", "validate", "--json"]],
  ["repository-doctor", repositoryDoctorArgs]
];

const results = [];
let liveSmoke;

for (const [name, command] of steps) {
  const result = run(command);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const parsed = parseJson(result.stdout);
  if (name === "repository-doctor") {
    liveSmoke = parsed?.liveSmoke;
  }
  results.push({
    name,
    command: command.join(" "),
    ok: result.status === 0,
    exitCode: result.status,
    outputSummary: summarize(output)
  });
}

const offlineOk = results.every((result) => result.ok);
const liveSmokeVerified = liveSmoke?.verified === true;
const summary = {
  kind: "acceptance-check",
  ok: offlineOk && liveSmokeVerified,
  offlineOk,
  liveSmoke: liveSmoke ?? {
    provider: "openai",
    command: "npx pnpm@9.15.0 smoke:openai",
    status: "unknown",
    verified: false,
    requiredEnv: ["OPENAI_API_KEY"],
    optionalEnv: ["OPENAI_BASE_URL", "OPENAI_API_PROTOCOL", "OPENAI_MODEL"],
    message: "Repository doctor did not return live smoke readiness."
  },
  results
};

if (json) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  printText(summary);
}

process.exitCode = summary.ok ? 0 : 1;

function run(command) {
  const [rawProgram, ...args] = command;
  const program = process.platform === "win32" && rawProgram === "npx" ? "npx.cmd" : rawProgram;
  const useShell = process.platform === "win32" && rawProgram === "npx";
  const result = spawnSync(program, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    shell: useShell
  });
  if (result.error) {
    return {
      ...result,
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: `${result.stderr ?? ""}\n${result.error.message}`.trim()
    };
  }
  return result;
}

function pnpmCommand(script) {
  if (process.env.npm_execpath) {
    return [process.execPath, process.env.npm_execpath, script];
  }
  return ["npx", "pnpm@9.15.0", script];
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function summarize(value) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}...`;
}

function printText(summary) {
  console.log("Acceptance check");
  console.log(`Status: ${summary.ok ? "ok" : "incomplete"}`);
  console.log(`Offline gates: ${summary.offlineOk ? "ok" : "failed"}`);
  console.log(`OpenAI live smoke: ${summary.liveSmoke.status}`);
  console.log(`OpenAI verified: ${summary.liveSmoke.verified ? "yes" : "no"}`);
  console.log(`OpenAI command: ${summary.liveSmoke.command}`);
  console.log(`OpenAI message: ${summary.liveSmoke.message}`);
  console.log("");
  console.log("Steps:");
  for (const result of summary.results) {
    console.log(`- ${result.name}: ${result.ok ? "ok" : "failed"} (${result.exitCode ?? "unknown"})`);
  }
}

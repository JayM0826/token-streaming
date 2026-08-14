#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const quick = process.argv.includes("--quick");
const json = process.argv.includes("--json");
const offlineEnvironment = withoutOpenAIEnvironment(process.env);
const repositoryDoctorArgs = [process.execPath, "apps/cli/dist/index.js", "doctor", "repo", "--json"];

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
  [
    "stub-smoke",
    [
      process.execPath,
      "apps/cli/dist/index.js",
      "--provider",
      "stub",
      "--dry-run",
      "--json",
      "Summarize this repository for the deterministic acceptance smoke."
    ]
  ],
  ["repository-doctor", repositoryDoctorArgs]
];

const results = [];
let liveSmoke;

for (const [name, command] of steps) {
  const result = run(command, offlineEnvironment);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const parsed = parseJson(result.stdout);
  if (name === "repository-doctor") {
    liveSmoke = parsed?.liveSmoke;
  }
  const validation = validateStepOutput(name, parsed);
  results.push({
    name,
    command: command.join(" "),
    ok: result.status === 0 && validation.ok,
    exitCode: result.status,
    ...(validation.evidence ? { evidence: validation.evidence } : {}),
    ...(validation.message ? { validationMessage: validation.message } : {}),
    outputSummary: summarize(output)
  });
}

if (process.env.OPENAI_API_KEY) {
  const command = [process.execPath, "apps/cli/dist/index.js", "doctor", "repo", "--provider", "openai", "--probe", "--json"];
  const result = run(command, process.env);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const parsed = parseJson(result.stdout);
  liveSmoke = parsed?.liveSmoke;
  results.push({
    name: "live-smoke",
    command: command.join(" "),
    ok: result.status === 0,
    exitCode: result.status,
    outputSummary: summarize(output)
  });
}

const offlineOk = results.filter((result) => result.name !== "live-smoke").every((result) => result.ok);
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
    optionalEnv: ["OPENAI_BASE_URL", "OPENAI_API_PROTOCOL", "OPENAI_MODEL", "OPENAI_TIMEOUT_MS"],
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

function run(command, environment) {
  const [rawProgram, ...args] = command;
  const program = process.platform === "win32" && rawProgram === "npx" ? "npx.cmd" : rawProgram;
  const useShell = process.platform === "win32" && rawProgram === "npx";
  const result = spawnSync(program, args, {
    cwd: process.cwd(),
    env: environment,
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

function withoutOpenAIEnvironment(environment) {
  const offline = { ...environment };
  for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_PROTOCOL", "OPENAI_MODEL", "OPENAI_TIMEOUT_MS"]) {
    delete offline[name];
  }
  return offline;
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

function validateStepOutput(name, parsed) {
  if (name !== "stub-smoke") {
    return { ok: true };
  }

  const modelCall = parsed?.modelCalls?.find((call) => call.provider === "stub");
  const artifacts = inspectStubArtifacts(parsed);
  const ok =
    parsed?.kind === "run" &&
    parsed?.session?.strategy === "default" &&
    Boolean(modelCall) &&
    parsed?.review?.verificationStatus === "not-run" &&
    artifacts.eventLog &&
    artifacts.report;

  return {
    ok,
    evidence: {
      provider: modelCall?.provider,
      model: modelCall?.model,
      strategy: parsed?.session?.strategy,
      review: parsed?.review?.verificationStatus,
      eventLog: artifacts.eventLog,
      report: artifacts.report
    },
    ...(ok ? {} : { message: "Stub smoke did not return the required run, model-call, review, event-log, and report evidence." })
  };
}

function inspectStubArtifacts(parsed) {
  try {
    const events = readFileSync(parsed.eventLogPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const report = readFileSync(parsed.reportPath, "utf8");
    return {
      eventLog: events.some((event) => event.type === "review.completed") && events.at(-1)?.type === "run.completed",
      report: report.includes("## Review") && report.includes("## Model Calls")
    };
  } catch {
    return { eventLog: false, report: false };
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

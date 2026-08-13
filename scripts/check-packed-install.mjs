#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(".");
const packageEntries = [
  ["@token-streaming/protocol", "packages/protocol"],
  ["@token-streaming/providers", "packages/providers"],
  ["@token-streaming/ai-manifest", "packages/ai-manifest"],
  ["@token-streaming/tools", "packages/tools"],
  ["@token-streaming/storage", "packages/storage"],
  ["@token-streaming/core", "packages/core"],
  ["@token-streaming/cli", "apps/cli"]
];
const tempRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-pack-check-"));

try {
  const tarballs = [];
  const expectedVersions = new Map();
  for (const [name, directory] of packageEntries) {
    const sourceManifest = JSON.parse(await readFile(path.join(repoRoot, directory, "package.json"), "utf8"));
    if (sourceManifest.name !== name || typeof sourceManifest.version !== "string") {
      throw new Error(`Invalid source package identity for ${name}.`);
    }
    expectedVersions.set(name, sourceManifest.version);

    const packed = run(pnpmCommand(["pack", "--pack-destination", tempRoot, "--json"]), path.join(repoRoot, directory));
    const output = parseJson(packed.stdout, `pack output for ${name}`);
    if (output.name !== name || typeof output.filename !== "string") {
      throw new Error(`Unexpected pack result for ${name}.`);
    }
    tarballs.push(output.filename);
  }

  const consumerRoot = path.join(tempRoot, "consumer");
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(
    path.join(consumerRoot, "package.json"),
    JSON.stringify({ name: "token-streaming-packed-consumer", version: "1.0.0", private: true }, null, 2),
    "utf8"
  );

  run([...npmCommand(), "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], consumerRoot);

  for (const [name] of packageEntries) {
    const manifestPath = path.join(consumerRoot, "node_modules", ...name.split("/"), "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.name !== name || manifest.version !== expectedVersions.get(name)) {
      throw new Error(`Installed package identity mismatch for ${name}.`);
    }
    for (const specifier of Object.values(manifest.dependencies ?? {})) {
      if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
        throw new Error(`${name} retained an unpublishable workspace dependency.`);
      }
    }
  }

  const binPath = path.join(consumerRoot, "node_modules", ".bin", process.platform === "win32" ? "token-streaming.cmd" : "token-streaming");
  await access(binPath);
  const cliEntrypoint = path.join(consumerRoot, "node_modules", "@token-streaming", "cli", "dist", "index.js");
  const version = run([process.execPath, cliEntrypoint, "--version"], consumerRoot).stdout.trim();
  if (version !== `token-streaming ${expectedVersions.get("@token-streaming/cli")}`) {
    throw new Error(`Unexpected packaged CLI version output: ${version}`);
  }

  const smoke = run([process.execPath, cliEntrypoint, "--provider", "stub", "--dry-run", "--json", "packaged CLI smoke"], consumerRoot);
  const result = parseJson(smoke.stdout, "packaged CLI smoke output");
  if (result.kind !== "run" || result.modelCalls?.[0]?.provider !== "stub") {
    throw new Error("Packaged CLI smoke did not complete through the stub provider.");
  }

  console.log(`Packed install check passed for ${packageEntries.length} packages.`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function pnpmCommand(args) {
  if (process.env.npm_execpath) {
    return [process.execPath, process.env.npm_execpath, ...args];
  }
  if (process.platform === "win32") {
    return [process.execPath, path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"), "pnpm@9.15.0", ...args];
  }
  return ["npx", "pnpm@9.15.0", ...args];
}

function npmCommand() {
  return process.platform === "win32"
    ? [process.execPath, path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
    : ["npm"];
}

function run(command, cwd) {
  const [program, ...args] = command;
  const result = spawnSync(program, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    const details = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n").trim();
    throw new Error(`Command failed: ${command.join(" ")}${details ? `\n${details}` : ""}`);
  }
  return result;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

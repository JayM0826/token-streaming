#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(".");
const packageEntries = [
  ["@token-streaming/protocol", "packages/protocol"],
  ["@token-streaming/marketplace-domain", "packages/marketplace-domain"],
  ["@token-streaming/providers", "packages/providers"],
  ["@token-streaming/ai-manifest", "packages/ai-manifest"],
  ["@token-streaming/tools", "packages/tools"],
  ["@token-streaming/storage", "packages/storage"],
  ["@token-streaming/core", "packages/core"],
  ["@token-streaming/cli", "apps/cli"],
  ["@token-streaming/supplier-node", "apps/supplier-node"],
  ["@token-streaming/supplier-agent", "apps/supplier-agent"]
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

  const supplierNodeBinPath = path.join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "gongsuanyun-supplier-node.cmd" : "gongsuanyun-supplier-node"
  );
  await access(supplierNodeBinPath);
  const supplierNodeEntrypoint = path.join(
    consumerRoot,
    "node_modules",
    "@token-streaming",
    "supplier-node",
    "dist",
    "index.js"
  );
  const supplierNodeVersion = run([process.execPath, supplierNodeEntrypoint, "--version"], consumerRoot).stdout.trim();
  if (supplierNodeVersion !== `gongsuanyun-supplier-node ${expectedVersions.get("@token-streaming/supplier-node")}`) {
    throw new Error(`Unexpected packaged supplier-node version output: ${supplierNodeVersion}`);
  }

  const supplierAgentBinPath = path.join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "gongsuanyun-agent.cmd" : "gongsuanyun-agent"
  );
  await access(supplierAgentBinPath);
  const supplierAgentEntrypoint = path.join(
    consumerRoot,
    "node_modules",
    "@token-streaming",
    "supplier-agent",
    "dist",
    "index.js"
  );
  const supplierAgentVersion = run([process.execPath, supplierAgentEntrypoint, "--version"], consumerRoot).stdout.trim();
  if (supplierAgentVersion !== `gongsuanyun-agent ${expectedVersions.get("@token-streaming/supplier-agent")}`) {
    throw new Error(`Unexpected packaged supplier-agent version output: ${supplierAgentVersion}`);
  }

  const smoke = run([process.execPath, cliEntrypoint, "--provider", "stub", "--dry-run", "--json", "packaged CLI smoke"], consumerRoot);
  const result = parseJson(smoke.stdout, "packaged CLI smoke output");
  if (result.kind !== "run" || result.modelCalls?.[0]?.provider !== "stub") {
    throw new Error("Packaged CLI smoke did not complete through the stub provider.");
  }

  const headlessSmoke = run(
    [
      process.execPath,
      "--input-type=module",
      "--eval",
      [
        'import { TokenStreamingRuntime } from "@token-streaming/core";',
        "const runtime = new TokenStreamingRuntime({ repoRoot: process.cwd() });",
        'const plan = await runtime.planTask("summarize packaged runtime");',
        "const tools = runtime.listTools();",
        "console.log(JSON.stringify({ risk: plan.risk, context: plan.context, verificationCommands: plan.verificationCommands, tools }));"
      ].join("\n")
    ],
    consumerRoot
  );
  const headlessResult = parseJson(headlessSmoke.stdout, "packaged headless core smoke output");
  if (
    !["low", "medium", "high"].includes(headlessResult.risk) ||
    !Number.isInteger(headlessResult.context?.maxSourceFiles) ||
    !Array.isArray(headlessResult.verificationCommands) ||
    !headlessResult.tools?.some((tool) => tool.name === "file.read" && tool.risk === "read")
  ) {
    throw new Error("Packaged headless core smoke did not expose the expected planning and tool contracts.");
  }

  const marketplaceSmoke = run(
    [
      process.execPath,
      "--input-type=module",
      "--eval",
      [
        'import { registerSupplier } from "@token-streaming/marketplace-domain";',
        "const event = registerSupplier(",
        '  { supplierId: "supplier_packaged", kind: "individual", legalName: "Packaged Supplier", displayName: "Packaged", countryCode: "US", taxResidenceCountryCode: "US" },',
        '  { tenantId: "tenant_packaged", actorId: "actor_packaged", commandId: "command_packaged", eventId: "event_packaged", occurredAt: "2026-08-24T00:00:00.000Z" }',
        ");",
        "console.log(JSON.stringify({ type: event.type, kind: event.payload.kind, version: event.aggregateVersion }));"
      ].join("\n")
    ],
    consumerRoot
  );
  const marketplaceResult = parseJson(marketplaceSmoke.stdout, "packaged marketplace-domain smoke output");
  if (
    marketplaceResult.type !== "supplier.registered" ||
    marketplaceResult.kind !== "individual" ||
    marketplaceResult.version !== 1
  ) {
    throw new Error("Packaged marketplace domain did not expose the expected individual-supplier contract.");
  }

  console.log(`Packed install check passed for ${packageEntries.length} packages, the CLI, supplier node, supplier agent, headless core, and marketplace domain.`);
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

#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { loadSupplierNodeConfig } from "./config.js";
import { createConfiguredProviderAdapter } from "./openai-compatible-adapter.js";
import { SupplierNodeRuntime } from "./runtime.js";
import { createSupplierNodeServer, listenSupplierNode } from "./server.js";

const VERSION = "0.3.0";
const command = process.argv[2] ?? "serve";

try {
  if (command === "--version" || command === "version") {
    process.stdout.write(`gongsuanyun-supplier-node ${VERSION}\n`);
  } else if (command === "--help" || command === "help") {
    printHelp();
  } else if (command === "token") {
    process.stdout.write(`${randomBytes(32).toString("base64url")}\n`);
  } else if (command === "doctor") {
    const config = loadSupplierNodeConfig();
    const runtime = new SupplierNodeRuntime(config, createConfiguredProviderAdapter(config), () => undefined);
    process.stdout.write(`${JSON.stringify({ ok: true, health: runtime.health(), upstream_host: config.upstream.baseUrl.hostname })}\n`);
  } else if (command === "serve") {
    await serve();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown startup error.";
  process.stderr.write(`${JSON.stringify({ event: "supplier-node.start-failed", message })}\n`);
  process.exitCode = 1;
}

async function serve(): Promise<void> {
  const config = loadSupplierNodeConfig();
  const runtime = new SupplierNodeRuntime(config, createConfiguredProviderAdapter(config));
  const server = createSupplierNodeServer(runtime);
  await listenSupplierNode(server, config.bindHost, config.port);
  process.stdout.write(`${JSON.stringify({
    event: "supplier-node.ready",
    protocol: runtime.health().protocol_version,
    providerId: config.providerId,
    bindHost: config.bindHost,
    port: config.port
  })}\n`);

  const shutdown = () => {
    runtime.setDraining();
    server.close((error) => {
      process.exitCode = error ? 1 : 0;
    });
    setTimeout(() => server.closeAllConnections(), 10_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function printHelp(): void {
  process.stdout.write([
    `gongsuanyun-supplier-node ${VERSION}`,
    "",
    "Commands:",
    "  serve    Start the signed supplier gateway (default)",
    "  doctor   Validate configuration without calling the provider",
    "  token    Generate a 256-bit gateway token",
    "  version  Print the version",
    ""
  ].join("\n"));
}

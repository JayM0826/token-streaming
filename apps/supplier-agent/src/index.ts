#!/usr/bin/env node
import { spawn } from "node:child_process";
import { SupplierAgentController } from "./controller.js";
import { startSupplierAgentManagementServer } from "./management-server.js";
import { resolveSupplierAgentPaths } from "./profile.js";
import { SupplierAgentStore } from "./store.js";

const VERSION = "0.3.0";
const command = process.argv[2] ?? "start";

try {
  if (command === "--version" || command === "version") {
    process.stdout.write(`gongsuanyun-agent ${VERSION}\n`);
  } else if (command === "--help" || command === "help") {
    printHelp();
  } else if (command === "doctor") {
    await doctor();
  } else if (command === "start") {
    await start();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown Supplier Agent error.";
  process.stderr.write(`${JSON.stringify({ event: "supplier-agent.failed", message })}\n`);
  process.exitCode = 1;
}

async function doctor(): Promise<void> {
  const paths = resolveSupplierAgentPaths(process.env.GONGSUANYUN_AGENT_HOME);
  const controller = new SupplierAgentController(new SupplierAgentStore(paths), managementUrl());
  await controller.initialize();
  process.stdout.write(`${JSON.stringify(await controller.doctor())}\n`);
}

async function start(): Promise<void> {
  const port = managementPort();
  const url = `http://127.0.0.1:${port}`;
  const paths = resolveSupplierAgentPaths(process.env.GONGSUANYUN_AGENT_HOME);
  const controller = new SupplierAgentController(new SupplierAgentStore(paths), url);
  await controller.initialize();
  let closing = false;
  let managementServer: Awaited<ReturnType<typeof startSupplierAgentManagementServer>> | undefined;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await controller.shutdown();
    if (managementServer) {
      await new Promise<void>((resolve) => {
        managementServer!.server.close(() => resolve());
        managementServer!.server.closeAllConnections();
      });
    }
  };
  managementServer = await startSupplierAgentManagementServer(controller, port, () => {
    void shutdown().then(() => { process.exitCode = 0; });
  });
  openBrowser(managementServer.launchUrl);
  process.stdout.write(`${JSON.stringify({
    event: "supplier-agent.ready",
    version: VERSION,
    managementUrl: managementServer.url,
    configured: controller.status().configured
  })}\n`);
  const onSignal = () => { void shutdown(); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

function openBrowser(url: string): void {
  const command = process.platform === "win32"
    ? { executable: "explorer.exe", args: [url] }
    : process.platform === "darwin"
      ? { executable: "open", args: [url] }
      : { executable: "xdg-open", args: [url] };
  const child = spawn(command.executable, command.args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {
    process.stderr.write(`${JSON.stringify({ event: "supplier-agent.browser-open-failed", message: "无法自动打开本地控制中心，请检查系统默认浏览器。" })}\n`);
  });
  child.unref();
}

function managementPort(): number {
  const value = process.env.GONGSUANYUN_AGENT_MANAGEMENT_PORT;
  const parsed = value === undefined ? 8790 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("GONGSUANYUN_AGENT_MANAGEMENT_PORT must be an integer between 1 and 65535.");
  }
  return parsed;
}

function managementUrl(): string {
  return `http://127.0.0.1:${managementPort()}`;
}

function printHelp(): void {
  process.stdout.write([
    `gongsuanyun-agent ${VERSION}`,
    "",
    "Commands:",
    "  start    Open the local supplier control center (default)",
    "  doctor   Validate the local profile without unlocking credentials",
    "  version  Print the version",
    "",
    "Environment:",
    "  GONGSUANYUN_AGENT_HOME             Override the local encrypted configuration directory",
    "  GONGSUANYUN_AGENT_MANAGEMENT_PORT  Override the loopback management port (default 8790)",
    ""
  ].join("\n"));
}

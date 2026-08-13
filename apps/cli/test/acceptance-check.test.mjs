import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");
const acceptanceScript = path.join(repoRoot, "scripts", "check-acceptance.mjs");
const relayFixture = path.join(repoRoot, "apps", "cli", "test", "fixtures", "openai-compatible-server.mjs");

test("acceptance check reports missing OpenAI live smoke as incomplete", () => {
  const result = spawnSync(process.execPath, [acceptanceScript, "--quick", "--json"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENAI_API_KEY: ""
    },
    encoding: "utf8"
  });
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(output.kind, "acceptance-check");
  assert.equal(output.ok, false);
  assert.equal(output.offlineOk, true);
  assert.equal(output.liveSmoke.status, "missing-api-key");
  assert.equal(output.liveSmoke.verified, false);
  assert.equal(output.results.some((step) => step.name === "package" && step.ok), true);
  assert.equal(output.results.some((step) => step.name === "manifest" && step.ok), true);
  assert.equal(output.results.some((step) => step.name === "repository-doctor" && step.ok), true);
});

test("acceptance check verifies Responses and Chat Completions provider probes", async () => {
  const relay = spawn(process.execPath, [relayFixture], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const port = await readFirstLine(relay);
    for (const [protocol, endpoint] of [
      ["responses", "responses"],
      ["chat-completions", "chat/completions"]
    ]) {
      const result = spawnSync(process.execPath, [acceptanceScript, "--quick", "--json"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPENAI_API_KEY: "relay-key",
          OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
          OPENAI_API_PROTOCOL: protocol
        },
        encoding: "utf8"
      });
      const output = JSON.parse(result.stdout);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.offlineOk, true);
      assert.equal(output.liveSmoke.status, "verified");
      assert.equal(output.liveSmoke.verified, true);
      assert.equal(output.liveSmoke.apiProtocol, protocol);
      assert.equal(output.liveSmoke.endpoint, `http://127.0.0.1:${port}/v1/${endpoint}`);
      assert.match(output.results.find((step) => step.name === "repository-doctor")?.command ?? "", /--probe/);
    }
  } finally {
    relay.kill();
  }
});

function readFirstLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for relay fixture.")), 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline !== -1) {
        clearTimeout(timeout);
        resolve(Number(stdout.slice(0, newline).trim()));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!stdout.includes("\n")) {
        clearTimeout(timeout);
        reject(new Error(`Relay fixture exited before listening (${code}).`));
      }
    });
  });
}

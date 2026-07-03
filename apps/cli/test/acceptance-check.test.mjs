import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");
const acceptanceScript = path.join(repoRoot, "scripts", "check-acceptance.mjs");

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

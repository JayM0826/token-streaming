import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");
const smokeScript = path.join(repoRoot, "scripts", "smoke-openai.mjs");

test("OpenAI smoke script fails clearly without an API key", () => {
  const result = spawnSync(process.execPath, [smokeScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENAI_API_KEY: "",
      OPENAI_TIMEOUT_MS: ""
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENAI_API_KEY is required for the OpenAI smoke test/);
  assert.equal(result.stdout, "");
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");
const smokeScripts = [
  { provider: "OpenAI", key: "OPENAI_API_KEY", script: "smoke-openai.mjs" },
  { provider: "Anthropic", key: "ANTHROPIC_API_KEY", script: "smoke-anthropic.mjs" },
  { provider: "Gemini", key: "GEMINI_API_KEY", script: "smoke-gemini.mjs" }
];

for (const smoke of smokeScripts) {
  test(`${smoke.provider} smoke script fails clearly without an API key`, () => {
    const environment = { ...process.env, [smoke.key]: "" };
    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", smoke.script)], {
      cwd: repoRoot,
      env: environment,
      encoding: "utf8"
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${smoke.key} is required for the ${smoke.provider} smoke test`));
    assert.equal(result.stdout, "");
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import { listManifestCommandGroups } from "../dist/index.js";

test("listManifestCommandGroups normalizes command groups", () => {
  const groups = listManifestCommandGroups({
    commands: {
      test: ["pnpm test", "", 1],
      build: "pnpm build",
      empty: [],
      invalid: 42
    },
    playbooks: [],
    modules: [],
    workflows: [],
    generated: false
  });

  assert.deepEqual(groups, [
    {
      name: "build",
      commands: ["pnpm build"]
    },
    {
      name: "test",
      commands: ["pnpm test"]
    }
  ]);
});

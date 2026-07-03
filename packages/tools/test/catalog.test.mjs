import assert from "node:assert/strict";
import test from "node:test";
import { listToolCatalog } from "../dist/index.js";

test("listToolCatalog exposes stable tool metadata and risk levels", () => {
  const tools = listToolCatalog();
  const names = tools.map((tool) => tool.name);

  assert.deepEqual(names, ["repo.scan", "repo.search", "file.read", "git.status", "git.diff", "command.run", "test.run", "patch.apply"]);
  assert.equal(tools.find((tool) => tool.name === "repo.search")?.risk, "read");
  assert.equal(tools.find((tool) => tool.name === "command.run")?.risk, "execute");
  assert.equal(tools.find((tool) => tool.name === "patch.apply")?.risk, "write");
  assert.equal(tools.every((tool) => tool.inputSchema.type === "object"), true);
  assert.equal(tools.every((tool) => tool.outputSchema.type === "object"), true);
});

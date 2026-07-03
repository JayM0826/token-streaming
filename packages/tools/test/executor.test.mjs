import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runReadOnlyTool } from "../dist/index.js";

test("runReadOnlyTool executes repository search", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "token-streaming-tool-run-"));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "payment.ts"), "export const authorizePayment = true;\n", "utf8");

  const output = await runReadOnlyTool("repo.search", {
    repoRoot: cwd,
    query: "authorizePayment",
    maxMatches: 1
  });

  assert.equal(output.matches.length, 1);
  assert.equal(output.matches[0].path, "src/payment.ts");
});

test("runReadOnlyTool reads files inside the repository", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "token-streaming-tool-read-"));
  await writeFile(path.join(cwd, "note.md"), "# Note\n", "utf8");

  const output = await runReadOnlyTool("file.read", {
    repoRoot: cwd,
    path: "note.md"
  });

  assert.deepEqual(output, {
    content: "# Note\n"
  });
});

test("runReadOnlyTool rejects non-read tools", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "token-streaming-tool-reject-"));

  await assert.rejects(runReadOnlyTool("patch.apply", { repoRoot: cwd }), /not available through read-only execution/);
});

test("runReadOnlyTool preserves repository path safety", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "token-streaming-tool-escape-"));

  await assert.rejects(runReadOnlyTool("file.read", { repoRoot: cwd, path: "../outside.txt" }), /escapes repository root/);
});

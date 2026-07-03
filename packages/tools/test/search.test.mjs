import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { searchRepo } from "../dist/index.js";

test("searchRepo finds bounded text matches in repo files", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "token-streaming-search-"));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "payment.ts"), "export function authorizePayment() {\n  return true;\n}\n", "utf8");
  await writeFile(path.join(cwd, "notes.md"), "Payment authorization notes\n", "utf8");

  const matches = await searchRepo(cwd, "authorizePayment");

  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0], {
    path: "src/payment.ts",
    line: 1,
    column: 17,
    text: "export function authorizePayment() {"
  });
});

test("searchRepo rejects empty queries", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "token-streaming-search-empty-"));

  await assert.rejects(searchRepo(cwd, "   "), /Search query must be non-empty/);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyFilePatches, parsePatchProposal } from "../dist/patch-engine.js";

test("parsePatchProposal reads explicit JSON fences", () => {
  const proposal = parsePatchProposal(`Here is a patch:

\`\`\`json
{
  "summary": "Add a note",
  "files": [
    {
      "path": "notes/example.txt",
      "content": "hello\\n"
    }
  ]
}
\`\`\`
`);

  assert.equal(proposal?.summary, "Add a note");
  assert.deepEqual(proposal?.files, [{ path: "notes/example.txt", content: "hello\n" }]);
});

test("parsePatchProposal ignores ordinary markdown code fences", () => {
  const proposal = parsePatchProposal(`This is only an example:

\`\`\`ts
const value = { files: [] };
\`\`\`
`);

  assert.equal(proposal, undefined);
});

test("parsePatchProposal reads raw JSON objects", () => {
  const proposal = parsePatchProposal('{"files":[{"path":"a.txt","content":"a"}]}');

  assert.equal(proposal?.summary, "No summary provided.");
  assert.deepEqual(proposal?.files, [{ path: "a.txt", content: "a" }]);
});

test("applyFilePatches writes files inside the repo", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-tools-"));
  try {
    const result = await applyFilePatches(repoRoot, [{ path: "nested/file.txt", content: "written\n" }]);

    assert.deepEqual(result.files, ["nested/file.txt"]);
    assert.equal(await readFile(path.join(repoRoot, "nested", "file.txt"), "utf8"), "written\n");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("applyFilePatches blocks symbolic links that resolve outside the repository", async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-patch-link-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-outside-"));
  try {
    try {
      await symlink(outsideRoot, path.join(repoRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("Symbolic links are not available in this environment.");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => applyFilePatches(repoRoot, [{ path: "linked/escaped.txt", content: "blocked\n" }]),
      /symbolic link/
    );
    await assert.rejects(() => readFile(path.join(outsideRoot, "escaped.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

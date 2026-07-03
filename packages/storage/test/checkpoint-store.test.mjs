import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckpointStore } from "../dist/checkpoint-store.js";

test("CheckpointStore rolls back changed and newly-created files", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-storage-"));
  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "existing.txt"), "before\n", "utf8");

    const store = new CheckpointStore(repoRoot);
    const checkpoint = await store.create(["src/existing.txt", "src/new.txt"]);
    const preview = await store.previewRollback(checkpoint.id);

    await writeFile(path.join(repoRoot, "src", "existing.txt"), "after\n", "utf8");
    await writeFile(path.join(repoRoot, "src", "new.txt"), "created\n", "utf8");

    const listed = await store.list();
    assert.equal(listed[0]?.id, checkpoint.id);
    assert.deepEqual(preview.restoreFiles, ["src/existing.txt"]);
    assert.deepEqual(preview.deleteFiles, ["src/new.txt"]);
    assert.deepEqual(preview.files, [
      {
        path: "src/existing.txt",
        action: "restore",
        existedAtCheckpoint: true
      },
      {
        path: "src/new.txt",
        action: "delete",
        existedAtCheckpoint: false
      }
    ]);

    const restored = await store.rollback(checkpoint.id);
    assert.deepEqual(restored, ["src/existing.txt", "src/new.txt"]);
    assert.equal(await readFile(path.join(repoRoot, "src", "existing.txt"), "utf8"), "before\n");
    assert.equal(existsSync(path.join(repoRoot, "src", "new.txt")), false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("CheckpointStore returns an empty list when no checkpoints exist", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-storage-"));
  try {
    const store = new CheckpointStore(repoRoot);
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

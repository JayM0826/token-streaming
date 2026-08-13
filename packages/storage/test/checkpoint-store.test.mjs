import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("CheckpointStore rejects paths outside the repository when creating checkpoints", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-storage-"));
  try {
    const store = new CheckpointStore(repoRoot);
    await assert.rejects(() => store.create(["../outside.txt"]), /Checkpoint path escapes repository root/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("CheckpointStore rejects tampered rollback paths outside the repository", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-storage-"));
  const outsidePath = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-outside.txt`);
  try {
    const store = new CheckpointStore(repoRoot);
    await store.save({
      id: "chk_tampered",
      createdAt: new Date().toISOString(),
      files: [{ path: `../${path.basename(outsidePath)}`, content: "tampered\n" }]
    });

    await assert.rejects(() => store.rollback("chk_tampered"), /Checkpoint path escapes repository root/);
    assert.equal(existsSync(outsidePath), false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(outsidePath, { force: true });
  }
});

test("CheckpointStore rejects checkpoint ids that could escape storage", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-storage-"));
  try {
    const store = new CheckpointStore(repoRoot);
    await assert.rejects(() => store.load("../../outside"), /Invalid checkpoint id/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("CheckpointStore rejects symbolic links that resolve outside the repository", async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-storage-link-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-outside-"));
  try {
    await writeFile(path.join(outsideRoot, "secret.txt"), "outside\n", "utf8");
    try {
      await symlink(outsideRoot, path.join(repoRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("Symbolic links are not available in this environment.");
        return;
      }
      throw error;
    }

    const store = new CheckpointStore(repoRoot);
    await assert.rejects(() => store.create(["linked/secret.txt"]), /symbolic link/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

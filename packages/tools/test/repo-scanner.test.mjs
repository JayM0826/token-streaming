import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scanRepo } from "../dist/repo-scanner.js";

test("scanRepo infers conservative Python verification commands", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "token-streaming-python-scan-"));
  try {
    await mkdir(path.join(repoRoot, "src", "model"), { recursive: true });
    await mkdir(path.join(repoRoot, "tests"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "model", "encoder.py"), "VALUE = 1\n", "utf8");
    await writeFile(path.join(repoRoot, "tests", "test_encoder.py"), "def test_value(): assert True\n", "utf8");
    await writeFile(path.join(repoRoot, "ruff.toml"), "line-length = 120\n", "utf8");
    await writeFile(path.join(repoRoot, "mypy.ini"), "[mypy]\n", "utf8");

    const summary = await scanRepo(repoRoot);

    assert.deepEqual(summary.verificationCommands, [
      "python -m compileall src tests",
      "python -m pytest",
      "python -m ruff check .",
      "python -m mypy ."
    ]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

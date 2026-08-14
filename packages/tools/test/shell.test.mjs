import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { runCommand } from "../dist/shell.js";

test("runCommand bounds captured output and reports truncation", async () => {
  const result = await runCommand(nodeCommand("process.stdout.write('x'.repeat(8192))"), {
    cwd: tmpdir(),
    timeoutMs: 5_000,
    maxOutputBytes: 256
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.outputLimitExceeded, true);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, false);
  assert.equal(Buffer.byteLength(result.stdout) <= 256, true);
});

test("runCommand applies a timeout and reports it structurally", async () => {
  const result = await runCommand(nodeCommand("setTimeout(() => {}, 1000)"), {
    cwd: tmpdir(),
    timeoutMs: 25,
    maxOutputBytes: 1_024
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.outputLimitExceeded, false);
});

test("runCommand validates execution bounds", async () => {
  await assert.rejects(() => runCommand("echo ok", { cwd: tmpdir(), timeoutMs: 0 }), /timeoutMs must be a positive integer/);
  await assert.rejects(() => runCommand("echo ok", { cwd: tmpdir(), maxOutputBytes: 0 }), /maxOutputBytes must be a positive integer/);
});

function nodeCommand(script) {
  const executable = `"${process.execPath}"`;
  return `${process.platform === "win32" ? "& " : ""}${executable} -e "${script}"`;
}

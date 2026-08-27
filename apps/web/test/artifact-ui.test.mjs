import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("artifact UI only offers reusable standard, ready, unpurged, unexpired content", async () => {
  const panel = await readFile(path.join(webRoot, "app", "artifact-task-panel.tsx"), "utf8");

  assert.match(panel, /artifact\.status === "ready"/);
  assert.match(panel, /artifact\.privacyMode === "standard"/);
  assert.match(panel, /artifact\.contentPurgedAt === null/);
  assert.match(panel, /artifact\.expiresAt > snapshot\.generatedAt/);
  assert.match(panel, /required=\{!selectedArtifact\}/);
  assert.match(panel, /artifactId,[\s\S]*?supplierProcessingAcknowledged/);
});

test("artifact UI exposes two-phase cancellation and keeps cancelling tasks polling", async () => {
  const panel = await readFile(path.join(webRoot, "app", "artifact-task-panel.tsx"), "utf8");

  assert.match(panel, /\["queued", "claimed", "running", "cancelling"\]/);
  assert.match(panel, /artifact-cancel-\$\{crypto\.randomUUID\(\)\}/);
  assert.match(panel, /预留仍保留/);
  assert.match(panel, /等待节点确认取消/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { findPlaybook, listPlaybookSummaries } from "../dist/index.js";

test("listPlaybookSummaries extracts headings and sorts playbooks", () => {
  const manifest = createManifest([
    {
      name: "z-task",
      path: "/repo/.ai/playbooks/z-task.md",
      content: "# Z Task\n\nSteps."
    },
    {
      name: "a-task",
      path: "/repo/.ai/playbooks/a-task.md",
      content: "No title here."
    }
  ]);

  assert.deepEqual(listPlaybookSummaries(manifest), [
    {
      name: "a-task",
      title: "a-task",
      path: "/repo/.ai/playbooks/a-task.md"
    },
    {
      name: "z-task",
      title: "Z Task",
      path: "/repo/.ai/playbooks/z-task.md"
    }
  ]);
});

test("findPlaybook matches names case-insensitively", () => {
  const manifest = createManifest([
    {
      name: "add-provider",
      path: "/repo/.ai/playbooks/add-provider.md",
      content: "# Add Provider\n"
    }
  ]);

  assert.equal(findPlaybook(manifest, "ADD-PROVIDER")?.name, "add-provider");
  assert.equal(findPlaybook(manifest, "missing"), undefined);
});

function createManifest(playbooks) {
  return {
    playbooks,
    modules: [],
    workflows: [],
    generated: false
  };
}

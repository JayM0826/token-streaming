import type { ModuleManifest, WorkflowManifest } from "@token-streaming/protocol";
import { taskTextIncludesSearchTerms } from "./search-terms.js";

export interface ManifestTaskMatch {
  field: string;
  value: string;
}

export function matchModuleToTask(taskText: string, module: ModuleManifest): ManifestTaskMatch | undefined {
  return matchNamedManifest(taskText, module.name, [
    ["description", module.description],
    ...module.dependsOn.map((value) => ["depends_on", value] as const),
    ...module.usedBy.map((value) => ["used_by", value] as const),
    ...module.rules.map((value) => ["rule", value] as const)
  ]);
}

export function matchWorkflowToTask(taskText: string, workflow: WorkflowManifest): ManifestTaskMatch | undefined {
  return matchNamedManifest(taskText, workflow.name, [
    ["description", workflow.description],
    ...workflow.steps.map((value) => ["step", value] as const),
    ...workflow.touches.map((value) => ["touch", value] as const),
    ...workflow.risks.map((value) => ["risk", value] as const)
  ]);
}

function matchNamedManifest(
  taskText: string,
  name: string,
  fields: ReadonlyArray<readonly [string, string | undefined]>
): ManifestTaskMatch | undefined {
  const normalizedTask = taskText.toLowerCase();
  if (normalizedTask.includes(name.toLowerCase())) {
    return { field: "name", value: name };
  }
  for (const [field, value] of fields) {
    if (value && taskTextIncludesSearchTerms(normalizedTask, value)) {
      return { field, value };
    }
  }
  return undefined;
}

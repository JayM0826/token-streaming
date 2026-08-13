import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModuleManifest, PlaybookManifest, RepoManifest, WorkflowManifest } from "@token-streaming/protocol";
import { parseSimpleYaml } from "./simple-yaml.js";

const ROOT_TEXT_FILES = {
  project: "project.md",
  architecture: "architecture.md",
  conventions: "conventions.md",
  glossary: "glossary.md"
} as const;

export async function loadRepoManifest(repoRoot: string): Promise<RepoManifest> {
  const aiRoot = path.join(repoRoot, ".ai");
  const generatedRoot = path.join(aiRoot, "generated");
  const hasRootManifest = await hasOfficialRootManifest(aiRoot);
  const fallbackRoot = hasRootManifest ? aiRoot : generatedRoot;

  const [textParts, commands, tests, safety, models, ownership, playbooks, modules, workflows, generatedRepoMap] = await Promise.all([
    readRootTextFiles(fallbackRoot),
    readYamlIfExists(path.join(fallbackRoot, "commands.yaml")),
    readYamlIfExists(path.join(fallbackRoot, "tests.yaml")),
    readYamlIfExists(path.join(fallbackRoot, "safety.yaml")),
    readYamlIfExists(path.join(fallbackRoot, "models.yaml")),
    readYamlIfExists(path.join(fallbackRoot, "ownership.yaml")),
    loadPlaybooks(path.join(fallbackRoot, "playbooks")),
    loadModuleManifests(repoRoot),
    loadWorkflowManifests(repoRoot),
    hasRootManifest ? Promise.resolve(undefined) : readJsonIfExists(path.join(generatedRoot, "repo-map.json"))
  ]);
  const defaultTestCommands = stringArray(tests?.default);
  const generatedMetadata = parseGeneratedRepoMap(repoRoot, generatedRepoMap, defaultTestCommands);

  return {
    ...textParts,
    commands,
    tests,
    safety,
    models,
    ownership,
    playbooks,
    modules: modules.length > 0 ? modules : generatedMetadata.modules,
    workflows: workflows.length > 0 ? workflows : generatedMetadata.workflows,
    generated: !hasRootManifest
  };
}

function parseGeneratedRepoMap(
  repoRoot: string,
  value: Record<string, unknown> | undefined,
  defaultTestCommands: string[]
): { modules: ModuleManifest[]; workflows: WorkflowManifest[] } {
  if (!value) {
    return { modules: [], workflows: [] };
  }

  const modules = objectArray(value.inferredModules).flatMap((candidate) => {
    const root = optionalString(candidate.root);
    if (!root) {
      return [];
    }
    const name = stringValue(candidate.name, path.basename(root));
    const evidence = stringArray(candidate.evidence);
    return [
      {
        path: path.join(repoRoot, root, "module.yaml"),
        generated: true,
        name,
        description: generatedDescription("module", candidate.confidence, evidence),
        owners: [],
        publicApi: stringArray(candidate.publicApiCandidates),
        dependsOn: [],
        usedBy: [],
        testCommands: defaultTestCommands,
        rules: []
      }
    ];
  });

  const workflows = objectArray(value.inferredWorkflows).flatMap((candidate) => {
    const root = optionalString(candidate.root);
    if (!root) {
      return [];
    }
    const name = stringValue(candidate.name, path.basename(root));
    const evidence = stringArray(candidate.evidence);
    return [
      {
        path: path.join(repoRoot, root, "flow.yaml"),
        generated: true,
        name,
        description: generatedDescription("workflow", candidate.confidence, evidence),
        steps: [],
        touches: stringArray(candidate.touches),
        testCommands: defaultTestCommands,
        risks: []
      }
    ];
  });

  return { modules, workflows };
}

function generatedDescription(kind: string, confidence: unknown, evidence: string[]): string {
  const confidenceText = typeof confidence === "string" ? confidence : "unknown";
  return `Generated ${kind} candidate (${confidenceText} confidence)${evidence.length ? `: ${evidence.join("; ")}` : "."}`;
}

async function hasOfficialRootManifest(aiRoot: string): Promise<boolean> {
  const officialFiles = [
    ...Object.values(ROOT_TEXT_FILES),
    "commands.yaml",
    "tests.yaml",
    "models.yaml",
    "ownership.yaml",
    "safety.yaml"
  ];

  const checks = await Promise.all(officialFiles.map((file) => exists(path.join(aiRoot, file))));
  return checks.some(Boolean);
}

async function readRootTextFiles(root: string): Promise<Pick<RepoManifest, "project" | "architecture" | "conventions" | "glossary">> {
  const entries = await Promise.all(
    Object.entries(ROOT_TEXT_FILES).map(async ([key, file]) => [key, await readTextIfExists(path.join(root, file))] as const)
  );

  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

async function loadPlaybooks(playbookRoot: string): Promise<PlaybookManifest[]> {
  if (!(await exists(playbookRoot))) {
    return [];
  }

  const entries = await fs.readdir(playbookRoot, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));

  return Promise.all(
    files.map(async (file) => {
      const fullPath = path.join(playbookRoot, file.name);
      return {
        name: path.basename(file.name, ".md"),
        path: fullPath,
        content: await fs.readFile(fullPath, "utf8")
      };
    })
  );
}

async function loadModuleManifests(repoRoot: string): Promise<ModuleManifest[]> {
  const roots = [
    path.join(repoRoot, "src", "modules"),
    path.join(repoRoot, "packages"),
    path.join(repoRoot, "apps")
  ];
  const manifests = (
    await Promise.all(
      roots.map(async (root) => {
        if (!(await exists(root))) {
          return [];
        }

        const directories = await fs.readdir(root, { withFileTypes: true });
        return Promise.all(
          directories
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => readModuleManifest(path.join(root, entry.name, "module.yaml")))
        );
      })
    )
  ).flat();

  return manifests.filter((manifest): manifest is ModuleManifest => manifest !== undefined);
}

async function loadWorkflowManifests(repoRoot: string): Promise<WorkflowManifest[]> {
  const workflowsRoot = path.join(repoRoot, "src", "workflows");
  if (!(await exists(workflowsRoot))) {
    return [];
  }

  const directories = await fs.readdir(workflowsRoot, { withFileTypes: true });
  const manifests = await Promise.all(
    directories
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => readWorkflowManifest(path.join(workflowsRoot, entry.name, "flow.yaml")))
  );

  return manifests.filter((manifest): manifest is WorkflowManifest => manifest !== undefined);
}

async function readModuleManifest(filePath: string): Promise<ModuleManifest | undefined> {
  const raw = await readYamlIfExists(filePath);
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  return {
    path: filePath,
    name: stringValue(record.name, path.basename(path.dirname(filePath))),
    description: optionalString(record.description),
    owners: stringArray(record.owners),
    publicApi: stringArray(record.public_api),
    dependsOn: stringArray(record.depends_on),
    usedBy: stringArray(record.used_by),
    testCommands: stringArray(record.test_commands),
    rules: stringArray(record.rules)
  };
}

async function readWorkflowManifest(filePath: string): Promise<WorkflowManifest | undefined> {
  const raw = await readYamlIfExists(filePath);
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  return {
    path: filePath,
    name: stringValue(record.name, path.basename(path.dirname(filePath))),
    description: optionalString(record.description),
    steps: stringArray(record.steps),
    touches: stringArray(record.touches),
    testCommands: stringArray(record.test_commands),
    risks: stringArray(record.risks)
  };
}

async function readYamlIfExists(filePath: string): Promise<Record<string, unknown> | undefined> {
  const content = await readTextIfExists(filePath);
  if (content === undefined) {
    return undefined;
  }

  const parsed = parseSimpleYaml(content);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | undefined> {
  const content = await readTextIfExists(filePath);
  if (content === undefined) {
    return undefined;
  }
  const parsed = JSON.parse(content) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

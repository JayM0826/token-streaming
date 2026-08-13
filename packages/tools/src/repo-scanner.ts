import { promises as fs } from "node:fs";
import path from "node:path";
import type { RepoSummary } from "@token-streaming/protocol";
import { listGitFiles } from "./git.js";

const SOURCE_DIRECTORY_CANDIDATES = ["src", "app", "lib", "packages", "apps", "services"];

export async function scanRepo(repoRoot: string): Promise<RepoSummary> {
  const [packageJson, trackedFiles, sourceDirectories, moduleManifestPaths, workflowManifestPaths, aiManifestPresent] =
    await Promise.all([
      readPackageJson(repoRoot),
      listFiles(repoRoot),
      findExistingDirectories(repoRoot, SOURCE_DIRECTORY_CANDIDATES),
      findModuleManifestPaths(repoRoot),
      findNestedManifestPaths(path.join(repoRoot, "src", "workflows"), "flow.yaml"),
      hasOfficialAiManifest(repoRoot)
    ]);

  return {
    root: repoRoot,
    packageManager: await detectPackageManager(repoRoot, packageJson),
    scripts: readScripts(packageJson),
    trackedFiles,
    sourceDirectories,
    moduleManifestPaths,
    workflowManifestPaths,
    aiManifestPresent,
    verificationCommands: inferVerificationCommands(trackedFiles)
  };
}

function inferVerificationCommands(trackedFiles: string[]): string[] {
  const files = trackedFiles.map((file) => file.replace(/\\/g, "/"));
  const pythonFiles = files.filter((file) => /\.py$/i.test(file));
  if (pythonFiles.length === 0) {
    return [];
  }

  const commands: string[] = [];
  const compileTargets = [
    ...new Set(
      pythonFiles.map((file) => {
        const separator = file.indexOf("/");
        return separator === -1 ? file : file.slice(0, separator);
      })
    )
  ].sort();
  commands.push(`python -m compileall ${compileTargets.map(quoteCommandArgument).join(" ")}`);

  if (files.some((file) => /(^|\/)(__tests__|tests?)(\/|$)|(^|\/)test_[^/]+\.py$|(^|\/)[^/]+_test\.py$/i.test(file))) {
    commands.push("python -m pytest");
  }
  if (files.some((file) => /(^|\/)(ruff\.toml|\.ruff\.toml)$/i.test(file))) {
    commands.push("python -m ruff check .");
  }
  if (files.some((file) => /(^|\/)(mypy\.ini|\.mypy\.ini)$/i.test(file))) {
    commands.push("python -m mypy .");
  }
  return commands;
}

function quoteCommandArgument(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

async function findModuleManifestPaths(repoRoot: string): Promise<string[]> {
  const roots = [
    path.join(repoRoot, "src", "modules"),
    path.join(repoRoot, "packages"),
    path.join(repoRoot, "apps")
  ];
  const groups = await Promise.all(roots.map((root) => findNestedManifestPaths(root, "module.yaml")));
  return groups.flat();
}

async function hasOfficialAiManifest(repoRoot: string): Promise<boolean> {
  const aiRoot = path.join(repoRoot, ".ai");
  const officialFiles = [
    "project.md",
    "architecture.md",
    "conventions.md",
    "commands.yaml",
    "tests.yaml",
    "safety.yaml",
    "glossary.md"
  ];
  const checks = await Promise.all(officialFiles.map((file) => exists(path.join(aiRoot, file))));
  return checks.some(Boolean);
}

async function listFiles(repoRoot: string): Promise<string[]> {
  const gitFiles = await listGitFiles(repoRoot);
  if (gitFiles.length > 0) {
    return gitFiles;
  }

  return walk(repoRoot, repoRoot, 500);
}

async function walk(root: string, current: string, limit: number, files: string[] = []): Promise<string[]> {
  if (files.length >= limit) {
    return files;
  }

  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }

    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, fullPath, limit, files);
    } else if (entry.isFile()) {
      files.push(path.relative(root, fullPath));
    }
  }

  return files;
}

async function readPackageJson(repoRoot: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readScripts(packageJson: Record<string, unknown> | undefined): Record<string, string> {
  const scripts = packageJson?.scripts;
  if (!scripts || typeof scripts !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(scripts as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

async function detectPackageManager(repoRoot: string, packageJson?: Record<string, unknown>): Promise<RepoSummary["packageManager"]> {
  if (await exists(path.join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(repoRoot, "pnpm-workspace.yaml"))) return "pnpm";
  if (await exists(path.join(repoRoot, "yarn.lock"))) return "yarn";
  if (await exists(path.join(repoRoot, "bun.lockb"))) return "bun";
  if (await exists(path.join(repoRoot, "package-lock.json"))) return "npm";
  const declaredManager = typeof packageJson?.packageManager === "string" ? packageJson.packageManager : undefined;
  if (declaredManager?.startsWith("pnpm@")) return "pnpm";
  if (declaredManager?.startsWith("yarn@")) return "yarn";
  if (declaredManager?.startsWith("bun@")) return "bun";
  if (declaredManager?.startsWith("npm@")) return "npm";
  if (await exists(path.join(repoRoot, "package.json"))) return "npm";
  return undefined;
}

async function findExistingDirectories(repoRoot: string, candidates: string[]): Promise<string[]> {
  const checks = await Promise.all(
    candidates.map(async (candidate) => ((await exists(path.join(repoRoot, candidate))) ? candidate : undefined))
  );
  return checks.filter((directory): directory is string => directory !== undefined);
}

async function findNestedManifestPaths(root: string, manifestName: string): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const paths = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const manifestPath = path.join(root, entry.name, manifestName);
        return (await exists(manifestPath)) ? manifestPath : undefined;
      })
  );

  return paths.filter((filePath): filePath is string => filePath !== undefined);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

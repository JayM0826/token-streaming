import { promises as fs } from "node:fs";
import path from "node:path";

export async function readTextFile(repoRoot: string, relativePath: string): Promise<string> {
  return fs.readFile(await resolveInsideRepoReal(repoRoot, relativePath), "utf8");
}

export async function writeTextFile(repoRoot: string, relativePath: string, content: string): Promise<void> {
  const filePath = await resolveInsideRepoReal(repoRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

export function resolveInsideRepo(repoRoot: string, relativePath: string): string {
  const resolved = path.resolve(repoRoot, relativePath);
  const root = path.resolve(repoRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }
  return resolved;
}

export async function resolveInsideRepoReal(repoRoot: string, relativePath: string): Promise<string> {
  const resolved = resolveInsideRepo(repoRoot, relativePath);
  const root = path.resolve(repoRoot);
  const realRoot = await fs.realpath(root);
  const existingAncestor = await findExistingAncestor(resolved, root);
  const realAncestor = await fs.realpath(existingAncestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`Path resolves outside repository root through a symbolic link: ${relativePath}`);
  }
  return resolved;
}

async function findExistingAncestor(candidate: string, root: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (current === root) {
      return root;
    }
    current = path.dirname(current);
  }
}

import { promises as fs } from "node:fs";
import path from "node:path";

export async function readTextFile(repoRoot: string, relativePath: string): Promise<string> {
  return fs.readFile(resolveInsideRepo(repoRoot, relativePath), "utf8");
}

export async function writeTextFile(repoRoot: string, relativePath: string, content: string): Promise<void> {
  const filePath = resolveInsideRepo(repoRoot, relativePath);
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

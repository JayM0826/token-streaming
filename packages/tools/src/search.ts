import { promises as fs } from "node:fs";
import path from "node:path";
import { listGitFiles } from "./git.js";
import { readTextFile } from "./filesystem.js";

export interface SearchOptions {
  maxMatches?: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

const DEFAULT_MAX_MATCHES = 50;
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".yaml", ".yml", ".txt"]);

export async function searchRepo(repoRoot: string, query: string, options: SearchOptions = {}): Promise<SearchMatch[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    throw new Error("Search query must be non-empty.");
  }

  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const matches: SearchMatch[] = [];
  for (const filePath of await listSearchableFiles(repoRoot)) {
    if (matches.length >= maxMatches) {
      break;
    }

    const content = await readSearchableFile(repoRoot, filePath);
    if (content === undefined) {
      continue;
    }

    collectMatches(filePath, content, normalizedQuery, maxMatches, matches);
  }

  return matches;
}

async function listSearchableFiles(repoRoot: string): Promise<string[]> {
  const gitFiles = await listGitFiles(repoRoot);
  const files = gitFiles.length > 0 ? gitFiles : await walk(repoRoot, repoRoot, []);
  return files.map(normalizePath).filter(isSearchablePath).sort((left, right) => left.localeCompare(right));
}

async function walk(repoRoot: string, current: string, files: string[]): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".token-streaming") {
      continue;
    }

    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(repoRoot, fullPath, files);
    } else if (entry.isFile()) {
      files.push(path.relative(repoRoot, fullPath));
    }
  }
  return files;
}

async function readSearchableFile(repoRoot: string, filePath: string): Promise<string | undefined> {
  try {
    return await readTextFile(repoRoot, filePath);
  } catch {
    return undefined;
  }
}

function collectMatches(filePath: string, content: string, query: string, maxMatches: number, matches: SearchMatch[]): void {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length && matches.length < maxMatches; index += 1) {
    const line = lines[index] ?? "";
    const column = line.toLowerCase().indexOf(query);
    if (column >= 0) {
      matches.push({
        path: filePath,
        line: index + 1,
        column: column + 1,
        text: line
      });
    }
  }
}

function isSearchablePath(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

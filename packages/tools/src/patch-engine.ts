import { promises as fs } from "node:fs";
import path from "node:path";
import type { PatchProposal, ProposedFilePatch } from "@token-streaming/protocol";
import { resolveInsideRepoReal } from "./filesystem.js";

export interface PatchResult {
  files: string[];
}

export async function applyFilePatches(repoRoot: string, patches: ProposedFilePatch[]): Promise<PatchResult> {
  const files: string[] = [];

  for (const patch of patches) {
    const filePath = await resolveInsideRepoReal(repoRoot, patch.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, patch.content, "utf8");
    files.push(patch.path);
  }

  return { files };
}

export function parsePatchProposal(text: string): PatchProposal | undefined {
  const rawJson = extractJsonPayload(text);
  if (!rawJson) {
    return undefined;
  }

  const parsed = JSON.parse(rawJson) as unknown;
  return normalizePatchProposal(parsed);
}

export function normalizePatchProposal(value: unknown): PatchProposal {
  if (!value || typeof value !== "object") {
    throw new Error("Patch proposal must be an object.");
  }

  const record = value as Record<string, unknown>;
  const files = record.files;
  if (!Array.isArray(files)) {
    throw new Error("Patch proposal must include a files array.");
  }

  return {
    summary: typeof record.summary === "string" ? record.summary : "No summary provided.",
    files: files.map(normalizeFilePatch)
  };
}

function normalizeFilePatch(value: unknown): ProposedFilePatch {
  if (!value || typeof value !== "object") {
    throw new Error("Patch file entry must be an object.");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || record.path.trim().length === 0) {
    throw new Error("Patch file entry must include a non-empty path.");
  }

  if (typeof record.content !== "string") {
    throw new Error(`Patch file entry for ${record.path} must include string content.`);
  }

  return {
    path: record.path,
    content: record.content
  };
}

function extractJsonPayload(text: string): string | undefined {
  const fenced = text.match(/```(?:json|token-streaming-patch)\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  return undefined;
}

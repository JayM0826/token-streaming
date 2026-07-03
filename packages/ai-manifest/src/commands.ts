import type { RepoManifest } from "@token-streaming/protocol";

export interface ManifestCommandGroup {
  name: string;
  commands: string[];
}

export function listManifestCommandGroups(manifest: RepoManifest): ManifestCommandGroup[] {
  const commands = manifest.commands;
  if (!commands) {
    return [];
  }

  return Object.entries(commands)
    .map(([name, value]) => ({
      name,
      commands: normalizeCommandList(value)
    }))
    .filter((group) => group.commands.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeCommandList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return [value];
  }

  return [];
}

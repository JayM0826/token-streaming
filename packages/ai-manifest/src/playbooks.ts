import type { PlaybookManifest, RepoManifest } from "@token-streaming/protocol";

export interface PlaybookSummary {
  name: string;
  title: string;
  path: string;
}

export function listPlaybookSummaries(manifest: RepoManifest): PlaybookSummary[] {
  return manifest.playbooks.map(toSummary).sort((left, right) => left.name.localeCompare(right.name));
}

export function findPlaybook(manifest: RepoManifest, name: string): PlaybookManifest | undefined {
  const normalizedName = name.toLowerCase();
  return manifest.playbooks.find((playbook) => playbook.name.toLowerCase() === normalizedName);
}

function toSummary(playbook: PlaybookManifest): PlaybookSummary {
  return {
    name: playbook.name,
    title: extractTitle(playbook),
    path: playbook.path
  };
}

function extractTitle(playbook: PlaybookManifest): string {
  const heading = playbook.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "));
  return heading ? heading.replace(/^#\s+/, "").trim() : playbook.name;
}

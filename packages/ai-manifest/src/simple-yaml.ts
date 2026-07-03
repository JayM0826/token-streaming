export function parseSimpleYaml(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  let currentKey: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }

    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && currentKey) {
      const list = Array.isArray(root[currentKey]) ? (root[currentKey] as string[]) : [];
      list.push(stripQuotes(listMatch[1] ?? ""));
      root[currentKey] = list;
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      const key = keyMatch[1] ?? "";
      const value = keyMatch[2] ?? "";
      currentKey = key;
      root[key] = value ? stripQuotes(value) : [];
    }
  }

  return root;
}

export function stringifySimpleYaml(value: unknown, indent = 0): string {
  if (!value || typeof value !== "object") {
    return `${String(value ?? "")}\n`;
  }

  const spaces = " ".repeat(indent);
  return Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => {
      if (Array.isArray(entry)) {
        return [`${spaces}${key}:`, ...entry.map((item) => `${spaces}  - ${String(item)}`)].join("\n");
      }

      if (entry && typeof entry === "object") {
        return `${spaces}${key}:\n${stringifySimpleYaml(entry, indent + 2).trimEnd()}`;
      }

      return `${spaces}${key}: ${String(entry ?? "")}`;
    })
    .join("\n");
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

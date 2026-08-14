import type { ToolDefinition } from "@token-streaming/protocol";

export interface ToolCatalogEntry {
  name: string;
  description: string;
  risk: ToolDefinition["risk"];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export function listToolCatalog(): ToolCatalogEntry[] {
  return [
    {
      name: "repo.scan",
      description: "Inspect package manager, scripts, tracked files, source directories, and manifest paths.",
      risk: "read",
      inputSchema: objectSchema({
        repoRoot: stringSchema("Repository root path.")
      }),
      outputSchema: objectSchema({
        root: stringSchema("Repository root path."),
        packageManager: enumSchema(["pnpm", "npm", "yarn", "bun"], "Detected package manager."),
        scripts: objectSchema({}, "Package scripts keyed by name."),
        trackedFiles: arraySchema("Repository-relative tracked or discovered files."),
        sourceDirectories: arraySchema("Detected source directories."),
        moduleManifestPaths: arraySchema("module.yaml paths."),
        workflowManifestPaths: arraySchema("flow.yaml paths."),
        aiManifestPresent: booleanSchema("Whether an official .ai manifest exists.")
      })
    },
    {
      name: "repo.search",
      description: "Search repository text files and return bounded line matches.",
      risk: "read",
      inputSchema: objectSchema({
        repoRoot: stringSchema("Repository root path."),
        query: stringSchema("Case-insensitive search query."),
        maxMatches: numberSchema("Optional maximum number of matches.")
      }),
      outputSchema: objectSchema({
        matches: arraySchema("Matches with path, line, column, and source text.")
      })
    },
    {
      name: "file.read",
      description: "Read a UTF-8 text file inside the repository root.",
      risk: "read",
      inputSchema: objectSchema({
        repoRoot: stringSchema("Repository root path."),
        path: stringSchema("Repository-relative file path.")
      }),
      outputSchema: objectSchema({
        content: stringSchema("File content.")
      })
    },
    {
      name: "git.status",
      description: "Return git status --short for the repository.",
      risk: "read",
      inputSchema: objectSchema({
        repoRoot: stringSchema("Repository root path.")
      }),
      outputSchema: objectSchema({
        status: stringSchema("Short git status output.")
      })
    },
    {
      name: "git.diff",
      description: "Return git diff -- . for the repository.",
      risk: "read",
      inputSchema: objectSchema({
        repoRoot: stringSchema("Repository root path.")
      }),
      outputSchema: objectSchema({
        diff: stringSchema("Working tree diff.")
      })
    },
    {
      name: "command.run",
      description: "Run a shell command in the repository after host permission checks.",
      risk: "execute",
      inputSchema: objectSchema({
        repoRoot: stringSchema("Repository root path."),
        command: stringSchema("Command to execute."),
        timeoutMs: numberSchema("Optional timeout in milliseconds.")
      }),
      outputSchema: objectSchema({
        command: stringSchema("Executed command."),
        exitCode: numberSchema("Process exit code or null."),
        stdout: stringSchema("Captured stdout."),
        stderr: stringSchema("Captured stderr."),
        timedOut: booleanSchema("Whether the command exceeded its timeout."),
        outputLimitExceeded: booleanSchema("Whether captured output exceeded the configured byte limit."),
        stdoutTruncated: booleanSchema("Whether stdout was truncated."),
        stderrTruncated: booleanSchema("Whether stderr was truncated.")
      })
    },
    {
      name: "test.run",
      description: "Run a verification command and return structured command output.",
      risk: "execute",
      inputSchema: objectSchema({
        repoRoot: stringSchema("Repository root path."),
        command: stringSchema("Verification command.")
      }),
      outputSchema: objectSchema({
        command: stringSchema("Executed command."),
        exitCode: numberSchema("Process exit code or null."),
        stdout: stringSchema("Captured stdout."),
        stderr: stringSchema("Captured stderr."),
        timedOut: booleanSchema("Whether the command exceeded its timeout."),
        outputLimitExceeded: booleanSchema("Whether captured output exceeded the configured byte limit."),
        stdoutTruncated: booleanSchema("Whether stdout was truncated."),
        stderrTruncated: booleanSchema("Whether stderr was truncated.")
      })
    },
    {
      name: "patch.apply",
      description: "Apply full-file patch proposals inside the repository after checkpoint and permission checks.",
      risk: "write",
      inputSchema: objectSchema({
        repoRoot: stringSchema("Repository root path."),
        proposal: objectSchema({}, "Structured patch proposal.")
      }),
      outputSchema: objectSchema({
        files: arraySchema("Repository-relative paths written by the patch.")
      })
    }
  ];
}

function objectSchema(properties: Record<string, unknown>, description?: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties
  };
}

function stringSchema(description: string): Record<string, unknown> {
  return {
    type: "string",
    description
  };
}

function numberSchema(description: string): Record<string, unknown> {
  return {
    type: "number",
    description
  };
}

function booleanSchema(description: string): Record<string, unknown> {
  return {
    type: "boolean",
    description
  };
}

function arraySchema(description: string): Record<string, unknown> {
  return {
    type: "array",
    description
  };
}

function enumSchema(values: string[], description: string): Record<string, unknown> {
  return {
    type: "string",
    enum: values,
    description
  };
}

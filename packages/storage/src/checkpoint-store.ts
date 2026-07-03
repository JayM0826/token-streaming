import { promises as fs } from "node:fs";
import path from "node:path";
import type { Checkpoint } from "@token-streaming/protocol";

export interface RollbackPreview {
  checkpointId: string;
  restoreFiles: string[];
  deleteFiles: string[];
  files: Array<{
    path: string;
    action: "restore" | "delete";
    existedAtCheckpoint: boolean;
  }>;
}

export class CheckpointStore {
  constructor(private readonly repoRoot: string) {}

  async create(files: string[]): Promise<Checkpoint> {
    const checkpoint: Checkpoint = {
      id: createId("chk"),
      createdAt: new Date().toISOString(),
      files: await Promise.all(
        files.map(async (file) => ({
          path: file,
          content: await readNullable(path.resolve(this.repoRoot, file))
        }))
      )
    };

    await this.save(checkpoint);
    return checkpoint;
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    const filePath = this.getCheckpointPath(checkpoint.id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2), "utf8");
  }

  async load(id: string): Promise<Checkpoint> {
    const content = await fs.readFile(this.getCheckpointPath(id), "utf8");
    return JSON.parse(content) as Checkpoint;
  }

  async list(): Promise<Checkpoint[]> {
    const directory = path.join(this.repoRoot, ".token-streaming", "checkpoints");
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const checkpoints = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          const content = await fs.readFile(path.join(directory, entry), "utf8");
          return JSON.parse(content) as Checkpoint;
        })
    );

    return checkpoints.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async rollback(id: string): Promise<string[]> {
    const checkpoint = await this.load(id);
    const restored: string[] = [];

    for (const file of checkpoint.files) {
      const absolutePath = path.resolve(this.repoRoot, file.path);
      if (file.content === null) {
        await fs.rm(absolutePath, { force: true });
      } else {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, file.content, "utf8");
      }
      restored.push(file.path);
    }

    return restored;
  }

  async previewRollback(id: string): Promise<RollbackPreview> {
    const checkpoint = await this.load(id);
    const files = checkpoint.files.map((file) => ({
      path: file.path,
      action: file.content === null ? "delete" : "restore",
      existedAtCheckpoint: file.content !== null
    })) satisfies RollbackPreview["files"];

    return {
      checkpointId: checkpoint.id,
      restoreFiles: files.filter((file) => file.action === "restore").map((file) => file.path),
      deleteFiles: files.filter((file) => file.action === "delete").map((file) => file.path),
      files
    };
  }

  private getCheckpointPath(id: string): string {
    return path.join(this.repoRoot, ".token-streaming", "checkpoints", `${id}.json`);
  }
}

async function readNullable(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

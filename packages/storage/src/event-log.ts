import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionEvent } from "@token-streaming/protocol";
import { assertSafeStorageId } from "./safe-id.js";

export class EventLog {
  private readonly filePath: string;

  constructor(
    private readonly repoRoot: string,
    private readonly sessionId: string,
    private readonly onAppend?: (event: SessionEvent) => void | Promise<void>
  ) {
    assertSafeStorageId("session", sessionId);
    this.filePath = path.join(repoRoot, ".token-streaming", "sessions", `${sessionId}.jsonl`);
  }

  async append(event: SessionEvent): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    try {
      const pending = this.onAppend?.(event);
      if (pending) {
        void pending.catch(() => undefined);
      }
    } catch {
      // A host observer must not compromise the durable runtime event log.
    }
  }

  async readAll(): Promise<SessionEvent[]> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SessionEvent);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  get path(): string {
    return this.filePath;
  }
}

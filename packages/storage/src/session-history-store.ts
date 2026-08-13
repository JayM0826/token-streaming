import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionEvent } from "@token-streaming/protocol";
import { classifyFailure, type FailureCategory } from "./failure-category.js";
import { assertSafeStorageId } from "./safe-id.js";

export interface SessionHistorySummary {
  sessionId: string;
  status: "completed" | "failed" | "running";
  failureCategory?: FailureCategory;
  eventCount: number;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  lastEventAt?: string;
  task?: string;
  summary?: string;
  error?: string;
  logPath: string;
}

export class SessionHistoryStore {
  constructor(private readonly repoRoot: string) {}

  async list(): Promise<SessionHistorySummary[]> {
    const directory = this.getSessionsDirectory();
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const summaries = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".jsonl"))
        .map(async (entry) => {
          const sessionId = entry.slice(0, -".jsonl".length);
          const events = await this.read(sessionId);
          return summarizeSession(sessionId, this.getSessionPath(sessionId), events);
        })
    );

    return summaries.sort((left, right) => (right.lastEventAt ?? "").localeCompare(left.lastEventAt ?? ""));
  }

  async read(sessionId: string): Promise<SessionEvent[]> {
    const content = await fs.readFile(this.getSessionPath(sessionId), "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionEvent);
  }

  getSessionPath(sessionId: string): string {
    assertSafeStorageId("session", sessionId);
    return path.join(this.getSessionsDirectory(), `${sessionId}.jsonl`);
  }

  private getSessionsDirectory(): string {
    return path.join(this.repoRoot, ".token-streaming", "sessions");
  }
}

function summarizeSession(sessionId: string, logPath: string, events: SessionEvent[]): SessionHistorySummary {
  const firstEvent = events[0];
  const lastEvent = events.at(-1);
  const userMessage = events.find((event) => event.type === "user.message");
  const completed = [...events].reverse().find((event) => event.type === "run.completed");
  const failed = [...events].reverse().find((event) => event.type === "run.failed");
  const terminal = completed && failed ? (completed.timestamp > failed.timestamp ? completed : failed) : (completed ?? failed);

  return {
    sessionId,
    status: terminal?.type === "run.completed" ? "completed" : terminal?.type === "run.failed" ? "failed" : "running",
    failureCategory: failed?.type === "run.failed" ? classifyFailure(failed.error) : undefined,
    eventCount: events.length,
    startedAt: firstEvent?.timestamp,
    completedAt: completed?.timestamp,
    failedAt: failed?.timestamp,
    lastEventAt: lastEvent?.timestamp,
    task: userMessage?.type === "user.message" ? userMessage.message : undefined,
    summary: completed?.type === "run.completed" ? firstLine(completed.summary) : undefined,
    error: failed?.type === "run.failed" ? firstLine(failed.error) : undefined,
    logPath
  };
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find(Boolean) ?? "";
}

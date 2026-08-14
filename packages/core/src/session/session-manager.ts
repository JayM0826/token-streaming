import type { ProductMode, Session, SessionEvent } from "@token-streaming/protocol";
import { EventLog } from "@token-streaming/storage";

export class SessionManager {
  create(repoRoot: string, options: { mode: ProductMode; strategy?: string }): Session {
    return {
      id: createId("ses"),
      repoRoot,
      startedAt: new Date().toISOString(),
      mode: options.mode,
      strategy: options.strategy ?? "default"
    };
  }

  createEventLog(session: Session, onEvent?: (event: SessionEvent) => void | Promise<void>): EventLog {
    return new EventLog(session.repoRoot, session.id, onEvent);
  }

  createEvent<T extends Omit<SessionEvent, "id" | "timestamp">>(event: T): T & Pick<SessionEvent, "id" | "timestamp"> {
    return {
      ...event,
      id: createId("evt"),
      timestamp: new Date().toISOString()
    };
  }
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

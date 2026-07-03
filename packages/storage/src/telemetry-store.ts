import type { ModelCallRecord, SessionEvent } from "@token-streaming/protocol";
import { SessionHistoryStore, type SessionHistorySummary } from "./session-history-store.js";

export interface ModelTelemetrySummary {
  totalSessions: number;
  completedSessions: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalResponseCharacters: number;
  failedSessions: number;
  runningSessions: number;
  failureRate: number;
  byProvider: ModelTelemetryGroup[];
  byModel: ModelTelemetryGroup[];
  byMode: ModelTelemetryGroup[];
  byPurpose: ModelTelemetryGroup[];
  byFailureCategory: FailureTelemetryGroup[];
  recommendations: ModelTelemetryRecommendation[];
}

export interface ModelTelemetryGroup {
  key: string;
  sessions: number;
  failedSessions: number;
  failureRate: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  responseCharacters: number;
}

export interface ModelTelemetryRecommendation {
  key: string;
  model: string;
  provider: string;
  mode: string;
  purpose: string;
  taskKind: string;
  sessions: number;
  calls: number;
  failedSessions: number;
  failureRate: number;
  averageTokens: number;
  averageResponseCharacters: number;
  efficiencyScore: number;
  confidence: "low" | "medium" | "high";
  recommendation: "prefer" | "watch" | "avoid";
  reasons: string[];
}

interface ModelCallWithSession {
  call: ModelCallRecord;
  session: SessionHistorySummary;
}

export interface FailureTelemetryGroup {
  key: string;
  sessions: number;
}

export class TelemetryStore {
  private readonly sessions: SessionHistoryStore;

  constructor(repoRoot: string) {
    this.sessions = new SessionHistoryStore(repoRoot);
  }

  async summarizeModelCalls(): Promise<ModelTelemetrySummary> {
    const sessions = await this.sessions.list();
    const calls = await this.readModelCalls(sessions);
    const failedSessions = sessions.filter((session) => session.status === "failed").length;
    return {
      totalSessions: sessions.length,
      completedSessions: sessions.filter((session) => session.status === "completed").length,
      totalCalls: calls.length,
      totalInputTokens: sum(calls, "inputTokens"),
      totalOutputTokens: sum(calls, "outputTokens"),
      totalResponseCharacters: sum(calls, "responseCharacters"),
      failedSessions,
      runningSessions: sessions.filter((session) => session.status === "running").length,
      failureRate: sessions.length ? failedSessions / sessions.length : 0,
      byProvider: groupCalls(calls, (entry) => entry.call.provider),
      byModel: groupCalls(calls, (entry) => entry.call.model ?? "unknown"),
      byMode: groupCalls(calls, (entry) => entry.call.mode),
      byPurpose: groupCalls(calls, (entry) => entry.call.purpose),
      byFailureCategory: groupFailures(sessions),
      recommendations: buildModelRecommendations(calls)
    };
  }

  private async readModelCalls(sessions: SessionHistorySummary[]): Promise<ModelCallWithSession[]> {
    const eventGroups = await Promise.all(sessions.map((summary) => this.sessions.read(summary.sessionId)));
    return eventGroups.flatMap((events, index) => {
      const session = sessions[index];
      if (!session) {
        return [];
      }
      return events
        .filter((event): event is Extract<SessionEvent, { type: "model.called" }> => event.type === "model.called")
        .map((event) => ({ call: event.call, session }));
    });
  }
}

function groupFailures(sessions: SessionHistorySummary[]): FailureTelemetryGroup[] {
  const groups = new Map<string, FailureTelemetryGroup>();
  for (const session of sessions) {
    if (session.status !== "failed") {
      continue;
    }
    const key = session.failureCategory ?? "unknown";
    const group = groups.get(key) ?? { key, sessions: 0 };
    group.sessions += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => right.sessions - left.sessions || left.key.localeCompare(right.key));
}

function groupCalls(calls: ModelCallWithSession[], keyOf: (entry: ModelCallWithSession) => string): ModelTelemetryGroup[] {
  const groups = new Map<string, ModelTelemetryGroup & { sessionIds: Set<string>; failedSessionIds: Set<string> }>();
  for (const entry of calls) {
    const key = keyOf(entry);
    const group =
      groups.get(key) ??
      {
        key,
        sessions: 0,
        failedSessions: 0,
        failureRate: 0,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        responseCharacters: 0,
        sessionIds: new Set<string>(),
        failedSessionIds: new Set<string>()
      };
    group.calls += 1;
    group.inputTokens += entry.call.inputTokens ?? 0;
    group.outputTokens += entry.call.outputTokens ?? 0;
    group.responseCharacters += entry.call.responseCharacters;
    group.sessionIds.add(entry.session.sessionId);
    if (entry.session.status === "failed") {
      group.failedSessionIds.add(entry.session.sessionId);
    }
    groups.set(key, group);
  }

  return [...groups.values()]
    .map(({ sessionIds, failedSessionIds, ...group }) => ({
      ...group,
      sessions: sessionIds.size,
      failedSessions: failedSessionIds.size,
      failureRate: sessionIds.size ? failedSessionIds.size / sessionIds.size : 0
    }))
    .sort((left, right) => right.calls - left.calls || left.key.localeCompare(right.key));
}

function sum(calls: ModelCallWithSession[], key: "inputTokens" | "outputTokens" | "responseCharacters"): number {
  return calls.reduce((total, entry) => total + (entry.call[key] ?? 0), 0);
}

function buildModelRecommendations(calls: ModelCallWithSession[]): ModelTelemetryRecommendation[] {
  const groups = new Map<
    string,
    {
      model: string;
      provider: string;
      mode: string;
      purpose: string;
      taskKind: string;
      calls: number;
      totalTokens: number;
      responseCharacters: number;
      sessionIds: Set<string>;
      failedSessionIds: Set<string>;
    }
  >();

  for (const entry of calls) {
    const model = entry.call.model ?? "unknown";
    const provider = entry.call.provider;
    const mode = entry.call.mode;
    const purpose = entry.call.purpose;
    const taskKind = inferTaskKind(entry.session.task);
    const key = [mode, purpose, taskKind, provider, model].join(":");
    const group =
      groups.get(key) ??
      {
        model,
        provider,
        mode,
        purpose,
        taskKind,
        calls: 0,
        totalTokens: 0,
        responseCharacters: 0,
        sessionIds: new Set<string>(),
        failedSessionIds: new Set<string>()
      };
    group.calls += 1;
    group.totalTokens += (entry.call.inputTokens ?? 0) + (entry.call.outputTokens ?? 0);
    group.responseCharacters += entry.call.responseCharacters;
    group.sessionIds.add(entry.session.sessionId);
    if (entry.session.status === "failed") {
      group.failedSessionIds.add(entry.session.sessionId);
    }
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const sessions = group.sessionIds.size;
      const failedSessions = group.failedSessionIds.size;
      const failureRate = sessions ? failedSessions / sessions : 0;
      const averageTokens = group.calls ? group.totalTokens / group.calls : 0;
      const averageResponseCharacters = group.calls ? group.responseCharacters / group.calls : 0;
      const efficiencyScore = scoreEfficiency(failureRate, averageTokens, averageResponseCharacters);
      return {
        key,
        model: group.model,
        provider: group.provider,
        mode: group.mode,
        purpose: group.purpose,
        taskKind: group.taskKind,
        sessions,
        calls: group.calls,
        failedSessions,
        failureRate,
        averageTokens: Number(averageTokens.toFixed(1)),
        averageResponseCharacters: Number(averageResponseCharacters.toFixed(1)),
        efficiencyScore,
        confidence: confidenceForSessions(sessions),
        recommendation: recommendationForScore(efficiencyScore, failureRate),
        reasons: buildRecommendationReasons(sessions, failureRate, averageTokens, averageResponseCharacters, efficiencyScore)
      } satisfies ModelTelemetryRecommendation;
    })
    .sort((left, right) => right.efficiencyScore - left.efficiencyScore || right.calls - left.calls || left.key.localeCompare(right.key));
}

function inferTaskKind(task: string | undefined): string {
  const normalized = task?.toLowerCase() ?? "";
  if (!normalized) {
    return "unknown";
  }
  if (/\b(test|failing|failure|ci|verify|spec)\b/.test(normalized)) {
    return "test-fix";
  }
  if (/\b(refactor|cleanup|rewrite|architecture|design)\b/.test(normalized)) {
    return "refactor";
  }
  if (/\b(explain|summarize|understand|inspect|review)\b/.test(normalized)) {
    return "understanding";
  }
  if (/\b(add|implement|build|create|feature)\b/.test(normalized)) {
    return "feature";
  }
  if (/\b(fix|bug|patch|repair)\b/.test(normalized)) {
    return "bugfix";
  }
  return "general";
}

function scoreEfficiency(failureRate: number, averageTokens: number, averageResponseCharacters: number): number {
  const reliability = Math.max(0, 1 - failureRate);
  const tokenEfficiency = averageTokens > 0 ? 1 / (1 + averageTokens / 4_000) : 0.55;
  const responseEfficiency = averageResponseCharacters > 0 ? 1 / (1 + averageResponseCharacters / 12_000) : 0.55;
  const score = reliability * 0.68 + tokenEfficiency * 0.2 + responseEfficiency * 0.12;
  return Number(score.toFixed(4));
}

function confidenceForSessions(sessions: number): ModelTelemetryRecommendation["confidence"] {
  if (sessions >= 20) {
    return "high";
  }
  if (sessions >= 5) {
    return "medium";
  }
  return "low";
}

function recommendationForScore(score: number, failureRate: number): ModelTelemetryRecommendation["recommendation"] {
  if (failureRate >= 0.5 || score < 0.55) {
    return "avoid";
  }
  if (score >= 0.78 && failureRate <= 0.2) {
    return "prefer";
  }
  return "watch";
}

function buildRecommendationReasons(
  sessions: number,
  failureRate: number,
  averageTokens: number,
  averageResponseCharacters: number,
  efficiencyScore: number
): string[] {
  const reasons = [
    `Observed in ${sessions} session${sessions === 1 ? "" : "s"}.`,
    `Failure rate ${Math.round(failureRate * 100)}%; efficiency score ${efficiencyScore}.`
  ];
  if (averageTokens > 0) {
    reasons.push(`Average tokens per call ${Math.round(averageTokens)}.`);
  } else {
    reasons.push("Token usage unavailable; response length is used as a weak cost proxy.");
  }
  reasons.push(`Average response characters ${Math.round(averageResponseCharacters)}.`);
  return reasons;
}

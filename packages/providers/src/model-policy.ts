import type { ProductMode, RepoManifest } from "@token-streaming/protocol";
import type { ProviderName } from "./factory.js";

export interface ModelSelectionInput {
  mode: ProductMode;
  requestedProvider?: ProviderName;
  requestedModel?: string;
  environmentModel?: string;
  manifest?: Pick<RepoManifest, "models">;
  telemetry?: ModelRoutingTelemetry;
  riskLevel?: "low" | "medium" | "high";
  task?: string;
}

export interface ModelSelection {
  provider: ProviderName;
  model?: string;
  source: "cli" | "environment" | "manifest" | "provider-default" | "scored";
  scoring?: ModelRoutingDecision;
}

export interface ModelRoutingTelemetry {
  byModel?: Array<{
    key: string;
    failureRate: number;
    calls: number;
  }>;
  recommendations?: Array<{
    model: string;
    provider: string;
    mode: string;
    purpose: string;
    taskKind: string;
    confidence: "low" | "medium" | "high";
    recommendation: "prefer" | "watch" | "avoid";
    efficiencyScore: number;
    failureRate: number;
    sessions: number;
  }>;
}

export interface ModelCandidate {
  model: string;
  provider: ProviderName;
  quality: number;
  cost: number;
  latency: number;
  tags: string[];
  source: "manifest-candidate" | "legacy-mode-field";
}

export interface ScoredModelCandidate extends ModelCandidate {
  score: number;
  failureRate: number;
  feedback?: {
    taskKind: string;
    recommendation: "prefer" | "watch" | "avoid";
    confidence: "low" | "medium" | "high";
    efficiencyScore: number;
    sessions: number;
  };
  reasons: string[];
}

export interface ModelRoutingDecision {
  objective: "cost" | "balanced" | "quality";
  riskLevel: "low" | "medium" | "high";
  taskKind: string;
  candidates: ScoredModelCandidate[];
  selected?: ScoredModelCandidate;
}

export function resolveModelSelection(input: ModelSelectionInput): ModelSelection {
  if (input.requestedModel) {
    return {
      provider: input.requestedProvider ?? "auto",
      model: input.requestedModel,
      source: "cli"
    };
  }

  const environmentModel = stringValue(input.environmentModel);
  if (environmentModel) {
    return {
      provider: input.requestedProvider ?? "auto",
      model: environmentModel,
      source: "environment"
    };
  }

  const policy = input.manifest?.models ?? {};
  const scored = scoreModelCandidates({
    mode: input.mode,
    requestedProvider: input.requestedProvider,
    manifest: input.manifest,
    telemetry: input.telemetry,
    riskLevel: input.riskLevel,
    task: input.task
  });
  if (scored.selected) {
    return {
      provider: input.requestedProvider ?? scored.selected.provider,
      model: scored.selected.model,
      source: "scored",
      scoring: scored
    };
  }

  const model = stringValue(policy[`${input.mode}_model`]) ?? stringValue(policy.default_model);

  if (model) {
    return {
      provider: input.requestedProvider ?? readProvider(policy.default_provider),
      model,
      source: "manifest",
      ...(scored.candidates.length ? { scoring: scored } : {})
    };
  }

  return {
    provider: input.requestedProvider ?? readProvider(policy.default_provider),
    source: "provider-default",
    ...(scored.candidates.length ? { scoring: scored } : {})
  };
}

export function scoreModelCandidates(input: ModelSelectionInput): ModelRoutingDecision {
  const objective = objectiveForMode(input.mode);
  const riskLevel = input.riskLevel ?? "medium";
  const taskKind = inferTaskKind(input.task);
  const candidates = parseModelCandidates(input.manifest?.models, input.requestedProvider);
  const scored = candidates
    .map((candidate) => scoreCandidate(candidate, input.mode, objective, riskLevel, taskKind, input.telemetry))
    .sort((left, right) => right.score - left.score || left.model.localeCompare(right.model));

  return {
    objective,
    riskLevel,
    taskKind,
    candidates: scored,
    selected: scored[0]
  };
}

function parseModelCandidates(models: Pick<RepoManifest, "models">["models"], requestedProvider?: ProviderName): ModelCandidate[] {
  const policy = models ?? {};
  const explicit = stringArray(policy.model_candidates).map(parseCandidateSpec).filter((candidate): candidate is ModelCandidate => candidate !== undefined);
  const legacy = [
    legacyCandidate(policy.economy_model, "economy"),
    legacyCandidate(policy.auto_model, "auto"),
    legacyCandidate(policy.max_model, "max"),
    legacyCandidate(policy.default_model, "default")
  ].filter((candidate): candidate is ModelCandidate => candidate !== undefined);
  const byModel = new Map<string, ModelCandidate>();

  for (const candidate of [...legacy, ...explicit]) {
    const provider = requestedProvider ?? candidate.provider;
    byModel.set(`${provider}:${candidate.model}`, { ...candidate, provider });
  }

  return [...byModel.values()];
}

function parseCandidateSpec(value: string): ModelCandidate | undefined {
  const [modelPart, ...parts] = value.split(";").map((part) => part.trim()).filter(Boolean);
  if (!modelPart) {
    return undefined;
  }

  const fields = new Map<string, string>();
  for (const part of parts) {
    const [key, ...rawValue] = part.split("=");
    if (key && rawValue.length) {
      fields.set(key.trim(), rawValue.join("=").trim());
    }
  }

  return {
    model: modelPart,
    provider: readProvider(fields.get("provider")),
    quality: boundedNumber(fields.get("quality"), 0.7),
    cost: boundedNumber(fields.get("cost"), 0.5),
    latency: boundedNumber(fields.get("latency"), 0.5),
    tags: fields.get("tags")?.split(",").map((tag) => tag.trim()).filter(Boolean) ?? [],
    source: "manifest-candidate"
  };
}

function legacyCandidate(value: unknown, mode: string): ModelCandidate | undefined {
  const model = stringValue(value);
  if (!model) {
    return undefined;
  }
  return {
    model,
    provider: "auto",
    quality: mode === "max" ? 0.9 : mode === "economy" ? 0.62 : 0.78,
    cost: mode === "economy" ? 0.25 : mode === "max" ? 0.85 : 0.55,
    latency: mode === "economy" ? 0.3 : mode === "max" ? 0.75 : 0.5,
    tags: [mode],
    source: "legacy-mode-field"
  };
}

function scoreCandidate(
  candidate: ModelCandidate,
  mode: ProductMode,
  objective: ModelRoutingDecision["objective"],
  riskLevel: ModelRoutingDecision["riskLevel"],
  taskKind: string,
  telemetry: ModelRoutingTelemetry | undefined
): ScoredModelCandidate {
  const failureRate = telemetry?.byModel?.find((group) => group.key === candidate.model)?.failureRate ?? 0;
  const feedback = findRecommendation(candidate, mode, taskKind, telemetry);
  const weights =
    objective === "cost"
      ? { quality: 0.28, cost: 0.42, latency: 0.18, reliability: 0.12 }
      : objective === "quality"
        ? { quality: 0.52, cost: 0.12, latency: 0.12, reliability: 0.24 }
        : { quality: 0.4, cost: 0.24, latency: 0.14, reliability: 0.22 };
  const riskBoost = riskLevel === "high" ? 0.12 : riskLevel === "medium" ? 0.06 : 0;
  const affinityBoost = modeAffinity(candidate, mode);
  const feedbackBoost = feedbackBoostFor(feedback);
  const reliability = Math.max(0, 1 - failureRate);
  const score =
    candidate.quality * (weights.quality + riskBoost) +
    (1 - candidate.cost) * weights.cost +
    (1 - candidate.latency) * weights.latency +
    reliability * (weights.reliability + riskBoost) +
    affinityBoost +
    feedbackBoost;

  return {
    ...candidate,
    failureRate,
    score: Number(score.toFixed(4)),
    ...(feedback
      ? {
          feedback: {
            taskKind: feedback.taskKind,
            recommendation: feedback.recommendation,
            confidence: feedback.confidence,
            efficiencyScore: feedback.efficiencyScore,
            sessions: feedback.sessions
          }
        }
      : {}),
    reasons: buildScoreReasons(candidate, mode, objective, riskLevel, taskKind, failureRate, affinityBoost, feedback, feedbackBoost)
  };
}

function findRecommendation(
  candidate: ModelCandidate,
  mode: ProductMode,
  taskKind: string,
  telemetry: ModelRoutingTelemetry | undefined
): NonNullable<ModelRoutingTelemetry["recommendations"]>[number] | undefined {
  const recommendations = telemetry?.recommendations ?? [];
  const providerMatches = (recommendation: NonNullable<ModelRoutingTelemetry["recommendations"]>[number]) =>
    recommendation.model === candidate.model && (recommendation.provider === candidate.provider || candidate.provider === "auto");
  const planningMatches = recommendations.filter((recommendation) => providerMatches(recommendation) && recommendation.purpose === "planning");
  return (
    planningMatches.find((recommendation) => recommendation.mode === mode && recommendation.taskKind === taskKind) ??
    planningMatches.find((recommendation) => recommendation.mode === mode && recommendation.taskKind === "general") ??
    planningMatches.find((recommendation) => recommendation.mode === mode) ??
    planningMatches.find((recommendation) => recommendation.taskKind === taskKind) ??
    planningMatches[0]
  );
}

function feedbackBoostFor(feedback: NonNullable<ModelRoutingTelemetry["recommendations"]>[number] | undefined): number {
  if (!feedback) {
    return 0;
  }
  const confidenceWeight = feedback.confidence === "high" ? 1 : feedback.confidence === "medium" ? 0.7 : 0.4;
  const direction = feedback.recommendation === "prefer" ? 1 : feedback.recommendation === "avoid" ? -1 : 0;
  const scoreComponent = (feedback.efficiencyScore - 0.65) * 0.18;
  return Number(((direction * 0.12 + scoreComponent) * confidenceWeight).toFixed(4));
}

function modeAffinity(candidate: ModelCandidate, mode: ProductMode): number {
  const tags = new Set(candidate.tags.map((tag) => tag.toLowerCase()));
  if (mode === "economy" && (tags.has("economy") || tags.has("cheap") || tags.has("fast"))) {
    return 0.08;
  }
  if (mode === "max" && (tags.has("max") || tags.has("strong") || tags.has("quality"))) {
    return 0.08;
  }
  if (mode === "auto" && (tags.has("auto") || tags.has("balanced"))) {
    return 0.08;
  }
  return 0;
}

function buildScoreReasons(
  candidate: ModelCandidate,
  mode: ProductMode,
  objective: ModelRoutingDecision["objective"],
  riskLevel: ModelRoutingDecision["riskLevel"],
  taskKind: string,
  failureRate: number,
  affinityBoost: number,
  feedback: NonNullable<ModelRoutingTelemetry["recommendations"]>[number] | undefined,
  feedbackBoost: number
): string[] {
  const reasons = [`Objective=${objective}; risk=${riskLevel}; taskKind=${taskKind}.`];
  reasons.push(`quality=${candidate.quality}, cost=${candidate.cost}, latency=${candidate.latency}.`);
  reasons.push(failureRate > 0 ? `Historical failure rate=${Math.round(failureRate * 100)}%.` : "No historical failures recorded for this model.");
  if (affinityBoost > 0) {
    reasons.push(`Mode affinity boost applied for ${mode}.`);
  }
  if (feedback) {
    reasons.push(
      `Telemetry recommendation=${feedback.recommendation} for ${feedback.mode}/${feedback.purpose}/${feedback.taskKind} with ${feedback.confidence} confidence; feedbackBoost=${feedbackBoost}.`
    );
  }
  if (candidate.tags.length) {
    reasons.push(`Tags: ${candidate.tags.join(", ")}.`);
  }
  return reasons;
}

function objectiveForMode(mode: ProductMode): ModelRoutingDecision["objective"] {
  if (mode === "economy") {
    return "cost";
  }
  if (mode === "max") {
    return "quality";
  }
  return "balanced";
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

function readProvider(value: unknown): ProviderName {
  if (value === "stub" || value === "openai" || value === "auto") {
    return value;
  }
  return "auto";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function boundedNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, parsed));
}

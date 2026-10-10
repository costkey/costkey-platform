import type { Tone } from "../components/ConsolePrimitives";

/** GET /api/v1/projects/:id/quality/scores */
export interface QualityScoreRun {
  name: string;
  count: number;
  runs: number;
  avg: number | null;
  p10: number | null;
  passRate: number | null;
}

export interface QualityScore {
  name: string;
  count: number;
  runs: number;
  avg: number | null;
  p10: number | null;
  min: number | null;
  max: number | null;
  passRate: number | null;
  threshold: number | null;
  latest: { value: number | null; label: string | null; timestamp: string | null };
  trend: Array<{ day: string; avg: number | null; count: number }>;
  byRun: QualityScoreRun[];
  scoredRuns: number;
  passingRuns: number;
  scoredCost: number | null;
  costPerPassingRun: number | null;
}

export interface QualityScoresResponse {
  from: string;
  to: string;
  scores: QualityScore[];
}

/** GET /api/v1/projects/:id/quality/reliability */
export interface ReliabilityStats {
  calls: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  p95TtftMs: number | null;
  streams: number;
  errors: number;
  errorRate: number | null;
  retries: number;
  retryRate: number | null;
  cost: number | null;
  wastedCost: number | null;
}

export interface QualityReliabilityResponse {
  from: string;
  to: string;
  totals: ReliabilityStats;
  byModel: Array<ReliabilityStats & { provider: string; model: string }>;
  byAgent: Array<ReliabilityStats & { agent: string; runs: number; failedRuns: number }>;
}

export interface ReliabilityTableRow extends ReliabilityStats {
  key: string;
  name: string;
  secondary: string | null;
}

export function qualityPath(projectId: string, endpoint: "scores" | "reliability", scope: { from: string; to: string; environment?: string | null }): string {
  const params = new URLSearchParams({ from: scope.from, to: scope.to });
  if (scope.environment && scope.environment !== "all") params.set("environment", scope.environment);
  return `/api/v1/projects/${encodeURIComponent(projectId)}/quality/${endpoint}?${params.toString()}`;
}

/** 0.8234 -> "0.82", 4.5 -> "4.5", 87 -> "87". */
export function formatScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  const digits = magnitude < 10 ? 2 : magnitude < 100 ? 1 : 0;
  return Number(value.toFixed(digits)).toString();
}

/** 820 -> "820 ms", 1430 -> "1.4 s", 72000 -> "72 s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

/** A 0..1 ratio as a percent string. */
export function formatRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  const percent = rate * 100;
  if (percent === 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  return `${Number(percent.toFixed(percent < 10 ? 1 : 0))}%`;
}

export function errorTone(rate: number | null | undefined): Tone {
  if (rate == null || rate <= 0) return "neutral";
  if (rate >= 0.05) return "critical";
  return "warn";
}

export function reliabilityRows(data: QualityReliabilityResponse | null, by: "model" | "agent"): ReliabilityTableRow[] {
  if (!data) return [];
  if (by === "agent") {
    return data.byAgent.map((row) => ({ ...row, key: `agent:${row.agent}`, name: row.agent, secondary: row.runs > 0 ? `${row.runs.toLocaleString()} run${row.runs === 1 ? "" : "s"}` : null }));
  }
  return data.byModel.map((row) => ({ ...row, key: `model:${row.provider}:${row.model}`, name: row.model, secondary: row.provider }));
}

/** Points for a sparkline; days without a value are skipped, never zeroed. */
export function trendPoints(score: QualityScore): Array<{ day: string; avg: number }> {
  return score.trend
    .filter((point): point is { day: string; avg: number; count: number } => point.avg != null && Number.isFinite(point.avg))
    .map((point) => ({ day: point.day, avg: point.avg }));
}

import { appUrl } from "./basePath";
import { UNAUTHENTICATED_EVENT, type InsightScope } from "./api";

/** Client for server-side quality checks (judges and rules). */

export type CheckKind = "judge" | "rule";
export type JudgeProvider = "openai" | "anthropic" | "google";
export type RuleId = "run_succeeded" | "tool_errors" | "retries" | "latency" | "cost";
export type CheckStatus = "active" | "paused" | "needs_capture" | "needs_key" | "error";

export interface JudgeTemplate { id: string; name: string; description: string; rubric: string }
export interface RuleDefinition {
  id: RuleId;
  name: string;
  description: string;
  target: null | { unit: "share" | "count" | "seconds" | "usd"; label: string; default: number; min: number; max: number };
}

export interface QualityCheck {
  id: string;
  name: string;
  kind: CheckKind;
  template: string | null;
  rule: RuleId | null;
  target: number | null;
  rubric: string | null;
  judgeProvider: JudgeProvider | null;
  judgeModel: string | null;
  hasKey: boolean;
  keyHint: string | null;
  appliesTo: "all" | "named";
  appliesToNames: string[];
  sampleRate: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QualityCheckWithStats extends QualityCheck {
  status: CheckStatus;
  lastError: string | null;
  stats: {
    scored: number;
    passRate: number | null;
    avg: number | null;
    lastScoredAt: string | null;
    queued: number;
    backfilling: number;
    failed: number;
    needsCapture: number;
  };
}

export interface QualityChecksResponse {
  from: string;
  to: string;
  canManage: boolean;
  textCapture: boolean;
  maxBackfillRuns: number;
  checks: QualityCheckWithStats[];
  templates: JudgeTemplate[];
  rules: RuleDefinition[];
  providers: Array<{ id: JudgeProvider; defaultModel: string }>;
}

export type RunCheckState =
  | "passed" | "failed" | "scored" | "queued" | "error"
  | "needs_capture" | "needs_key" | "no_text" | "not_applicable"
  | "not_sampled" | "paused" | "waiting";

export interface RunCheckResult {
  checkId: string;
  name: string;
  kind: CheckKind;
  state: RunCheckState;
  score: number | null;
  label: string | null;
  reason: string | null;
  detail: string | null;
  evaluatedAt: string | null;
}

export interface CheckPayload {
  name?: string;
  kind?: CheckKind;
  template?: string | null;
  rule?: RuleId;
  target?: number | null;
  rubric?: string;
  judgeProvider?: JudgeProvider;
  judgeModel?: string;
  apiKey?: string | null;
  appliesTo?: "all" | "named";
  appliesToNames?: string[];
  sampleRate?: number;
  enabled?: boolean;
}

export class QualityChecksApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "QualityChecksApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(appUrl(`/api/v1/projects/${path}`), {
    method: init.method ?? "GET",
    credentials: "include",
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (response.status === 401) window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const message = typeof payload?.["error"] === "string" ? payload["error"] : `Request failed (${response.status})`;
    throw new QualityChecksApiError(message, response.status);
  }
  return payload as T;
}

const project = (projectId: string) => encodeURIComponent(projectId);

export function getQualityChecks(projectId: string, scope: InsightScope): Promise<QualityChecksResponse> {
  const params = new URLSearchParams({ from: scope.from, to: scope.to });
  return request(`${project(projectId)}/quality/checks?${params.toString()}`);
}

export function createQualityCheck(projectId: string, body: CheckPayload): Promise<{ check: QualityCheck }> {
  return request(`${project(projectId)}/quality/checks`, { method: "POST", body });
}

export function updateQualityCheck(projectId: string, checkId: string, body: CheckPayload): Promise<{ check: QualityCheck }> {
  return request(`${project(projectId)}/quality/checks/${encodeURIComponent(checkId)}`, { method: "PATCH", body });
}

export function deleteQualityCheck(projectId: string, checkId: string): Promise<void> {
  return request(`${project(projectId)}/quality/checks/${encodeURIComponent(checkId)}`, { method: "DELETE" });
}

export function backfillQualityCheck(projectId: string, checkId: string): Promise<{ queued: number }> {
  return request(`${project(projectId)}/quality/checks/${encodeURIComponent(checkId)}/backfill`, { method: "POST", body: {} });
}

export function getRunQualityChecks(projectId: string, traceId: string): Promise<{ traceId: string; results: RunCheckResult[] }> {
  return request(`${project(projectId)}/quality/runs/${encodeURIComponent(traceId)}/checks`);
}

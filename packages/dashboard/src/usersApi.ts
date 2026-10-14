import { UNAUTHENTICATED_EVENT, type InsightScope, type RunRetry, type TokenUsage } from "./api";
import { appUrl } from "./basePath";

/** One end user of the app: the id its calls send as context.customer, userId, user_id or customerId. */
export interface UserRow {
  userId: string;
  runs: number;
  calls: number;
  cost: number | null;
  usage: TokenUsage;
  /** Units billed besides tokens: { characters: 907 }. */
  units: Record<string, number>;
  /** Top 3 agents and workflows by spend. */
  agents: string[];
  lastRun: string | null;
}

export interface UsersList {
  users: UserRow[];
  totals: { runs: number; runsWithoutUser: number; cost: number | null };
}

export interface UserRun {
  traceId: string;
  /** The agent's name, or the workflow's. */
  name: string;
  kind: "agent" | "workflow";
  startedAt: string | null;
  cost: number | null;
  calls: number;
  durationMs: number | null;
  failed: boolean;
  retry: RunRetry;
  usage: TokenUsage;
}

export interface UserDetail {
  userId: string;
  window: { from: string; to: string; environment: string | null; timezone: string; bucket: "day" };
  summary: {
    runs: number;
    failedRuns: number;
    retriedRuns: number;
    calls: number;
    cost: number | null;
    usage: TokenUsage;
    units: Record<string, number>;
    firstRun: string | null;
    lastRun: string | null;
  };
  /** Every day in the window, workspace time zone, zero-filled. */
  series: Array<{ bucket: string; cost: number; runs: number }>;
  owners: Array<{ kind: "agent" | "workflow"; name: string; runs: number; cost: number | null }>;
  models: Array<{ provider: string | null; model: string; calls: number; cost: number | null; usage: TokenUsage; units: Record<string, number> }>;
  /** The latest 50 runs. */
  runs: UserRun[];
}

function scopeQuery(scope: InsightScope): URLSearchParams {
  const params = new URLSearchParams({ from: scope.from, to: scope.to });
  if (scope.environment && scope.environment !== "all") params.set("environment", scope.environment);
  return params;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(appUrl(path), { credentials: "include" });
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export function getUsers(projectId: string, scope: InsightScope, q?: string): Promise<UsersList> {
  const params = scopeQuery(scope);
  if (q && q.trim()) params.set("q", q.trim());
  return get(`/api/v1/projects/${encodeURIComponent(projectId)}/users?${params.toString()}`);
}

export function getUserDetail(projectId: string, userId: string, scope: InsightScope): Promise<UserDetail> {
  const params = scopeQuery(scope);
  params.set("user", userId);
  return get(`/api/v1/projects/${encodeURIComponent(projectId)}/users/detail?${params.toString()}`);
}

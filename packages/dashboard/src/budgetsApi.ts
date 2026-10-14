import { appUrl } from "./basePath";

export type BudgetHealth = "on_track" | "at_risk" | "over" | "paused" | "no_data";
export type BudgetUnit = "money" | "calls" | "tokens";
export type BudgetWindow = "per_trace" | "per_execution" | "per_call" | "calendar_minute" | "calendar_day" | "calendar_month";

/** A budget with what it has used and where it is heading by the end of its period. */
export interface Budget {
  id: string;
  projectId?: string;
  name: string | null;
  scope: Record<string, string | string[]>;
  mode: "monitor" | "enforce";
  status: "active" | "paused" | "archived";
  unit: BudgetUnit;
  allowance: number;
  currency: "USD" | "INR" | null;
  window: BudgetWindow;
  timezone?: string;
  usdToPolicyCurrency?: number | null;
  usage?: { observed?: number | null; committed?: number | null; overLimit?: number | null } | null;
  /** Missing on legacy rules and on servers that predate forecasts. */
  forecast?: { periodStart: string | null; periodEnd: string | null; projected: number | null; health: BudgetHealth } | null;
}

export type ScopeNameKind = "agent" | "workflow" | "feature" | "model" | "customer";
export type ScopeNames = Record<ScopeNameKind, string[]>;

export interface SpendPoint {
  /** "2026-10-04" for a day or "2026-10" for a month, in the workspace time zone. */
  key: string;
  /** Known spend in USD. */
  cost: number;
  calls: number;
  unpriced: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(appUrl(`/api/v1${path}`), { credentials: "include", ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(response.status === 403 ? "Only Owners and Admins can change budgets." : body?.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export async function listBudgets(projectId: string): Promise<Budget[]> {
  const result = await request<{ policies?: Budget[] }>(`/projects/${encodeURIComponent(projectId)}/budget/policies`);
  return result.policies ?? [];
}

/** Deleting keeps the budget's history; it stops checking calls and leaves the list. */
export async function deleteBudget(projectId: string, budgetId: string): Promise<void> {
  await request(`/projects/${encodeURIComponent(projectId)}/budget/policies/${encodeURIComponent(budgetId)}`, { method: "DELETE" });
}

export async function getScopeNames(projectId: string): Promise<ScopeNames> {
  const result = await request<{ names?: Partial<ScopeNames> }>(`/projects/${encodeURIComponent(projectId)}/budget/scope-names`);
  return { agent: [], workflow: [], feature: [], model: [], customer: [], ...result.names };
}

export async function getSpendSeries(projectId: string, input: { from: string; to: string; bucket: "day" | "month"; environment?: string }): Promise<{ timezone: string; bucket: "day" | "month"; points: SpendPoint[] }> {
  const params = new URLSearchParams({ from: input.from, to: input.to, bucket: input.bucket });
  if (input.environment && input.environment !== "all") params.set("environment", input.environment);
  return request(`/projects/${encodeURIComponent(projectId)}/budget/spend-series?${params.toString()}`);
}

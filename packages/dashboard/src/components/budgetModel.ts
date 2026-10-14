import type { Budget, BudgetHealth, BudgetWindow } from "../budgetsApi";
import type { Tone } from "./ConsolePrimitives";
import { formatCurrencyAmount } from "./consoleFormatters";
import { compactNumber } from "./overviewBoardModel";

/** What a budget can cover, in the order the editor offers them. */
export const SCOPE_DIMENSIONS = ["project", "agent", "workflow", "feature", "model", "customer", "function", "provider", "tool", "user", "group"] as const;
export type BudgetDimension = typeof SCOPE_DIMENSIONS[number];

export const DIMENSION_LABEL: Record<BudgetDimension, string> = {
  project: "Whole project",
  agent: "Agent",
  workflow: "Workflow",
  feature: "Feature",
  model: "Model",
  customer: "Customer",
  function: "Function",
  provider: "Provider",
  tool: "Tool",
  user: "User",
  group: "Experiment",
};

const WINDOW_LABEL: Record<BudgetWindow, string> = {
  calendar_month: "Monthly",
  calendar_day: "Daily",
  calendar_minute: "Per minute",
  per_trace: "Per run",
  per_execution: "Per batch",
  per_call: "Per call",
};

export function periodText(window: string): string {
  return WINDOW_LABEL[window as BudgetWindow] ?? window;
}

function values(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** The dimensions a budget is limited to; an empty list means the whole project. */
export function budgetScope(budget: Pick<Budget, "scope">): Array<{ dimension: BudgetDimension; values: string[] }> {
  return Object.entries(budget.scope ?? {})
    .filter(([key, value]) => key !== "project" && values(value).length > 0)
    .map(([key, value]) => ({ dimension: (SCOPE_DIMENSIONS as readonly string[]).includes(key) ? key as BudgetDimension : "feature", values: values(value) }));
}

/** "search, answer +1": a group shows its first two values. */
export function valuesText(list: string[]): string {
  return list.length > 2 ? `${list.slice(0, 2).join(", ")} +${list.length - 2}` : list.join(", ");
}

/** "Whole project", or "Agent: support-agent". */
export function coversText(budget: Pick<Budget, "scope">): { kind: string; value: string | null } {
  const scope = budgetScope(budget);
  if (scope.length === 0) return { kind: DIMENSION_LABEL.project, value: null };
  return { kind: scope.map((item) => DIMENSION_LABEL[item.dimension]).join(" and "), value: scope.map((item) => valuesText(item.values)).join(" · ") };
}

/** Health from the server forecast, or from usage alone on an older server. */
export function budgetHealth(budget: Budget): BudgetHealth {
  if (budget.status === "paused" || budget.status === "archived") return "paused";
  if (budget.forecast?.health) return budget.forecast.health;
  const used = budget.usage?.observed;
  if (used == null) return "no_data";
  const allowance = Number(budget.allowance) || 0;
  if (used >= allowance) return "over";
  return used >= allowance * 0.8 ? "at_risk" : "on_track";
}

const HEALTH_ORDER: Record<BudgetHealth, number> = { over: 0, at_risk: 1, on_track: 2, no_data: 3, paused: 4 };

export function healthView(budget: Budget): { health: BudgetHealth; tone: Tone; label: string } {
  const health = budgetHealth(budget);
  if (health === "over") return { health, tone: "critical", label: "Over" };
  if (health === "at_risk") return { health, tone: "warn", label: "At risk" };
  if (health === "on_track") return { health, tone: "good", label: "On track" };
  if (health === "paused") return { health, tone: "neutral", label: "Paused" };
  const perRun = budget.window === "per_trace" || budget.window === "per_execution";
  return { health, tone: "neutral", label: perRun ? "Each run" : "No usage yet" };
}

/** What happens at the limit. */
export function actionText(budget: Pick<Budget, "mode">): { label: string; detail: string } {
  return budget.mode === "enforce"
    ? { label: "Kill switch", detail: "Stops new calls" }
    : { label: "Alert only", detail: "Calls keep going" };
}

/** A limit or usage figure in the budget's own unit and currency. */
export function formatBudgetAmount(budget: Pick<Budget, "unit" | "currency">, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  if (budget.unit === "money") return formatCurrencyAmount(Number(value), budget.currency ?? "USD");
  const count = Number(value);
  const text = count >= 10_000 ? compactNumber(count) : Math.round(count).toLocaleString("en-US");
  return `${text} ${budget.unit === "calls" ? (count === 1 ? "call" : "calls") : "tokens"}`;
}

/** Share of the limit used, from 0 (nothing) up; null when unknown. */
export function usedShare(budget: Budget): number | null {
  const used = budget.usage?.observed;
  const allowance = Number(budget.allowance) || 0;
  if (used == null || allowance <= 0) return null;
  return Math.max(0, used / allowance);
}

/** Every budget still in force, the most urgent first. */
export function sortBudgets(budgets: Budget[]): Budget[] {
  return budgets
    .filter((budget) => budget.status !== "archived")
    .slice()
    .sort((a, b) => HEALTH_ORDER[budgetHealth(a)] - HEALTH_ORDER[budgetHealth(b)] || (usedShare(b) ?? -1) - (usedShare(a) ?? -1) || (a.name ?? "").localeCompare(b.name ?? ""));
}

function globMatch(pattern: string, value: string): boolean {
  if (!/[*?]/.test(pattern)) return pattern === value;
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`, "i").test(value);
}

/** The budgets that cover exactly this agent, workflow, feature, model or customer; most urgent first. */
export function budgetsFor(budgets: Budget[], dimension: BudgetDimension, name: string): Budget[] {
  return sortBudgets(budgets).filter((budget) => {
    const scope = budgetScope(budget);
    return scope.length === 1 && scope[0].dimension === dimension && scope[0].values.some((value) => globMatch(value, name));
  });
}

/** Whole-project money budgets (the line on the spend chart), monthly first. */
export function projectMoneyBudget(budgets: Budget[]): Budget | null {
  const candidates = budgets.filter((budget) => budget.status === "active" && budget.unit === "money" && budgetScope(budget).length === 0 && (budget.window === "calendar_month" || budget.window === "calendar_day"));
  return candidates.find((budget) => budget.window === "calendar_month") ?? candidates[0] ?? null;
}

/** A money limit in USD, the unit spend is reported in; null when the rate is unknown. */
export function limitInUsd(budget: Pick<Budget, "unit" | "currency" | "allowance" | "usdToPolicyCurrency">): number | null {
  if (budget.unit !== "money") return null;
  if ((budget.currency ?? "USD") === "USD") return Number(budget.allowance);
  const rate = Number(budget.usdToPolicyCurrency);
  return rate > 0 ? Number(budget.allowance) / rate : null;
}

/** Counts by health for a glance: "2 at risk, 1 over". */
export function healthCounts(budgets: Budget[]): Record<BudgetHealth, number> {
  const counts: Record<BudgetHealth, number> = { over: 0, at_risk: 0, on_track: 0, no_data: 0, paused: 0 };
  for (const budget of budgets) if (budget.status !== "archived") counts[budgetHealth(budget)] += 1;
  return counts;
}

export function budgetDetailHref(projectId: string, budgetId: string): string {
  return `/policy?id=${encodeURIComponent(budgetId)}&project=${encodeURIComponent(projectId)}`;
}

/** The editor: an existing budget, or a new one, optionally scoped to one name. */
export function budgetEditorHref(projectId: string, options: { id?: string; dimension?: BudgetDimension; name?: string } = {}): string {
  const params = new URLSearchParams({ project: projectId });
  if (options.id) params.set("id", options.id);
  if (options.dimension && options.dimension !== "project") params.set("scopeDimension", options.dimension);
  if (options.name) params.set("scopeValue", options.name);
  return `/policy-edit?${params.toString()}`;
}

/** "31 Oct": the last day of a period that ends at `periodEnd` (exclusive), in the workspace time zone. */
export function periodLastDay(periodEnd: string | null | undefined, timezone?: string): string | null {
  if (!periodEnd) return null;
  const end = new Date(periodEnd);
  if (Number.isNaN(end.getTime())) return null;
  try {
    return new Date(end.getTime() - 1).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: timezone });
  } catch {
    return new Date(end.getTime() - 1).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
}

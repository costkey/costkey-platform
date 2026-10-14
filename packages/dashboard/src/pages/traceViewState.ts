export const TRACE_VIEW_FILTER_KEYS = ["provider", "model", "feature", "function", "customer", "environment", "lifecycle", "accounting"] as const;

export type TraceViewTab = "traces" | "calls";
export type TraceViewPeriod = import("../components/consoleFormatters").ConsolePeriod;

export interface TraceViewStateInput {
  tab: TraceViewTab;
  query: string;
  period: TraceViewPeriod;
  from?: string | null;
  to?: string | null;
  sort: string;
  filters: Record<string, string[]>;
}

export interface RestoredTraceView {
  tab: TraceViewTab;
  query: string;
  period: TraceViewPeriod | null;
  from: string | null;
  to: string | null;
  sort: string;
  filters: Record<string, string[]>;
}

export function serializeTraceView(input: TraceViewStateInput): Record<string, unknown> {
  const filters: Record<string, string[]> = {};
  for (const key of TRACE_VIEW_FILTER_KEYS) filters[key] = [...(input.filters[key] ?? [])];
  return { route: "traces", tab: input.tab, query: input.query, period: input.period, from: input.from ?? null, to: input.to ?? null, sort: input.sort, filters };
}

export function restoreTraceView(raw: unknown): RestoredTraceView {
  const definition = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const source = definition["filters"] && typeof definition["filters"] === "object" ? definition["filters"] as Record<string, unknown> : {};
  const filters: Record<string, string[]> = {};
  for (const key of TRACE_VIEW_FILTER_KEYS) {
    const alias = key === "lifecycle" ? "status" : key === "accounting" ? "coverage" : undefined;
    const value = source[key] ?? (alias ? source[alias] ?? definition[alias] : definition[key]);
    filters[key] = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [];
  }
  const period = definition["period"] === "1h" || definition["period"] === "today" || definition["period"] === "24h" || definition["period"] === "mtd" || definition["period"] === "7d" || definition["period"] === "30d" || definition["period"] === "custom" ? definition["period"] as TraceViewPeriod : null;
  return {
    tab: definition["tab"] === "calls" ? "calls" : "traces",
    query: typeof definition["query"] === "string" ? definition["query"] : typeof definition["q"] === "string" ? definition["q"] : "",
    period,
    from: typeof definition["from"] === "string" ? definition["from"] : null,
    to: typeof definition["to"] === "string" ? definition["to"] : null,
    sort: typeof definition["sort"] === "string" ? definition["sort"] : "newest",
    filters,
  };
}

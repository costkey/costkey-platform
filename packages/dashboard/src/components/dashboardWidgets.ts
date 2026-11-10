import type { CostBreakdownResponse, TrendBucket } from "../api";
import type { WidgetMetric, WidgetPeriod, WidgetSpec } from "../dashboardsApi";

/**
 * What a dashboard has to fetch, kept free of React: widgets that need the
 * same data share one request (one /trends per period, one /costs per
 * period and grouping), so a dashboard costs at most a handful of calls.
 */

const PERIOD_MS: Record<WidgetPeriod, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

export interface DataRequest {
  key: string;
  kind: "trends" | "costs";
  period: WidgetPeriod;
  groupBy?: WidgetSpec["groupBy"];
}

export function requestFor(widget: WidgetSpec): DataRequest {
  return widget.kind === "breakdown"
    ? { key: `costs:${widget.period}:${widget.groupBy}`, kind: "costs", period: widget.period, groupBy: widget.groupBy }
    : { key: `trends:${widget.period}`, kind: "trends", period: widget.period };
}

/** The distinct requests a dashboard needs, in first-use order. */
export function requestsFor(widgets: WidgetSpec[]): DataRequest[] {
  const seen = new Map<string, DataRequest>();
  for (const widget of widgets) {
    const request = requestFor(widget);
    if (!seen.has(request.key)) seen.set(request.key, request);
  }
  return [...seen.values()];
}

/** The window a period covers, ending now (rounded to the minute so repeat loads match). */
export function periodRange(period: WidgetPeriod, now = Date.now()): { from: string; to: string; bucket: "hour" | "day" } {
  const end = Math.floor(now / 60_000) * 60_000;
  return { from: new Date(end - PERIOD_MS[period]).toISOString(), to: new Date(end).toISOString(), bucket: period === "24h" ? "hour" : "day" };
}

export function bucketValue(bucket: TrendBucket, metric: WidgetMetric): number {
  if (metric === "cost") return Number(bucket.cost ?? 0);
  if (metric === "calls") return Number(bucket.calls ?? 0);
  return Number(bucket.input_tokens ?? 0) + Number(bucket.output_tokens ?? 0);
}

export function totalOf(trends: TrendBucket[], metric: WidgetMetric): { value: number; unpriced: number } {
  return {
    value: trends.reduce((sum, bucket) => sum + bucketValue(bucket, metric), 0),
    unpriced: metric === "cost" ? trends.reduce((sum, bucket) => sum + Number(bucket.unpriced_count ?? 0), 0) : 0,
  };
}

export interface BreakdownRow { label: string; value: number }

export function breakdownRows(response: CostBreakdownResponse, metric: WidgetMetric, limit = 8): BreakdownRow[] {
  return (response.contributors ?? [])
    .map((row) => ({
      label: String(row.label ?? row.name ?? row.key ?? "Unattributed"),
      value: metric === "calls" ? Number(row.calls ?? row.observations ?? 0) : Number(row.known_cost ?? row.cost ?? 0),
    }))
    .filter((row) => Number.isFinite(row.value))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

export const KIND_LABELS = { total: "Total", trend: "Over time", breakdown: "Breakdown" } as const;
export const METRIC_LABELS = { cost: "Spend", calls: "Calls", tokens: "Tokens" } as const;
export const GROUP_LABELS = { model: "model", provider: "provider", feature: "feature", customer: "customer", function: "function" } as const;
export const PERIOD_LABELS = { "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days" } as const;

/** A title for a widget the user didn't name. */
export function defaultTitle(widget: Pick<WidgetSpec, "kind" | "metric" | "groupBy">): string {
  if (widget.kind === "breakdown") return `${METRIC_LABELS[widget.metric]} by ${GROUP_LABELS[widget.groupBy ?? "model"]}`;
  if (widget.kind === "trend") return `${METRIC_LABELS[widget.metric]} over time`;
  return METRIC_LABELS[widget.metric];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Nov" for a day bucket, "14:00" for an hour bucket. */
export function bucketLabel(bucket: string, hourly: boolean, timeZone?: string): string {
  const date = new Date(bucket);
  if (Number.isNaN(date.getTime())) return bucket;
  if (hourly) {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date);
  }
  const parts = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "numeric", timeZone }).formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  const month = Number(parts.find((part) => part.type === "month")?.value ?? 0);
  return `${day} ${MONTHS[month - 1] ?? ""}`.trim();
}

/** Each row's share of the breakdown's total, for "32%" next to a bar. */
export function withShares(rows: BreakdownRow[]): Array<BreakdownRow & { share: number }> {
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0);
  return rows.map((row) => ({ ...row, share: total > 0 ? Math.max(0, row.value) / total : 0 }));
}

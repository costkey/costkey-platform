import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AlertCircle, ArrowRight } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import {
  getCostBreakdown,
  getForecast,
  getHealth,
  getOverview,
  getQualitySummary,
  getSummary,
  getTraces,
  getTrends,
  type CostContributor,
  type CostDimension,
  type Overview,
  type PipelineHealth,
  type Summary,
  type Trace,
  type TrendBucket,
  type ForecastResponse,
  type FindingResponse,
  type QualitySummary,
} from "../api";
import { formatDuration } from "../utils";
import { findingTitle, findingView } from "../components/findingView";
import { useAuth } from "../contexts/useAuth";
import {
  Delta,
  EmptyPanel,
  LoadingRows,
  MetricCard,
  PageHeader,
  Panel,
  StatusLine,
  StatusPill,
  type Period,
  type Tone,
} from "../components/ConsolePrimitives";
import { PrototypeIcon } from "../components/PrototypeIcon";
import { formatDateTime, formatPercent, formatReportedAmount, parsePeriod, periodDates, periodLabel, type ReportingFx } from "../components/consoleFormatters";
import { prototypeRole, prototypeState, PrototypeStateNotice, PrototypeStatePanel } from "../components/PrototypeState";

interface BudgetPolicySummary {
  id: string;
  name: string | null;
  mode: "monitor" | "enforce" | string;
  status: "active" | "paused" | "archived" | string;
  unit: "money" | "calls" | "tokens" | string;
  allowance: number;
  currency?: string | null;
  window: string;
  scope?: Record<string, string> | null;
  usage?: { observed?: number | null; settled?: number | null; reserved?: number | null; remaining?: number | null; overage?: number | null } | null;
}

interface FindingRow {
  id: string;
  family: string;
  state: string;
  scope: Record<string, unknown>;
  observedAt: string;
  lastSeenAt: string;
  baseline: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
  nextActions: string[];
}

interface OverviewData {
  summary: Summary | null;
  overview: Overview | null;
  trends: TrendBucket[];
  contributors: CostContributor[];
  forecast: ForecastResponse | null;
  health: PipelineHealth | null;
  findings: FindingRow[];
  policies: BudgetPolicySummary[];
  environments: string[];
  recentRuns: Trace[];
  quality: QualitySummary["totals"] | null;
}

const EMPTY_DATA: OverviewData = { summary: null, overview: null, trends: [], contributors: [], forecast: null, health: null, findings: [], policies: [], environments: [], recentRuns: [], quality: null };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include" });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

/** The breakdown lens loads on its own, so switching it never blanks the page. */
function useBreakdownRows(projectId: string | null, period: Period, timezone: string | null | undefined, scopeOverride: { from?: string; to?: string } | null, environment: string, group: Extract<CostDimension, "feature" | "function" | "model">, featureRows: CostContributor[]) {
  const key = [projectId ?? "none", period, timezone ?? "", scopeOverride?.from ?? "", scopeOverride?.to ?? "", environment, group].join("\u0001");
  const [state, setState] = useState<{ key: string; group: Extract<CostDimension, "feature" | "function" | "model">; rows: CostContributor[] } | null>(null);
  useEffect(() => {
    if (!projectId || group === "feature") return;
    let cancelled = false;
    const dates = periodDates(period, timezone ?? undefined);
    getCostBreakdown(projectId, { groupBy: group, from: scopeOverride?.from ?? dates.from, to: scopeOverride?.to ?? dates.to, environment: environment !== "all" ? environment : undefined })
      .then((result) => { if (!cancelled) setState({ key, group, rows: result.contributors ?? [] }); })
      .catch(() => { if (!cancelled) setState({ key, group, rows: [] }); });
    return () => { cancelled = true; };
    // key captures every input above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (group === "feature") return { rows: featureRows, group, updating: false };
  if (state?.key === key) return { rows: state.rows, group: state.group, updating: false };
  return state ? { rows: state.rows, group: state.group, updating: true } : { rows: featureRows, group: "feature" as const, updating: true };
}

function useOverviewData(projectId: string | null, period: Period, timezone?: string | null, scopeOverride?: { from?: string; to?: string } | null, environment?: string) {
  const requestKey = [projectId ?? "none", period, timezone ?? "", scopeOverride?.from ?? "", scopeOverride?.to ?? "", environment ?? "all"].join("\u0001");
  const [state, setState] = useState<{ key: string; data: OverviewData; error: string | null }>({ key: "", data: EMPTY_DATA, error: null });
  const loading = Boolean(projectId) && state.key !== requestKey;
  const data = state.key === requestKey ? state.data : EMPTY_DATA;
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const dates = periodDates(period, timezone ?? undefined);
    const from = scopeOverride?.from ?? dates.from;
    const to = scopeOverride?.to ?? dates.to;
    const env = environment && environment !== "all" ? environment : undefined;
    const load = async () => {
      const [summary, overview, trends, callSites, forecast, health, anomalies, policies, runs, quality] = await Promise.allSettled([
        getSummary(projectId),
        getOverview(projectId, from, to, env),
        getTrends(projectId, "day", period, undefined, { from, to, environment: env }),
        getCostBreakdown(projectId, { groupBy: "feature", from, to, environment: env }),
        period === "mtd" ? getForecast(projectId, { from, to, environment: env }) : Promise.resolve(null),
        getHealth(projectId),
        getJson<{ findings: FindingRow[] }>(`/api/v1/projects/${projectId}/findings`),
        getJson<{ policies: BudgetPolicySummary[] }>(`/api/v1/projects/${projectId}/budget/policies`),
        getTraces(projectId, { limit: 5, sort: "newest", from, to, environment: env }),
        getQualitySummary(projectId, { from, to, environment: env }),
      ]);
      if (cancelled) return;
      const forecastResult = period === "mtd" ? forecast : null;
      const next: OverviewData = {
        summary: summary.status === "fulfilled" ? summary.value : null,
        overview: overview.status === "fulfilled" ? overview.value.overview : null,
        trends: trends.status === "fulfilled" ? trends.value.trends : [],
        contributors: callSites.status === "fulfilled" ? callSites.value.contributors ?? [] : [],
        forecast: forecastResult?.status === "fulfilled" ? forecastResult.value?.forecast ?? null : null,
        health: health.status === "fulfilled" ? health.value : null,
        findings: anomalies.status === "fulfilled" ? anomalies.value.findings ?? [] : [],
        policies: policies.status === "fulfilled" ? policies.value.policies ?? [] : [],
        environments: callSites.status === "fulfilled" ? callSites.value.availableFilters?.environments ?? [] : [],
        recentRuns: runs.status === "fulfilled" ? runs.value.traces ?? [] : [],
        quality: quality.status === "fulfilled" ? quality.value.totals : null,
      };
      const firstError = [summary, overview, trends, callSites].find((result) => result.status === "rejected");
      setState({ key: requestKey, data: next, error: firstError?.status === "rejected" ? firstError.reason instanceof Error ? firstError.reason.message : "Could not load overview" : null });
      setRefreshing(false);
    };
    void load().catch((reason: unknown) => {
      if (cancelled) return;
      setState({ key: requestKey, data: EMPTY_DATA, error: reason instanceof Error ? reason.message : "Could not load overview" });
      setRefreshing(false);
    });
    return () => { cancelled = true; };
  }, [projectId, period, timezone, reloadKey, requestKey, scopeOverride?.from, scopeOverride?.to, environment]);

  const error = state.key === requestKey ? state.error : null;

  return {
    data,
    loading,
    refreshing,
    error,
    refresh: () => { setRefreshing(true); setReloadKey((key) => key + 1); },
  };
}

function normalizeOverview(value: Overview | null): Overview | null {
  if (!value) return null;
  return {
    ...value,
    total_calls: Number(value.total_calls) || 0,
    total_cost: Number(value.total_cost) || 0,
    known_cost: value.known_cost === undefined ? null : value.known_cost == null ? null : Number(value.known_cost) || 0,
    unpriced_count: Number(value.unpriced_count) || 0,
    total_input_tokens: Number(value.total_input_tokens) || 0,
    total_output_tokens: Number(value.total_output_tokens) || 0,
    avg_duration_ms: Number(value.avg_duration_ms) || 0,
    avg_ttft: Number(value.avg_ttft) || 0,
    avg_tps: Number(value.avg_tps) || 0,
  };
}

/** The summary already reports change as a percentage. */
function asPercent(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Number(value);
}

/** The active money policy that reads as "the monthly budget" for this project. */
function monthlyBudget(policies: BudgetPolicySummary[]): BudgetPolicySummary | null {
  return policies.find((item) => item.status === "active" && item.unit === "money" && item.window === "calendar_month"
    && Object.keys(item.scope ?? {}).every((key) => key === "project")) ?? null;
}

function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const nice = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((step) => fraction <= step) ?? 10;
  return nice * exponent;
}

function axisMoney(value: number, max: number): string {
  if (value === 0) return "$0";
  return max < 2 ? `$${value.toFixed(2)}` : `$${value.toLocaleString("en-US", { maximumFractionDigits: max < 20 ? 1 : 0 })}`;
}

interface ChartProps {
  trends: TrendBucket[];
  loading: boolean;
  mode: "Daily" | "Cumulative";
  currency: string;
  fx?: ReportingFx | null;
  monthToDate: boolean;
  periodDays: number;
  projected: number | null;
  budget: number | null;
}

/**
 * Spend chart from the design language: solid actuals, a dashed estimate to
 * month end, and a labelled budget rule. Daily mode shows plain daily spend.
 */
function SpendChart({ trends, loading, mode, currency, fx, monthToDate, periodDays, projected, budget }: ChartProps) {
  const ordered = useMemo(() => {
    const sorted = [...trends].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
    if (!monthToDate) return sorted;
    // Day buckets can straddle the month boundary; plot only the month of the
    // latest bucket (the reporting month), never days after it.
    const latest = sorted.length ? new Date(sorted[sorted.length - 1].bucket) : null;
    if (!latest || Number.isNaN(latest.getTime())) return sorted;
    return sorted.filter((bucket) => {
      const date = new Date(bucket.bucket);
      return !Number.isNaN(date.getTime()) && date.getUTCFullYear() === latest.getUTCFullYear() && date.getUTCMonth() === latest.getUTCMonth();
    });
  }, [trends, monthToDate]);
  if (loading) return <div className="ck-chart-wrap"><div className="ck-skeleton" style={{ height: 220, width: "100%" }} /></div>;
  if (ordered.length === 0) return <EmptyPanel title="No runs in this period" icon={<PrototypeIcon name="activity" size={20} />} />;

  const cumulative = mode === "Cumulative";
  const values = ordered.reduce<number[]>((series, bucket) => {
    const cost = bucket.cost == null ? 0 : Number(bucket.cost);
    series.push(cumulative ? (series.at(-1) ?? 0) + cost : cost);
    return series;
  }, []);
  const dayOf = (bucket: string): number => {
    const date = new Date(bucket);
    return Number.isNaN(date.getTime()) ? 1 : date.getUTCDate();
  };
  // Month to date plots on a day-of-month axis so the estimate can reach month end.
  const useMonthAxis = monthToDate && cumulative;
  const xCount = useMonthAxis ? Math.max(periodDays, dayOf(ordered.at(-1)?.bucket ?? "")) : ordered.length;
  const position = (index: number): number => useMonthAxis ? dayOf(ordered[index]?.bucket ?? "") : index + 1;
  const showEstimate = useMonthAxis && projected != null && projected > 0;
  const showBudget = cumulative && budget != null && budget > 0;
  const peak = Math.max(...values, showEstimate ? projected ?? 0 : 0, showBudget ? budget ?? 0 : 0, 0.0001);
  const yMax = niceCeiling(peak * 1.08);

  const width = 640;
  const height = 250;
  const x0 = 54;
  const x1 = 612;
  const y0 = 28;
  const y1 = 206;
  const x = (pos: number) => x0 + (x1 - x0) * (pos - 1) / Math.max(xCount - 1, 1);
  const y = (value: number) => y1 - (y1 - y0) * value / yMax;
  const points = values.map((value, index) => [x(position(index)), y(value)] as const);
  const line = points.map(([px, py], index) => `${index === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
  const last = points.at(-1);
  const area = last ? `${line} L${last[0].toFixed(1)} ${y1} L${points[0][0].toFixed(1)} ${y1}Z` : "";
  const ticks = [0, yMax / 2, yMax];
  const xLabels = useMonthAxis
    ? Array.from(new Set([1, 10, 20, xCount])).filter((day) => day <= xCount).map((day) => ({ pos: day, label: `Day ${day}` }))
    : Array.from(new Set([0, Math.floor((ordered.length - 1) / 3), Math.floor((ordered.length - 1) * 2 / 3), ordered.length - 1])).map((index) => {
      const date = new Date(ordered[index]?.bucket ?? "");
      return { pos: index + 1, label: Number.isNaN(date.getTime()) ? "" : `${date.getUTCDate()} ${date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}` };
    });
  const lastValue = values.at(-1) ?? 0;
  const money = (value: number) => formatReportedAmount(value, currency, fx);
  // Put the point label on the open side of the line (away from the segment
  // that arrives at the point) and off the budget line, inside the plot.
  const label = (() => {
    if (!last) return { x: 0, y: 0, anchor: "end" as const };
    const previous = points.at(-2);
    const arrivesFromAbove = previous ? previous[1] < last[1] : false;
    let labelY = arrivesFromAbove ? last[1] + 22 : last[1] - 14;
    const budgetY = showBudget ? y(budget ?? 0) : null;
    if (budgetY != null && Math.abs(labelY - 4 - budgetY) < 12) labelY = arrivesFromAbove ? last[1] - 14 : last[1] + 22;
    labelY = Math.min(y1 - 6, Math.max(y0 + 12, labelY));
    const nearRight = last[0] > x1 - 70;
    return { x: nearRight ? last[0] - 10 : last[0] + 10, y: labelY, anchor: nearRight ? "end" as const : "start" as const };
  })();
  const description = cumulative
    ? `Cumulative spend: ${money(lastValue)} so far${showEstimate ? `; estimated ${money(projected ?? 0)} by month end` : ""}${showBudget ? `; budget ${money(budget ?? 0)}` : ""}.`
    : `Daily spend over ${ordered.length} days. Latest day ${money(lastValue)}.`;

  return (
    <>
      <div className="ck-chart-wrap">
        <svg className="ck-chart ck-spend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={description}>
          <defs><linearGradient id="ck-chart-wash" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--ck-mist)" stopOpacity=".85" /><stop offset="1" stopColor="var(--ck-mist)" stopOpacity=".12" /></linearGradient></defs>
          {ticks.map((tick) => <g key={tick}><line className="grid" x1={x0} y1={y(tick)} x2={x1} y2={y(tick)} /><text x={x0 - 12} y={y(tick) + 4} textAnchor="end">{axisMoney(tick, yMax)}</text></g>)}
          {area && <path d={area} fill="url(#ck-chart-wash)" />}
          {showBudget && <><line className="budget" x1={x0} y1={y(budget ?? 0)} x2={x1} y2={y(budget ?? 0)} /><text className="budget-label" x={x1} y={y(budget ?? 0) - 8} textAnchor="end">{money(budget ?? 0)} budget</text></>}
          <path className="actual" d={line} />
          {showEstimate && last && <><path className="estimate" d={`M${last[0].toFixed(1)} ${last[1].toFixed(1)} L${x(xCount).toFixed(1)} ${y(projected ?? 0).toFixed(1)}`} /><line className="today" x1={last[0]} y1={last[1]} x2={last[0]} y2={y1} /><circle className="estimate-point" cx={x(xCount)} cy={y(projected ?? 0)} r="4" /></>}
          {last && <><circle className="actual-point" cx={last[0]} cy={last[1]} r="5" /><text className="point-label" x={label.x} y={label.y} textAnchor={label.anchor}>{money(lastValue)}</text></>}
          {xLabels.map(({ pos, label }) => <text key={`${pos}-${label}`} x={x(pos)} y={height - 14} textAnchor="middle">{label}</text>)}
        </svg>
      </div>
    </>
  );
}

function BudgetCheck({ policy, projected, currency, fx, scopeSearch }: { policy: BudgetPolicySummary | null; projected: number | null; currency: string; fx?: ReportingFx | null; scopeSearch: string }) {
  if (!policy) {
    return (
      <section className="ck-panel ck-budget-check">
        <div className="ck-budget-check-head"><h2 className="ck-panel-title">Budget check</h2><PrototypeIcon name="shield" size={18} /></div>
        <p className="ck-budget-check-empty">No monthly budget yet. Set one to see how much room is left this month.</p>
        <Link className="ck-button ck-button-secondary" to={`/policy-edit${scopeSearch}`}>Set a budget <ArrowRight size={14} /></Link>
      </section>
    );
  }
  const limit = Number(policy.allowance) || 0;
  const spent = policy.usage?.observed == null ? null : Number(policy.usage.observed);
  const ratio = spent != null && limit > 0 ? spent / limit : null;
  const remaining = spent == null ? null : Math.max(0, limit - spent);
  const headroom = projected != null ? limit - projected : null;
  const status: { tone: Tone; label: string } = ratio == null
    ? { tone: "neutral", label: "Waiting for usage" }
    : ratio >= 1 ? { tone: "critical", label: "Over budget" }
      : (headroom != null && headroom < 0) || ratio >= 0.8 ? { tone: "warn", label: "Needs a look" }
        : { tone: "good", label: "Within budget" };
  const money = (value: number | null) => value == null ? "Unavailable" : formatReportedAmount(value, currency, fx);
  return (
    <section className="ck-panel ck-budget-check">
      <div className="ck-budget-check-head"><h2 className="ck-panel-title">Budget check</h2><PrototypeIcon name="shield" size={18} /></div>
      <div className="ck-budget-check-value">{money(remaining)}</div>
      <div className="ck-budget-check-caption">left in this month’s budget</div>
      <div className={`ck-progress ck-progress-${status.tone}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ratio == null ? undefined : Math.round(Math.min(ratio, 1) * 100)} aria-label="Budget used"><span style={{ width: `${Math.min(ratio ?? 0, 1) * 100}%` }} /></div>
      <div className="ck-budget-check-caption">{ratio == null ? "Usage not reported yet" : `${Math.floor(ratio * 100)}% of ${money(limit)} used`}</div>
      <Link className="ck-text-link" to={`/budgets${scopeSearch}`}>Manage budgets <ArrowRight size={12} /></Link>
    </section>
  );
}

function runStatus(trace: Trace): { tone: Tone; label: string } {
  const execution = String(trace.execution_state ?? "").toLowerCase();
  if (execution === "failed" || execution === "error") return { tone: "critical", label: "Failed" };
  if (execution === "running" || execution === "in_progress") return { tone: "neutral", label: "Running" };
  if (Number(trace.unpriced_count) > 0) return { tone: "warn", label: "Partly priced" };
  return { tone: "good", label: "Complete" };
}

function RecentRuns({ runs, loading, currency, fx, scopeSearch }: { runs: Trace[]; loading: boolean; currency: string; fx?: ReportingFx | null; scopeSearch: string }) {
  return (
    <Panel className="ck-recent-runs" title="Recent runs" actions={<Link className="ck-text-link" to={`/traces${scopeSearch}`}>View all runs <ArrowRight size={12} /></Link>}>
      {loading ? <LoadingRows count={5} columns={5} /> : runs.length === 0 ? <EmptyPanel title="No runs in this period" /> : (
        <div className="ck-table-wrap">
          <table className="ck-table ck-runs-table">
            <thead><tr><th>Run</th><th>Feature</th><th>Started</th><th className="numeric">Duration</th><th className="numeric">Cost ({currency})</th></tr></thead>
            <tbody>
              {runs.map((run) => {
                const status = runStatus(run);
                const cost = run.known_cost ?? run.total_cost;
                return (
                  <tr key={run.trace_id}>
                    <td className="primary-cell"><Link className="ck-table-link" to={`/traces/${encodeURIComponent(run.trace_id)}${scopeSearch}`}>{run.trace_name || "Unnamed run"}</Link>{status.tone !== "good" && <> <StatusPill tone={status.tone}>{status.label}</StatusPill></>}</td>
                    <td>{run.feature || <span className="muted">—</span>}</td>
                    <td>{formatDateTime(run.started_at)}</td>
                    <td className="numeric">{run.total_duration_ms ? formatDuration(Number(run.total_duration_ms)) : "—"}</td>
                    <td className="numeric ck-cost-cell">{cost == null ? "Unpriced" : formatReportedAmount(Number(cost), currency, fx)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function CostBreakdown({ contributors, rowsGroup, updating, totalCost, loading, currency, fx, scopeSearch, group, onGroupChange }: { contributors: CostContributor[]; rowsGroup: Extract<CostDimension, "feature" | "function" | "model">; updating: boolean; totalCost: number; loading: boolean; currency: string; fx?: ReportingFx | null; scopeSearch: string; group: Extract<CostDimension, "feature" | "function" | "model">; onGroupChange: (group: Extract<CostDimension, "feature" | "function" | "model">) => void }) {
  return (
    <Panel title={`Spend by ${group}`} actions={<div className="ck-segmented ck-breakdown-lens" role="group" aria-label="Group spend by">{(["feature", "function", "model"] as const).map((value) => <button key={value} className={group === value ? "active" : ""} type="button" aria-pressed={group === value} onClick={() => onGroupChange(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>}>
      {loading ? <LoadingRows count={5} columns={5} /> : contributors.length === 0 ? <EmptyPanel title={`Nothing labelled by ${group} yet`} body={`Spend still counts in every total. Add a ${group} label in the SDK, or map calls to ${group}s on the Costs page.`} action={<Link className="ck-button ck-button-secondary" to={`/costs${scopeSearch}`}>Open Costs</Link>} /> : (
        <div className={`ck-table-wrap${updating ? " is-updating" : ""}`} aria-busy={updating}>
          <table className="ck-table ck-breakdown-table">
            <colgroup><col /><col className="ck-col-money" /><col className="ck-col-share" /></colgroup>
            <thead><tr><th>{rowsGroup[0].toUpperCase() + rowsGroup.slice(1)}</th><th className="numeric">Cost ({currency})</th><th className="numeric">Share</th></tr></thead>
            <tbody>
              {contributors.slice(0, 5).map((contributor) => {
                const cost = contributor.known_cost == null ? null : Number(contributor.known_cost);
                const share = totalCost > 0 && cost != null ? cost / totalCost * 100 : null;
                const value = String(contributor.key ?? contributor.label ?? "(unassigned)");
                const unlabelled = contributor.label === "(unassigned)" || value === "(unassigned)";
                return (
                  <tr key={value}>
                    <td className="primary-cell"><Link className="ck-table-link" to={`/costs?groupBy=${rowsGroup}&groupValue=${encodeURIComponent(value)}&${scopeSearch.slice(1)}`}>{unlabelled ? "Not labelled" : contributor.label || value}</Link>{!unlabelled && contributor.secondary && <div className="muted">{contributor.secondary}</div>}</td>
                    <td className="numeric">{cost == null ? "Unpriced" : formatReportedAmount(cost, currency, fx)}</td>
                    <td className="numeric">{formatPercent(share)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function OverviewLoadingState(): ReactNode {
  return <>
    <div className="ck-metric-grid"><MetricCard label="Month to date" value="" loading icon="activity" /><MetricCard label="Monthly budget" value="" loading icon="shield" /><MetricCard label="Estimated month-end" value="" loading icon="telescope" /></div>
    <div className="ck-content-grid"><Panel className="ck-chart-card"><div className="ck-skeleton" style={{ height: 260, width: "100%" }} /></Panel><Panel><div className="ck-skeleton" style={{ height: 260, width: "100%" }} /></Panel></div>
  </>;
}

/** Run health beside spend: did the runs work, how long they took, what failures cost. */
function RunHealth({ totals, money, scopeSearch }: { totals: QualitySummary["totals"] | null; money: (value: number | null | undefined) => string; scopeSearch: string }) {
  if (!totals || totals.runs === 0) return null;
  const failedShare = totals.failedRuns / totals.runs;
  const judged = totals.judgedRuns ?? 0;
  const judgedFailed = totals.judgedFailed ?? 0;
  const share = (value: number) => value > 0 && value < 0.01 ? "<1%" : `${Math.round(value * 100)}%`;
  return (
    <Panel className="ck-run-health" title="Run health" actions={<Link className="ck-text-link" to={`/quality${scopeSearch}`}>Open quality <ArrowRight size={12} /></Link>}>
      <div className="ck-health-grid">
        <div className="ck-health-stat">
          <span className="ck-health-label"><PrototypeIcon name="alert" size={14} />Failed runs</span>
          <strong className={failedShare > 0.05 ? "ck-tone-warn" : undefined}>{share(failedShare)}</strong>
          <span className="ck-health-detail">{totals.failedRuns.toLocaleString()} of {totals.runs.toLocaleString()} runs</span>
        </div>
        <div className="ck-health-stat">
          <span className="ck-health-label"><PrototypeIcon name="clock" size={14} />Run time</span>
          <strong>{totals.p50Ms == null ? "—" : formatDuration(totals.p50Ms)}</strong>
          <span className="ck-health-detail">{totals.p95Ms == null ? "Typical run" : `Typical · p95 ${formatDuration(totals.p95Ms)}`}</span>
        </div>
        <div className="ck-health-stat">
          <span className="ck-health-label"><PrototypeIcon name="quality" size={14} />Judge scores</span>
          <strong>{judged === 0 ? "—" : share((judged - judgedFailed) / judged)}</strong>
          <span className="ck-health-detail">{judged === 0 ? "No scored runs yet" : `passed · ${judgedFailed.toLocaleString()} of ${judged.toLocaleString()} failed`}</span>
        </div>
        <div className="ck-health-stat">
          <span className="ck-health-label"><PrototypeIcon name="activity" size={14} />Failed calls</span>
          <strong>{totals.failedCalls.toLocaleString()}</strong>
          <span className="ck-health-detail">{totals.retries.toLocaleString()} {totals.retries === 1 ? "retry" : "retries"} · {money(totals.wastedCost)} wasted</span>
        </div>
      </div>
    </Panel>
  );
}

function daysInMonth(date: Date): number {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

export default function Dashboard() {
  const { currentProjectId, projects, org, workspaceSettings, setCurrentProjectId } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  const project = projects.find((item) => item.id === projectId);
  const timezone = workspaceSettings?.timezone ?? org?.timezone;
  const reportingCurrency = workspaceSettings?.reportingCurrency ?? "USD";
  const fx = workspaceSettings?.fx;
  const [period, setPeriod] = useState<Period>(() => parsePeriod(searchParams.get("period")));
  const [chartMode, setChartMode] = useState<"Daily" | "Cumulative">("Cumulative");
  const [breakdownGroup, setBreakdownGroup] = useState<Extract<CostDimension, "feature" | "function" | "model">>("feature");
  const [dataVersion, setDataVersion] = useState(0);
  const requestedProjectId = searchParams.get("project");
  const requestedFrom = searchParams.get("from");
  const requestedTo = searchParams.get("to");
  const environment = searchParams.get("environment") ?? "all";
  const requestedScope = requestedFrom && requestedTo && !Number.isNaN(new Date(requestedFrom).getTime()) && !Number.isNaN(new Date(requestedTo).getTime()) && new Date(requestedFrom) < new Date(requestedTo) ? { from: requestedFrom, to: requestedTo } : null;
  const requestedProject = requestedProjectId ? projects.find((item) => item.id === requestedProjectId) : undefined;
  useEffect(() => {
    if (requestedProject && requestedProject.id !== currentProjectId) setCurrentProjectId(requestedProject.id);
  }, [requestedProject, currentProjectId, setCurrentProjectId]);
  const resource = useOverviewData(projectId, period, timezone, requestedScope, environment);
  const breakdown = useBreakdownRows(projectId, period, timezone, requestedScope, environment, breakdownGroup, resource.data.contributors);
  const overview = normalizeOverview(resource.data.overview);
  const summary = resource.data.summary;
  const monthToDate = !requestedScope && period === "mtd";
  const periodChange = monthToDate && summary ? asPercent(summary.costChange) : null;
  const currentCost = overview?.known_cost === undefined ? null : overview.known_cost;
  const currentObservations = Number(overview?.observations ?? overview?.total_calls) || 0;
  const forecastObserved = resource.data.forecast?.observed;
  const runCount = Number(overview?.trace_count ?? forecastObserved?.fullyPricedTraces) || 0;
  const pace = resource.data.forecast?.currentPace;
  const projected = pace?.available && pace.projectedCost != null ? Number(pace.projectedCost) : null;
  const now = new Date();
  const periodDays = pace?.periodDays ?? daysInMonth(now);
  const dayOfMonth = now.getUTCDate();
  const unpriced = Number(overview?.unpriced_count ?? forecastObserved?.unpricedObservations) || 0;
  const explicitState = prototypeState(searchParams);
  const activeFindings = explicitState === "healthy" ? [] : resource.data.findings.filter((finding) => finding.state !== "no_longer_outside_threshold" && finding.state !== "acknowledged");
  const budget = monthlyBudget(resource.data.policies);
  const budgetLimit = budget ? Number(budget.allowance) || null : null;
  const budgetSpent = budget?.usage?.observed == null ? null : Number(budget.usage.observed);
  const projectName = (project?.name ?? "This project").replace(/\s+\(synthetic\)$/i, "");
  const noProject = !projectId;
  const toolbarPeriod: Period = requestedScope ? "custom" : period;
  const scopeParams = new URLSearchParams();
  scopeParams.set("project", projectId ?? "");
  if (requestedScope) { scopeParams.set("period", "custom"); scopeParams.set("from", requestedScope.from ?? ""); scopeParams.set("to", requestedScope.to ?? ""); }
  else scopeParams.set("period", period);
  if (environment !== "all") scopeParams.set("environment", environment);
  const scopeSearch = `?${scopeParams.toString()}`;
  const money = (value: number | null | undefined) => formatReportedAmount(value, reportingCurrency, fx);
  const changePeriod = (next: Period): void => {
    if (next === "custom") {
      const dates = periodDates("30d", timezone ?? undefined);
      setPeriod(next);
      setSearchParams((current) => { current.set("period", "custom"); current.set("from", dates.from); current.set("to", dates.to); return current; });
      return;
    }
    setPeriod(next);
    setSearchParams((current) => { current.set("period", next); current.delete("from"); current.delete("to"); return current; });
  };
  const environmentOptions = [{ value: "all", label: "All environments" }, ...resource.data.environments.filter((value) => value !== "all").map((value) => ({ value, label: value }))];
  const onEnvironmentChange = (next: string) => setSearchParams((current) => { if (next === "all") current.delete("environment"); else current.set("environment", next); return current; });

  useEffect(() => {
    if (dataVersion === 0) return;
    resource.refresh();
    // refresh is intentionally explicit; avoid a timer that shifts rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion]);

  const scopeEnvironments = environmentOptions.length > 1 || environment !== "all";
  const periodBadge = <div className="ck-period-badge">
    {scopeEnvironments && <span className="ck-pill-select"><select aria-label="Environment" value={environment} onChange={(event) => onEnvironmentChange(event.target.value)}>{environmentOptions.concat(environment !== "all" && !environmentOptions.some((option) => option.value === environment) ? [{ value: environment, label: environment }] : []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><PrototypeIcon name="down" size={12} /></span>}
    <span className="ck-pill-select ck-period-pill"><select aria-label="Period" value={toolbarPeriod === "custom" ? "custom" : period} onChange={(event) => changePeriod(event.target.value as Period)}>
      <option value="mtd">{now.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })}</option>
      <option value="7d">Last 7 days</option>
      <option value="30d">Last 30 days</option>
      {toolbarPeriod === "custom" && <option value="custom">Custom range</option>}
    </select><PrototypeIcon name="down" size={12} /></span>
    {monthToDate && <span>Day {dayOfMonth} of {periodDays}</span>}
  </div>;

  if (requestedProject && requestedProject.id !== currentProjectId) {
    return <div className="ck-main-inner"><PageHeader title="Opening shared overview" /><Panel><LoadingRows count={4} columns={3} /></Panel></div>;
  }

  if (noProject) {
    return <div className="ck-main-inner"><PageHeader title="Overview" /><Panel><EmptyPanel illustration="first-light" title="Ready for your first run" body="Connect a project to start." action={<Link className="ck-button ck-button-primary" to="/onboarding">Connect a project <ArrowRight size={14} /></Link>} /></Panel></div>;
  }

  if (explicitState === "loading") {
    return <div className="ck-main-inner"><PageHeader title="Overview" actions={periodBadge} /><OverviewLoadingState /></div>;
  }

  const namedState = ["none", "new"].includes(explicitState)
    ? PrototypeStatePanel({ state: explicitState, family: "Overview", title: explicitState === "new" ? "Ready for your first run" : "No runs in this period", backHref: "/onboarding", retryHref: window.location.pathname + window.location.search })
    : null;
  if (namedState) return namedState;

  if (!resource.loading && !resource.error && overview && currentObservations === 0) {
    const lastSeen = resource.data.health?.lastEventAt;
    return <div className="ck-main-inner"><PageHeader title="Overview" actions={periodBadge} /><Panel><EmptyPanel illustration={lastSeen ? "a-closer-look" : "first-light"} title={lastSeen ? "No runs in this period" : "Ready for your first run"} body={lastSeen ? `The last run arrived ${formatDateTime(lastSeen)}. Try a longer period. A quiet project is not necessarily disconnected.` : "Send a request from your app. It shows up here with its cost."} action={<div className="ck-button-row"><Link className="ck-button ck-button-secondary" to={`/traces${scopeSearch}`}>View runs</Link><Link className="ck-button ck-button-primary" to="/onboarding">Check setup</Link></div>} /></Panel></div>;
  }

  const finding = activeFindings[0];
  const findingHref = finding ? `/finding?id=${encodeURIComponent(finding.id)}&project=${encodeURIComponent(projectId ?? "")}` : "";
  const status: { tone: Tone; text: ReactNode; right?: ReactNode } = (() => {
    if (explicitState === "stale" || resource.data.health?.status === "inactive") {
      const lastSeen = resource.data.health?.lastEventAt;
      return { tone: "neutral", text: lastSeen ? `No new runs since ${formatDateTime(lastSeen)}.` : "No recent runs.", right: <Link className="ck-text-link" to="/settings?section=projects">Check connection</Link> };
    }
    if (finding) return { tone: "warn", text: <>{findingTitle(finding)}. Worth a look.</>, right: <Link className="ck-text-link" to={findingHref}>Review <ArrowRight size={12} /></Link> };
    if (unpriced > 0) return { tone: "warn", text: `${unpriced.toLocaleString()} call${unpriced === 1 ? " has" : "s have"} no price yet, so totals are partial.`, right: <Link className="ck-text-link" to="/settings?section=pricing">Set prices <ArrowRight size={12} /></Link> };
    if (budgetLimit != null && budgetSpent != null && budgetSpent >= budgetLimit) return { tone: "critical", text: `${projectName} is over its ${money(budgetLimit)} budget.`, right: <Link className="ck-text-link" to={`/budgets${scopeSearch}`}>Review budget</Link> };
    if (budgetLimit != null && projected != null && projected > budgetLimit) return { tone: "warn", text: `At this pace, ${projectName} passes its ${money(budgetLimit)} budget this month.`, right: <Link className="ck-text-link" to={`/forecast${scopeSearch}`}>See estimate</Link> };
    if (budgetLimit != null) return { tone: "good", text: `${projectName} is within its monthly budget.` };
    return { tone: "good", text: `No unusual spending in ${projectName} ${monthToDate ? "this month" : `in the ${periodLabel(toolbarPeriod)}`}.`, right: <Link className="ck-text-link" to={`/policy-edit${scopeSearch}`}>Set a budget</Link> };
  })();

  return (
    <div className="ck-main-inner ck-overview">
      <PageHeader title="Overview" actions={periodBadge} />
      
      {!["partial", "stale", "error", "healthy"].includes(explicitState) && <PrototypeStateNotice state={explicitState} family="overview" role={prototypeRole(searchParams, "viewer")} />}
      {(explicitState === "error" || resource.error) && <div className="ck-alert ck-alert-error" role="alert"><AlertCircle size={15} aria-hidden="true" /><div><strong>Couldn’t refresh everything.</strong> Showing the latest numbers we have. <button type="button" className="ck-button ck-button-quiet ck-inline-button" onClick={() => setDataVersion((value) => value + 1)}>Try again</button></div></div>}
      {!resource.loading && <StatusLine tone={status.tone} right={status.right}>{status.text}</StatusLine>}
      {resource.loading ? <OverviewLoadingState /> : <>
        <div className="ck-metric-grid">
          <MetricCard icon="activity" label={monthToDate ? "Month to date" : periodLabel(toolbarPeriod).replace(/^./, (letter) => letter.toUpperCase())} value={money(currentCost)} detail={<>{runCount > 0 ? `Across ${runCount.toLocaleString()} run${runCount === 1 ? "" : "s"}` : "No fully priced runs yet"}{periodChange != null && <><br /><Delta value={periodChange} comparison="last month" /></>}</>} />
          <MetricCard icon="shield" label="Monthly budget" value={budgetLimit == null ? "Not set" : money(budgetLimit)} detail={budgetLimit == null ? <Link className="ck-text-link" to={`/policy-edit${scopeSearch}`}>Set a monthly budget</Link> : budget?.mode === "enforce" ? "Stops new calls when reached" : "Alerts only"} />
          <MetricCard icon="telescope" label="Estimated month-end" value={!monthToDate ? "—" : projected == null ? "Not yet" : money(projected)} detail={!monthToDate ? "Switch to month to date to estimate" : projected == null ? pace?.reason === "incomplete_pricing" ? "Waiting for prices on every call" : "Needs a few complete days" : "At current pace"} />
        </div>
        <RunHealth totals={resource.data.quality} money={money} scopeSearch={scopeSearch} />
        <div className="ck-content-grid">
          <Panel className="ck-chart-card" title={chartMode === "Cumulative" ? "Cumulative spend" : "Daily spend"} actions={<div className="ck-chart-head-actions">{chartMode === "Cumulative" && <div className="ck-chart-legend"><span><i />Actual</span>{monthToDate && projected != null && <span><i className="dashed" />Estimated</span>}</div>}<div className="ck-segmented ck-chart-mode" role="group" aria-label="Chart mode">{(["Cumulative", "Daily"] as const).map((mode) => <button key={mode} className={chartMode === mode ? "active" : ""} type="button" aria-pressed={chartMode === mode} onClick={() => setChartMode(mode)}>{mode}</button>)}</div></div>}>
            <SpendChart trends={resource.data.trends} loading={resource.loading} mode={chartMode} currency={reportingCurrency} fx={fx} monthToDate={monthToDate} periodDays={periodDays} projected={projected} budget={budgetLimit} />
          </Panel>
          <div className="ck-stack">
            <BudgetCheck policy={budget} projected={monthToDate ? projected : null} currency={reportingCurrency} fx={fx} scopeSearch={scopeSearch} />
            {finding && <section className="ck-panel ck-attention-card"><div className="ck-attention-kicker"><PrototypeIcon name="alert" size={16} />Needs a look</div><h2>{findingTitle(finding)}</h2><p>{findingView({ ...finding, lastSeenAt: finding.lastSeenAt ?? finding.observedAt } as FindingResponse, money).summary}</p><Link className="ck-button ck-button-secondary" to={findingHref}>Review this change <ArrowRight size={14} /></Link></section>}
          </div>
        </div>
        <RecentRuns runs={resource.data.recentRuns} loading={resource.loading} currency={reportingCurrency} fx={fx} scopeSearch={scopeSearch} />
        <CostBreakdown contributors={breakdown.rows} rowsGroup={breakdown.group} updating={breakdown.updating} totalCost={currentCost ?? 0} loading={resource.loading} currency={reportingCurrency} fx={fx} scopeSearch={scopeSearch} group={breakdownGroup} onGroupChange={setBreakdownGroup} />
      </>}
    </div>
  );
}

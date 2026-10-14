import { appUrl, currentRouterPath } from "../basePath";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AlertCircle, ArrowRight } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import {
  getCostBreakdown,
  getForecast,
  getHealth,
  getOverview,
  getOverviewBoard,
  type Overview,
  type OverviewBoard,
  type PipelineHealth,
  type ForecastResponse,
} from "../api";
import { findingTitle } from "../components/findingView";
import { useAuth } from "../contexts/useAuth";
import {
  EmptyPanel,
  LoadingRows,
  PageHeader,
  Panel,
  StatusLine,
  type Period,
  type Tone,
} from "../components/ConsolePrimitives";
import { PrototypeIcon } from "../components/PrototypeIcon";
import { billedUnitsText } from "../components/tokenUsage";
import { scopeSearch as drillScope } from "../components/links";
import { allClearDismissed, dismissAllClear } from "../components/allClear";
import { LiveStatus } from "../components/LiveStatus";
import { useLiveQuery } from "../hooks/useLiveQuery";
import { formatDateTime, formatReportedAmount, parsePeriod, periodDates, periodLabel, zonedDateParts, zonedDaysInMonth } from "../components/consoleFormatters";
import { prototypeRole, prototypeState, PrototypeStateNotice, PrototypeStatePanel } from "../components/PrototypeState";
import { BoardSkeleton, CostByModel, KpiCard, LatencyPanel, RunVolume, ScoresPanel, UsageByAgent } from "../components/OverviewBoard";
import { SpendOverTime } from "../components/SpendOverTime";
import { compactNumber, formatScore, previousRange } from "../components/overviewBoardModel";

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
  overview: Overview | null;
  previousOverview: Overview | null;
  board: OverviewBoard | null;
  forecast: ForecastResponse | null;
  health: PipelineHealth | null;
  findings: FindingRow[];
  policies: BudgetPolicySummary[];
  environments: string[];
}

const EMPTY_DATA: OverviewData = { overview: null, previousOverview: null, board: null, forecast: null, health: null, findings: [], policies: [], environments: [] };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(appUrl(path), { credentials: "include" });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function useOverviewData(projectId: string | null, period: Period, timezone?: string | null, scopeOverride?: { from?: string; to?: string } | null, environment?: string) {
  const requestKey = [projectId ?? "none", period, timezone ?? "", scopeOverride?.from ?? "", scopeOverride?.to ?? "", environment ?? "all"].join("\u0001");
  // Live: the board refreshes every 10 s while the tab is visible, keeping what is on screen.
  const live = useLiveQuery(projectId ? requestKey : null, async () => {
    const dates = periodDates(period, timezone ?? undefined);
    const from = scopeOverride?.from ?? dates.from;
    const to = scopeOverride?.to ?? dates.to;
    const previous = previousRange(from, to);
    const env = environment && environment !== "all" ? environment : undefined;
    const [overview, previousOverview, board, callSites, forecast, health, anomalies, policies] = await Promise.allSettled([
      getOverview(projectId!, from, to, env),
      getOverview(projectId!, previous.from, previous.to, env),
      getOverviewBoard(projectId!, { from, to, environment: env }),
      // Only for the environments that have data.
      getCostBreakdown(projectId!, { groupBy: "feature", from, to, environment: env }),
      period === "mtd" ? getForecast(projectId!, { from, to, environment: env }) : Promise.resolve(null),
      getHealth(projectId!),
      getJson<{ findings: FindingRow[] }>(`/api/v1/projects/${projectId}/findings`),
      getJson<{ policies: BudgetPolicySummary[] }>(`/api/v1/projects/${projectId}/budget/policies`),
    ]);
    const forecastResult = period === "mtd" ? forecast : null;
    const next: OverviewData = {
      overview: overview.status === "fulfilled" ? overview.value.overview : null,
      previousOverview: previousOverview.status === "fulfilled" ? previousOverview.value.overview : null,
      board: board.status === "fulfilled" ? board.value : null,
      forecast: forecastResult?.status === "fulfilled" ? forecastResult.value?.forecast ?? null : null,
      health: health.status === "fulfilled" ? health.value : null,
      findings: anomalies.status === "fulfilled" ? anomalies.value.findings ?? [] : [],
      policies: policies.status === "fulfilled" ? policies.value.policies ?? [] : [],
      environments: callSites.status === "fulfilled" ? callSites.value.availableFilters?.environments ?? [] : [],
    };
    const firstError = [overview, board, callSites].find((result) => result.status === "rejected");
    // Every part failing is a failed refresh: keep the last numbers and say so.
    if (overview.status === "rejected" && board.status === "rejected") throw firstError?.status === "rejected" && firstError.reason instanceof Error ? firstError.reason : new Error("Could not load overview");
    return { key: requestKey, data: next, error: firstError?.status === "rejected" ? firstError.reason instanceof Error ? firstError.reason.message : "Could not load overview" : null };
  });
  const current = live.data?.key === requestKey ? live.data : null;
  return {
    data: current?.data ?? EMPTY_DATA,
    loading: Boolean(projectId) && !current,
    refreshing: false,
    error: current ? current.error : live.error,
    status: live.status,
    updatedAt: live.updatedAt,
    refresh: live.refresh,
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

/** Tokens on the board: input plus output, as the spend overview counts them. */
function overviewTokens(value: Overview | null): number | null {
  if (!value || !(Number(value.observations ?? value.total_calls) > 0)) return null;
  return value.total_input_tokens + value.total_output_tokens;
}

/** The active money policy that reads as "the monthly budget" for this project. */
function monthlyBudget(policies: BudgetPolicySummary[]): BudgetPolicySummary | null {
  return policies.find((item) => item.status === "active" && item.unit === "money" && item.window === "calendar_month"
    && Object.keys(item.scope ?? {}).every((key) => key === "project")) ?? null;
}

function OverviewLoadingState(): ReactNode {
  return <>
    <div className="ck-board-kpis">{["Runs", "Model cost", "Tokens", "Avg score"].map((label) => <KpiCard key={label} label={label} value="" current={null} previous={null} previousLabel="" higherIsBetter loading />)}</div>
    <div className="ck-board-row ck-board-row-3"><BoardSkeleton /><BoardSkeleton /><BoardSkeleton /></div>
    <div className="ck-board-row ck-board-row-2"><BoardSkeleton /><BoardSkeleton /></div>
  </>;
}

export default function Dashboard() {
  const { currentProjectId, projects, org, workspaceSettings, setCurrentProjectId } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  const workspaceZone = workspaceSettings?.timezone ?? org?.timezone ?? undefined;
  const [allClearHidden, setAllClearHidden] = useState<Record<string, boolean>>({});
  const allClearIsHidden = projectId ? allClearHidden[projectId] ?? allClearDismissed(projectId, new Date(), workspaceZone) : false;
  const hideAllClear = () => { if (!projectId) return; dismissAllClear(projectId, new Date(), workspaceZone); setAllClearHidden((current) => ({ ...current, [projectId]: true })); };
  const project = projects.find((item) => item.id === projectId);
  const timezone = workspaceSettings?.timezone ?? org?.timezone;
  const reportingCurrency = workspaceSettings?.reportingCurrency ?? "USD";
  const fx = workspaceSettings?.fx;
  const [period, setPeriod] = useState<Period>(() => parsePeriod(searchParams.get("period")));
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
  void dataVersion;
  const overview = normalizeOverview(resource.data.overview);
  const previousOverview = normalizeOverview(resource.data.previousOverview);
  const board = resource.data.board;
  const monthToDate = !requestedScope && period === "mtd";
  const currentCost = overview?.known_cost === undefined ? null : overview.known_cost;
  const previousCost = previousOverview?.known_cost == null ? null : previousOverview.known_cost;
  const currentObservations = Number(overview?.observations ?? overview?.total_calls) || 0;
  const forecastObserved = resource.data.forecast?.observed;
  const pace = resource.data.forecast?.currentPace;
  const projected = pace?.available && pace.projectedCost != null ? Number(pace.projectedCost) : null;
  const now = new Date();
  // Days count in the workspace time zone: 1 Nov starts at midnight in India, not UTC.
  const periodDays = pace?.periodDays ?? zonedDaysInMonth(now, timezone);
  const dayOfMonth = zonedDateParts(now, timezone).day;
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
  const compareParams = new URLSearchParams({ project: projectId ?? "" });
  if (environment !== "all") compareParams.set("environment", environment);
  const periodBadge = <div className="ck-period-badge">
    <LiveStatus status={resource.status} updatedAt={resource.updatedAt} onRefresh={resource.refresh} />
    {scopeEnvironments && <span className="ck-pill-select"><select aria-label="Environment" value={environment} onChange={(event) => onEnvironmentChange(event.target.value)}>{environmentOptions.concat(environment !== "all" && !environmentOptions.some((option) => option.value === environment) ? [{ value: environment, label: environment }] : []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><PrototypeIcon name="down" size={12} /></span>}
    <span className="ck-pill-select ck-period-pill"><select aria-label="Period" value={toolbarPeriod === "custom" ? "custom" : period} onChange={(event) => changePeriod(event.target.value as Period)}>
      <option value="mtd">{now.toLocaleDateString("en-US", { month: "long", timeZone: timezone ?? undefined })}</option>
      <option value="7d">Last 7 days</option>
      <option value="30d">Last 30 days</option>
      {toolbarPeriod === "custom" && <option value="custom">Custom range</option>}
    </select><PrototypeIcon name="down" size={12} /></span>
    {monthToDate && <span>Day {dayOfMonth} of {periodDays}</span>}
    <Link className="ck-text-link" to={`/overview/compare?${compareParams.toString()}`}>Compare periods</Link>
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
    ? PrototypeStatePanel({ state: explicitState, family: "Overview", title: explicitState === "new" ? "Ready for your first run" : "No runs in this period", backHref: "/onboarding", retryHref: currentRouterPath() })
    : null;
  if (namedState) return namedState;

  if (!resource.loading && !resource.error && overview && currentObservations === 0) {
    const lastSeen = resource.data.health?.lastEventAt;
    return <div className="ck-main-inner"><PageHeader title="Overview" actions={periodBadge} /><Panel><EmptyPanel illustration={lastSeen ? "a-closer-look" : "first-light"} title={lastSeen ? "No runs in this period" : "Ready for your first run"} body={lastSeen ? `The last run arrived ${formatDateTime(lastSeen)}. Try a longer period. A quiet project is not necessarily disconnected.` : "Send a request from your app. It shows up here with its cost."} action={<div className="ck-button-row"><Link className="ck-button ck-button-secondary" to={`/traces${scopeSearch}`}>View runs</Link><Link className="ck-button ck-button-primary" to="/onboarding">Check setup</Link></div>} /></Panel></div>;
  }

  // Every run counts, agents and workflows alike; the split is under the number.
  const agentRuns = board?.runs.current.agentRuns ?? 0;
  const workflowRuns = Math.max(0, (board?.runs.current.runs ?? 0) - agentRuns);
  const runsKpi = {
    label: "Runs",
    current: board ? board.runs.current.runs : 0,
    previous: board ? board.runs.previous.runs : 0,
    split: board && agentRuns > 0 && workflowRuns > 0
      ? `${agentRuns.toLocaleString("en-US")} agent · ${workflowRuns.toLocaleString("en-US")} workflow`
      : undefined,
  };
  const currentTokens = overviewTokens(overview);
  // Speech, audio, images and searches bill in their own units; they count as usage too.
  const otherUnits = billedUnitsText(board?.units?.current);
  const scopeSearchText = drillScope();
  const previousTokens = overviewTokens(previousOverview);
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
      {(explicitState === "error" || resource.error) && <div className="ck-alert ck-alert-error" role="alert"><AlertCircle size={15} aria-hidden="true" /><div><strong>Couldn’t refresh everything.</strong> Showing the latest numbers we have. <button type="button" className="ck-button ck-button-quiet ck-inline-button" onClick={() => { resource.refresh(); setDataVersion((value) => value + 1); }}>Try again</button></div></div>}
      {/* The all-clear can be dismissed for the month; a warning always shows. */}
      {!resource.loading && !(status.tone === "good" && allClearIsHidden) && <StatusLine tone={status.tone} right={status.right} onDismiss={status.tone === "good" ? hideAllClear : undefined}>{status.text}</StatusLine>}
      {resource.loading ? <OverviewLoadingState /> : <>
        <div className="ck-board-kpis">
          <KpiCard to={`/traces${scopeSearchText}`} label={runsKpi.label} value={board ? runsKpi.current.toLocaleString("en-US") : "—"} current={board ? runsKpi.current : null} previous={board ? runsKpi.previous : null} previousLabel={runsKpi.previous.toLocaleString("en-US")} higherIsBetter={null} note={runsKpi.split} />
          <KpiCard to={`/costs${scopeSearchText}`} label="Model cost" value={money(currentCost)} current={currentCost} previous={previousCost} previousLabel={money(previousCost)} higherIsBetter={false} />
          <KpiCard to={`/models${scopeSearchText}`} label={currentTokens || !otherUnits ? "Tokens" : "Usage"} value={currentTokens ? compactNumber(currentTokens) : otherUnits || compactNumber(currentTokens)} current={currentTokens} previous={previousTokens} previousLabel={compactNumber(previousTokens)} higherIsBetter={null} />
          <KpiCard to={`/quality${scopeSearchText}`} label="Avg score" value={formatScore(board?.scores.current.avg)} current={board?.scores.current.avg ?? null} previous={board?.scores.previous.avg ?? null} previousLabel={formatScore(board?.scores.previous.avg)} higherIsBetter />
        </div>
        <SpendOverTime projectId={projectId} period={toolbarPeriod} range={requestedScope} environment={environment} money={money} />
        <div className="ck-board-row ck-board-row-3">
          <CostByModel board={board} totalCost={money(currentCost)} money={money} projectId={projectId} />
          <UsageByAgent board={board} money={money} />
          <ScoresPanel board={board} />
        </div>
        <div className="ck-board-row ck-board-row-2">
          <RunVolume board={board} />
          <LatencyPanel board={board} />
        </div>
      </>}
    </div>
  );
}

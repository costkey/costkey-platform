import { appUrl } from "../basePath";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CircleAlert, Clock, Save, ShieldCheck, X } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import {
  acknowledgeFinding,
  getCostBreakdown,
  getCostContributor,
  getTrace,
  getTraces,
  type CostContributorDetailResponse,
  type CostDimension,
  type FindingResponse,
  type Trace,
  type TraceEvent,
} from "../api";
import { useAuth } from "../contexts/useAuth";
import { EmptyPanel, LoadingRows, MetricCard, PageHeader, Panel, ScopeToolbar, StatusLine, StatusPill, type Period } from "../components/ConsolePrimitives";
import { FindingBody } from "../components/FindingBody";
import { PrototypeIcon } from "../components/PrototypeIcon";
import { formatDateTime, formatDayDate, formatPercent, formatReportedAmount, parsePeriod, periodDates, periodLabel, reportingCurrencyNote, type ReportingFx } from "../components/consoleFormatters";
import { formatDuration } from "../utils";
import { prototypeRole, prototypeState, PrototypeStateNotice, PrototypeStatePanel } from "../components/PrototypeState";
import { isPrototypePreview } from "../prototypePreview";
import Dashboard from "./Dashboard";
import "./PrototypeRoute.css";

const dimensionForType: Record<string, CostDimension> = {
  feature: "feature",
  function: "function",
  customer: "customer",
  model: "model",
  provider: "provider",
  context: "context",
  label: "context",
};

function scopeParams(projectId: string, period: Period, timezone?: string | null): { from: string; to: string; query: string } {
  const dates = periodDates(period, timezone ?? undefined);
  return { ...dates, query: `?project=${encodeURIComponent(projectId)}&period=${encodeURIComponent(period)}` };
}

function contributorTitle(type: string, name: string): string {
  if (name) return name;
  return type ? `${type} contributor` : "Contributor";
}

function ContributorHistory({ detail, currency, fx }: { detail: CostContributorDetailResponse; currency: string; fx?: ReportingFx | null }) {
  const chartData = detail.history.slice(-30).map((row) => ({ bucket: row.day, cost: row.known_cost == null ? null : Number(row.known_cost) }));
  const chartHost = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(0);
  useEffect(() => {
    const element = chartHost.current;
    if (!element) return;
    const update = () => {
      if (element.clientWidth > 0) setChartWidth(element.clientWidth);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    const frame = window.requestAnimationFrame(update);
    return () => { observer?.disconnect(); window.cancelAnimationFrame(frame); };
  }, []);
  return <div ref={chartHost} className="ck-chart-wrap" style={{ height: 210, width: "100%", minWidth: 1 }} aria-label="Contributor cost history">{chartWidth > 0 ? <AreaChart width={chartWidth} height={190} data={chartData} margin={{ top: 14, right: 12, bottom: 0, left: 0 }}><CartesianGrid stroke="var(--ck-border)" strokeDasharray="2 4" vertical={false} /><XAxis dataKey="bucket" tickFormatter={(value: string) => { const date = new Date(value); if (Number.isNaN(date.getTime())) return value.slice(5, 10); return `${date.getUTCDate()} ${date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}`; }} tick={{ fill: "var(--ck-slate)", fontSize: 12 }} tickLine={false} axisLine={false} minTickGap={24} /><YAxis tickFormatter={(value: number) => currency.toUpperCase() === "USD" ? `$${Number(value).toFixed(Number(value) >= 10 ? 0 : 2)}` : formatReportedAmount(Number(value), currency, fx)} tick={{ fill: "var(--ck-slate)", fontSize: 12 }} tickLine={false} axisLine={false} width={50} /><Tooltip content={<ContributorHistoryTooltip currency={currency} fx={fx} />} /><Area type="monotone" dataKey="cost" stroke="var(--ck-blue)" strokeWidth={2} fill="var(--ck-mist)" fillOpacity={0.45} connectNulls={false} isAnimationActive={false} /></AreaChart> : <div className="ck-skeleton" style={{ height: 190, width: "100%" }} />}</div>;
}

function ContributorHistoryTooltip({ active, payload, label, currency, fx }: { active?: boolean; payload?: Array<{ value: number | null }>; label?: string; currency: string; fx?: ReportingFx | null }) {
  if (!active || !payload?.[0]) return null;
  return <div style={{ border: "1px solid var(--ck-border-strong)", borderRadius: 8, background: "var(--ck-raised)", padding: "8px 10px" }}><div style={{ color: "var(--ck-slate)", fontSize: 12 }}>{label ?? ""}</div><strong style={{ display: "block", marginTop: 4, fontFamily: "var(--font)", fontSize: 12 }}>{payload[0].value == null ? "Unpriced" : formatReportedAmount(payload[0].value, currency, fx)}</strong></div>;
}

function ContributorPage() {
  const { currentProjectId, projects, org, workspaceSettings, user, setCurrentProjectId } = useAuth();
  const [params, setParams] = useSearchParams();
  const requestedProjectId = params.get("project");
  const requestedProject = requestedProjectId ? projects.find((project) => project.id === requestedProjectId) : undefined;
  const projectId = requestedProject?.id ?? currentProjectId ?? projects[0]?.id ?? null;
  const type = params.get("type")?.toLowerCase() ?? "feature";
  const dimension = dimensionForType[type] ?? "feature";
  const name = params.get("name") ?? params.get("value") ?? params.get("feature") ?? (isPrototypePreview() ? "Search" : "");
  const period = parsePeriod(params.get("period"));
  const timezone = workspaceSettings?.timezone ?? org?.timezone;
  const currency = workspaceSettings?.reportingCurrency ?? "USD";
  const fx = workspaceSettings?.fx;
  const environment = params.get("environment") ?? "all";
  const tab = params.get("tab") === "Traces" ? "Traces" : "Summary";
  const contextKey = params.get("contextKey");
  const [detail, setDetail] = useState<CostContributorDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scope = useMemo(() => scopeParams(projectId ?? "", period, timezone), [projectId, period, timezone]);
  const { from, to, query } = scope;

  useEffect(() => {
    if (requestedProject && requestedProject.id !== currentProjectId) setCurrentProjectId(requestedProject.id);
  }, [requestedProject, currentProjectId, setCurrentProjectId]);

  useEffect(() => {
    if (!projectId || !name) return;
    let cancelled = false;
    const load = async () => {
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true); setError(null);
      try {
        const result = await getCostContributor(projectId, dimension, name, { from, to, environment: environment === "all" ? undefined : environment, contextKey: contextKey ?? undefined });
        if (!cancelled) setDetail(result);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Couldn’t load this breakdown");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [projectId, dimension, name, from, to, environment, contextKey]);

  if (!projectId) return <div className="ck-main-inner"><PageHeader title="Cost detail" /><Panel><EmptyPanel illustration="first-light" title="Ready for your first run" body="Connect a project to start." action={<Link className="ck-button ck-button-primary" to="/onboarding">Connect a project</Link>} /></Panel></div>;
  if (!name) return <div className="ck-main-inner"><PageHeader title="Cost detail" /><Panel><EmptyPanel title="Pick something to look at" body="Open a feature, function or model from the Costs page." action={<Link className="ck-button ck-button-secondary" to="/costs">Go to Costs</Link>} /></Panel></div>;
  const explicitState = prototypeState(params);
  const effectiveRole = prototypeRole(params, user?.role ?? "viewer");
  const namedState = PrototypeStatePanel({ state: explicitState, family: "Cost detail", title: explicitState === "no-matches" ? "No matching runs" : undefined, backHref: `/costs${query}`, retryHref: `/contributor${window.location.search}`, loadingRows: 5 });
  if (namedState) return namedState;
  if (loading) return <div className="ck-main-inner"><PageHeader title={contributorTitle(type, name)} actions={<Link className="ck-button ck-button-secondary" to={`/costs${query}`}><ArrowLeft size={13} /> Costs</Link>} /><Panel><LoadingRows count={5} columns={4} /></Panel></div>;
  if (!detail || error) return <div className="ck-main-inner"><PageHeader title="Couldn’t open this" actions={<Link className="ck-button ck-button-secondary" to={`/costs${query}`}><ArrowLeft size={13} /> Costs</Link>} /><Panel><EmptyPanel title="Nothing to show for this period" icon={<CircleAlert size={20} />} /></Panel></div>;
  const summary = detail.summary;
  const history = detail.history;
  const relatedFunctions = detail.related?.functions ?? detail.distributions?.functions ?? [];
  const scopeQuery = new URLSearchParams({ project: projectId, period });
  if (environment !== "all") scopeQuery.set("environment", environment);
  const changePeriod = (next: Period): void => setParams((current) => { current.set("period", next); if (next !== "custom") { current.delete("from"); current.delete("to"); } return current; });
  const changeEnvironment = (next: string): void => setParams((current) => { if (next === "all") current.delete("environment"); else current.set("environment", next); return current; });
  return <div className="ck-main-inner ck-contributor-page">
    <PageHeader title={contributorTitle(type, name)} actions={<><ScopeToolbar period={period} onPeriodChange={changePeriod} environment={environment} onEnvironmentChange={changeEnvironment} environmentOptions={[{ value: "all", label: "All environments" }, ...(typeof summary?.period === "object" && environment !== "all" ? [{ value: environment, label: environment }] : [])]} currency={currency} currencyNote={reportingCurrencyNote(currency, fx)} timezone={timezone ?? undefined} /><><Link className="ck-button ck-button-secondary" to={`/traces?${scopeQuery.toString()}&${dimension}=${encodeURIComponent(name)}`}><PrototypeIcon name="trace" size={16} /> View runs</Link><Link className="ck-button ck-button-secondary" to={`/policy-edit?${scopeQuery.toString()}&scopeDimension=${dimension}&scopeValue=${encodeURIComponent(name)}`}><ShieldCheck size={14} /> Set a budget</Link></></>} />
    <PrototypeStateNotice state={explicitState} family="contributor" role={effectiveRole} />
    <p className="ck-contributor-subtitle" style={{ margin: "-10px 0 18px", color: "var(--ck-slate)", fontSize: 14 }}>{type.charAt(0).toUpperCase() + type.slice(1)} · {environment === "all" ? "All environments" : environment} · {periodLabel(period).replace(/^./, (letter) => letter.toUpperCase())}</p>
    <div className="ck-tabs" role="tablist" aria-label="Detail view"><button className={`ck-tab ${tab === "Summary" ? "active" : ""}`} role="tab" aria-selected={tab === "Summary"} type="button" onClick={() => setParams((current) => { current.set("tab", "Summary"); return current; })}>Summary</button><button className={`ck-tab ${tab === "Traces" ? "active" : ""}`} role="tab" aria-selected={tab === "Traces"} type="button" onClick={() => setParams((current) => { current.set("tab", "Traces"); return current; })}>Runs</button></div>
    
    <div className="ck-metric-grid"><MetricCard icon="activity" label="Spend" value={summary?.known_cost == null ? "Unpriced" : formatReportedAmount(Number(summary.known_cost), currency, fx)} detail={summary?.coverage != null && Number(summary.coverage) < 1 ? `${Math.round(Number(summary.coverage) * 100)}% of calls priced` : "Every call priced"} /><MetricCard icon="trace" label="Runs" value={Number(summary?.trace_count ?? summary?.observations ?? detail.traces.length).toLocaleString()} /><MetricCard icon="cost" label="Per run" value={summary?.mean_cost_per_trace == null ? "—" : formatReportedAmount(Number(summary.mean_cost_per_trace), currency, fx)} detail="Average" /></div>
    {tab === "Traces" ? <Panel title="Runs">{detail.traces.length === 0 ? <EmptyPanel title="No runs in this period" /> : <div className="ck-table-wrap"><table className="ck-table"><thead><tr><th>Run</th><th>Started</th><th className="numeric">Calls</th><th className="numeric">Cost ({currency})</th></tr></thead><tbody>{detail.traces.slice(0, 50).map((trace) => <tr key={trace.trace_id}><td className="primary-cell"><Link className="ck-table-link" to={`/traces/${encodeURIComponent(trace.trace_id)}?project=${encodeURIComponent(projectId)}`}>{trace.trace_name || trace.trace_id}</Link><div className="muted mono">{trace.trace_id}</div></td><td>{formatDateTime(trace.started_at)}</td><td className="numeric">{trace.call_count.toLocaleString()}</td><td className="numeric">{trace.known_cost == null ? "Unpriced" : formatReportedAmount(Number(trace.known_cost), currency, fx)}</td></tr>)}</tbody></table></div>}</Panel> : <div className="ck-stack ck-contributor-history"><Panel title="Daily cost"><div className="ck-chart-wrap"><ContributorHistory detail={detail} currency={currency} fx={fx} /></div>{history.length === 0 && <p className="ck-table-note">No daily history for this period yet.</p>}</Panel></div>}
    {tab === "Summary" && <div className="ck-content-grid" style={{ marginTop: 16 }}><Panel title="Where in your code">{relatedFunctions.length === 0 ? <p className="ck-table-note" style={{ borderTop: 0 }}>No functions recorded for this yet.</p> : <div className="ck-table-wrap"><table className="ck-table"><thead><tr><th>Function</th><th className="numeric">Cost ({currency})</th><th className="numeric">Share</th><th className="numeric">Calls</th><th className="numeric">Per call</th></tr></thead><tbody>{relatedFunctions.slice(0, 5).map((row) => <tr key={row.key}><td className="primary-cell"><Link className="ck-table-link" to={`/contributor?type=Function&name=${encodeURIComponent(row.key)}&project=${encodeURIComponent(projectId)}&period=${period}`}>{row.label || row.key}</Link></td><td className="numeric">{row.known_cost == null ? "Unpriced" : formatReportedAmount(Number(row.known_cost), currency, fx)}</td><td className="numeric">{summary?.known_cost && row.known_cost != null ? formatPercent(Number(row.known_cost) / Number(summary.known_cost) * 100) : "—"}</td><td className="numeric">{Number(row.observations).toLocaleString()}</td><td className="numeric">{row.known_cost == null || !Number(row.priced_observations ?? row.observations) ? "Unpriced" : formatReportedAmount(Number(row.known_cost) / Number(row.priced_observations ?? row.observations), currency, fx)}</td></tr>)}</tbody></table></div>}</Panel><Panel title="Budget">{(() => { const policies = detail.policyActions?.policies ?? []; if (policies.length === 0) return <div className="ck-budget-check"><p className="ck-budget-check-empty">No budget covers {name} yet.</p><Link className="ck-button ck-button-secondary" to={`/policy-edit?${scopeQuery.toString()}&scopeDimension=${dimension}&scopeValue=${encodeURIComponent(name)}`}><ShieldCheck size={14} /> Set a budget</Link></div>; return <div className="ck-definition-list">{policies.slice(0, 3).map((policy) => <div key={String(policy["id"] ?? policy["name"])}><span>{String(policy["name"] ?? "Budget")}</span><strong>{policy["allowance"] != null ? formatReportedAmount(Number(policy["allowance"]), currency, fx) : ""} {String(policy["mode"]) === "enforce" ? "· stops calls" : "· alerts only"}</strong></div>)}</div>; })()}</Panel></div>}
  </div>;
}

function FindingDrawerPage() {
  const { currentProjectId, projects, user, workspaceSettings, setCurrentProjectId } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const explicitState = prototypeState(params);
  const requestedProjectId = params.get("project");
  const requestedProject = requestedProjectId ? projects.find((project) => project.id === requestedProjectId) : undefined;
  const projectId = requestedProject?.id ?? currentProjectId ?? projects[0]?.id ?? null;
  const requestedId = params.get("id") ?? params.get("findingId");
  const currency = workspaceSettings?.reportingCurrency ?? "USD";
  const fx = workspaceSettings?.fx;
  const [finding, setFinding] = useState<FindingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledging, setAcknowledging] = useState(false);
  useEffect(() => {
    if (requestedProject && requestedProject.id !== currentProjectId) setCurrentProjectId(requestedProject.id);
  }, [requestedProject, currentProjectId, setCurrentProjectId]);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const load = async () => {
      try {
        let id = requestedId;
        if (!id) {
          const response = await fetch(appUrl(`/api/v1/projects/${projectId}/findings`), { credentials: "include" });
          const data = await response.json() as { findings?: FindingResponse[] };
          id = data.findings?.[0]?.id ?? null;
        }
        if (!id) throw new Error("Nothing needs a look right now.");
        const response = await fetch(appUrl(`/api/v1/projects/${projectId}/findings/${encodeURIComponent(id)}`), { credentials: "include" });
        if (!response.ok) throw new Error("Couldn’t open this change. It may have been removed.");
        const data = await response.json() as { finding?: FindingResponse };
        if (!data.finding) throw new Error("Couldn’t open this change.");
        if (!cancelled) setFinding(data.finding);
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : "Couldn’t open this change."); }
    };
    void load();
    return () => { cancelled = true; };
  }, [projectId, requestedId]);

  const close = () => navigate(params.get("returnTo") || "/");
  const acknowledge = async (): Promise<void> => {
    if (!projectId || !finding || acknowledging || finding.state === "acknowledged") return;
    setAcknowledging(true); setError(null);
    try { await acknowledgeFinding(projectId, finding.id); setFinding({ ...finding, state: "acknowledged", acknowledgedAt: new Date().toISOString(), acknowledgedBy: user?.name ?? null }); }
    catch { setError("Couldn’t save that. Try again."); }
    finally { setAcknowledging(false); }
  };
  return <div className="ck-drawer-route"><DashboardUnderlay /><div className="ck-drawer-overlay" role="presentation" onClick={close}><aside className="ck-drawer" role="dialog" aria-modal="true" aria-labelledby="finding-drawer-title" onClick={(event) => event.stopPropagation()}>
    <div className="ck-drawer-close"><button className="ck-icon-button" type="button" onClick={close} aria-label="Close"><X size={16} /></button></div>
    <PrototypeStateNotice state={explicitState} family="finding" role={user?.role ?? "viewer"} onRetry={() => window.location.reload()} />
    {explicitState === "baseline-unavailable" && <div className="ck-alert" role="status"><CircleAlert size={14} /><div><strong>Not enough history to compare yet.</strong> Today’s costs are still here.</div></div>}
    {explicitState === "revised" && <div className="ck-alert" role="status"><CircleAlert size={14} /><div><strong>Costs changed after late usage arrived.</strong> The numbers below are the latest.</div></div>}
    {explicitState === "updated" && <div className="ck-alert" role="status"><Check size={14} /><div><strong>Updated.</strong> More matching runs arrived since this was first spotted.</div></div>}
    {explicitState === "no-longer" && <div className="ck-alert" role="status"><Check size={14} /><div><strong>Back to normal.</strong> This is no longer outside the usual range.</div></div>}
    {error && <div className="ck-alert ck-alert-error" role="alert"><CircleAlert size={14} /><div>{error}</div></div>}
    {!finding || explicitState === "loading" ? (error ? <EmptyPanel title="Nothing needs a look" icon={<Check size={20} />} /> : <LoadingRows count={5} columns={2} />) : <FindingBody finding={finding} projectId={projectId ?? ""} money={(value) => formatReportedAmount(value, currency, fx)} canAcknowledge={user?.role !== "viewer"} acknowledging={acknowledging} onAcknowledge={() => void acknowledge()} titleId="finding-drawer-title" />}
  </aside></div></div>;
}

function DashboardUnderlay() {
  return <div className="ck-drawer-underlay" aria-hidden="true"><Dashboard /></div>;
}

function capitalizeState(value: unknown): string {
  const text = String(value ?? "Unknown");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function accountingLabel(value: unknown): string {
  const text = String(value ?? "Unknown").toLowerCase();
  if (text === "complete" || text === "up to date") return "All calls priced";
  if (text === "partial" || text === "partial cost") return "Some calls unpriced";
  return capitalizeState(value);
}

/** Lists recent runs, preferring the same feature, so one-run compares never dead-end. */
function CompareRunPicker({ projectId, runId, currency, fx, onPick }: { projectId: string; runId: string; currency: string; fx?: ReportingFx | null; onPick: (id: string) => void }) {
  const [state, setState] = useState<{ base: Trace | null; runs: Trace[]; loading: boolean; error: string | null }>({ base: null, runs: [], loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const base = await getTrace(projectId, runId).then((result) => result.summary as unknown as Trace).catch(() => null);
      const feature = base && typeof base.feature === "string" ? base.feature : undefined;
      const recent = await getTraces(projectId, { limit: 12, sort: "newest", ...(feature ? { feature } : {}) });
      const runs = recent.traces.filter((trace: Trace) => trace.trace_id !== runId).slice(0, 10);
      if (!cancelled) setState({ base, runs, loading: false, error: null });
    })().catch(() => { if (!cancelled) setState({ base: null, runs: [], loading: false, error: "Couldn’t load recent runs." }); });
    return () => { cancelled = true; };
  }, [projectId, runId]);
  if (state.loading) return <Panel><LoadingRows count={5} columns={3} /></Panel>;
  if (state.error || state.runs.length === 0) return <Panel><EmptyPanel illustration="a-closer-look" title="No other runs to compare yet" body={state.error ?? "Once another run arrives, you can put it beside this one."} action={<Link className="ck-button ck-button-secondary" to="/traces">Go to Runs</Link>} /></Panel>;
  const feature = state.base && typeof state.base.feature === "string" ? state.base.feature : null;
  return <Panel title={feature ? `Recent ${feature} runs` : "Recent runs"}>
    <div className="ck-table-wrap"><table className="ck-table"><thead><tr><th>Run</th><th className="hide-mobile">Started</th><th className="numeric">Cost ({currency})</th><th><span className="sr-only">Compare</span></th></tr></thead><tbody>{state.runs.map((run) => <tr key={run.trace_id}><td className="primary-cell">{run.trace_name || run.trace_id}</td><td className="hide-mobile">{run.started_at ? formatDateTime(run.started_at) : "—"}</td><td className="numeric">{run.known_cost == null ? "Unpriced" : formatReportedAmount(Number(run.known_cost), currency, fx)}</td><td className="numeric"><button className="ck-button ck-button-secondary sm" type="button" onClick={() => onPick(run.trace_id)}>Compare</button></td></tr>)}</tbody></table></div>
  </Panel>;
}

function ComparePage() {
  const { currentProjectId, projects, org, workspaceSettings, setCurrentProjectId } = useAuth();
  const [params, setParams] = useSearchParams();
  const ids = useMemo(() => {
    const requested = (params.get("ids") ?? params.get("compare") ?? "").split(",").filter(Boolean).slice(0, 2);
    if (requested.length === 2) return requested;
    if (!isPrototypePreview()) return requested;
    if (requested.length === 1) return [requested[0], requested[0] === "search-request-1042" ? "search-request-0981" : "search-request-1042"];
    return ["search-request-0981", "search-request-1042"];
  }, [params]);
  const idsKey = ids.join(",");
  const requestedProjectId = params.get("project");
  const requestedProject = requestedProjectId ? projects.find((project) => project.id === requestedProjectId) : undefined;
  const projectId = requestedProject?.id ?? currentProjectId ?? projects[0]?.id ?? null;
  const currency = workspaceSettings?.reportingCurrency ?? "USD";
  const fx = workspaceSettings?.fx;
  const timezone = workspaceSettings?.timezone ?? org?.timezone;
  const explicitState = prototypeState(params);
  useEffect(() => {
    if (requestedProject && requestedProject.id !== currentProjectId) setCurrentProjectId(requestedProject.id);
  }, [requestedProject, currentProjectId, setCurrentProjectId]);
  const [traces, setTraces] = useState<Array<{ id: string; trace: { summary: Record<string, unknown>; events: TraceEvent[] } }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId || ids.length !== 2) return;
    let cancelled = false;
    Promise.all(ids.map((id) => getTrace(projectId, id))).then((results) => { if (!cancelled) { setTraces(results.map((trace, index) => ({ id: ids[index], trace }))); setError(null); } }).catch(() => { if (!cancelled) setError("One of these runs is no longer available."); });
    return () => { cancelled = true; };
  }, [projectId, idsKey, ids]);
  if (!projectId) return <div className="ck-main-inner"><PageHeader title="Compare runs" /><Panel><EmptyPanel illustration="first-light" title="Ready for your first run" body="Connect a project to start." action={<Link className="ck-button ck-button-primary" to="/onboarding">Connect a project</Link>} /></Panel></div>;
  if (ids.length === 1) return <div className="ck-main-inner"><PageHeader title="Compare runs" actions={<Link className="ck-button ck-button-secondary" to={`/traces/${encodeURIComponent(ids[0])}`}><ArrowLeft size={13} /> Back to run</Link>} /><CompareRunPicker projectId={projectId} runId={ids[0]} currency={currency} fx={fx} onPick={(other) => setParams((current) => { current.set("ids", `${ids[0]},${other}`); return current; })} /></div>;
  if (ids.length !== 2) return <div className="ck-main-inner"><PageHeader title="Compare runs" /><Panel><EmptyPanel illustration="a-closer-look" title="Pick two runs to compare" body="On the Runs page, tick two runs and press Compare." action={<Link className="ck-button ck-button-secondary" to="/traces">Go to Runs</Link>} /></Panel></div>;
  const namedState = PrototypeStatePanel({ state: explicitState, family: "Comparison", title: explicitState === "error" ? "Couldn’t compare these" : undefined, backHref: "/traces", retryHref: `/compare${window.location.search}`, loadingRows: 4 });
  if (namedState) return namedState;
  if (error || traces.length !== 2) return <div className="ck-main-inner"><PageHeader title="Compare runs" actions={<Link className="ck-button ck-button-secondary" to="/traces"><ArrowLeft size={13} /> Runs</Link>} /><Panel>{error ? <EmptyPanel title="Couldn’t compare these" body={error} icon={<CircleAlert size={20} />} /> : <LoadingRows count={4} columns={3} />}</Panel></div>;
  const metricRows = ["Cost", "Duration", "Calls", "Status", "Pricing"];
  const values = traces.map(({ trace }) => { const events = trace.events.filter((event) => event.event_type === "call" || !event.event_type); const cost = trace.summary.known_cost == null ? events.reduce((sum, event) => sum + (event.cost_usd == null ? 0 : Number(event.cost_usd) || 0), 0) : Number(trace.summary.known_cost); return { events, cost, summary: trace.summary }; });
  const stepKey = (event: TraceEvent, index: number): string => { const context = typeof event.context === "string" ? (() => { try { return JSON.parse(event.context) as Record<string, unknown>; } catch { return {}; } })() : {}; return typeof context.stepKey === "string" ? context.stepKey : `step-${index + 1}`; };
  const steps = [...new Set(values.flatMap(({ events }) => events.map(stepKey)))];
  return <div className="ck-main-inner"><PageHeader title={params.get("kind") === "groups" ? "Compare batches" : params.get("kind") === "cohorts" ? "Compare periods" : "Compare runs"} /><PrototypeStateNotice state={explicitState} family="comparison" role="viewer" />{explicitState === "incomparable" && <div className="ck-alert" role="status"><CircleAlert size={15} /><div><strong>These runs used different settings.</strong> Compare with care; a difference isn’t necessarily a cause.</div></div>}{explicitState === "partial" && <div className="ck-alert ck-partial-notice" role="status"><CircleAlert size={15} /><div><strong>Some calls have no price.</strong> Totals include only the priced calls.</div></div>}<div className="ck-compare-grid ck-contributor-grid" style={{ padding: 0, marginBottom: 16 }}>{traces.map(({ id, trace }, index) => <div className="ck-compare-card" key={`${index}:${id}`}><div className="ck-overline">{index === 0 ? "Run A" : "Run B"}</div><h3>{String(trace.summary.trace_name ?? id)}</h3>{String(trace.summary.trace_name ?? id) !== id && <p className="mono">{id}</p>}<div className="ck-detail-id">{trace.summary.started_at ? [isPrototypePreview() ? formatDayDate(String(trace.summary.started_at), timezone ?? undefined) : formatDateTime(String(trace.summary.started_at)), trace.summary.environment ? String(trace.summary.environment) : null, trace.summary.release ? `Release ${String(trace.summary.release)}` : null].filter(Boolean).join(" · ") : "Time not recorded"}</div></div>)}</div><Panel className="ck-compare-metrics"><div className="ck-compare-table"><div className="ck-compare-row head"><strong></strong><strong>Run A</strong><strong>Run B</strong></div>{metricRows.map((label, index) => (index === 3 && String(values[0]?.summary.execution_state ?? "") === String(values[1]?.summary.execution_state ?? "")) || (index === 4 && String(values[0]?.summary.accounting_state ?? "complete") === String(values[1]?.summary.accounting_state ?? "complete")) ? null : <div className="ck-compare-row" key={label}><span>{label}</span>{values.map(({ events, cost, summary }, valueIndex) => <span key={`${valueIndex}:${String(summary.trace_id ?? "trace")}:${label}`}>{index === 0 ? (valueIndex === 1 ? `${formatReportedAmount(cost, currency, fx)} (${`${formatReportedAmount(Math.abs(cost - values[0].cost), currency, fx)} ${cost - values[0].cost >= 0 ? "more" : "less"}`})` : formatReportedAmount(cost, currency, fx)) : index === 1 ? formatDuration(Number(summary.elapsed_ms) || 0) : index === 2 ? events.length.toLocaleString() : index === 3 ? (String(summary.execution_state ?? "unknown") === "unknown" ? "Complete" : capitalizeState(summary.execution_state)) : accountingLabel(summary.accounting_state ?? "complete")}</span>)}</div>)}</div>{isPrototypePreview() && <p className="ck-table-note">Sample data.</p>}</Panel><Panel title="Call by call"><div className="ck-table-wrap"><table className="ck-table"><thead><tr><th>Step</th><th>Run A</th><th>Run B</th></tr></thead><tbody>{steps.map((key) => <tr key={key}><td>{key.startsWith("step-") ? `Call ${key.slice(5)}` : key}</td>{values.map(({ events }, valueIndex) => { const event = events.find((item, eventIndex) => stepKey(item, eventIndex) === key); return <td key={`${key}-${valueIndex}`}>{event ? <><div className="primary-cell">{event.bl_function || event.model || "Recorded call"}</div><div className="muted">{event.cost_usd == null ? "Unpriced" : formatReportedAmount(Number(event.cost_usd), currency, fx)} · {formatDuration(Number(event.duration_ms) || 0)}</div></> : <span className="muted">—</span>}</td>; })}</tr>)}</tbody></table></div></Panel></div>;
}

interface PolicyRecord {
  id: string;
  name?: string | null;
  scope?: Record<string, string | string[]>;
  mode: "monitor" | "enforce";
  status: "active" | "paused" | "archived";
  unit: "money" | "calls" | "tokens";
  allowance: number;
  currency?: string | null;
  window: string;
  timezone?: string | null;
  usage?: { observed?: number | null; committed?: number | null; overLimit?: number | null };
}

const REFUSAL_REASON: Record<string, string> = {
  budget_exhausted: "Limit reached",
  price_unavailable: "Price unknown",
  decision_unavailable: "Budget check unavailable",
  unsupported_integration: "Unsupported integration",
  unbounded_request: "No size limit on the call",
  missing_context: "Missing budget labels",
  idempotency_conflict: "Duplicate request",
  call_too_expensive: "Call over the limit",
};

const WINDOW_WORDS: Record<string, string> = { calendar_month: "per month", calendar_day: "per day", calendar_minute: "per minute", per_trace: "per run", per_execution: "per batch", per_call: "per call" };
const SCOPE_SUGGESTION_DIMENSIONS = new Set<string>(["feature", "customer", "model", "provider"]);
const MAX_SCOPE_VALUES = 50;
const MAX_SCOPE_VALUE_LENGTH = 200;

/** "search, answer +1": a group shows its first two values. */
function scopeValueText(value: string | string[]): string {
  const values = Array.isArray(value) ? value : [value];
  return values.length > 2 ? `${values.slice(0, 2).join(", ")} +${values.length - 2}` : values.join(", ");
}

function parseScopeValues(text: string): string[] {
  return [...new Set(text.split(",").map((value) => value.trim()).filter(Boolean))];
}

function refusalReason(decision: Record<string, unknown>): string {
  const refusal = decision.refusal as { reason?: string } | null | undefined;
  const reason = refusal?.reason ?? (decision.reason as string | undefined);
  return reason ? REFUSAL_REASON[reason] ?? reason : "—";
}

function policyDisplayValue(policy: PolicyRecord, value: number | null | undefined, currency: string): string {
  if (value == null) return "Unavailable";
  return policy.unit === "money" ? formatReportedAmount(value, currency, undefined) : `${value.toLocaleString()} ${policy.unit}`;
}

function PrototypePolicyDetail({ policyId, state, canManage }: { policyId: string; state: string; canManage: boolean }) {
  const isJob = policyId === "job";
  const isVoice = policyId === "voice";
  const paused = state === "paused";
  const title = isJob ? "Nightly document budget" : isVoice ? "Voice calls per conversation" : policyId === "search" ? "Search monthly budget" : "Atlas monthly budget";
  const scope = isJob ? "Group: nightly-document-import" : isVoice ? "Voice · Per run" : policyId === "search" ? "Feature: Search · All environments" : "Atlas · All environments";
  const version = isJob ? "v3" : "v1";
  const amount = isVoice ? "20 calls" : isJob ? "$6.00" : policyId === "search" ? "$200.00" : "$400.00";
  const observed = isVoice ? "8 calls" : isJob ? "$6.18" : policyId === "search" ? "$142.80" : "$248.60";
  const windowLabel = isVoice ? "Calls per run" : isJob ? "Per batch" : "Monthly";
  const enforced = isJob;
  const showDecision = isJob && ["default", "refused", "decision-unavailable", "stop-requested", "stop-confirmed", "unknown-exposure"].includes(state);
  const decisionTitle = state === "stop-requested" ? "Pause requested. Stop not yet confirmed." : state === "stop-confirmed" ? "Stop confirmed" : state === "decision-unavailable" ? "A call was refused because we couldn’t check it" : "A call was refused by this budget";
  const decisionBody = state === "stop-requested" ? "Your app received the stop request. It hasn’t confirmed it stopped yet." : state === "stop-confirmed" ? "The integration supplied an acknowledgement at 02:14:16 IST. This is separate from the earlier refused call." : "Nightly document import · 20 Sep, 02:14:08 IST. No provider request was sent for the refused call. In-flight usage can still arrive.";
  const headerActions = canManage ? <><Link className="ck-button ck-button-secondary" to={`/policy-edit?id=${encodeURIComponent(policyId)}&project=proj_preview`}><Save size={13} /> Edit budget</Link><button className="ck-button ck-button-secondary" type="button">{paused ? "Resume budget" : "Pause budget"}</button></> : <button className="ck-button ck-button-secondary" type="button" disabled>Read-only</button>;
  if (state === "loading") return <div className="ck-main-inner ck-policy-detail-page prototype-policy-detail-page"><PageHeader title={title} description={`${scope} · Policy ${version}`} actions={headerActions} /><p className="ck-panel-subtitle prototype-policy-loading-copy">Loading budget…</p></div>;
  return <div className="ck-main-inner ck-policy-detail-page prototype-policy-detail-page">
    <PageHeader title={title} description={`${scope} · Policy ${version}`} actions={headerActions} />
    <div className="ck-pill-row prototype-policy-detail-pills"><StatusPill tone={enforced ? "info" : "neutral"}>{enforced && <ShieldCheck size={11} aria-hidden="true" />}{paused ? "Paused" : enforced ? "Stops new calls" : "Alerts only"}</StatusPill><StatusPill tone="neutral">{windowLabel}</StatusPill><StatusPill tone="neutral">USD · Asia/Kolkata</StatusPill></div>
    {state === "restricted" && <div className="ck-alert prototype-policy-decision-notice" role="status"><ShieldCheck size={15} /><div><strong>Read-only access</strong><span>You can see costs and usage. Changing budgets needs an Owner or Admin.</span><Link className="ck-finding-link" to="/settings?section=team">View permissions</Link></div></div>}
    {showDecision && <div className="ck-alert ck-alert-error prototype-policy-decision-notice" role="status"><ShieldCheck size={15} /><div><strong>{decisionTitle}</strong><span>{decisionBody}</span></div><button className="ck-button ck-button-secondary sm" type="button" onClick={() => document.getElementById("policy-decision-history")?.scrollIntoView({ behavior: "smooth", block: "start" })}>View decision</button></div>}
    {paused && <div className="ck-alert prototype-policy-decision-notice" role="status"><CircleAlert size={15} /><div><strong>This budget is paused</strong><span>New calls aren’t checked against it. Other budgets still apply.</span></div></div>}
    {state === "error" && <div className="ck-alert ck-alert-error prototype-policy-decision-notice" role="alert"><CircleAlert size={15} /><div><strong>Could not refresh</strong><span>Showing the last history we loaded.</span><button className="ck-button ck-button-quiet" type="button">Retry</button></div></div>}
    <div className="ck-metric-grid prototype-policy-detail-metrics"><article className="ck-metric-card"><div className="ck-metric-label">Allowance</div><div className="ck-metric-value">{amount}</div><div className="ck-metric-detail">{isJob ? "Each batch gets its own limit" : isVoice ? "Per run · resets each run" : "Calendar window · Resets 1 Oct, 00:00 IST"}</div></article><article className="ck-metric-card"><div className="ck-metric-label">{isJob ? "Cost so far" : "Observed usage"}</div><div className="ck-metric-value">{observed}</div><div className="ck-metric-detail">{isJob ? "Includes $0.30 that arrived after the decision" : "Same as the budget"}</div></article><article className="ck-metric-card"><div className="ck-metric-label">Reserved for calls in progress</div><div className="ck-metric-value">{isJob ? "Unavailable" : "$0.00"}</div><div className="ck-metric-detail">{isJob ? "No reliable reservation total was reported." : "No in-flight reservations reported"}</div><div className="ck-metric-detail">{isJob ? "Precise remaining capacity is not shown." : "Observed spend is separate from commitments."}</div></article></div>
    <div className="ck-content-grid prototype-policy-detail-grid"><Panel title="How this budget works"><div className="ck-definition-list"><div><span>Mode</span><strong>{paused ? "Paused" : enforced ? "Stops new calls" : "Alerts only"}</strong></div><div><span>Action</span><strong>{enforced ? "Refuse new matching calls" : "Send alerts"}</strong></div>{isJob && <div><span>If your app has a fallback</span><strong>Configured by application</strong><small>Supplied fallback: mark remaining items deferred.<br />The console did not choose a cheaper model.</small></div>}<div><span>Unknown price / required decision</span><strong>{enforced ? "Refuse the matching call" : "Record incomplete coverage"}</strong></div></div></Panel><Panel title="Notifications and scope"><div className="ck-definition-list"><div><span>Warning thresholds</span><strong>80% and 100%</strong></div><div><span>Recipients</span><strong>Alex Morgan · Owner</strong></div><div><span>Refused calls</span><strong>First refusal immediately</strong></div><div><span>Equivalent later refusals</span><strong>Grouped hourly</strong></div></div></Panel></div><Panel title="Decision history" id="policy-decision-history" actions={<StatusPill tone="neutral">Immutable records</StatusPill>}><div className="ck-table-wrap"><table className="ck-table"><thead><tr><th>Decision time</th><th>Affected work</th><th className="hide-mobile">Decision basis</th><th>Action / result</th><th className="hide-mobile">Version</th></tr></thead><tbody>{isJob ? <><tr><td>20 Sep, 02:14:08<div className="muted">IST</div></td><td><button className="ck-button ck-button-quiet sm" type="button">nightly-document-import</button><div className="muted">Execution: docs-0920</div></td><td className="hide-mobile">$5.88 observed + $0.24 requested<div className="muted">Would exceed $6.00</div></td><td><StatusPill tone="critical">{state === "decision-unavailable" ? "Decision unavailable" : "Next call refused"}</StatusPill><div className="muted">Provider call not sent</div></td><td className="hide-mobile">v3</td></tr><tr><td>20 Sep, 02:14:12<div className="muted">IST</div></td><td>In-flight document calls<div className="muted">Previously admitted work</div></td><td className="hide-mobile">+$0.30 observed after refusal<div className="muted">$6.18 observed so far</div></td><td><StatusPill tone="info">Accounting updating</StatusPill></td><td className="hide-mobile">v3</td></tr></> : <tr><td>20 Sep, 14:33<div className="muted">IST</div></td><td>Selected project activity</td><td className="hide-mobile">{observed} observed</td><td><StatusPill tone="info">Monitoring only</StatusPill><div className="muted">No calls refused</div></td><td className="hide-mobile">v1</td></tr>}</tbody></table></div></Panel><p className="ck-table-note prototype-freshness" style={{ borderTop: 0, paddingLeft: 0, paddingRight: 0 }}><Clock size={12} aria-hidden="true" /> Updated 14:33 IST · Demo data</p>
  </div>;
}

function PolicyDetailPage() {
  const { currentProjectId, projects, workspaceSettings, setCurrentProjectId, user } = useAuth();
  const [params] = useSearchParams();
  const requestedProjectId = params.get("project");
  const requestedProject = requestedProjectId ? projects.find((project) => project.id === requestedProjectId) : undefined;
  const projectId = requestedProject?.id ?? currentProjectId ?? projects[0]?.id ?? null;
  const policyId = params.get("id") ?? params.get("policy");
  const explicitState = prototypeState(params);
  const currency = workspaceSettings?.reportingCurrency ?? "USD";
  const [policy, setPolicy] = useState<PolicyRecord | null>(null);
  const [decisions, setDecisions] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const canManage = user?.role === "owner" || user?.role === "admin";
  useEffect(() => {
    if (requestedProject && requestedProject.id !== currentProjectId) setCurrentProjectId(requestedProject.id);
  }, [requestedProject, currentProjectId, setCurrentProjectId]);
  async function setPolicyStatus(next: "active" | "paused"): Promise<void> {
    if (!projectId || !policy) return;
    setStatusSaving(true); setStatusError(null);
    try {
      const response = await fetch(appUrl(`/api/v1/projects/${projectId}/budget/policies/${encodeURIComponent(policy.id)}`), { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: next }) });
      if (!response.ok) throw new Error(next === "paused" ? "Couldn’t pause this budget." : "Couldn’t resume this budget.");
      const data = await response.json() as { policy?: PolicyRecord };
      setPolicy((current) => data.policy ? { ...current, ...data.policy } : current ? { ...current, status: next } : current);
    } catch (reason) {
      setStatusError(reason instanceof Error ? reason.message : "Couldn’t update this budget.");
    } finally {
      setStatusSaving(false);
    }
  }
  useEffect(() => {
    if (!projectId || !policyId) return;
    let cancelled = false;
    const load = async () => {
      await Promise.resolve();
      try {
        const [policyResponse, decisionsResponse] = await Promise.all([
          fetch(appUrl(`/api/v1/projects/${projectId}/budget/policies/${encodeURIComponent(policyId)}`), { credentials: "include" }),
          fetch(appUrl(`/api/v1/projects/${projectId}/budget/policies/${encodeURIComponent(policyId)}/decisions`), { credentials: "include" }),
        ]);
        if (!policyResponse.ok) throw new Error("It may have been archived, or you don’t have access.");
        const policyData = await policyResponse.json() as { policy?: PolicyRecord };
        const decisionsData = decisionsResponse.ok ? await decisionsResponse.json() as { decisions?: Array<Record<string, unknown>> } : {};
        if (!cancelled) { setPolicy(policyData.policy ?? null); setDecisions(decisionsData.decisions ?? []); setError(policyData.policy ? null : "Couldn’t open this budget."); setLoading(false); }
      } catch (reason) { if (!cancelled) { setError(reason instanceof Error ? reason.message : "Couldn’t open this budget."); setLoading(false); } }
    };
    void load();
    return () => { cancelled = true; };
  }, [projectId, policyId]);
  if (!projectId || !policyId) return <div className="ck-main-inner"><Link className="ck-back-link" to="/budgets"><ArrowLeft size={13} /> Budgets</Link><PageHeader title="No budget selected" /><Panel><EmptyPanel title="Pick a budget" body="Open one from Budgets to see its limit and history." action={<Link className="ck-button ck-button-secondary" to="/budgets">Go to Budgets</Link>} /></Panel></div>;
  const panelState = isPrototypePreview() && ["loading", "error", "restricted"].includes(explicitState) ? "default" : explicitState;
  const namedState = PrototypeStatePanel({ state: panelState as typeof explicitState, family: "Budget", title: explicitState === "error" ? "Couldn’t open this budget" : undefined, backHref: "/budgets", retryHref: `/policy${window.location.search}`, loadingRows: 5 });
  if (namedState) return namedState;
  if (isPrototypePreview() && explicitState === "loading") {
    const role = prototypeRole(params, user?.role ?? "viewer");
    return <PrototypePolicyDetail policyId={policyId} state="loading" canManage={role === "owner" || role === "admin"} />;
  }
  if (loading) return <div className="ck-main-inner"><Link className="ck-back-link" to="/budgets"><ArrowLeft size={13} /> Budgets</Link><PageHeader title="Loading budget" /><Panel><LoadingRows count={5} columns={4} /></Panel></div>;
  if (!policy || error) return <div className="ck-main-inner"><Link className="ck-back-link" to="/budgets"><ArrowLeft size={13} /> Budgets</Link><PageHeader title="Couldn’t open this budget" /><Panel><EmptyPanel title="Budget unavailable" body={error ?? "It may have been archived, or you don’t have access."} icon={<CircleAlert size={20} />} /></Panel></div>;
  if (isPrototypePreview()) {
    const role = prototypeRole(params, user?.role ?? "viewer");
    return <PrototypePolicyDetail policyId={policyId} state={explicitState} canManage={role === "owner" || role === "admin"} />;
  }
  const observed = policy.usage?.observed;
  const committed = policy.usage?.committed;
  const allowanceValue = Number(policy.allowance) || 0;
  const ratio = observed != null && allowanceValue > 0 ? observed / allowanceValue : null;
  const status = policy.status === "paused" ? { tone: "neutral" as const, label: "Paused" } : policy.status === "archived" ? { tone: "neutral" as const, label: "Archived" } : ratio == null ? { tone: "neutral" as const, label: "Waiting for usage" } : ratio >= 1 ? { tone: "critical" as const, label: "Limit reached" } : ratio >= 0.8 ? { tone: "warn" as const, label: "Needs a look" } : { tone: "good" as const, label: "Within budget" };
  const windowWords = WINDOW_WORDS[policy.window] ?? policy.window;
  const perCall = policy.window === "per_call";
  const overLimit = Number(policy.usage?.overLimit) || 0;
  const scopeWords = Object.entries(policy.scope ?? {}).filter(([key]) => key !== "project").map(([key, value]) => `${key === "group" ? "Experiment" : key.charAt(0).toUpperCase() + key.slice(1)}: ${scopeValueText(value)}`).join(" · ") || "Whole project";
  return <div className="ck-main-inner ck-policy-detail-page">
    <Link className="ck-back-link" to="/budgets"><ArrowLeft size={13} /> Budgets</Link>
    <PageHeader title={policy.name || "Budget"} description={`${scopeWords} · ${policy.mode === "enforce" ? "Stops new calls when reached" : "Alerts only"}`} actions={canManage ? <>{policy.status !== "archived" && <button className="ck-button ck-button-quiet" type="button" disabled={statusSaving} onClick={() => void setPolicyStatus(policy.status === "paused" ? "active" : "paused")}>{policy.status === "paused" ? statusSaving ? "Resuming" : "Resume" : statusSaving ? "Pausing" : "Pause"}</button>}<Link className="ck-button ck-button-secondary" to={`/policy-edit?id=${encodeURIComponent(policy.id)}&project=${encodeURIComponent(projectId)}`}><Save size={14} /> Edit budget</Link></> : undefined} />
    {statusError && <div className="ck-alert ck-alert-error" role="alert"><CircleAlert size={15} /><div><strong>{statusError}</strong></div></div>}
    <PrototypeStateNotice state={explicitState} family="policy" role="viewer" />
    {["refused", "stop-requested", "stop-confirmed", "decision-unavailable", "unknown-exposure", "paused"].includes(explicitState) && <div className="ck-alert" role="status"><ShieldCheck size={15} /><div><strong>{explicitState === "refused" ? "A call was refused." : explicitState === "decision-unavailable" ? "We couldn’t check a call, so it was refused." : explicitState === "unknown-exposure" ? "Some spend isn’t known yet." : explicitState === "paused" ? "This budget is paused." : explicitState === "stop-requested" ? "Pause requested. Stop not yet confirmed." : "Stop confirmed."}</strong> Late costs still show below.</div></div>}
    <StatusLine tone={status.tone} right={<span>{policy.status === "active" ? "Checking new calls" : "Not checking"}</span>}>{status.label === "Within budget" ? `${policy.name || "This budget"} is within its limit.` : status.label === "Needs a look" ? perCall ? `The largest call used ${Math.floor((ratio ?? 0) * 100)}% of the limit.` : `${Math.floor((ratio ?? 0) * 100)}% of this budget is used.` : status.label === "Limit reached" ? (perCall ? (policy.mode === "enforce" ? "Calls over the limit are refused." : "A call went over the limit. Nothing is blocked; alerts were sent.") : policy.mode === "enforce" ? "Limit reached. New matching calls are being refused." : "Limit reached. Nothing is blocked; alerts were sent.") : status.label === "Waiting for usage" ? "No usage counted yet." : `This budget is ${status.label.toLowerCase()}.`}</StatusLine>
    <div className="ck-metric-grid">
      <MetricCard icon="shield" label="Limit" value={policyDisplayValue(policy, policy.allowance, policy.currency ?? currency)} detail={windowWords.charAt(0).toUpperCase() + windowWords.slice(1)} />
      {perCall ? <MetricCard icon="activity" label="Largest call" value={policyDisplayValue(policy, observed, policy.currency ?? currency)} detail={overLimit > 0 ? `${overLimit.toLocaleString()} over the limit · last 24 hours` : "Last 24 hours"} /> : <MetricCard icon="activity" label="Used" value={policyDisplayValue(policy, observed, policy.currency ?? currency)} detail={ratio == null ? "Nothing counted yet" : `${Math.floor(ratio * 100)}% of the limit`} />}
      {policy.mode === "enforce" && !perCall && <MetricCard icon="clock" label="Reserved for calls in progress" value={policyDisplayValue(policy, committed, policy.currency ?? currency)} />}
    </div>
    {policy.mode === "enforce" && <Panel title="Recent decisions">{decisions.length === 0 ? <EmptyPanel title="No calls refused yet" /> : <div className="ck-table-wrap"><table className="ck-table"><thead><tr><th>Decision</th><th>Reason</th><th>When</th></tr></thead><tbody>{decisions.map((decision, index) => <tr key={String(decision.id ?? index)}><td><StatusPill tone={decision.decision === "refuse" ? "critical" : "good"}>{decision.decision === "refuse" ? "Refused" : "Allowed"}</StatusPill></td><td>{refusalReason(decision)}</td><td>{decision.created_at ? formatDateTime(String(decision.created_at)) : "—"}</td></tr>)}</tbody></table></div>}</Panel>}
  </div>;
}

function PrototypePolicyReview({ projectName, scopeValue, amount, windowLabel, timezone, enforce, onBack }: { projectName: string; scopeValue: string; amount: string; windowLabel: string; timezone: string; enforce: boolean; onBack: () => void }) {
  return <div className="ck-main-inner ck-policy-editor-page prototype-policy-route prototype-policy-review-page">
    <PageHeader title="Check your budget" actions={<button className="ck-button ck-button-quiet prototype-policy-back" type="button" onClick={onBack}><ArrowLeft size={13} /> Back to edit</button>} />
    <div className="prototype-policy-review-layout">
      <section className="ck-panel prototype-policy-review-card">
        <div className="prototype-policy-review-intro"><div className="ck-overline">Before you save</div><h2>Search monthly budget</h2><p>Applies to new calls only.</p></div>
        <div className="prototype-policy-review-list"><div><span>Project</span><strong>{projectName}</strong></div><div><span>Matches</span><strong>{scopeValue}</strong></div><div><span>Environment</span><strong>All environments</strong></div><div><span>Allowance</span><strong>${amount} · {windowLabel.toLowerCase()}</strong></div><div><span>Timezone</span><strong>{timezone}</strong></div><div><span>Mode</span><strong>{enforce ? "Stops new calls" : "Alerts only"}</strong></div><div><span>Action</span><strong>{enforce ? "Refuse new matching calls" : "Send alerts"}</strong></div><div><span>If your app has a fallback</span><strong>Not configured</strong></div><div><span>If we can’t check a call</span><strong>{enforce ? "Refuse it" : "Mark totals partial"}</strong></div></div>
        <div className="prototype-policy-review-confirm"><div className={`ck-alert ${enforce ? "ck-alert-warning" : ""}`}><ShieldCheck size={15} /><div><strong>{enforce ? "This changes how your app behaves" : "This never blocks calls"}</strong><span>{enforce ? "The SDK refuses matching calls before they reach the provider. Calls already running still finish and still cost money." : "You get alerts at 80% and 100%. Calls keep going."}</span></div></div><label className="prototype-policy-check"><input type="checkbox" /> <span>I understand what this budget covers and what happens when it’s reached.</span></label></div>
      </section>
      <aside className="ck-panel prototype-policy-review-aside"><h3>Other budgets that apply</h3><div className="prototype-policy-review-aside-body"><StatusPill tone="neutral">Atlas monthly budget</StatusPill><p>$400 / month · Alerts only</p><hr /><h4>Every stop budget must allow a call</h4><p>If any one of them refuses, the call is refused, and we record which one.</p><hr /><h4>Your integration</h4><p>Sample HTTP integration: can check calls before they’re sent.</p></div></aside>
    </div>
    <div className="prototype-policy-save-footer"><span>Design preview · nothing is saved</span><div><button className="ck-button ck-button-secondary" type="button" onClick={onBack}>Cancel</button><button className="ck-button ck-button-primary" type="button">{enforce ? "Save and stop calls" : "Save budget"}<ArrowRight size={13} /></button></div></div>
  </div>;
}

function PolicyEditPage() {
  const { currentProjectId, projects, org, workspaceSettings, setCurrentProjectId, user } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const requestedProjectId = params.get("project");
  const requestedProject = requestedProjectId ? projects.find((project) => project.id === requestedProjectId) : undefined;
  const [selectedProjectId, setSelectedProjectId] = useState(requestedProject?.id ?? currentProjectId ?? projects[0]?.id ?? "");
  const projectId = selectedProjectId || requestedProject?.id || currentProjectId || projects[0]?.id || null;
  const policyId = params.get("id");
  const explicitState = prototypeState(params);
  const currency = workspaceSettings?.reportingCurrency ?? "USD";
  const timezone = workspaceSettings?.timezone ?? org?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // The editor opens on the same useful, concrete fixture as the approved
  // prototype. Query parameters still win when the editor is opened from a
  // contributor/finding or when an existing policy is being edited.
  const prototypeDefaults = isPrototypePreview();
  const initialScopeValue = params.get("scopeValue") ?? params.get("feature") ?? (prototypeDefaults ? "Search" : "");
  const [name, setName] = useState(params.get("name") ?? (prototypeDefaults ? "Search monthly budget" : initialScopeValue ? `${initialScopeValue.split(",").map((value) => value.trim()).filter(Boolean).join(", ")} monthly budget` : "Monthly budget"));
  const [scopeDimension, setScopeDimension] = useState(params.get("scopeDimension") ?? (params.get("feature") || prototypeDefaults ? "feature" : "project"));
  const [scopeValue, setScopeValue] = useState(initialScopeValue);
  const [allowance, setAllowance] = useState(prototypeDefaults ? "200" : params.get("amount") ?? "");
  const [unit, setUnit] = useState<"money" | "calls" | "tokens">("money");
  const [windowKind, setWindowKind] = useState("calendar_month");
  const [policyCurrency, setPolicyCurrency] = useState<"USD" | "INR">(currency === "INR" ? "INR" : "USD");
  const [mode, setMode] = useState<"monitor" | "enforce">("monitor");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [suggestions, setSuggestions] = useState<{ dimension: string; values: string[] }>({ dimension: "", values: [] });
  const prototype = isPrototypePreview();
  const role = prototype ? prototypeRole(params, user?.role ?? "owner") : user?.role ?? "viewer";
  const proposal = explicitState === "proposal" || (role !== "owner" && role !== "admin");
  const [copied, setCopied] = useState(false);
  const prototypeLoading = prototype && explicitState === "loading";
  const prototypeError = prototype && explicitState === "error";
  const unavailable = explicitState === "unavailable";
  const scopeValues = parseScopeValues(scopeValue);
  useEffect(() => {
    // The prototype exposes these editor variants as deterministic URLs. Seed
    // the form from the requested state so the preview communicates the same
    // policy mode/window instead of only showing a banner above a default form.
    if (explicitState === "enforce") setMode("enforce");
    if (explicitState === "per-execution") {
      setMode("enforce");
      setWindowKind("per_execution");
      setName("Nightly document budget");
      setScopeValue(params.get("group") ?? "nightly-document-import");
      setAllowance("6");
    }
    if (explicitState === "review") setReviewed(true);
    if (explicitState === "invalid") setAllowance("0");
  }, [explicitState, params]);
  useEffect(() => {
    const nextProjectId = requestedProject?.id ?? currentProjectId ?? projects[0]?.id ?? "";
    setSelectedProjectId((current) => current || nextProjectId);
    if (requestedProject && requestedProject.id !== currentProjectId) setCurrentProjectId(requestedProject.id);
  }, [requestedProject, currentProjectId, projects, setCurrentProjectId]);
  useEffect(() => {
    if (!projectId || !policyId) return;
    let cancelled = false;
    const load = async () => {
      await Promise.resolve();
      const response = await fetch(appUrl(`/api/v1/projects/${projectId}/budget/policies/${encodeURIComponent(policyId)}`), { credentials: "include" });
      if (!response.ok) return;
      const data = await response.json() as { policy?: PolicyRecord };
      if (!cancelled && data.policy) { setName(data.policy.name ?? "Monthly budget"); setAllowance(String(data.policy.allowance)); setUnit(data.policy.unit); setPolicyCurrency(data.policy.currency === "INR" ? "INR" : "USD"); setWindowKind(data.policy.window); setMode(data.policy.mode); const [dimension, value] = Object.entries(data.policy.scope ?? {})[0] ?? []; if (dimension) setScopeDimension(dimension); setScopeValue(Array.isArray(value) ? value.join(", ") : value ?? ""); }
    };
    void load();
    return () => { cancelled = true; };
  }, [projectId, policyId, currency]);
  useEffect(() => {
    // Known values from the last 30 days of costs; the field still takes any name.
    if (!projectId || prototype || !SCOPE_SUGGESTION_DIMENSIONS.has(scopeDimension)) return;
    let cancelled = false;
    const { from, to } = periodDates("30d", timezone);
    getCostBreakdown(projectId, { groupBy: scopeDimension as CostDimension, from, to, limit: 50 })
      .then((result) => { if (!cancelled) setSuggestions({ dimension: scopeDimension, values: (result.contributors ?? []).map((row) => row.key ?? "").filter((key) => key && !key.startsWith("(")) }); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, scopeDimension, prototype, timezone]);
  async function copySummary(): Promise<void> {
    const windowWords = WINDOW_WORDS[windowKind] ?? windowKind;
    const limit = unit === "money" ? `${policyCurrency} ${allowance || "?"}` : `${allowance || "?"} ${unit}`;
    const covers = scopeDimension === "project" || scopeValues.length === 0 ? "Whole project" : `${scopeDimension}: ${scopeValues.join(", ")}`;
    const text = `${name}\n${limit} ${windowWords} · ${covers} · ${mode === "enforce" ? "Stops new calls" : "Alerts only"}`;
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { setError("Couldn’t copy. Select the form and copy it manually."); }
  }
  async function review(): Promise<void> {
    if (!projectId || !allowance || Number(allowance) <= 0) { setError("Enter a limit greater than zero."); return; }
    if (scopeDimension !== "project" && scopeValues.length === 0) { setError(`Enter which ${scopeDimension} this budget covers, or choose Whole project.`); return; }
    if (scopeValues.length > MAX_SCOPE_VALUES) { setError(`Up to ${MAX_SCOPE_VALUES} values.`); return; }
    if (scopeValues.some((value) => value.length > MAX_SCOPE_VALUE_LENGTH)) { setError(`Keep each value under ${MAX_SCOPE_VALUE_LENGTH} characters.`); return; }
    setSaving(true); setError(null);
    try {
      const payload = { name, scope: scopeDimension !== "project" && scopeValues.length > 0 ? { [scopeDimension]: scopeValues.length === 1 ? scopeValues[0] : scopeValues } : { project: projectId }, unit, allowance: Number(allowance), currency: unit === "money" ? policyCurrency : undefined, window: windowKind, timezone, mode, ...(policyId ? {} : { status: "active" }) };
      const response = await fetch(appUrl(`/api/v1/projects/${projectId}/budget/policies${policyId ? `/${encodeURIComponent(policyId)}` : ""}`), { method: policyId ? "PATCH" : "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(response.status === 403 ? "Only Owners and Admins can save budgets." : "Couldn’t save this budget. Try again.");
      setReviewed(true);
      if (isPrototypePreview()) {
        // Land on the explicit activation review instead of stranding the user
        // on the form with a relabeled button (prototype review step).
        const reviewParams = new URLSearchParams(params.toString());
        reviewParams.set("state", "review");
        navigate(`/policy-edit?${reviewParams.toString()}`);
        return;
      }
      // Live sessions land on the saved policy itself: there is no deferred
      // draft status, so the detail page is the honest confirmation surface.
      const saved = await response.json().catch(() => null) as { policy?: { id?: unknown } } | null;
      const savedId = typeof saved?.policy?.id === "string" && saved.policy.id ? saved.policy.id : policyId;
      navigate(savedId ? `/policy?id=${encodeURIComponent(savedId)}&project=${encodeURIComponent(projectId)}` : "/budgets");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn’t save this budget. Try again."); } finally { setSaving(false); }
  }
  if (!projectId) return <div className="ck-main-inner"><PageHeader title="Create a budget" /><Panel><EmptyPanel title="Connect a project first" action={<Link className="ck-button ck-button-primary" to="/onboarding">Connect a project</Link>} /></Panel></div>;
  if (prototypeLoading) return <div className="ck-main-inner ck-policy-editor-page prototype-policy-route"><PageHeader title={proposal ? "Suggest a budget" : "Create a budget"} description={proposal ? "An Owner or Admin needs to turn this on." : undefined} actions={<button className="ck-button ck-button-quiet prototype-policy-back" type="button" onClick={() => navigate("/budgets")}><ArrowLeft size={13} /> Back to budgets</button>} /><Panel><p className="ck-panel-subtitle">Loading…</p><LoadingRows count={4} columns={3} /></Panel></div>;
  const namedState = PrototypeStatePanel({ state: prototypeError ? "default" : explicitState, family: "Budget editor", title: explicitState === "error" ? "Couldn’t save this budget" : undefined, backHref: "/budgets", retryHref: `/policy-edit${window.location.search}`, loadingRows: 4 });
  if (namedState) return namedState;
  const scopeLabel = scopeDimension !== "project" && scopeValues.length > 0 ? `${scopeDimension[0].toUpperCase()}${scopeDimension.slice(1)}: ${scopeValueText(scopeValues)}` : "Whole project";
  const projectName = projects.find((project) => project.id === projectId)?.name ?? (prototype ? "Atlas" : "this project");
  const environment = params.get("env") ?? "all environments";
  const environmentLabel = environment === "all" || environment === "all environments" ? "All environments" : environment;
  const windowLabel = ({ calendar_month: "Monthly", calendar_day: "Daily", per_trace: "Per run", per_execution: "Per batch", per_call: "Per call" } as Record<string, string>)[windowKind] ?? windowKind;
  const perCall = windowKind === "per_call";
  // Offer known values after the last comma, keeping what is already typed.
  const suggestionPrefix = scopeValue.includes(",") ? `${scopeValue.slice(0, scopeValue.lastIndexOf(",") + 1).trimEnd()} ` : "";
  const scopeSuggestions = suggestions.dimension === scopeDimension ? suggestions.values.filter((value) => !scopeValues.includes(value)) : [];
  const preview = scopeValue === "Search" ? "1,200 runs · $142.80" : scopeValue === "nightly-document-import" ? "40 runs · $6.18" : "Matching history preview available";
  const summaryAmount = unit === "money" ? formatReportedAmount(Number(allowance) || 0, policyCurrency, undefined) : `${Number(allowance || 0).toLocaleString()} ${unit}`;
  const summaryAction = perCall ? (mode === "enforce" ? "Refuse calls over the limit" : "Alert on calls over the limit") : mode === "enforce" ? "Stop new calls" : "Alert at 80% and 100%";
  if (prototype && explicitState === "review") return <PrototypePolicyReview projectName={projectName} scopeValue={scopeValue || "Search"} amount={allowance || "200"} windowLabel={windowLabel} timezone={timezone} enforce={mode === "enforce" || explicitState === "review"} onBack={() => navigate("/policy-edit?design=prototype&project=proj_preview")} />;
  return <div className="ck-main-inner ck-policy-editor-page prototype-policy-route">
    <Link className="ck-back-link" to="/budgets"><ArrowLeft size={13} /> Budgets</Link>
    <PageHeader title={proposal ? "Suggest a budget" : policyId ? "Edit budget" : "Create a budget"} description={proposal ? "An Owner or Admin needs to turn this on." : undefined} />
    {proposal && <div className="ck-alert prototype-policy-proposal-notice" role="status"><ShieldCheck size={15} /><div><strong>This won’t turn on by itself</strong><span>Only Owners and Admins can save budgets. Copy the summary and send it to one.</span></div></div>}
    {unavailable && <div className="ck-alert" role="status"><CircleAlert size={15} /><div><strong>This integration can’t stop calls.</strong><span>It doesn’t check prices before each call, so only alerts are available.</span></div></div>}
    {prototypeError && <div className="ck-alert ck-alert-error" role="alert"><CircleAlert size={15} /><div><strong>Couldn’t save this budget</strong><span>Your values are kept and nothing was turned on. Try again.</span></div></div>}
    {explicitState === "invalid" && <div className="ck-form-error" role="alert">Enter a limit greater than zero.</div>}
    <div className="ck-policy-editor-layout prototype-policy-layout">
      <form id="policy-form" className="ck-panel ck-form prototype-policy-form" onSubmit={(event) => { event.preventDefault(); void review(); }}>
        <div className="ck-form-section prototype-policy-section">
          <div className="ck-form-section-title"><span className="ck-section-number">1</span> Name</div>
          <label className="ck-form-field"><span>Budget name</span><input className="ck-input" name="policyName" value={name} onChange={(event) => setName(event.target.value)} required autoComplete="off" /></label>
        </div>
        <div className="ck-form-section prototype-policy-section prototype-policy-scope-section">
          <div className="ck-form-section-title"><span className="ck-section-number">2</span> Applies to</div>
          <div className="ck-form-grid prototype-policy-two-col"><label className="ck-form-field"><span>Project</span><span className="ck-form-select-wrap"><select className="ck-select" name="project" value={projectId ?? ""} onChange={(event) => setSelectedProjectId(event.target.value)}>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select><PrototypeIcon name="down" size={14} /></span></label><label className="ck-form-field"><span>Covers</span><span className="ck-form-select-wrap"><select className="ck-select" name="dimension" value={scopeDimension} onChange={(event) => setScopeDimension(event.target.value)}><option value="project">Whole project</option><option value="feature">A feature</option><option value="customer">A customer</option><option value="function">A function</option><option value="model">A model</option><option value="group">An experiment</option><option value="agent">An agent</option><option value="tool">A tool</option><option value="user">A user</option><option value="workflow">A workflow</option></select><PrototypeIcon name="down" size={14} /></span></label></div>
          {scopeDimension !== "project" && <label className="ck-form-field prototype-policy-match-field"><span>Which {scopeDimension === "group" ? "experiments" : `${scopeDimension}s`}?</span><input className="ck-input" name="scope" value={scopeValue} onChange={(event) => setScopeValue(event.target.value)} list={scopeSuggestions.length > 0 ? "policy-scope-suggestions" : undefined} autoComplete="off" placeholder={scopeDimension === "feature" ? "e.g. search, answer" : scopeDimension === "model" ? "e.g. gpt-4o" : scopeDimension === "agent" ? "e.g. browser-agent" : scopeDimension === "tool" ? "e.g. search_funds" : scopeDimension === "user" ? "e.g. user_123" : scopeDimension === "workflow" ? "e.g. nightly-import" : ""} /><small>Exact names, comma-separated.</small>{scopeSuggestions.length > 0 && <datalist id="policy-scope-suggestions">{scopeSuggestions.map((value) => <option key={value} value={`${suggestionPrefix}${value}`} />)}</datalist>}</label>}
          {prototype && <details className="prototype-policy-advanced"><summary>Advanced matching</summary><div className="prototype-policy-advanced-body"><label className="prototype-policy-check"><input type="checkbox" /> <span>Use a wildcard pattern. Preview matches before activation.</span></label><div className="ck-definition-list"><div><span>Project</span><strong>{projectName}</strong></div><div><span>Scope</span><strong>{scopeLabel}</strong></div><div><span>Future work</span><strong>Matching calls only</strong></div></div></div></details>}
          {prototype && <div className="prototype-policy-preview"><PrototypeIcon name="trace" size={15} /><span>Recent match preview: {preview} · 1–20 Sep · {environmentLabel}</span></div>}
        </div>
        <div className="ck-form-section prototype-policy-section">
          <div className="ck-form-section-title"><span className="ck-section-number">3</span> Limit</div>
          <div className="ck-form-grid prototype-policy-two-col"><label className="ck-form-field"><span>Measure</span><span className="ck-form-select-wrap"><select className="ck-select" name="unit" value={unit} onChange={(event) => setUnit(event.target.value as typeof unit)}><option value="money">Spend</option>{!perCall && <option value="calls">Number of calls</option>}<option value="tokens">Number of tokens</option></select><PrototypeIcon name="down" size={14} /></span></label>{unit === "money" && <label className="ck-form-field"><span>Currency</span><span className="ck-form-select-wrap"><select className="ck-select" name="currency" value={policyCurrency} onChange={(event) => setPolicyCurrency(event.target.value === "INR" ? "INR" : "USD")}><option value="USD">USD</option><option value="INR">INR</option></select><PrototypeIcon name="down" size={14} /></span></label>}</div>
          <div className="ck-form-grid prototype-policy-two-col prototype-policy-allowance-row"><label className="ck-form-field"><span>Amount</span><div className="prototype-policy-input-group"><span>{unit === "money" ? "$" : "#"}</span><input className="ck-input" type="number" name="amount" min="0.01" step={unit === "money" ? "0.01" : "1"} value={allowance} onChange={(event) => setAllowance(event.target.value)} placeholder={unit === "money" ? "e.g. 400" : "e.g. 1000"} required /></div></label><label className="ck-form-field"><span>Resets</span><span className="ck-form-select-wrap"><select className="ck-select" name="window" value={windowKind} onChange={(event) => { setWindowKind(event.target.value); if (event.target.value === "per_call" && unit === "calls") setUnit("money"); }}><option value="calendar_month">Every month</option><option value="calendar_day">Every day</option><option value="per_trace">For each run</option><option value="per_execution">For each batch</option><option value="per_call">Each call</option></select><PrototypeIcon name="down" size={14} /></span></label></div>
        </div>
        <div className="ck-form-section prototype-policy-section">
          <div className="ck-form-section-title"><span className="ck-section-number">4</span> When it’s reached</div>
          <div className="prototype-policy-radio-stack"><label className={`prototype-policy-radio ${mode === "monitor" ? "selected" : ""}`}><input type="radio" name="mode" value="monitor" checked={mode === "monitor"} onChange={() => setMode("monitor")} /><span><strong>Alert me</strong><small>Send alerts. Calls keep going.</small></span></label><label className={`prototype-policy-radio ${mode === "enforce" && !unavailable ? "selected" : ""}`} style={unavailable ? { opacity: 0.6 } : undefined}><input type="radio" name="mode" value="enforce" checked={mode === "enforce"} onChange={() => setMode("enforce")} disabled={unavailable} /><span><strong>Stop new calls</strong><small>{perCall ? "Refuses calls over the limit" : "Refuses new calls at the limit"}</small></span></label></div>
          
        </div>
        {error && <div className="ck-form-error" role="alert">{error}</div>}
      </form>
      <aside className="ck-panel prototype-policy-summary"><div className="prototype-policy-summary-body"><h2>Summary</h2><dl className="ck-definition-list"><div><dt>Covers</dt><dd>{scopeLabel} · {projectName}</dd></div><div><dt>Limit</dt><dd>{allowance ? `${summaryAmount} · ${windowLabel.toLowerCase()}` : "—"}</dd></div><div><dt>When reached</dt><dd>{summaryAction}</dd></div></dl><span className="prototype-policy-default"><PrototypeIcon name={mode === "enforce" ? "shield" : "info"} size={14} /> {mode === "enforce" ? "Stops new calls" : "Alerts only"}</span></div></aside>
    </div>
    <div className="prototype-policy-save-footer"><span>{proposal ? "Not active until an Owner or Admin saves it." : mode === "enforce" ? "Starts refusing calls as soon as you save." : ""}</span><div><button className="ck-button ck-button-secondary" type="button" onClick={() => navigate("/budgets")} disabled={saving}>Cancel</button>{proposal ? <button className="ck-button ck-button-primary" type="button" onClick={() => void copySummary()}>{copied ? "Copied" : "Copy summary"}</button> : <button className="ck-button ck-button-primary" form="policy-form" type="submit" disabled={saving}>{saving ? "Saving" : reviewed ? "Saved" : policyId ? "Save changes" : "Save budget"}</button>}</div></div>
  </div>;
}

export { ComparePage, ContributorPage, FindingDrawerPage, PolicyDetailPage, PolicyEditPage };

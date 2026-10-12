import { Fragment, useEffect, useRef } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { getAgentDetail, getAgents, getBudgetPolicies, getTabModels, getWorkflows, type AgentDetail, type AgentRun, type BudgetPolicy, type InsightScope, type RunGroup, type TokenUsage } from "../api";
import { currentRouterPath } from "../basePath";
import { RunFlow, runModel, RunSummaryStrip, useRunDetail } from "../components/RunFlow";
import { billedUnitsText, formatHitRate, formatTokenCount } from "../components/tokenUsage";
import { EmptyPanel, LoadingRows, MetricCard, PageHeader, Panel, StatusPill } from "../components/ConsolePrimitives";
import { formatDateTime, formatReportedAmount, periodDates, type ReportingFx } from "../components/consoleFormatters";
import { useAuth } from "../contexts/useAuth";
import { formatDuration } from "../utils";
import { useInsightScope, useScopedLoad } from "./useInsightScope";
import { ProviderLabel } from "../components/ProviderLogo";

function money(value: number | null | undefined, currency: string, fx?: ReportingFx | null): string {
  return value == null ? "Unpriced" : formatReportedAmount(value, currency, fx);
}

function failureRate(group: RunGroup): string {
  if (group.runs === 0) return "—";
  const rate = group.failedRuns / group.runs;
  return rate === 0 ? "0%" : rate < 0.01 ? "<1%" : `${Math.round(rate * 100)}%`;
}

function Totals({ groups, currency, fx, loading }: { groups: RunGroup[]; currency: string; fx?: ReportingFx | null; loading: boolean }) {
  const runs = groups.reduce((sum, group) => sum + group.runs, 0);
  const cost = groups.reduce((sum, group) => sum + (group.cost ?? 0), 0);
  const failed = groups.reduce((sum, group) => sum + group.failedRuns, 0);
  return <div className="ck-metric-grid">
    <MetricCard icon="trace" label="Runs" value={runs.toLocaleString()} loading={loading} />
    <MetricCard icon="cost" label="Spend" value={formatReportedAmount(cost, currency, fx)} detail={runs > 0 ? `${formatReportedAmount(cost / runs, currency, fx)} per run` : undefined} loading={loading} />
    <MetricCard icon="alert" label="Failed runs" value={failed.toLocaleString()} tone={failed > 0 ? "warn" : "neutral"} detail={runs > 0 ? `${Math.round(failed / runs * 100)}% of runs` : undefined} loading={loading} />
  </div>;
}

function GroupTable({ groups, label, showShape, currency, fx, onOpen }: { groups: RunGroup[]; label: string; showShape: boolean; currency: string; fx?: ReportingFx | null; onOpen: (group: RunGroup) => void }) {
  return <div className="ck-table-wrap"><table className="ck-table ck-table-clickable">
    <thead><tr><th>{label}</th><th className="numeric">Runs</th><th className="numeric">Spend</th><th className="numeric">Per run</th><th className="numeric hide-mobile" title="Spend over runs that succeeded, failed runs included">Per success</th>{showShape && <th className="numeric hide-mobile">Steps</th>}{showShape && <th className="numeric hide-mobile">Tool calls</th>}<th className="numeric hide-mobile">p95</th><th className="numeric hide-mobile" title="Share of input tokens read from cache">Cache</th><th className="numeric">Failed</th><th className="hide-mobile">Last run</th></tr></thead>
    <tbody>{groups.map((group) => <tr key={group.name} tabIndex={0} onClick={() => onOpen(group)} onKeyDown={(event) => { if (event.key === "Enter") onOpen(group); }}>
      <td className="primary-cell">{group.name}</td>
      <td className="numeric">{group.runs.toLocaleString()}</td>
      <td className="numeric">{money(group.cost, currency, fx)}{group.partlyPricedRuns > 0 && <small className="ck-table-sub">{group.partlyPricedRuns} partly priced</small>}</td>
      <td className="numeric">{money(group.costPerRun, currency, fx)}</td>
      <td className="numeric hide-mobile">{money(group.costPerSuccess ?? null, currency, fx)}</td>
      {showShape && <td className="numeric hide-mobile">{group.avgSteps == null ? "—" : group.avgSteps.toFixed(1)}</td>}
      {showShape && <td className="numeric hide-mobile">{group.avgTools == null ? "—" : group.avgTools.toFixed(1)}</td>}
      <td className="numeric hide-mobile">{group.p95Ms == null ? "—" : formatDuration(group.p95Ms)}</td>
      <td className="numeric hide-mobile">{formatHitRate(group.usage?.cacheHitRate)}</td>
      <td className="numeric">{group.failedRuns > 0 ? <StatusPill tone="warn">{failureRate(group)}</StatusPill> : "0%"}</td>
      <td className="hide-mobile">{group.lastRun ? formatDateTime(group.lastRun) : "—"}</td>
    </tr>)}</tbody>
  </table></div>;
}

type GroupKind = "agent" | "workflow";
type View = "runs" | "models" | "budgets" | "forecast";
const VIEWS: Array<{ id: View; label: string }> = [
  { id: "runs", label: "Runs" },
  { id: "models", label: "By model" },
  { id: "budgets", label: "Budgets" },
  { id: "forecast", label: "Forecast" },
];

function scopeValues(policy: BudgetPolicy, key: GroupKind): string[] {
  const value = policy.scope?.[key];
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function windowWords(window: string): string {
  return ({ calendar_month: "per month", calendar_day: "per day", calendar_minute: "per minute", per_trace: "per run", per_execution: "per batch", per_call: "per call" } as Record<string, string>)[window] ?? window;
}

function policyAmount(policy: BudgetPolicy, value: number | null | undefined, currency: string, fx?: ReportingFx | null): string {
  if (value == null) return "—";
  return policy.unit === "money" ? formatReportedAmount(value, policy.currency ?? currency, fx) : `${value.toLocaleString()} ${policy.unit}`;
}

function BudgetsView({ kind, projectId, currency, fx }: { kind: GroupKind; projectId: string; currency: string; fx?: ReportingFx | null }) {
  const { data, error, loading } = useScopedLoad(`budgets|${projectId}`, () => getBudgetPolicies(projectId));
  const policies = (data?.policies ?? []).filter((policy) => policy.status !== "archived" && scopeValues(policy, kind).length > 0);
  if (error && !data) return <EmptyPanel title="Couldn’t load budgets" body={error} />;
  if (loading && !data) return <LoadingRows count={4} columns={5} />;
  if (policies.length === 0) return <EmptyPanel title={kind === "agent" ? "No agent budgets" : "No workflow budgets"} action={<Link className="ck-button ck-button-primary" to={`/policy-edit?scopeDimension=${kind}`}>New budget</Link>} />;
  return <div className="ck-table-wrap"><table className="ck-table">
    <thead><tr><th>Budget</th><th>Covers</th><th className="numeric">Limit</th><th className="numeric">Used</th><th>When reached</th></tr></thead>
    <tbody>{policies.map((policy) => {
      const used = policy.usage?.observed ?? null;
      const ratio = used != null && policy.allowance > 0 ? used / policy.allowance : null;
      return <tr key={policy.id}>
        <td className="primary-cell"><Link className="ck-table-link" to={`/policy?id=${encodeURIComponent(policy.id)}&project=${encodeURIComponent(projectId)}`}>{policy.name || "Budget"}</Link>{policy.status === "paused" && <small className="ck-table-sub">Paused</small>}</td>
        <td>{scopeValues(policy, kind).join(", ")}</td>
        <td className="numeric">{policyAmount(policy, policy.allowance, currency, fx)}<small className="ck-table-sub">{windowWords(policy.window)}</small></td>
        <td className="numeric">{policyAmount(policy, used, currency, fx)}{ratio != null && <small className="ck-table-sub">{Math.round(ratio * 100)}%</small>}</td>
        <td>{policy.mode === "enforce" ? <StatusPill tone="critical" icon="pause">Stop calls</StatusPill> : <StatusPill tone="neutral" icon="bell">Alert</StatusPill>}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}

function ModelsView({ kind, projectId, scope, scopeKey, currency, fx }: { kind: GroupKind; projectId: string; scope: InsightScope; scopeKey: string; currency: string; fx?: ReportingFx | null }) {
  const { data, error, loading } = useScopedLoad(`models|${kind}|${scopeKey}`, () => getTabModels(projectId, kind, scope));
  const models = data?.models ?? [];
  if (error && !data) return <EmptyPanel title="Couldn’t load models" body={error} />;
  if (loading && !data) return <LoadingRows count={5} columns={5} />;
  if (models.length === 0) return <EmptyPanel title="No model calls in this period" />;
  const total = models.reduce((sum, model) => sum + (model.cost ?? 0), 0);
  return <div className="ck-table-wrap"><table className="ck-table">
    <thead><tr><th>Model</th><th className="numeric">Spend</th><th className="numeric">Share</th><th className="numeric">Calls</th><th className="numeric hide-mobile" title="Tokens in and out, or the units the model bills">Usage</th><th className="numeric hide-mobile">Per call</th><th className="numeric hide-mobile" title="Share of input tokens read from cache">Cache hit</th><th className="numeric hide-mobile" title="Output tokens spent on reasoning">Reasoning</th><th className="numeric hide-mobile" title="Saved against the uncached input price">Saved by cache</th><th className="hide-mobile">{kind === "agent" ? "Agents" : "Workflows"}</th></tr></thead>
    <tbody>{models.map((model) => <tr key={`${model.provider}/${model.model}`}>
      <td className="primary-cell">{model.model}<small className="ck-table-sub"><ProviderLabel provider={model.provider} size={12} /></small></td>
      <td className="numeric">{money(model.cost, currency, fx)}</td>
      <td className="numeric">{model.cost != null && total > 0 ? `${Math.round(model.cost / total * 100)}%` : "—"}</td>
      <td className="numeric">{model.calls.toLocaleString()}</td>
      <td className="numeric hide-mobile">{(model.usage?.inputTokens ?? 0) + (model.usage?.outputTokens ?? 0) > 0 ? `${formatTokenCount((model.usage?.inputTokens ?? 0) + (model.usage?.outputTokens ?? 0))} tokens` : billedUnitsText(model.units) || "—"}</td>
      <td className="numeric hide-mobile">{model.cost != null && model.calls > 0 ? money(model.cost / model.calls, currency, fx) : "—"}</td>
      <td className="numeric hide-mobile">{formatHitRate(model.usage?.cacheHitRate)}</td>
      <td className="numeric hide-mobile">{formatTokenCount(model.usage?.reasoningTokens)}</td>
      <td className="numeric hide-mobile">{model.usage?.cacheSavings == null ? "—" : formatReportedAmount(model.usage.cacheSavings, currency, fx)}</td>
      <td className="hide-mobile">{model.topOwners.join(", ")}</td>
    </tr>)}</tbody>
  </table></div>;
}

/** Month to date and where each one lands at this pace, against its monthly budget. */
function ForecastView({ kind, projectId, currency, fx, timezone }: { kind: GroupKind; projectId: string; currency: string; fx?: ReportingFx | null; timezone?: string }) {
  const month = periodDates("mtd", timezone);
  const key = `forecast|${kind}|${projectId}|${month.from}`;
  const { data, error, loading } = useScopedLoad(key, () => Promise.all([
    kind === "agent" ? getAgents(projectId, month).then((result) => result.agents) : getWorkflows(projectId, month).then((result) => result.workflows),
    getBudgetPolicies(projectId).then((result) => result.policies).catch(() => [] as BudgetPolicy[]),
  ]));
  if (error && !data) return <EmptyPanel title="Couldn’t load the forecast" body={error} />;
  if (loading && !data) return <LoadingRows count={5} columns={4} />;
  const [groups, policies] = data ?? [[], []];
  const now = new Date();
  const start = new Date(month.from).getTime();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const elapsedDays = Math.max(1, (now.getTime() - start) / (24 * 60 * 60 * 1000));
  const budgetFor = (name: string) => policies.find((policy) => policy.status === "active" && policy.unit === "money" && policy.window === "calendar_month" && scopeValues(policy, kind).length === 1 && scopeValues(policy, kind)[0] === name);
  if (groups.length === 0) return <EmptyPanel title="No spend this month yet" />;
  return <div className="ck-table-wrap"><table className="ck-table">
    <thead><tr><th>{kind === "agent" ? "Agent" : "Workflow"}</th><th className="numeric">Month to date</th><th className="numeric">Month-end at this pace</th><th className="numeric">Monthly budget</th><th /></tr></thead>
    <tbody>{groups.map((group) => {
      const projected = group.cost == null ? null : group.cost / elapsedDays * daysInMonth;
      const budget = budgetFor(group.name);
      const over = budget && projected != null && projected > budget.allowance;
      return <tr key={group.name}>
        <td className="primary-cell">{group.name}</td>
        <td className="numeric">{money(group.cost, currency, fx)}</td>
        <td className="numeric">{money(projected, currency, fx)}</td>
        <td className="numeric">{budget ? policyAmount(budget, budget.allowance, currency, fx) : <Link className="ck-table-link" to={`/policy-edit?scopeDimension=${kind}&scopeValue=${encodeURIComponent(group.name)}`}>Set budget</Link>}</td>
        <td>{budget && (over ? <StatusPill tone="warn">Over budget</StatusPill> : <StatusPill tone="good">Within budget</StatusPill>)}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}

function RunGroupsPage({ kind }: { kind: GroupKind }) {
  const { projectId, scope, scopeKey, currency, fx, toolbar } = useInsightScope();
  const { workspaceSettings, org } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.find((item) => item.id === params.get("view"))?.id ?? "runs") as View;
  const { data, error, loading } = useScopedLoad(projectId ? `${kind}|${scopeKey}` : null, () => kind === "agent"
    ? getAgents(projectId!, scope).then((result) => result.agents)
    : getWorkflows(projectId!, scope).then((result) => result.workflows));
  const groups = data ?? [];
  const title = kind === "agent" ? "Agents" : "Workflows";
  const setView = (next: View) => setParams((current) => { if (next === "runs") current.delete("view"); else current.set("view", next); return current; });
  const headerAction = view === "budgets" && projectId ? <Link className="ck-button ck-button-primary" to={`/policy-edit?scopeDimension=${kind}`}>New budget</Link> : view === "forecast" ? undefined : toolbar;
  return <div className="ck-main-inner">
    <PageHeader title={title} actions={headerAction} />
    <div className="ck-tabs ck-page-tabs" role="tablist" aria-label={`${title} views`}>{VIEWS.map((item) => <button key={item.id} className={`ck-tab ${view === item.id ? "active" : ""}`} role="tab" aria-selected={view === item.id} type="button" onClick={() => setView(item.id)}>{item.label}</button>)}</div>
    {view === "runs" && <div className="ck-view">
      <Totals groups={groups} currency={currency} fx={fx} loading={loading && !data} />
      <Panel>{error && !data ? <EmptyPanel title={`Couldn’t load ${title.toLowerCase()}`} body={error} /> : loading && !data ? <LoadingRows count={6} columns={6} /> : groups.length === 0
        ? <EmptyPanel illustration="first-light" title={kind === "agent" ? "No agent runs yet" : "No workflows yet"} body={kind === "agent" ? "Wrap a run in CostKey.agent() to see it here." : "Name a run with startTrace to see it here."} />
        : <GroupTable groups={groups} label={kind === "agent" ? "Agent" : "Workflow"} showShape={kind === "agent"} currency={currency} fx={fx} onOpen={(group) => navigate(kind === "agent" ? `/agents/${encodeURIComponent(group.name)}${window.location.search}` : `/traces?q=${encodeURIComponent(group.name)}`)} />}</Panel>
    </div>}
    {view !== "runs" && projectId && <Panel key={view} className="ck-view">
      {view === "models" && <ModelsView kind={kind} projectId={projectId} scope={scope} scopeKey={scopeKey} currency={currency} fx={fx} />}
      {view === "budgets" && <BudgetsView kind={kind} projectId={projectId} currency={currency} fx={fx} />}
      {view === "forecast" && <ForecastView kind={kind} projectId={projectId} currency={currency} fx={fx} timezone={workspaceSettings?.timezone ?? org?.timezone ?? undefined} />}
    </Panel>}
    {view === "budgets" && <p className="ck-table-note"><Link className="ck-table-link" to="/alerting">Where alerts go</Link></p>}
  </div>;
}

export function Workflows() {
  return <RunGroupsPage kind="workflow" />;
}

export function Agents() {
  return <RunGroupsPage kind="agent" />;
}

/** One run opened in place: its summary, waterfall and inspector, with a link to the full run page. */
function InlineRun({ projectId, traceId, currency, fx, initialCallId, onCallChange }: { projectId: string; traceId: string; currency: string; fx?: ReportingFx | null; initialCallId: string | null; onCallChange: (callId: string | null) => void }) {
  const { user } = useAuth();
  const { detail, error, loading } = useRunDetail(projectId, traceId);
  const model = detail ? runModel(detail, traceId) : null;
  return <div className="ck-run-inline" id={`run-${traceId}`}>
    <div className="ck-run-inline-head">
      <span className="ck-run-inline-id">{model ? model.traceName : "Run"} <span className="mono">{traceId}</span></span>
      <Link className="ck-button ck-button-secondary" to={`/traces/${encodeURIComponent(traceId)}${initialCallId ? `?call=${encodeURIComponent(initialCallId)}` : ""}`} state={{ returnTo: currentRouterPath() }}>Open run page <ArrowRight size={13} aria-hidden="true" /></Link>
    </div>
    {loading ? <div className="ck-run-inline-loading"><LoadingRows count={4} columns={4} /></div>
      : error || !model ? <EmptyPanel title="Couldn’t open this run" body="It may have expired. Try the run page." />
      : <>
        <RunSummaryStrip model={model} currency={currency} fx={fx} />
        <RunFlow projectId={projectId} traceId={traceId} model={model} role={user?.role ?? "viewer"} currency={currency} fx={fx} initialCallId={initialCallId} onCallChange={onCallChange} requestedTab="cost" inline />
      </>}
  </div>;
}

function cacheCell(usage: TokenUsage | undefined): string {
  return formatHitRate(usage?.cacheHitRate);
}

function AgentRunsTable({ runs, projectId, openRun, onToggle, currency, fx, callId, onCallChange }: { runs: AgentRun[]; projectId: string; openRun: string | null; onToggle: (traceId: string) => void; currency: string; fx?: ReportingFx | null; callId: string | null; onCallChange: (callId: string | null) => void }) {
  const columns = 9;
  return <div className="ck-table-wrap ck-runs-wrap"><table className="ck-table ck-runs-expandable">
    <thead><tr><th>Started</th><th className="numeric">Cost</th><th className="numeric hide-mobile">Calls</th><th className="numeric hide-mobile">Steps</th><th className="numeric hide-mobile">Tools</th><th className="numeric hide-mobile" title="Share of input tokens read from cache">Cache</th><th className="numeric">Time</th><th className="hide-mobile">User</th><th>Status</th></tr></thead>
    <tbody>{runs.map((run) => {
      const open = openRun === run.traceId;
      return <Fragment key={run.traceId}>
        <tr id={`run-row-${run.traceId}`} className={`ck-run-row ${open ? "is-open" : ""}`} onClick={() => onToggle(run.traceId)}>
          <td className="primary-cell"><button className="ck-run-toggle" type="button" aria-expanded={open} aria-controls={`run-${run.traceId}`} onClick={(event) => { event.stopPropagation(); onToggle(run.traceId); }}>{open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}<span>{formatDateTime(run.startedAt)}</span><span className="sr-only">{open ? ", hide this run" : ", show this run"}</span></button></td>
          <td className="numeric">{run.unpriced > 0 && run.cost == null ? "Unpriced" : money(run.cost, currency, fx)}</td>
          <td className="numeric hide-mobile">{run.calls}</td>
          <td className="numeric hide-mobile">{run.steps}</td>
          <td className="numeric hide-mobile">{run.tools}</td>
          <td className="numeric hide-mobile">{cacheCell(run.usage)}</td>
          <td className="numeric">{run.durationMs == null ? "—" : formatDuration(run.durationMs)}</td>
          <td className="hide-mobile">{run.userId ?? "—"}</td>
          <td>{run.failed ? <StatusPill tone="critical">Failed</StatusPill> : <StatusPill tone="good">Done</StatusPill>}</td>
        </tr>
        {open && <tr className="ck-run-expanded"><td colSpan={columns}><InlineRun projectId={projectId} traceId={run.traceId} currency={currency} fx={fx} initialCallId={callId} onCallChange={onCallChange} /></td></tr>}
      </Fragment>;
    })}</tbody>
  </table></div>;
}

/** Cache hit rate across the agent's runs, with what it saved when that can be checked. */
function cacheDetail(usage: TokenUsage | undefined, currency: string, fx?: ReportingFx | null): string | undefined {
  if (!usage) return undefined;
  if (usage.cacheReadTokens == null) return "No cache usage reported";
  const parts = [`${formatTokenCount(usage.cacheReadTokens)} cached`];
  if (usage.cacheSavings != null && usage.cacheSavings > 0) parts.push(`${formatReportedAmount(usage.cacheSavings, currency, fx)} saved`);
  return parts.join(" · ");
}

function ModelUsageTable({ models, currency, fx }: { models: AgentDetail["models"]; currency: string; fx?: ReportingFx | null }) {
  return <div className="ck-table-wrap"><table className="ck-table">
    <thead><tr><th>Model</th><th className="numeric">Calls</th><th className="numeric">Spend</th><th className="numeric hide-mobile" title="Input tokens with cache, or the units the model bills">Usage</th><th className="numeric" title="Share of input tokens read from cache">Cache hit</th><th className="numeric hide-mobile">Cached</th><th className="numeric hide-mobile" title="Output tokens spent on reasoning">Reasoning</th><th className="numeric hide-mobile" title="Saved against the uncached input price">Saved by cache</th></tr></thead>
    <tbody>{models.map((model) => <tr key={`${model.provider}/${model.model}`}>
      <td className="primary-cell">{model.model}<small className="ck-table-sub"><ProviderLabel provider={model.provider} size={12} /></small></td>
      <td className="numeric">{model.calls.toLocaleString()}</td>
      <td className="numeric">{money(model.cost, currency, fx)}</td>
      <td className="numeric hide-mobile">{model.usage?.inputTokens ? formatTokenCount(model.usage.inputTokens) : billedUnitsText(model.units) || "—"}</td>
      <td className="numeric">{formatHitRate(model.usage?.cacheHitRate)}</td>
      <td className="numeric hide-mobile">{formatTokenCount(model.usage?.cacheReadTokens)}</td>
      <td className="numeric hide-mobile">{formatTokenCount(model.usage?.reasoningTokens)}</td>
      <td className="numeric hide-mobile">{model.usage?.cacheSavings == null ? "—" : formatReportedAmount(model.usage.cacheSavings, currency, fx)}</td>
    </tr>)}</tbody>
  </table></div>;
}

export function AgentDetailPage() {
  const { name = "" } = useParams();
  const { projectId, scope, scopeKey, currency, fx, toolbar } = useInsightScope();
  const [params, setParams] = useSearchParams();
  const { data, error, loading } = useScopedLoad(projectId && name ? `agent|${name}|${scopeKey}` : null, () => getAgentDetail(projectId!, name, scope));
  const agent = data?.agent;
  const openRun = params.get("run");
  const callId = openRun ? params.get("call") : null;
  const runListed = Boolean(openRun && data?.runs.some((run) => run.traceId === openRun));
  const toggleRun = (traceId: string) => setParams((current) => {
    current.delete("call");
    if (current.get("run") === traceId) current.delete("run"); else current.set("run", traceId);
    return current;
  }, { replace: true });
  const changeCall = (next: string | null) => setParams((current) => { if (next) current.set("call", next); else current.delete("call"); return current; }, { replace: true });
  // A shared link opens with its run in view.
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !data) return;
    scrolled.current = true;
    if (!openRun) return;
    document.getElementById(runListed ? `run-row-${openRun}` : `run-${openRun}`)?.scrollIntoView({ block: "start" });
  }, [openRun, data, runListed]);
  const usage = agent?.usage;
  return <div className="ck-main-inner">
    <Link className="ck-back-link" to="/agents"><ArrowLeft size={13} /> Agents</Link>
    <PageHeader title={name} actions={toolbar} />
    {error && !data ? <Panel><EmptyPanel title="Couldn’t load this agent" body={error} /></Panel> : <>
      <div className="ck-metric-grid ck-metric-grid-5">
        <MetricCard icon="trace" label="Runs" value={(agent?.runs ?? 0).toLocaleString()} detail={agent && agent.failedRuns > 0 ? `${agent.failedRuns} failed` : undefined} loading={loading && !data} />
        <MetricCard icon="cost" label="Per run" value={money(agent?.costPerRun, currency, fx)} detail={agent ? `${money(agent.cost, currency, fx)} total` : undefined} loading={loading && !data} />
        <MetricCard icon="cost" label="Per successful run" value={money(agent?.costPerSuccess ?? null, currency, fx)} detail={agent && agent.runs > 0 ? `${(agent.runs - agent.failedRuns).toLocaleString()} of ${agent.runs.toLocaleString()} succeeded` : undefined} loading={loading && !data} />
        <MetricCard icon="clock" label="p95 run time" value={agent?.p95Ms == null ? "—" : formatDuration(agent.p95Ms)} detail={agent?.avgSteps != null ? [agent.avgSteps > 0 ? `${agent.avgSteps.toFixed(1)} steps` : null, `${(agent.avgTools ?? 0).toFixed(1)} tools per run`].filter(Boolean).join(" · ") : undefined} loading={loading && !data} />
        <MetricCard icon="model" label="Cache hit rate" value={formatHitRate(usage?.cacheHitRate)} detail={cacheDetail(usage, currency, fx)} loading={loading && !data} />
      </div>
      {openRun && data && !runListed && projectId && <Panel title="Run" className="ck-run-panel"><InlineRun projectId={projectId} traceId={openRun} currency={currency} fx={fx} initialCallId={callId} onCallChange={changeCall} /></Panel>}
      <Panel title="Runs" subtitle={data && data.runs.length > 0 ? "Select a run to see its steps, tools and calls." : undefined}>{loading && !data ? <LoadingRows count={5} columns={6} /> : (data?.runs.length ?? 0) === 0 ? <EmptyPanel title="No runs in this period" /> : <AgentRunsTable runs={data!.runs} projectId={projectId!} openRun={openRun} onToggle={toggleRun} currency={currency} fx={fx} callId={callId} onCallChange={changeCall} />}</Panel>
      <Panel title="Models" subtitle={usage?.reasoningTokens ? `${formatTokenCount(usage.outputTokens)} output tokens, ${formatTokenCount(usage.reasoningTokens)} of them reasoning` : undefined}>{loading && !data ? <LoadingRows count={2} columns={5} /> : (data?.models.length ?? 0) === 0 ? <EmptyPanel title="No model calls" /> : <ModelUsageTable models={data!.models} currency={currency} fx={fx} />}{(data?.subagents.length ?? 0) > 0 && <p className="ck-table-note">Hands off to {data!.subagents.map((agent) => `${agent.name} (${agent.runs})`).join(", ")}</p>}</Panel>
      <Panel title="Tools">{loading && !data ? <LoadingRows count={2} columns={5} /> : (data?.tools.length ?? 0) === 0 ? <EmptyPanel title="No tool calls" /> : <div className="ck-table-wrap"><table className="ck-table">
        <thead><tr><th>Tool</th><th className="numeric">Calls</th><th className="numeric">Avg time</th><th className="numeric">Failed</th><th className="numeric">Model spend</th></tr></thead>
        <tbody>{data!.tools.map((tool) => <tr key={tool.name}><td className="primary-cell">{tool.name}</td><td className="numeric">{tool.calls}</td><td className="numeric">{tool.avgMs == null ? "—" : formatDuration(tool.avgMs)}</td><td className="numeric">{tool.failed}</td><td className="numeric">{tool.cost ? money(tool.cost, currency, fx) : "—"}</td></tr>)}</tbody>
      </table></div>}</Panel>
    </>}
  </div>;
}

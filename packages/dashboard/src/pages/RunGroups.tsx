import { Fragment, useEffect, useRef } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { getAgentDetail, getWorkflowDetail, getAgents, getTabModels, getWorkflows, type AgentDetail, type AgentRun, type InsightScope, type RunGroup, type TokenUsage } from "../api";
import { currentRouterPath } from "../basePath";
import { RunFlow, runModel, RunSummaryStrip, useRunDetail } from "../components/RunFlow";
import { LiveStatus } from "../components/LiveStatus";
import { UserId } from "../components/UserId";
import { modelHref, ownerHref, toolHref, userHref } from "../components/links";
import { useNewIds, usePointerHold } from "../hooks/useLiveQuery";
import { billedUnitsText, formatHitRate, formatTokenCount } from "../components/tokenUsage";
import { EmptyPanel, LoadingRows, MetricCard, PageHeader, Pagination, Panel, StatusPill } from "../components/ConsolePrimitives";
import { formatDateTime, formatReportedAmount, type ReportingFx } from "../components/consoleFormatters";
import { useAuth } from "../contexts/useAuth";
import { formatDuration } from "../utils";
import { useInsightScope, useScopedLoad } from "./useInsightScope";
import { ProviderLabel } from "../components/ProviderLogo";
import { GroupBudgets, ScopeBudgetCard } from "../components/ScopeBudget";

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

function GroupTable({ groups, label, kind, showShape, currency, fx }: { groups: RunGroup[]; label: string; kind: GroupKind; showShape: boolean; currency: string; fx?: ReportingFx | null }) {
  return <div className="ck-table-wrap"><table className="ck-table">
    <thead><tr><th>{label}</th><th className="numeric">Runs</th><th className="numeric">Spend</th><th className="numeric">Per run</th><th className="numeric hide-mobile" title="Spend over runs that succeeded, failed runs included">Per success</th>{showShape && <th className="numeric hide-mobile">Steps</th>}{showShape && <th className="numeric hide-mobile">Tool calls</th>}<th className="numeric hide-mobile">p95</th><th className="numeric hide-mobile" title="Share of input tokens read from cache">Cache</th><th className="numeric">Failed</th><th className="hide-mobile">Last run</th></tr></thead>
    <tbody>{groups.map((group) => <tr key={group.name} className="ck-row-link">
      <td className="primary-cell"><Link className="ck-table-link ck-stretch-link" to={ownerHref(kind, group.name)}>{group.name}</Link></td>
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
type View = "runs" | "models" | "budgets";
const VIEWS: Array<{ id: View; label: string }> = [
  { id: "runs", label: "Runs" },
  { id: "models", label: "By model" },
  { id: "budgets", label: "Budgets" },
];

function ModelsView({ kind, projectId, scope, scopeKey, currency, fx }: { kind: GroupKind; projectId: string; scope: InsightScope; scopeKey: string; currency: string; fx?: ReportingFx | null }) {
  const { data, error, loading } = useScopedLoad(`models|${kind}|${scopeKey}`, () => getTabModels(projectId, kind, scope));
  const models = data?.models ?? [];
  if (error && !data) return <EmptyPanel title="Couldn’t load models" body={error} />;
  if (loading && !data) return <LoadingRows count={5} columns={5} />;
  if (models.length === 0) return <EmptyPanel title="No model calls in this period" />;
  const total = models.reduce((sum, model) => sum + (model.cost ?? 0), 0);
  return <div className="ck-table-wrap"><table className="ck-table">
    <thead><tr><th>Model</th><th className="numeric">Spend</th><th className="numeric">Share</th><th className="numeric">Calls</th><th className="numeric hide-mobile" title="Tokens in and out, or the units the model bills">Usage</th><th className="numeric hide-mobile">Per call</th><th className="numeric hide-mobile" title="Share of input tokens read from cache">Cache hit</th><th className="numeric hide-mobile" title="Output tokens spent on reasoning">Reasoning</th><th className="numeric hide-mobile" title="Saved against the uncached input price">Saved by cache</th><th className="hide-mobile">{kind === "agent" ? "Agents" : "Workflows"}</th></tr></thead>
    <tbody>{models.map((model) => <tr key={`${model.provider}/${model.model}`} className="ck-row-link">
      <td className="primary-cell"><Link className="ck-table-link ck-stretch-link" to={modelHref(model.provider, model.model)}>{model.model}</Link><small className="ck-table-sub"><ProviderLabel provider={model.provider} size={12} /></small></td>
      <td className="numeric">{money(model.cost, currency, fx)}</td>
      <td className="numeric">{model.cost != null && total > 0 ? `${Math.round(model.cost / total * 100)}%` : "—"}</td>
      <td className="numeric">{model.calls.toLocaleString()}</td>
      <td className="numeric hide-mobile">{(model.usage?.inputTokens ?? 0) + (model.usage?.outputTokens ?? 0) > 0 ? `${formatTokenCount((model.usage?.inputTokens ?? 0) + (model.usage?.outputTokens ?? 0))} tokens` : billedUnitsText(model.units) || "—"}</td>
      <td className="numeric hide-mobile">{model.cost != null && model.calls > 0 ? money(model.cost / model.calls, currency, fx) : "—"}</td>
      <td className="numeric hide-mobile">{formatHitRate(model.usage?.cacheHitRate)}</td>
      <td className="numeric hide-mobile">{formatTokenCount(model.usage?.reasoningTokens)}</td>
      <td className="numeric hide-mobile">{model.usage?.cacheSavings == null ? "—" : formatReportedAmount(model.usage.cacheSavings, currency, fx)}</td>
      <td className="hide-mobile">{model.topOwners.map((owner, index) => <span key={owner}>{index > 0 && ", "}<Link className="ck-table-link" to={ownerHref(kind, owner)}>{owner}</Link></span>)}</td>
    </tr>)}</tbody>
  </table></div>;
}

function RunGroupsPage({ kind }: { kind: GroupKind }) {
  const { projectId, scope, scopeKey, currency, fx, toolbar } = useInsightScope();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.find((item) => item.id === params.get("view"))?.id ?? "runs") as View;
  const { data, error, loading, status: liveStatus, updatedAt, refresh } = useScopedLoad(projectId ? `${kind}|${scopeKey}` : null, () => kind === "agent"
    ? getAgents(projectId!, scope).then((result) => result.agents)
    : getWorkflows(projectId!, scope).then((result) => result.workflows));
  const groups = data ?? [];
  const title = kind === "agent" ? "Agents" : "Workflows";
  const setView = (next: View) => setParams((current) => { if (next === "runs") current.delete("view"); else current.set("view", next); return current; });
  const headerAction = view === "budgets" ? undefined : <><LiveStatus status={liveStatus} updatedAt={updatedAt} onRefresh={refresh} />{toolbar}</>;
  return <div className="ck-main-inner">
    <PageHeader title={title} actions={headerAction} />
    <div className="ck-tabs ck-page-tabs" role="tablist" aria-label={`${title} views`}>{VIEWS.map((item) => <button key={item.id} className={`ck-tab ${view === item.id ? "active" : ""}`} role="tab" aria-selected={view === item.id} type="button" onClick={() => setView(item.id)}>{item.label}</button>)}</div>
    {view === "runs" && <div className="ck-view">
      <Totals groups={groups} currency={currency} fx={fx} loading={loading && !data} />
      <Panel>{error && !data ? <EmptyPanel title={`Couldn’t load ${title.toLowerCase()}`} body={error} /> : loading && !data ? <LoadingRows count={6} columns={6} /> : groups.length === 0
        ? <EmptyPanel illustration="first-light" title={kind === "agent" ? "No agent runs yet" : "No workflows yet"} body={kind === "agent" ? "Wrap a run in CostKey.agent() to see it here." : "Name a run with startTrace to see it here."} />
        : <GroupTable groups={groups} label={kind === "agent" ? "Agent" : "Workflow"} kind={kind} showShape={kind === "agent"} currency={currency} fx={fx} />}</Panel>
    </div>}
    {view !== "runs" && projectId && <Panel key={view} className="ck-view">
      {view === "models" && <ModelsView kind={kind} projectId={projectId} scope={scope} scopeKey={scopeKey} currency={currency} fx={fx} />}
      {view === "budgets" && <GroupBudgets kind={kind} projectId={projectId} currency={currency} fx={fx} />}
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

function AgentRunsTable({ runs, fresh, projectId, openRun, onToggle, currency, fx, callId, onCallChange }: { runs: AgentRun[]; fresh?: ReadonlySet<string>; projectId: string; openRun: string | null; onToggle: (traceId: string) => void; currency: string; fx?: ReportingFx | null; callId: string | null; onCallChange: (callId: string | null) => void }) {
  // Steps and tools only where runs have them (agents); workflows usually don't.
  const shape = runs.some((run) => run.steps > 0 || run.tools > 0);
  const columns = shape ? 9 : 7;
  return <div className="ck-table-wrap ck-runs-wrap"><table className="ck-table ck-runs-expandable">
    <thead><tr><th>Started</th><th className="numeric">Cost</th><th className="numeric hide-mobile">Calls</th>{shape && <><th className="numeric hide-mobile">Steps</th><th className="numeric hide-mobile">Tools</th></>}<th className="numeric hide-mobile" title="Share of input tokens read from cache">Cache</th><th className="numeric">Time</th><th className="hide-mobile">User</th><th>Status</th></tr></thead>
    <tbody>{runs.map((run) => {
      const open = openRun === run.traceId;
      return <Fragment key={run.traceId}>
        <tr id={`run-row-${run.traceId}`} className={`ck-run-row ${open ? "is-open" : ""} ${fresh?.has(run.traceId) ? "is-new" : ""}`} onClick={() => onToggle(run.traceId)}>
          <td className="primary-cell"><button className="ck-run-toggle" type="button" aria-expanded={open} aria-controls={`run-${run.traceId}`} onClick={(event) => { event.stopPropagation(); onToggle(run.traceId); }}>{open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}<span>{formatDateTime(run.startedAt)}</span><span className="sr-only">{open ? ", hide this run" : ", show this run"}</span></button></td>
          <td className="numeric">{run.unpriced > 0 && run.cost == null ? "Unpriced" : money(run.cost, currency, fx)}</td>
          <td className="numeric hide-mobile">{run.calls}</td>
          {shape && <><td className="numeric hide-mobile">{run.steps}</td><td className="numeric hide-mobile">{run.tools}</td></>}
          <td className="numeric hide-mobile">{cacheCell(run.usage)}</td>
          <td className="numeric">{run.durationMs == null ? "—" : formatDuration(run.durationMs)}</td>
          <td className="hide-mobile">{run.userId ? <UserId id={run.userId} to={userHref(run.userId)} linkClassName="ck-table-link" /> : "—"}</td>
          <td>{run.retry?.retried
            ? <span title={`This attempt failed${run.retry.errorType ? ` (${run.retry.errorType})` : ""}; attempt ${run.retry.succeededOnAttempt ?? 2} finished the work.`}><StatusPill tone="good">Succeeded</StatusPill></span>
            : run.failed ? <span title={run.retry?.errorType ? `The run raised ${run.retry.errorType}.` : undefined}><StatusPill tone="critical">Failed</StatusPill></span> : <StatusPill tone="good">Succeeded</StatusPill>}</td>
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
    <tbody>{models.map((model) => <tr key={`${model.provider}/${model.model}`} className="ck-row-link">
      <td className="primary-cell"><Link className="ck-table-link ck-stretch-link" to={modelHref(model.provider, model.model)}>{model.model}</Link><small className="ck-table-sub"><ProviderLabel provider={model.provider} size={12} /></small></td>
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
  return <GroupDetailPage kind="agent" />;
}

export function WorkflowDetailPage() {
  return <GroupDetailPage kind="workflow" />;
}

/** Who an agent or workflow ran for, by spend. */
function UsersPanel({ users, total, currency, fx }: { users: NonNullable<AgentDetail["users"]>; total: number | null; currency: string; fx?: ReportingFx | null }) {
  return <div className="ck-table-wrap"><table className="ck-table ck-table-linked">
    <thead><tr><th>User</th><th className="numeric">Runs</th><th className="numeric hide-mobile">Calls</th><th className="numeric hide-mobile">Usage</th><th className="numeric">Spend</th><th className="numeric hide-mobile">Share</th></tr></thead>
    <tbody>{users.map((user) => {
      const tokens = (user.usage?.inputTokens ?? 0) + (user.usage?.outputTokens ?? 0);
      return <tr key={user.userId}>
        <td className="primary-cell"><UserId id={user.userId} to={userHref(user.userId)} linkClassName="ck-table-link" />{user.failedRuns > 0 && <small className="ck-table-sub">{user.failedRuns} failed</small>}</td>
        <td className="numeric">{user.runs.toLocaleString()}</td>
        <td className="numeric hide-mobile">{user.calls.toLocaleString()}</td>
        <td className="numeric hide-mobile">{tokens > 0 ? `${formatTokenCount(tokens)} tokens` : billedUnitsText(user.units) || "—"}</td>
        <td className="numeric">{money(user.cost, currency, fx)}</td>
        <td className="numeric hide-mobile">{user.cost != null && total ? `${Math.round(user.cost / total * 100)}%` : "—"}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}


function GroupDetailPage({ kind }: { kind: GroupKind }) {
  const { name = "" } = useParams();
  const { projectId, scope, scopeKey, currency, fx, toolbar } = useInsightScope();
  const [params, setParams] = useSearchParams();
  const runsHold = usePointerHold();
  // Runs are paged in the URL so a shared link opens on the same page.
  const pageLimit = [25, 50, 100, 200].includes(Number(params.get("limit"))) ? Number(params.get("limit")) : 50;
  const pageOffset = Math.max(0, Math.floor(Number(params.get("offset"))) || 0);
  const { data, error, loading, status: liveStatus, updatedAt, refresh } = useScopedLoad(projectId && name ? `${kind}|${name}|${scopeKey}|${pageOffset}|${pageLimit}` : null, () => (kind === "agent" ? getAgentDetail : getWorkflowDetail)(projectId!, name, scope, { offset: pageOffset, limit: pageLimit }), { shouldDefer: runsHold.held });
  const setPage = (offset: number, limit = pageLimit) => setParams((current) => {
    if (offset > 0) current.set("offset", String(offset)); else current.delete("offset");
    if (limit !== 50) current.set("limit", String(limit)); else current.delete("limit");
    current.delete("run");
    current.delete("call");
    return current;
  });
  const freshRuns = useNewIds(data?.runs.map((run) => run.traceId) ?? []);
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
    <Link className="ck-back-link" to={`${kind === "agent" ? "/agents" : "/workflows"}${window.location.search.replace(/([?&])(run|call)=[^&]*/g, "$1").replace(/[?&]+$/, "")}`}><ArrowLeft size={13} /> {kind === "agent" ? "Agents" : "Workflows"}</Link>
    <PageHeader title={name} actions={<><LiveStatus status={liveStatus} updatedAt={updatedAt} onRefresh={refresh} />{toolbar}</>} />
    {error && !data ? <Panel><EmptyPanel title={kind === "agent" ? "Couldn’t load this agent" : "Couldn’t load this workflow"} body={error} /></Panel> : <>
      <div className="ck-metric-grid ck-metric-grid-5">
        <MetricCard icon="trace" label="Runs" value={(agent?.runs ?? 0).toLocaleString()} detail={agent && (agent.failedRuns > 0 || (agent.retriedRuns ?? 0) > 0) ? [agent.failedRuns > 0 ? `${agent.failedRuns} failed` : null, agent.retriedRuns ? `${agent.retriedRuns} retried` : null].filter(Boolean).join(" · ") : undefined} loading={loading && !data} />
        <MetricCard icon="cost" label="Per run" value={money(agent?.costPerRun, currency, fx)} detail={agent ? `${money(agent.cost, currency, fx)} total` : undefined} loading={loading && !data} />
        <MetricCard icon="cost" label="Per successful run" value={money(agent?.costPerSuccess ?? null, currency, fx)} detail={agent && agent.runs > 0 ? `${(agent.runs - agent.failedRuns).toLocaleString()} of ${agent.runs.toLocaleString()} succeeded` : undefined} loading={loading && !data} />
        <MetricCard icon="clock" label="p95 run time" value={agent?.p95Ms == null ? "—" : formatDuration(agent.p95Ms)} detail={agent?.avgSteps != null ? [agent.avgSteps > 0 ? `${agent.avgSteps.toFixed(1)} steps` : null, (agent.avgTools ?? 0) > 0 ? `${(agent.avgTools ?? 0).toFixed(1)} tools per run` : null].filter(Boolean).join(" · ") || undefined : undefined} loading={loading && !data} />
        <MetricCard icon="model" label="Cache hit rate" value={formatHitRate(usage?.cacheHitRate)} detail={cacheDetail(usage, currency, fx)} loading={loading && !data} />
      </div>
      <ScopeBudgetCard projectId={projectId} dimension={kind} name={name} />
      {openRun && data && !runListed && projectId && <Panel title="Run" className="ck-run-panel"><InlineRun projectId={projectId} traceId={openRun} currency={currency} fx={fx} initialCallId={callId} onCallChange={changeCall} /></Panel>}
      <Panel title="Runs" subtitle={data && data.runs.length > 0 ? "Select a run to see its steps, tools and calls." : undefined}>{loading && !data ? <LoadingRows count={5} columns={6} /> : (data?.runs.length ?? 0) === 0 ? (pageOffset > 0 && (data?.runsPage?.total ?? 0) > 0
        ? <><EmptyPanel title="No runs on this page" /><Pagination offset={pageOffset} limit={pageLimit} total={data!.runsPage!.total} onOffsetChange={(offset) => setPage(offset)} onLimitChange={(limit) => setPage(0, limit)} /></>
        : <EmptyPanel title="No runs in this period" />) : <div {...runsHold.bind}><AgentRunsTable runs={data!.runs} fresh={freshRuns} projectId={projectId!} openRun={openRun} onToggle={toggleRun} currency={currency} fx={fx} callId={callId} onCallChange={changeCall} /><Pagination offset={data!.runsPage?.offset ?? pageOffset} limit={data!.runsPage?.limit ?? pageLimit} total={data!.runsPage?.total ?? data!.runs.length} onOffsetChange={(offset) => setPage(offset)} onLimitChange={(limit) => setPage(0, limit)} /></div>}</Panel>
      <Panel title="Models" subtitle={usage?.reasoningTokens ? `${formatTokenCount(usage.outputTokens)} output tokens, ${formatTokenCount(usage.reasoningTokens)} of them reasoning` : undefined}>{loading && !data ? <LoadingRows count={2} columns={5} /> : (data?.models.length ?? 0) === 0 ? <EmptyPanel title="No model calls" /> : <ModelUsageTable models={data!.models} currency={currency} fx={fx} />}{(data?.subagents.length ?? 0) > 0 && <p className="ck-table-note">Sub-agents it runs: {data!.subagents.map((agent, index) => <span key={agent.name}>{index > 0 && ", "}<Link to={ownerHref("agents", agent.name)}>{agent.name}</Link> in {agent.runs.toLocaleString()} run{agent.runs === 1 ? "" : "s"}</span>)}. Their calls are counted here too.</p>}</Panel>
      {(data?.users?.length ?? 0) > 0 && <Panel title="Users" subtitle="Who the runs were for, by spend">{<UsersPanel users={data!.users!} total={agent?.cost ?? null} currency={currency} fx={fx} />}</Panel>}
      <Panel title="Tools">{loading && !data ? <LoadingRows count={2} columns={5} /> : (data?.tools.length ?? 0) === 0 ? <EmptyPanel title="No tool calls" /> : <div className="ck-table-wrap"><table className="ck-table">
        <thead><tr><th>Tool</th><th className="numeric">Calls</th><th className="numeric">Avg time</th><th className="numeric">Failed</th><th className="numeric">Model spend</th></tr></thead>
        <tbody>{data!.tools.map((tool) => <tr key={tool.name} className="ck-row-link"><td className="primary-cell"><Link className="ck-table-link ck-stretch-link" to={toolHref(tool.name)} title="Runs that used this tool">{tool.name}</Link></td><td className="numeric">{tool.calls}</td><td className="numeric">{tool.avgMs == null ? "—" : formatDuration(tool.avgMs)}</td><td className="numeric">{tool.failed}</td><td className="numeric">{tool.cost ? money(tool.cost, currency, fx) : "—"}</td></tr>)}</tbody>
      </table></div>}</Panel>
    </>}
  </div>;
}

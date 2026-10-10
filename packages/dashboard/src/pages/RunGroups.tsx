import { ArrowLeft } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { getAgentDetail, getAgents, getBudgetPolicies, getTabModels, getWorkflows, type BudgetPolicy, type InsightScope, type RunGroup } from "../api";
import { EmptyPanel, LoadingRows, MetricCard, PageHeader, Panel, StatusPill } from "../components/ConsolePrimitives";
import { formatDateTime, formatProviders, formatReportedAmount, periodDates, type ReportingFx } from "../components/consoleFormatters";
import { useAuth } from "../contexts/useAuth";
import { formatDuration } from "../utils";
import { useInsightScope, useScopedLoad } from "./useInsightScope";

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
    <thead><tr><th>{label}</th><th className="numeric">Runs</th><th className="numeric">Spend</th><th className="numeric">Per run</th>{showShape && <th className="numeric hide-mobile">Steps</th>}{showShape && <th className="numeric hide-mobile">Tool calls</th>}<th className="numeric hide-mobile">p95</th><th className="numeric">Failed</th><th className="hide-mobile">Last run</th></tr></thead>
    <tbody>{groups.map((group) => <tr key={group.name} tabIndex={0} onClick={() => onOpen(group)} onKeyDown={(event) => { if (event.key === "Enter") onOpen(group); }}>
      <td className="primary-cell">{group.name}</td>
      <td className="numeric">{group.runs.toLocaleString()}</td>
      <td className="numeric">{money(group.cost, currency, fx)}{group.partlyPricedRuns > 0 && <small className="ck-table-sub">{group.partlyPricedRuns} partly priced</small>}</td>
      <td className="numeric">{money(group.costPerRun, currency, fx)}</td>
      {showShape && <td className="numeric hide-mobile">{group.avgSteps == null ? "—" : group.avgSteps.toFixed(1)}</td>}
      {showShape && <td className="numeric hide-mobile">{group.avgTools == null ? "—" : group.avgTools.toFixed(1)}</td>}
      <td className="numeric hide-mobile">{group.p95Ms == null ? "—" : formatDuration(group.p95Ms)}</td>
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
    <thead><tr><th>Model</th><th className="numeric">Spend</th><th className="numeric">Share</th><th className="numeric">Calls</th><th className="numeric hide-mobile">Per call</th><th className="hide-mobile">{kind === "agent" ? "Agents" : "Workflows"}</th></tr></thead>
    <tbody>{models.map((model) => <tr key={`${model.provider}/${model.model}`}>
      <td className="primary-cell">{model.model}<small className="ck-table-sub">{formatProviders(model.provider)}</small></td>
      <td className="numeric">{money(model.cost, currency, fx)}</td>
      <td className="numeric">{model.cost != null && total > 0 ? `${Math.round(model.cost / total * 100)}%` : "—"}</td>
      <td className="numeric">{model.calls.toLocaleString()}</td>
      <td className="numeric hide-mobile">{model.cost != null && model.calls > 0 ? money(model.cost / model.calls, currency, fx) : "—"}</td>
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

export function AgentDetailPage() {
  const { name = "" } = useParams();
  const { projectId, scope, scopeKey, currency, fx, toolbar } = useInsightScope();
  const { data, error, loading } = useScopedLoad(projectId && name ? `agent|${name}|${scopeKey}` : null, () => getAgentDetail(projectId!, name, scope));
  const agent = data?.agent;
  return <div className="ck-main-inner">
    <Link className="ck-back-link" to="/agents"><ArrowLeft size={13} /> Agents</Link>
    <PageHeader title={name} actions={toolbar} />
    {error && !data ? <Panel><EmptyPanel title="Couldn’t load this agent" body={error} /></Panel> : <>
      <div className="ck-metric-grid">
        <MetricCard icon="trace" label="Runs" value={(agent?.runs ?? 0).toLocaleString()} detail={agent && agent.failedRuns > 0 ? `${agent.failedRuns} failed` : undefined} loading={loading && !data} />
        <MetricCard icon="cost" label="Per run" value={money(agent?.costPerRun, currency, fx)} detail={agent ? `${money(agent.cost, currency, fx)} total` : undefined} loading={loading && !data} />
        <MetricCard icon="clock" label="p95 run time" value={agent?.p95Ms == null ? "—" : formatDuration(agent.p95Ms)} detail={agent?.avgSteps != null ? `${agent.avgSteps.toFixed(1)} steps · ${(agent.avgTools ?? 0).toFixed(1)} tool calls` : undefined} loading={loading && !data} />
      </div>
      <Panel title="Runs">{loading && !data ? <LoadingRows count={5} columns={6} /> : (data?.runs.length ?? 0) === 0 ? <EmptyPanel title="No runs in this period" /> : <div className="ck-table-wrap"><table className="ck-table">
        <thead><tr><th>Started</th><th className="numeric">Cost</th><th className="numeric">Calls</th><th className="numeric hide-mobile">Steps</th><th className="numeric hide-mobile">Tools</th><th className="numeric">Time</th><th className="hide-mobile">User</th><th>Status</th></tr></thead>
        <tbody>{data!.runs.map((run) => <tr key={run.traceId}>
          <td className="primary-cell"><Link className="ck-table-link" to={`/traces/${encodeURIComponent(run.traceId)}`}>{formatDateTime(run.startedAt)}</Link></td>
          <td className="numeric">{run.unpriced > 0 && run.cost == null ? "Unpriced" : money(run.cost, currency, fx)}</td>
          <td className="numeric">{run.calls}</td>
          <td className="numeric hide-mobile">{run.steps}</td>
          <td className="numeric hide-mobile">{run.tools}</td>
          <td className="numeric">{run.durationMs == null ? "—" : formatDuration(run.durationMs)}</td>
          <td className="hide-mobile">{run.userId ?? "—"}</td>
          <td>{run.failed ? <StatusPill tone="critical">Failed</StatusPill> : <StatusPill tone="good">Done</StatusPill>}</td>
        </tr>)}</tbody>
      </table></div>}</Panel>
      <div className="ck-content-grid">
        <Panel title="Tools">{(data?.tools.length ?? 0) === 0 ? <EmptyPanel title="No tool calls" /> : <div className="ck-table-wrap"><table className="ck-table">
          <thead><tr><th>Tool</th><th className="numeric">Calls</th><th className="numeric">Avg time</th><th className="numeric">Failed</th><th className="numeric">Model spend</th></tr></thead>
          <tbody>{data!.tools.map((tool) => <tr key={tool.name}><td className="primary-cell">{tool.name}</td><td className="numeric">{tool.calls}</td><td className="numeric">{tool.avgMs == null ? "—" : formatDuration(tool.avgMs)}</td><td className="numeric">{tool.failed}</td><td className="numeric">{tool.cost ? money(tool.cost, currency, fx) : "—"}</td></tr>)}</tbody>
        </table></div>}</Panel>
        <Panel title="Models">{(data?.models.length ?? 0) === 0 ? <EmptyPanel title="No model calls" /> : <div className="ck-table-wrap"><table className="ck-table">
          <thead><tr><th>Model</th><th className="numeric">Calls</th><th className="numeric">Spend</th></tr></thead>
          <tbody>{data!.models.map((model) => <tr key={`${model.provider}/${model.model}`}><td className="primary-cell">{model.model}<small className="ck-table-sub">{model.provider}</small></td><td className="numeric">{model.calls}</td><td className="numeric">{money(model.cost, currency, fx)}</td></tr>)}</tbody>
        </table></div>}{(data?.subagents.length ?? 0) > 0 && <p className="ck-table-note">Hands off to {data!.subagents.map((agent) => `${agent.name} (${agent.runs})`).join(", ")}</p>}</Panel>
      </div>
    </>}
  </div>;
}

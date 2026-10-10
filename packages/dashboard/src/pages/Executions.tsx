import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, CircleAlert, GitCompare, Route, ShieldCheck } from "lucide-react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/useAuth";
import { EmptyPanel, LoadingRows, PageHeader, Panel, ScopeToolbar, StatusPill, type Period } from "../components/ConsolePrimitives";
import { dateInputToIso, formatAbsoluteDate, formatDateTime, formatReportedAmount, parsePeriod, periodDates, reportingCurrencyNote, type ReportingFx } from "../components/consoleFormatters";
import { isPrototypePreview } from "../prototypePreview";
import { prototypeState, PrototypeStateNotice, PrototypeStatePanel } from "../components/PrototypeState";
import "./PrototypeRoute.css";

interface Execution {
  id: string;
  project_id: string;
  group_id: string | null;
  name: string | null;
  kind: string | null;
  state: string | null;
  execution_state?: string | null;
  started_at: string | null;
  ended_at: string | null;
  elapsed_ms: number | null;
  observations: number;
  call_count: number;
  known_cost: number | null;
  unpriced_count: number;
  pricing_coverage: number | null;
  accounting_state: string | null;
  expected_items?: number | null;
  completed_items?: number | null;
  failed_items?: number | null;
  phases?: Record<string, { knownCost?: number | null; unpricedCount?: number; observations?: number }>;
  configuration?: Record<string, unknown> | null;
  dataset_revision?: string | null;
  service?: string | null;
  release?: string | null;
}

interface ExecutionDetail { execution: Execution; traces: Array<{ trace_id: string; trace_name: string | null; call_count: number; started_at: string; ended_at: string }>; phases: Array<{ phase: string; observations: number; known_cost: number | null; unpriced_count: number }> }

async function getExecutions(projectId: string, options: { from?: string; to?: string; environment?: string; groupId?: string } = {}): Promise<{ executions: Execution[]; total: number }> {
  const params = new URLSearchParams({ limit: "50", offset: "0" });
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  if (options.environment) params.set("environment", options.environment);
  if (options.groupId) params.set("groupId", options.groupId);
  const response = await fetch(`/api/v1/projects/${projectId}/executions?${params.toString()}`, { credentials: "include" });
  if (!response.ok) throw new Error(`Grouped work request failed (${response.status})`);
  return response.json() as Promise<{ executions: Execution[]; total: number }>;
}

async function getExecution(projectId: string, executionId: string): Promise<ExecutionDetail> {
  const response = await fetch(`/api/v1/projects/${projectId}/executions/${encodeURIComponent(executionId)}`, { credentials: "include" });
  if (!response.ok) throw new Error(`Execution request failed (${response.status})`);
  return response.json() as Promise<ExecutionDetail>;
}

/** Status words for a batch, from the state its job reported. */
function batchStatus(execution: Execution): { tone: "good" | "warn" | "critical" | "neutral"; label: string } {
  const state = String(execution.execution_state || execution.state || "").toLowerCase();
  if (state === "failed" || state === "error") return { tone: "critical", label: "Failed" };
  if (state === "cancelled" || state === "canceled") return { tone: "neutral", label: "Cancelled" };
  if (state === "running" || state === "in_progress" || state === "started") return { tone: "neutral", label: "Running" };
  if (execution.unpriced_count > 0) return { tone: "warn", label: "Partly priced" };
  if (state === "completed" || state === "complete") return { tone: "good", label: "Complete" };
  return { tone: "neutral", label: "Recorded" };
}

function ComparePanel({ items, onClose, currency, fx }: { items: Execution[]; onClose: () => void; currency: string; fx?: ReportingFx | null }) {
  return <Panel title="Compare batches"><div className="ck-compare-grid">{items.map((item) => <div className="ck-compare-card" key={item.id}><div className="ck-overline">{item.kind || "Batch"}</div><h3>{item.name || "Unnamed batch"}</h3><p>{item.started_at ? formatAbsoluteDate(item.started_at) : item.id}</p><dl><div><dt>Cost</dt><dd>{item.known_cost == null ? "Unpriced" : formatReportedAmount(item.known_cost, currency, fx)}</dd></div><div><dt>Calls</dt><dd>{Number(item.call_count ?? item.observations ?? 0).toLocaleString()}</dd></div><div><dt>Pricing</dt><dd>{item.unpriced_count > 0 ? `${item.unpriced_count} unpriced` : "All calls priced"}</dd></div><div><dt>Status</dt><dd>{batchStatus(item).label}</dd></div></dl></div>)}</div><div className="ck-form-footer" style={{ padding: "14px 18px" }}><button className="ck-button ck-button-secondary" type="button" onClick={onClose}>Close comparison</button></div></Panel>;
}

function ExecutionHistoryTable({ executions, currency, fx, returnTo, compareIds, onSelect }: { executions: Execution[]; currency: string; fx?: ReportingFx | null; returnTo: string; compareIds: string[]; onSelect: (id: string) => void }) {
  const prototype = isPrototypePreview();
  return <div className="ck-table-wrap"><table className="ck-table"><thead><tr><th className="ck-select-cell"><span className="sr-only">Compare</span></th><th>Batch</th><th className="hide-mobile">Settings</th><th>Items</th><th className="hide-mobile">Status</th><th className="numeric">Cost ({currency})</th></tr></thead><tbody>{executions.map((execution) => {
    const cases = prototype ? "100 traces" : execution.expected_items == null ? `${Number(execution.call_count ?? execution.observations ?? 0).toLocaleString()} calls` : execution.completed_items == null ? `${execution.expected_items.toLocaleString()}` : `${execution.completed_items.toLocaleString()} of ${execution.expected_items.toLocaleString()}`;
    const batch = batchStatus(execution);
    const status = prototype ? (execution.failed_items ? "98 completed · 2 failed" : "100 completed") : execution.failed_items ? `${execution.failed_items} failed` : batch.label;
    const configuration = prototype ? "50 examples × 2 variants" : execution.configuration && Object.keys(execution.configuration).length > 0 ? Object.entries(execution.configuration).slice(0, 2).map(([key, value]) => `${key}: ${String(value)}`).join(" · ") : execution.dataset_revision ? `Dataset ${execution.dataset_revision}` : execution.kind || "—";
    const timeLabel = prototype ? "20 Sep, 02:00" : execution.started_at ? formatDateTime(execution.started_at) : "Time not recorded";
    const receiptParams = new URLSearchParams(returnTo.includes("?") ? returnTo.slice(returnTo.indexOf("?") + 1) : "");
    receiptParams.set("view", "receipt"); receiptParams.set("execution", execution.id);
    return <tr key={execution.id} className={compareIds.includes(execution.id) ? "selected" : undefined}><td className="ck-select-cell"><input type="checkbox" checked={compareIds.includes(execution.id)} onChange={() => onSelect(execution.id)} disabled={!compareIds.includes(execution.id) && compareIds.length >= 2} aria-label={`Compare ${execution.name || execution.id}`} /></td><td><Link className="ck-table-link primary-cell" to={prototype ? `/group?${receiptParams.toString()}` : `/executions/${encodeURIComponent(execution.id)}`} state={{ returnTo }}>{prototype ? `nightly-search-quality / ${execution.id.endsWith("-20") ? "20 Sep" : "19 Sep"}` : execution.name || execution.group_id || "Unnamed batch"}</Link><div className="muted">{timeLabel}</div></td><td className="hide-mobile">{configuration}{prototype && <div className="muted">Variants A and B</div>}</td><td>{cases}</td><td className="hide-mobile"><StatusPill tone={batch.tone}>{status}</StatusPill></td><td className="numeric ck-cost-cell">{execution.known_cost == null ? "Unpriced" : formatReportedAmount(execution.known_cost, currency, fx)}</td></tr>;
  })}</tbody></table></div>;
}

function ExecutionDetailView({ projectId, executionId, currency, fx }: { projectId: string; executionId: string; currency: string; fx?: ReportingFx | null }) {
  const requestKey = `${projectId}:${executionId}`;
  const [state, setState] = useState<{ key: string; detail: ExecutionDetail | null; error: string | null }>({ key: "", detail: null, error: null });
  const loading = state.key !== requestKey;
  const detail = state.key === requestKey ? state.detail : null;
  const error = state.key === requestKey ? state.error : null;
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = typeof location.state === "object" && location.state !== null && "returnTo" in location.state && typeof (location.state as { returnTo?: unknown }).returnTo === "string" ? (location.state as { returnTo: string }).returnTo : "/executions";
  useEffect(() => {
    let cancelled = false;
    getExecution(projectId, executionId).then((result) => { if (!cancelled) setState({ key: requestKey, detail: result, error: null }); }).catch((reason: unknown) => { if (!cancelled) setState({ key: requestKey, detail: null, error: reason instanceof Error ? reason.message : "Couldn’t load this batch" }); });
    return () => { cancelled = true; };
  }, [projectId, executionId, requestKey]);
  if (loading) return <><PageHeader title="Loading batch" /><Panel><LoadingRows count={5} columns={4} /></Panel></>;
  if (!detail || error) return <><PageHeader title="Batch unavailable" actions={<Link className="ck-button ck-button-secondary" to={returnTo}><ArrowLeft size={13} /> Experiments</Link>} /><Panel><EmptyPanel title="Couldn’t open this batch" body="It may have expired, or it belongs to a project you can’t open." icon={<CircleAlert size={18} />} /></Panel></>;
  const execution = detail.execution;
  return <><div className="ck-detail-header"><div><Link className="ck-back-link" to={returnTo}><ArrowLeft size={13} /> Experiments</Link><h1 className="ck-detail-title">{execution.name || "Unnamed batch"}</h1><div className="ck-detail-id">{execution.started_at ? `${formatAbsoluteDate(execution.started_at)} · ` : ""}{execution.kind ? `${execution.kind} · ` : ""}<span className="mono">{execution.id}</span></div></div><div className="ck-detail-actions">{execution.group_id && <Link className="ck-button ck-button-secondary" to={`/policy-edit?project=${encodeURIComponent(execution.project_id)}&scopeDimension=group&scopeValue=${encodeURIComponent(execution.group_id)}`}><ShieldCheck size={13} /> Budget per batch</Link>}<button className="ck-button ck-button-secondary" type="button" onClick={() => navigate(`/executions?compare=${encodeURIComponent(execution.id)}${returnTo.includes("?") ? `&${returnTo.slice(returnTo.indexOf("?") + 1)}` : ""}`)}><GitCompare size={13} /> Compare</button></div></div><div className="ck-summary-strip"><div className="ck-summary-item"><div className="ck-overline">Cost</div><div className="ck-summary-value">{execution.known_cost == null ? "Unpriced" : formatReportedAmount(execution.known_cost, currency, fx)}</div><div className="ck-summary-meta">{execution.unpriced_count > 0 ? `${execution.unpriced_count} calls unpriced` : "All calls priced"}</div></div><div className="ck-summary-item"><div className="ck-overline">Status</div><div className="ck-summary-value"><StatusPill tone={batchStatus(execution).tone}>{batchStatus(execution).label}</StatusPill></div></div><div className="ck-summary-item"><div className="ck-overline">Runs</div><div className="ck-summary-value">{detail.traces.length.toLocaleString()}</div><div className="ck-summary-meta">{Number(execution.call_count ?? execution.observations ?? 0).toLocaleString()} calls</div></div></div><div className="ck-content-grid ck-grid-top"><Panel title="Cost by phase"><div className="ck-table-wrap"><table className="ck-table"><thead><tr><th>Phase</th><th className="numeric">Cost ({currency})</th><th className="numeric">Calls</th><th className="numeric">Unpriced</th></tr></thead><tbody>{detail.phases.map((phase) => <tr key={phase.phase}><td className="primary-cell">{phase.phase}</td><td className="numeric">{phase.known_cost == null ? "Unpriced" : formatReportedAmount(phase.known_cost, currency, fx)}</td><td className="numeric">{phase.observations.toLocaleString()}</td><td className="numeric">{phase.unpriced_count.toLocaleString()}</td></tr>)}</tbody></table></div></Panel><Panel title="Runs in this batch">{detail.traces.length === 0 ? <EmptyPanel title="No runs recorded" icon={<Route size={18} />} /> : <div className="ck-trace-steps">{detail.traces.map((trace) => <Link className="ck-step" key={trace.trace_id} to={`/traces/${encodeURIComponent(trace.trace_id)}`}><span className="ck-step-rail" aria-hidden="true" /><span><span className="ck-step-name">{trace.trace_name || trace.trace_id}</span><span className="ck-step-meta"><span>{trace.call_count} calls</span><span>{formatDateTime(trace.started_at)}</span></span></span><ArrowRight size={14} /></Link>)}</div>}</Panel></div></>;
}

export default function Executions() {
  const { currentProjectId, projects, org, workspaceSettings } = useAuth();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  const { executionId } = useParams();
  const [params, setParams] = useSearchParams();
  const previewState = params.get("state");
  const previewLoading = previewState === "loading";
  const previewEmpty = previewState === "empty";
  const previewError = previewState === "error" ? "Couldn’t refresh experiments. Nothing was changed." : null;
  const [period, setPeriod] = useState<Period>(() => parsePeriod(params.get("period")));
  const timezone = workspaceSettings?.timezone ?? org?.timezone;
  const reportingCurrency = workspaceSettings?.reportingCurrency ?? "USD";
  const fx = workspaceSettings?.fx;
  const currencyNote = reportingCurrencyNote(reportingCurrency, fx);
  const environment = params.get("environment") ?? "all";
  const groupFilter = params.get("group") ?? params.get("groupId");
  const requestedFrom = params.get("from");
  const requestedTo = params.get("to");
  const scopeOverride = requestedFrom && requestedTo && Number.isFinite(new Date(requestedFrom).getTime()) && Number.isFinite(new Date(requestedTo).getTime()) && new Date(requestedFrom) < new Date(requestedTo) ? { from: requestedFrom, to: requestedTo } : null;
  const { from, to } = scopeOverride ?? periodDates(period, timezone ?? undefined);
  const requestKey = [projectId ?? "none", period, environment, groupFilter ?? "", scopeOverride?.from ?? "", scopeOverride?.to ?? ""].join(":");
  const [state, setState] = useState<{ key: string; executions: Execution[]; error: string | null }>({ key: "", executions: [], error: null });
  const loading = Boolean(projectId) && !executionId && (previewLoading || state.key !== requestKey);
  const executions = previewEmpty ? [] : state.key === requestKey ? state.executions : [];
  const error = previewError ?? (state.key === requestKey ? state.error : null);
  useEffect(() => {
    if (!projectId || executionId) return;
    let cancelled = false;
    getExecutions(projectId, { from, to, environment: environment === "all" ? undefined : environment, groupId: groupFilter ?? undefined }).then((result) => { if (!cancelled) setState({ key: requestKey, executions: result.executions ?? [], error: null }); }).catch((reason: unknown) => { if (!cancelled) setState({ key: requestKey, executions: [], error: reason instanceof Error ? reason.message : "Couldn’t load experiments" }); });
    return () => { cancelled = true; };
  }, [projectId, executionId, requestKey, from, to, environment, groupFilter]);
  if (!projectId) return <div className="ck-main-inner"><PageHeader title="Experiments" /><Panel><EmptyPanel illustration="room-to-explore" title="Room to explore" body="Connect a project to start." action={<Link className="ck-button ck-button-primary" to="/onboarding">Connect a project</Link>} /></Panel></div>;
  const explicitState = prototypeState(params);
  const namedState = PrototypeStatePanel({ state: explicitState, family: "Experiments", title: explicitState === "error" ? "Couldn’t load experiments" : undefined, backHref: "/traces", retryHref: `/executions${window.location.search}`, loadingRows: 5 });
  if (namedState) return namedState;
  if (executionId) return <div className="ck-main-inner"><ExecutionDetailView projectId={projectId} executionId={decodeURIComponent(executionId)} currency={reportingCurrency} fx={fx} /></div>;
  const compareIds = (params.get("compare") ?? "").split(",").filter(Boolean).slice(0, 2);
  const compareItems = compareIds.map((id) => executions.find((item) => item.id === id)).filter((item): item is Execution => Boolean(item));
  function toggle(id: string): void { setParams((current) => { const ids = new Set((current.get("compare") ?? "").split(",").filter(Boolean)); if (ids.has(id)) ids.delete(id); else if (ids.size < 2) ids.add(id); current.delete("compare"); if (ids.size) current.set("compare", [...ids].join(",")); return current; }); }
  const scopeLinkParams = new URLSearchParams({ project: projectId });
  if (scopeOverride) { scopeLinkParams.set("period", "custom"); scopeLinkParams.set("from", scopeOverride.from); scopeLinkParams.set("to", scopeOverride.to); }
  else scopeLinkParams.set("period", period);
  if (environment !== "all") scopeLinkParams.set("environment", environment);
  const scopeLink = `?${scopeLinkParams.toString()}`;
  const toolbarPeriod: Period = scopeOverride ? "custom" : period;
  const changePeriod = (next: Period): void => {
    if (next === "custom") {
      const dates = periodDates("30d", timezone ?? undefined);
      setPeriod(next);
      setParams((current) => { current.set("period", "custom"); current.set("from", dates.from); current.set("to", dates.to); return current; });
      return;
    }
    setPeriod(next);
    setParams((current) => { current.set("period", next); current.delete("from"); current.delete("to"); return current; });
  };
  const changeCustomRange = (fromValue: string, toValue: string): void => {
    const nextFrom = dateInputToIso(fromValue, timezone ?? undefined);
    const nextTo = dateInputToIso(toValue, timezone ?? undefined, true);
    if (!nextFrom || !nextTo || new Date(nextFrom) >= new Date(nextTo)) return;
    setPeriod("custom");
    setParams((current) => { current.set("period", "custom"); current.set("from", nextFrom); current.set("to", nextTo); return current; });
  };
  const environmentOptions = environment === "all" ? [{ value: "all", label: "All environments" }] : [{ value: "all", label: "All environments" }, { value: environment, label: environment }];
  const returnTo = `/executions${scopeLink}`;
  const selectedExecution = executions.find((execution) => execution.id === (params.get("execution") ?? "")) ?? executions[0];
  const rawGroupName = params.get("groupName") ?? groupFilter ?? selectedExecution?.name ?? "Experiments";
  const groupName = groupFilter ? groupFilter.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : rawGroupName;
  const hasGroupContext = Boolean(groupFilter || params.get("groupName") || params.get("view") || params.get("execution"));
  const prototype = isPrototypePreview();
  const pageTitle = prototype ? "Nightly search quality" : hasGroupContext ? (selectedExecution?.name || groupName) : "Experiments";
  return <div className="ck-main-inner prototype-group-route">
    <PageHeader title={pageTitle} actions={<ScopeToolbar period={toolbarPeriod} onPeriodChange={changePeriod} customFrom={scopeOverride?.from} customTo={scopeOverride?.to} onCustomRangeChange={changeCustomRange} environment={environment} onEnvironmentChange={(next) => setParams((current) => { if (next === "all") current.delete("environment"); else current.set("environment", next); return current; })}     environmentOptions={environmentOptions} currency={reportingCurrency} currencyNote={currencyNote} timezone={timezone ?? undefined} chips={groupFilter ? <><StatusPill tone="info">Group: {groupFilter}</StatusPill><button className="ck-button ck-button-quiet sm" type="button" onClick={() => setParams((current) => { current.delete("group"); current.delete("groupId"); current.delete("groupName"); current.delete("execution"); current.delete("view"); return current; })}>Clear filters</button></> : undefined} />} />
    
    <PrototypeStateNotice state={explicitState} family="grouped work" role="owner" />
    {explicitState === "delayed" && <div className="ck-alert" role="status"><CircleAlert size={15} /><div><strong>Scores are running late.</strong> Costs are here; outcomes may arrive later.</div></div>}
    {explicitState === "voice" && <div className="ck-alert" role="status"><CircleAlert size={15} /><div><strong>Some voice costs are missing.</strong> Speech, language and voice charges show separately as they arrive.</div></div>}
    {explicitState === "job" && <div className="ck-alert ck-alert-error" role="alert"><ShieldCheck size={15} /><div><strong>A batch was stopped by its budget.</strong> CostKey refused further calls. It doesn’t stop the job itself.</div></div>}
    {error && <div className="ck-alert" style={{ marginBottom: 18 }}><CircleAlert size={15} />{error}</div>}
    {compareItems.length === 2 && <div style={{ marginBottom: 18 }}><ComparePanel items={compareItems} currency={reportingCurrency} fx={fx} onClose={() => setParams((current) => { current.delete("compare"); return current; })} /></div>}
    {loading || previewLoading ? <Panel title="Batches"><LoadingRows count={5} columns={5} /></Panel> : executions.length === 0 ? <Panel><EmptyPanel illustration="room-to-explore" title="Room to explore" body="Wrap a job or eval with startExecution to see each batch’s cost." action={<div className="ck-button-row"><a className="ck-button ck-button-secondary" href="https://costkey.dev/docs" target="_blank" rel="noreferrer">Read the guide</a><Link className="ck-button ck-button-secondary" to={`/traces${scopeLink}`}>View runs</Link></div>} /></Panel> : <>
      <Panel title="Batches"><ExecutionHistoryTable executions={executions} currency={reportingCurrency} fx={fx} returnTo={returnTo} compareIds={compareIds} onSelect={toggle} /></Panel>
    </>}
  </div>;
}

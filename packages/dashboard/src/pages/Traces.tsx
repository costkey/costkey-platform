import { appUrl, currentRouterPath } from "../basePath";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, CircleAlert, Copy, Download, ExternalLink, GitCompare, Info, Pin, RefreshCw, Route, Search, Share, SlidersHorizontal } from "lucide-react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  getEvents,
  getTrace,
  getTraceFilterOptions,
  getTraces,
  type EventRow,
  type Trace,
  type TraceEvent,
  type TraceQuery,
  type TraceFilterDimension,
  type TraceFilterOption,
  type TraceSort,
} from "../api";
import { useAuth } from "../contexts/useAuth";
import {
  EmptyPanel,
  LoadingRows,
  PageHeader,
  Panel,
  ScopeToolbar,
  StatusPill,
  type Period,
} from "../components/ConsolePrimitives";
import { dateInputToIso, displayTimeZoneLabel, formatAbsoluteDate, formatDateTime, formatReportedAmount, periodDates, reportingCurrencyNote, type ReportingFx } from "../components/consoleFormatters";
import { restoreTraceView, serializeTraceView, TRACE_VIEW_FILTER_KEYS } from "./traceViewState";
import { formatDuration } from "../utils";
import { callCostText, callFailure } from "../components/callOutcome";
import { LiveStatus } from "../components/LiveStatus";
import { UserId } from "../components/UserId";
import { featureHref, userHref } from "../components/links";
import { useLiveQuery, useNewIds, usePointerHold } from "../hooks/useLiveQuery";
import { eventDisplayName, inspectorTab, isCallEvent, parseJson, PRICE_PENDING_HINT, RunFlow, runModel, runStatus, RunStatusPill, RunSummaryStrip, useRunDetail } from "../components/RunFlow";
import { prototypeRole, prototypeState, PrototypeStateNotice, PrototypeStatePanel } from "../components/PrototypeState";
import { isPrototypePreview } from "../prototypePreview";
import "./PrototypeRoute.css";
import { ProviderLabel } from "../components/ProviderLogo";

type ListView = "traces" | "calls";

interface SavedView {
  id: string;
  name: string;
  visibility: "private" | "workspace";
  definition: Record<string, unknown>;
  pinned: boolean;
}

interface TraceFiltersState {
  provider: string[];
  model: string[];
  feature: string[];
  function: string[];
  customer: string[];
  environment: string[];
  lifecycle: string[];
  accounting: string[];
}

const EMPTY_TRACE_FILTERS: TraceFiltersState = { provider: [], model: [], feature: [], function: [], customer: [], environment: [], lifecycle: [], accounting: [] };
const TRACE_FILTER_KEYS: Array<keyof TraceFiltersState> = [...TRACE_VIEW_FILTER_KEYS];
const TRACE_SORTS: Array<{ value: TraceSort; label: string }> = [{ value: "newest", label: "Newest" }, { value: "cost_desc", label: "Highest cost" }, { value: "duration_desc", label: "Longest" }, { value: "calls_desc", label: "Most calls" }];

function parsePrototypePeriod(value: string | null): Period {
  const normalized = value?.trim().toLowerCase().replaceAll("_", "-") ?? "";
  if (["24h", "last-24-hours", "last-24-hour"].includes(normalized)) return "24h";
  if (["7d", "last-7-days", "last-7-day"].includes(normalized)) return "7d";
  if (["30d", "last-30-days", "last-30-day"].includes(normalized)) return "30d";
  if (["custom", "custom-range"].includes(normalized)) return "custom";
  return "mtd";
}

function prototypePreviewCall(state: "partial" | "orphan"): EventRow {
  const standalone = state === "orphan";
  return {
    id: "custom-call-0008",
    timestamp: "2026-09-20T14:32:00.000Z",
    trace_id: standalone ? null : "search-request-1042",
    trace_name: standalone ? null : "search-request-1042",
    provider: standalone ? "Custom provider" : "Anthropic",
    model: standalone ? "custom-model-v2" : "Context model",
    request_model: standalone ? "custom-model-v2" : "Context model",
    url: "https://api.example/v1/chat/completions",
    method: "POST",
    status_code: 200,
    input_tokens: 1200,
    output_tokens: 180,
    total_tokens: 1380,
    cost_usd: standalone ? 0.0188 : null,
    cost_basis: standalone ? "estimated" : "unknown",
    cost_source: standalone ? "Synthetic fixture rate" : null,
    cost_currency: "USD",
    content_status: "captured",
    unit_kind: "tokens",
    unit_value: 1200,
    unit: "tokens",
    aggregation: "component",
    duration_ms: 800,
    streaming: false,
    ttft: null,
    tps: null,
    call_site_raw: standalone ? "Unassigned" : "build_context · shared/context.py",
    call_site_frames: [],
    context: standalone ? null : { feature: "Search", environment: "Production" },
    metadata: null,
    system_prompt: null,
    request_body: null,
    response_body: null,
    bl_function: standalone ? "Unassigned" : "build_context",
    bl_file: standalone ? null : "shared/context.py",
    bl_line: standalone ? null : 148,
    feature_source: standalone ? null : "mapped",
    feature_mapping_id: null,
    feature_original: standalone ? null : "Search",
  };
}

function readTraceSort(value: string | null): TraceSort {
  return TRACE_SORTS.some((option) => option.value === value) ? value as TraceSort : "newest";
}

function normalizeTrace(trace: Trace): Trace {
  const knownCost = trace.known_cost !== undefined
    ? (trace.known_cost == null ? null : Number(trace.known_cost) || 0)
    : (Number(trace.total_cost) || 0);
  return {
    ...trace,
    call_count: Number(trace.call_count) || 0,
    total_cost: knownCost ?? 0,
    total_input_tokens: Number(trace.total_input_tokens) || 0,
    total_output_tokens: Number(trace.total_output_tokens) || 0,
    total_duration_ms: Number(trace.total_duration_ms) || 0,
    known_cost: knownCost,
    unpriced_count: Number(trace.unpriced_count) || 0,
  };
}

function knownTraceCost(trace: Trace): number | null {
  if (trace.known_cost !== undefined) return trace.known_cost == null ? null : Number(trace.known_cost) || 0;
  return trace.total_cost > 0 ? Number(trace.total_cost) : null;
}

/**
 * Trace and call tables keep four decimal places for sub-dollar rows. This is
 * deliberate: the table is a cost-inspection surface, so rounding a $0.0112
 * call to $0.01 hides the evidence the prototype is designed to expose.
 */
function formatTraceTableCost(value: number | null | undefined, currency: string, fx?: ReportingFx | null): string {
  if (value == null || !Number.isFinite(Number(value))) return "Unpriced";
  if (currency.toUpperCase() === "USD") {
    const amount = Number(value);
    return `$${amount.toFixed(Math.abs(amount) < 1 ? 4 : 2)}`;
  }
  return formatReportedAmount(value, currency, fx);
}

function traceDuration(trace: Trace): string {
  const start = new Date(trace.started_at).getTime();
  const end = new Date(trace.ended_at).getTime();
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return formatDuration(end - start);
  return formatDuration(Number(trace.total_duration_ms) || 0);
}

function traceLabel(trace: Trace): string {
  return trace.trace_name?.trim() || `Run ${trace.trace_id.slice(0, 12)}`;
}


function useTraceList(projectId: string | null, view: ListView, period: Period, query: string, filters: TraceFiltersState, sort: TraceSort, page: number, pageSize: number, reload: number, timezone?: string | null, contextKey?: string | null, contextValue?: string[] | null, scopeOverride?: { from: string; to: string } | null, shouldDefer?: () => boolean, withCalls = true) {
  const filterKey = JSON.stringify(filters);
  const contextValueKey = JSON.stringify(contextValue ?? []);
  const overrideFrom = scopeOverride?.from;
  const overrideTo = scopeOverride?.to;
  const requestKey = [projectId ?? "none", view, period, query, filterKey, sort, page, pageSize, reload, timezone ?? "", contextKey ?? "", contextValueKey, overrideFrom ?? "", overrideTo ?? "", withCalls ? "calls" : "all"].join("\u0002");
  // Live: refreshes every 10 s while the tab is visible; the period's end moves with the clock.
  const live = useLiveQuery(projectId ? requestKey : null, async () => {
    const { from, to } = overrideFrom && overrideTo ? { from: overrideFrom, to: overrideTo } : periodDates(period, timezone ?? undefined);
    const requestFilters = JSON.parse(filterKey) as TraceFiltersState;
    const requestContextValues = JSON.parse(contextValueKey) as string[];
    const contextScope: Pick<TraceQuery, "groupBy" | "contextKey" | "contextValue"> = contextKey && requestContextValues.length > 0 ? { groupBy: "context", contextKey, contextValue: requestContextValues } : {};
    if (view === "traces") {
      const result = await getTraces(projectId!, { limit: pageSize, offset: page * pageSize, q: query || undefined, from, to, sort, withCalls, ...requestFilters, ...contextScope } satisfies TraceQuery);
      return { key: requestKey, traces: result.traces.map(normalizeTrace), calls: [] as EventRow[], total: Number(result.total) || 0 };
    }
    const result = await getEvents(projectId!, { limit: pageSize, offset: page * pageSize, q: query || undefined, from, to, sort, ...requestFilters, ...contextScope });
    return { key: requestKey, traces: [] as Trace[], calls: result.events, total: Number(result.total) || 0 };
  }, { shouldDefer });
  const current = live.data?.key === requestKey ? live.data : null;
  return {
    traces: current?.traces ?? [],
    calls: current?.calls ?? [],
    total: current?.total ?? 0,
    loading: Boolean(projectId) && !current,
    refreshing: false,
    error: current || !live.error ? null : live.error,
    liveError: live.error,
    status: live.status,
    updatedAt: live.updatedAt,
    refresh: live.refresh,
  };
}

function TraceViewTabs({ view, onViewChange }: { view: ListView; onViewChange: (view: ListView) => void }) {
  return <div className="ck-trace-tabs-row"><div className="ck-tabs" role="tablist" aria-label="Show runs or calls"><button className={`ck-tab ${view === "traces" ? "active" : ""}`} role="tab" aria-selected={view === "traces"} type="button" onClick={() => onViewChange("traces")}>Runs</button><button className={`ck-tab ${view === "calls" ? "active" : ""}`} role="tab" aria-selected={view === "calls"} type="button" onClick={() => onViewChange("calls")}>Calls</button></div></div>;
}

function ListToolbar({ draft, onDraftChange, onSubmit, sort, onSort, selectedCount, onClearSelection, savedViews, onSavedViewChange, onCompare, filtersOpen, onToggleFilters, onRefresh, activeViewId, onDeleteView }: { activeViewId?: string | null; onDeleteView?: (view: SavedView) => void; draft: string; onDraftChange: (value: string) => void; onSubmit: (event: FormEvent) => void; sort: TraceSort; onSort: (sort: TraceSort) => void; selectedCount: number; onClearSelection: () => void; savedViews: SavedView[]; onSavedViewChange: (view: SavedView) => void; onCompare: () => void; filtersOpen: boolean; onToggleFilters: () => void; onRefresh: () => void }) {
  return (
    <>
      <div className="ck-trace-toolbar">
        <div className="prototype-trace-toolbar-leading"><form className="ck-trace-search" onSubmit={onSubmit}><Search size={14} aria-hidden="true" /><label className="sr-only" htmlFor="trace-search">Search runs and calls</label><input id="trace-search" type="search" value={draft} onChange={(event) => onDraftChange(event.target.value)} placeholder="Search runs, models, functions" /><span className="ck-search-hint" aria-hidden="true">↵</span></form><label className="ck-saved-view-select"><span className="sr-only">Saved view</span><select className="ck-select" value={savedViews.some((item) => item.id === activeViewId) ? activeViewId ?? "" : ""} aria-label="Saved views" onChange={(event) => { const match = savedViews.find((item) => item.id === event.target.value); if (match) onSavedViewChange(match); }}><option value="">Saved views</option>{savedViews.map((item) => <option key={item.id} value={item.id}>{item.name}{item.visibility === "workspace" ? " · workspace" : ""}</option>)}</select></label>{onDeleteView && activeViewId && savedViews.some((item) => item.id === activeViewId) && <button className="ck-button ck-button-quiet" type="button" onClick={() => onDeleteView(savedViews.find((item) => item.id === activeViewId)!)}>Remove view</button>}</div>
        <div className="ck-trace-toolbar-actions"><button className="ck-button ck-button-secondary" type="button" onClick={onToggleFilters} aria-expanded={filtersOpen}><SlidersHorizontal size={14} /> Filters</button><button className="ck-icon-button ck-trace-refresh" type="button" onClick={onRefresh} aria-label="Refresh runs"><RefreshCw size={16} aria-hidden="true" /></button>{selectedCount > 0 && <><span className="ck-table-note" style={{ border: 0, padding: 0 }}>{selectedCount}/2 selected</span><button className="ck-button ck-button-quiet" type="button" onClick={onClearSelection}>Clear</button></>}{selectedCount === 2 && <button className="ck-button ck-button-secondary" type="button" onClick={onCompare}>Compare <ExternalLink size={12} /></button>}<label className="ck-sort-hidden"><span className="sr-only">Sort runs</span><select className="ck-select" aria-label="Sort runs" value={sort} onChange={(event) => onSort(readTraceSort(event.target.value))}>{TRACE_SORTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div>
      </div>
    </>
  );
}


function TraceRows({ traces, fresh, selected, onToggle, onToggleAll, onSort, sort, currency, fx }: { traces: Trace[]; fresh?: ReadonlySet<string>; selected: Set<string>; onToggle: (traceId: string) => void; onToggleAll: () => void; onSort: (sort: TraceSort) => void; sort: TraceSort; currency: string; fx?: ReportingFx | null }) {
  const allSelected = traces.length > 0 && traces.every((trace) => selected.has(trace.trace_id));
  return <div className="ck-table-wrap"><table className="ck-table ck-traces-table"><thead><tr><th aria-label="Select"><input type="checkbox" checked={allSelected} onChange={onToggleAll} aria-label="Select loaded rows" /></th><th>Run</th><th className="ck-trace-hide-mobile"><button type="button" className="ck-table-sort" onClick={() => onSort("newest")}>Started{sort === "newest" && <span aria-hidden="true"> ↓</span>}</button></th><th className="numeric ck-trace-hide-mobile"><button type="button" className="ck-table-sort" onClick={() => onSort(sort === "duration_desc" ? "newest" : "duration_desc")}>Duration{sort === "duration_desc" && <span aria-hidden="true"> ↓</span>}</button></th><th className="numeric ck-trace-hide-mobile">Calls</th><th className="numeric"><button type="button" className="ck-table-sort" onClick={() => onSort(sort === "cost_desc" ? "newest" : "cost_desc")}>Cost ({currency}){sort === "cost_desc" && <span aria-hidden="true"> ↓</span>}</button></th></tr></thead><tbody>{traces.map((trace) => {
    const cost = knownTraceCost(trace);
    const status = runStatus(trace, cost);
    const agentShape = (trace.step_count ?? 0) > 0 || (trace.tool_count ?? 0) > 0
      ? [(trace.step_count ?? 0) > 0 ? `${trace.step_count} step${trace.step_count === 1 ? "" : "s"}` : null, (trace.tool_count ?? 0) > 0 ? `${trace.tool_count} tool call${trace.tool_count === 1 ? "" : "s"}` : null].filter(Boolean).join(", ")
      : null;
    const labels = [trace.feature, trace.environment, agentShape].filter(Boolean).join(" · ");
    return <tr key={trace.trace_id} className={fresh?.has(trace.trace_id) ? "is-new" : undefined}><td><input type="checkbox" checked={selected.has(trace.trace_id)} onChange={() => onToggle(trace.trace_id)} aria-label={`Select ${traceLabel(trace)}`} /></td><td className="primary-cell"><Link className="ck-table-link" to={`/traces/${encodeURIComponent(trace.trace_id)}`} state={{ returnTo: currentRouterPath() }}>{traceLabel(trace)}</Link>{status.tone !== "good" && <> <RunStatusPill status={status} /></>}{labels && <div className="muted">{labels}</div>}<span className="ck-trace-mobile-line muted">{formatDateTime(trace.started_at)}</span></td><td className="ck-trace-hide-mobile">{formatDateTime(trace.started_at)}</td><td className="numeric ck-trace-hide-mobile">{traceDuration(trace)}</td><td className="numeric ck-trace-hide-mobile">{trace.call_count.toLocaleString()}</td><td className="numeric ck-cost-cell">{trace.call_count === 0 ? <span className="ck-muted-value">No model calls</span> : cost == null ? <span title={PRICE_PENDING_HINT}>Unpriced</span> : formatTraceTableCost(cost, currency, fx)}</td></tr>;
  })}</tbody></table></div>;
}

function CallRows({ calls, fresh, returnTo, currency, fx }: { calls: EventRow[]; fresh?: ReadonlySet<string>; returnTo: string; currency: string; fx?: ReportingFx | null }) {
  if (calls.length === 0) return <EmptyPanel title="No calls match these filters" body="Clear the search, or try a longer period." action={<Link className="ck-button ck-button-secondary" to="/traces?tab=calls">Clear filters</Link>} icon={<Search size={18} />} />;
  return <div className="ck-table-wrap"><table className="ck-table"><thead><tr><th>Call</th><th className="ck-trace-hide-mobile">Run</th><th className="ck-trace-hide-mobile">Usage</th><th className="ck-trace-hide-mobile">Latency</th><th className="ck-trace-hide-mobile">Response</th><th className="numeric">Cost (USD)</th></tr></thead><tbody>{calls.map((call) => { const failure = callFailure(call); const traceId = call.trace_id || contextTraceId(call.context); const usage = call.input_tokens != null || call.output_tokens != null ? `${Number(call.input_tokens ?? 0).toLocaleString()} in / ${Number(call.output_tokens ?? 0).toLocaleString()} out` : call.total_tokens != null ? `${Number(call.total_tokens).toLocaleString()} tokens` : "Not reported"; return <tr key={call.id} className={fresh?.has(call.id) ? "is-new" : undefined}><td className="primary-cell"><Link className="ck-table-link" to={traceId ? `/traces/${encodeURIComponent(traceId)}?call=${encodeURIComponent(call.id)}` : `/traces?tab=calls&q=${encodeURIComponent(call.id)}`} state={{ returnTo }}>{call.model || call.id.slice(0, 12)}</Link>{failure && <> <StatusPill tone="critical">{failure.label}</StatusPill></>}<div className="muted"><ProviderLabel provider={call.provider} size={13} /> · {eventDisplayName(call)}</div></td><td className="ck-trace-hide-mobile">{traceId ? <Link className="ck-table-link mono" to={`/traces/${encodeURIComponent(traceId)}`} state={{ returnTo }}>{traceId.slice(0, 16)}</Link> : <span className="muted">Not part of a run</span>}</td><td className="ck-trace-hide-mobile">{usage}<div className="muted">{call.unit || "tokens"}</div></td><td className="ck-trace-hide-mobile">{formatDuration(Number(call.duration_ms) || 0)}</td><td className="ck-trace-hide-mobile">{failure ? <span className="ck-tone-critical-text">{failure.reason ?? failure.label}</span> : call.status_code == null ? <span className="muted">Not recorded</span> : `HTTP ${call.status_code}`}</td><td className="numeric ck-cost-cell">{call.cost_usd != null ? <><span>{formatTraceTableCost(Number(call.cost_usd), currency, fx)}</span>{call.cost_basis === "reported" && <div className="muted">Reported by provider</div>}</> : callCostText(call, (value) => formatTraceTableCost(value, currency, fx))}</td></tr>; })}</tbody></table></div>;
}

function contextTraceId(context: EventRow["context"]): string {
  try {
    const value = typeof context === "string" ? JSON.parse(context) as Record<string, unknown> : context;
    return typeof value?.traceId === "string" ? value.traceId : "";
  } catch { return ""; }
}

function mergeFilterOptions(current: Partial<Record<TraceFilterDimension, TraceFilterOption[]>>, next: Partial<Record<TraceFilterDimension, TraceFilterOption[]>>): Partial<Record<TraceFilterDimension, TraceFilterOption[]>> {
  const merged: Partial<Record<TraceFilterDimension, TraceFilterOption[]>> = { ...current };
  for (const [dimension, options] of Object.entries(next) as Array<[TraceFilterDimension, TraceFilterOption[] | undefined]>) {
    const byValue = new Map((merged[dimension] ?? []).map((option) => [option.value, option]));
    for (const option of options ?? []) byValue.set(option.value, option);
    merged[dimension] = [...byValue.values()];
  }
  return merged;
}

function TraceFiltersPopover({ filters, options, optionsComplete, nextCursor, optionSearch, onOptionSearchChange, onLoadMore, onApply, onClear }: { filters: TraceFiltersState; options: Partial<Record<TraceFilterDimension, TraceFilterOption[]>>; optionsComplete: boolean; nextCursor?: string | null; optionSearch: string; onOptionSearchChange: (value: string) => void; onLoadMore: () => void; onApply: (filters: TraceFiltersState) => void; onClear: () => void }) {
  const [draft, setDraft] = useState<TraceFiltersState>(() => ({
    provider: [...filters.provider], model: [...filters.model], feature: [...filters.feature], function: [...filters.function],
    customer: [...filters.customer], environment: [...filters.environment], lifecycle: [...filters.lifecycle], accounting: [...filters.accounting],
  }));
  const fields: Array<{ key: keyof TraceFiltersState; label: string; placeholder: string }> = [
    { key: "provider", label: "Provider", placeholder: "All providers" },
    { key: "model", label: "Model", placeholder: "All models" },
    { key: "feature", label: "Feature", placeholder: "All features" },
    { key: "function", label: "Function", placeholder: "All functions" },
    { key: "customer", label: "Customer", placeholder: "All customers" },
    { key: "environment", label: "Environment", placeholder: "All environments" },
    { key: "lifecycle", label: "Status", placeholder: "Any status" },
    { key: "accounting", label: "Pricing", placeholder: "Any pricing" },
  ];
  return <div className="ck-filter-popover" role="region" aria-label="Run filters"><p className="ck-filter-popover-note">{optionsComplete ? "Runs must match every field you set. Within a field, any ticked value matches." : "Some fields have more values than shown. Search, or load more values."}</p><label className="ck-filter-option-search"><span className="ck-filter-label">Find a filter value</span><input className="ck-input" type="search" value={optionSearch} onChange={(event) => onOptionSearchChange(event.target.value)} placeholder="Search providers, models, features…" /></label><div className="ck-filter-popover-grid">{fields.map((field) => { const available = options[field.key as TraceFilterDimension] ?? []; return <fieldset className="ck-form-field ck-filter-fieldset" key={field.key}><legend>{field.label}</legend>{available.length === 0 ? <span className="ck-filter-unavailable">{field.placeholder}</span> : <div className="ck-filter-checks">{available.map((option) => <label key={option.value}><input type="checkbox" checked={draft[field.key].includes(option.value)} onChange={(event) => setDraft({ ...draft, [field.key]: event.target.checked ? [...draft[field.key], option.value] : draft[field.key].filter((value) => value !== option.value) })} /><span>{option.value}</span>{option.count != null && <small>{option.count.toLocaleString()}</small>}</label>)}</div>}</fieldset>; })}</div><div className="ck-filter-popover-footer"><span className="ck-toolbar-spacer" />{nextCursor && <button className="ck-button ck-button-quiet" type="button" onClick={onLoadMore}>Load more values</button>}<button className="ck-button ck-button-quiet" type="button" onClick={onClear}>Clear all</button><button className="ck-button ck-button-primary" type="button" onClick={() => onApply(draft)}>Apply filters</button></div></div>;
}

function TraceCompare({ projectId, ids, currency, fx, onClose }: { projectId: string; ids: string[]; currency: string; fx?: ReportingFx | null; onClose: () => void }) {
  const compareKey = `${projectId}:${ids.join(",")}`;
  const [state, setState] = useState<{ key: string; details: Array<{ traceId: string; summary: Record<string, unknown>; events: TraceEvent[] }>; error: string | null }>({ key: "", details: [], error: null });
  const loading = state.key !== compareKey;
  const details = state.key === compareKey ? state.details : [];
  const error = state.key === compareKey ? state.error : null;
  useEffect(() => {
    let cancelled = false;
    Promise.all(ids.map((id) => getTrace(projectId, id)))
      .then((result) => { if (!cancelled) setState({ key: compareKey, details: result, error: null }); })
      .catch((reason: unknown) => { if (!cancelled) setState({ key: compareKey, details: [], error: reason instanceof Error ? reason.message : "Could not compare these runs" }); });
    return () => { cancelled = true; };
  }, [projectId, ids, compareKey]);
  if (loading) return <Panel title="Compare runs"><LoadingRows count={4} columns={3} /></Panel>;
  if (error || details.length !== 2) return <Panel title="Compare runs"><EmptyPanel title="Comparison unavailable" body={error ?? "Both runs need to still be available to compare them."} action={<button className="ck-button ck-button-secondary" type="button" onClick={onClose}>Close comparison</button>} icon={<CircleAlert size={18} />} /></Panel>;
  return <Panel title="Compare runs"><div className="ck-compare-grid">{details.map((detail, detailIndex) => { const summary = detail.summary; const events = detail.events.filter(isCallEvent); const knownCost = summary.known_cost == null ? events.reduce((sum, event) => sum + (event.cost_usd == null ? 0 : Number(event.cost_usd) || 0), 0) : Number(summary.known_cost); const unpriced = summary.unpriced_count == null ? events.filter((event) => event.cost_usd == null).length : Number(summary.unpriced_count); return <div className="ck-compare-card" key={`${detailIndex}:${detail.traceId}`}><div className="ck-overline">Run</div><h3>{String(summary.trace_name ?? detail.traceId.slice(0, 12))}</h3><p>{detail.traceId}</p><dl><div><dt>Known cost</dt><dd>{summary.known_cost == null && unpriced > 0 ? "Partial · " : ""}{knownCost > 0 || summary.known_cost === 0 ? formatReportedAmount(knownCost, currency, fx) : "Unpriced"}</dd></div><div><dt>Calls</dt><dd>{events.length.toLocaleString()}</dd></div><div><dt>Input / output</dt><dd>{events.reduce((sum, event) => sum + Number(event.input_tokens ?? 0), 0).toLocaleString()} / {events.reduce((sum, event) => sum + Number(event.output_tokens ?? 0), 0).toLocaleString()}</dd></div>{unpriced > 0 && <div><dt>Pricing</dt><dd>{`${unpriced} unpriced`}</dd></div>}</dl><div className="ck-compare-steps">{events.slice(0, 6).map((event) => <div key={event.id}><span>{eventDisplayName(event)}</span><strong>{event.cost_usd == null ? "Unpriced" : formatReportedAmount(Number(event.cost_usd), currency, fx)}</strong></div>)}</div></div>; })}</div><div className="ck-form-footer" style={{ padding: "14px 18px" }}><span className="ck-table-note" style={{ border: 0, padding: 0 }}>Calls are listed in the order they ran.</span><button className="ck-button ck-button-secondary" type="button" onClick={onClose}>Close comparison</button></div></Panel>;
}

function TraceList({ projectId, period, setPeriod, contextKey, contextValue, scopeOverride, explicitState = "default" }: { projectId: string; period: Period; setPeriod: (period: Period) => void; contextKey?: string | null; contextValue?: string[] | null; scopeOverride?: { from: string; to: string } | null; explicitState?: ReturnType<typeof prototypeState> }) {
  const { user, org, workspaceSettings } = useAuth();
  const navigate = useNavigate();
  const overrideFrom = scopeOverride?.from;
  const overrideTo = scopeOverride?.to;
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab") ?? (params.get("view")?.toLowerCase() === "calls" ? "calls" : "traces");
  const view: ListView = tabParam === "calls" ? "calls" : "traces";
  const committedQuery = params.get("q") ?? params.get("query") ?? "";
  const sort = readTraceSort(params.get("sort"));
  const compareSelectionKey = params.get("compare") ?? "";
  const [draft, setDraft] = useState(committedQuery);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(compareSelectionKey.split(",").filter(Boolean).slice(0, 2)));
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savingView, setSavingView] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterOptions, setFilterOptions] = useState<Partial<Record<TraceFilterDimension, TraceFilterOption[]>>>({});
  const [filterOptionsComplete, setFilterOptionsComplete] = useState(false);
  const [filterOptionSearch, setFilterOptionSearch] = useState("");
  const [filterOptionOffset, setFilterOptionOffset] = useState(0);
  const [filterOptionsNextCursor, setFilterOptionsNextCursor] = useState<string | null>(null);
  const filterValues = (key: string, alias?: string): string[] => {
    const values = params.getAll(key);
    if (values.length > 0) return values;
    return alias ? params.getAll(alias) : [];
  };
  const filters: TraceFiltersState = {
    provider: filterValues("provider"),
    model: filterValues("model"),
    feature: filterValues("feature"),
    function: filterValues("function", "fn"),
    customer: filterValues("customer"),
    environment: filterValues("environment", "env"),
    lifecycle: filterValues("lifecycle", "status"),
    accounting: filterValues("accounting", "coverage"),
  };
  const listHold = usePointerHold();
  const idleKey = `costkey.runs.includeNoCalls.${user?.id ?? "anon"}`;
  const [includeNoCalls, setIncludeNoCalls] = useState(() => { try { return window.localStorage.getItem(idleKey) === "1"; } catch { return false; } });
  const toggleNoCalls = (next: boolean) => { setIncludeNoCalls(next); setPage(0); try { window.localStorage.setItem(idleKey, next ? "1" : "0"); } catch { /* remembered for this visit only */ } };
  const list = useTraceList(projectId, view, period, committedQuery, filters, sort, page, pageSize, reload, workspaceSettings?.timezone ?? org?.timezone, contextKey, contextValue, scopeOverride, listHold.held, !includeNoCalls);
  const freshRows = useNewIds(view === "traces" ? list.traces.map((trace) => trace.trace_id) : list.calls.map((call) => call.id));
  const reportingCurrency = workspaceSettings?.reportingCurrency ?? "USD";
  const fx = workspaceSettings?.fx;
  const currencyNote = reportingCurrencyNote(reportingCurrency, fx);
  const returnTo = currentRouterPath();

  useEffect(() => {
    let cancelled = false;
    fetch(appUrl(`/api/v1/saved-views?projectId=${encodeURIComponent(projectId)}&kind=view`), { credentials: "include" }).then(async (response) => {
      if (!response.ok) return;
      const result = await response.json() as { views?: SavedView[] };
      if (!cancelled) setSavedViews(result.views ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    const { from, to } = overrideFrom && overrideTo ? { from: overrideFrom, to: overrideTo } : periodDates(period, workspaceSettings?.timezone ?? org?.timezone ?? undefined);
    getTraceFilterOptions(projectId, { from, to, q: committedQuery || undefined, search: filterOptionSearch || undefined, offset: filterOptionOffset }).then((result) => { if (!cancelled) { setFilterOptions((current) => filterOptionOffset === 0 ? result.options ?? {} : mergeFilterOptions(current, result.options ?? {})); setFilterOptionsComplete(result.complete === true); setFilterOptionsNextCursor(result.nextCursor ?? null); } }).catch(() => { if (!cancelled) { setFilterOptions({}); setFilterOptionsComplete(false); setFilterOptionsNextCursor(null); } });
    return () => { cancelled = true; };
  }, [projectId, period, committedQuery, workspaceSettings?.timezone, org?.timezone, overrideFrom, overrideTo, filterOptionSearch, filterOptionOffset]);

  useEffect(() => { setDraft(committedQuery); setPage(0); setSelected(new Set(compareSelectionKey.split(",").filter(Boolean).slice(0, 2))); }, [committedQuery, view, compareSelectionKey]);

  function changeView(next: ListView): void { setParams((current) => { current.set("tab", next); current.delete("view"); current.delete("q"); return current; }); setDraft(""); setPage(0); setSelected(new Set()); }
  function submit(event: FormEvent): void { event.preventDefault(); setParams((current) => { current.set("tab", view); current.delete("view"); if (draft.trim()) current.set("q", draft.trim()); else current.delete("q"); return current; }); setPage(0); }
  function toggle(traceId: string): void { setSelected((current) => { const next = new Set(current); if (next.has(traceId)) next.delete(traceId); else if (next.size < 2) next.add(traceId); return next; }); }
  function toggleAll(): void {
    setSelected((current) => {
      const loaded = list.traces.map((trace) => trace.trace_id);
      const allSelected = loaded.length > 0 && loaded.every((id) => current.has(id));
      return allSelected ? new Set() : new Set(loaded.slice(0, 2));
    });
  }
  function applySavedView(saved: SavedView): void {
    const restored = restoreTraceView(parseJson(saved.definition));
    const savedTab = restored.tab;
    const savedQuery = restored.query;
    const savedFilters = restored.filters;
    const nextFilters: TraceFiltersState = { ...EMPTY_TRACE_FILTERS };
    TRACE_FILTER_KEYS.forEach((key) => {
      nextFilters[key] = savedFilters[key] ?? [];
    });
    const savedSort = readTraceSort(restored.sort);
    const savedPeriod = restored.period as Period | null;
    setParams((current) => {
      current.set("tab", savedTab); current.set("view", saved.id); if (savedQuery) current.set("q", savedQuery); else current.delete("q");
      current.delete("sort"); if (savedSort !== "newest") current.set("sort", savedSort);
      current.delete("from"); current.delete("to");
      if (restored.from && restored.to) { current.set("period", "custom"); current.set("from", restored.from); current.set("to", restored.to); }
      else if (savedPeriod) current.set("period", savedPeriod);
      TRACE_FILTER_KEYS.forEach((key) => { current.delete(key); nextFilters[key].forEach((value) => current.append(key, value)); });
      return current;
    });
    if (restored.from && restored.to) setPeriod("custom");
    else if (savedPeriod) setPeriod(savedPeriod);
    setDraft(savedQuery); setPage(0); setSelected(new Set());
  }
  /** A saved view can be removed again: the one that's open shows a Remove button. */
  async function deleteView(saved: SavedView): Promise<void> {
    if (!window.confirm(`Remove the saved view “${saved.name}”?`)) return;
    const response = await fetch(appUrl(`/api/v1/saved-views/${encodeURIComponent(saved.id)}`), { method: "DELETE", credentials: "include" }).catch(() => null);
    if (!response?.ok) return;
    setSavedViews((current) => current.filter((item) => item.id !== saved.id));
    setParams((current) => { current.delete("view"); return current; });
  }
  async function saveView(): Promise<void> {
    const name = window.prompt("Name this saved view");
    if (!name?.trim()) return;
    setSavingView(true);
    try {
      const response = await fetch(appUrl("/api/v1/saved-views"), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), projectId, kind: "view", visibility: user?.role === "owner" || user?.role === "admin" ? "workspace" : "private", definition: serializeTraceView({ tab: view, query: committedQuery, period: scopeOverride ? "custom" : period, from: overrideFrom, to: overrideTo, sort, filters: Object.fromEntries(TRACE_FILTER_KEYS.map((key) => [key, filters[key]])) }) }) });
      if (!response.ok) throw new Error("Unable to save view");
      const result = await response.json() as { view?: SavedView };
      if (result.view) setSavedViews((current) => [result.view!, ...current]);
    } catch { /* keep the query visible; the API owns persistence */ } finally { setSavingView(false); }
  }
  function applyFilters(next: TraceFiltersState): void {
    setParams((current) => {
      (Object.keys(next) as Array<keyof TraceFiltersState>).forEach((key) => {
        current.delete(key);
        next[key].forEach((value) => current.append(key, value));
      });
      return current;
    });
    setPage(0); setSelected(new Set()); setFiltersOpen(false);
  }
  function clearFilters(): void { applyFilters(EMPTY_TRACE_FILTERS); }
  function changeSort(next: TraceSort): void { setParams((current) => { if (next === "newest") current.delete("sort"); else current.set("sort", next); return current; }); setPage(0); setSelected(new Set()); }
  function changeEnvironment(next: string): void { applyFilters({ ...filters, environment: next === "all" ? [] : [next] }); }
  const environmentValue = filters.environment[0] ?? "all";
  const environmentOptions = [{ value: "all", label: "All environments" }, ...(filterOptions.environment ?? []).filter((option) => option.value !== "all" && option.value !== environmentValue).map((option) => ({ value: option.value, label: option.value })), ...(environmentValue !== "all" ? [{ value: environmentValue, label: environmentValue }] : [])];
  const { from: exportFrom, to: exportTo } = overrideFrom && overrideTo ? { from: overrideFrom, to: overrideTo } : periodDates(period, workspaceSettings?.timezone ?? org?.timezone ?? undefined);
  const exportParams = new URLSearchParams({ format: "csv", includeContent: "false", from: exportFrom, to: exportTo });
  if (committedQuery) exportParams.set("q", committedQuery);
  if (sort !== "newest") exportParams.set("sort", sort);
  (Object.entries(filters) as Array<[keyof TraceFiltersState, string[]]>).forEach(([key, values]) => values.forEach((value: string) => exportParams.append(key, value)));
  if (contextKey && contextValue && contextValue.length > 0) { exportParams.set("groupBy", "context"); exportParams.set("contextKey", contextKey); contextValue.forEach((value) => exportParams.append("contextValue", value)); }
  const exportHref = appUrl(`/api/v1/projects/${projectId}/export?${exportParams.toString()}`);
  const compareIds = params.get("compare")?.split(",").filter(Boolean).slice(0, 2) ?? [];
  function compareSelected(): void {
    if (selected.size !== 2) return;
    navigate(`/compare?ids=${encodeURIComponent([...selected].join(","))}&project=${encodeURIComponent(projectId)}`);
  }
  const previewStateRows = isPrototypePreview() && explicitState === "no-matches" ? [] : list.traces;
  const previewStateCalls = isPrototypePreview() && (explicitState === "partial" || explicitState === "orphan") ? [prototypePreviewCall(explicitState)] : list.calls;
  const previewStateLoading = isPrototypePreview() && explicitState === "loading";
  const previewStateError = isPrototypePreview() && explicitState === "error";
  const displayedTotal = view === "traces" ? (explicitState === "no-matches" ? 0 : list.total) : (explicitState === "partial" || explicitState === "orphan" ? 1 : list.total);
  const loadedRows = view === "traces" ? previewStateRows.length : previewStateCalls.length;
  const totalPages = Math.max(1, Math.ceil(displayedTotal / pageSize));

  return <div className="prototype-traces-route">
    <PageHeader title="Traces" actions={<><LiveStatus status={list.status} updatedAt={list.updatedAt} onRefresh={list.refresh} /><ScopeToolbar period={scopeOverride ? "custom" : period} onPeriodChange={(next) => { if (next === "custom") { const dates = periodDates("30d", workspaceSettings?.timezone ?? org?.timezone ?? undefined); setPeriod(next); setParams((current) => { current.set("period", "custom"); current.set("from", dates.from); current.set("to", dates.to); return current; }); } else { setPeriod(next); setParams((current) => { current.set("period", next); current.delete("from"); current.delete("to"); return current; }); } setPage(0); }} customFrom={scopeOverride?.from} customTo={scopeOverride?.to} onCustomRangeChange={(fromValue, toValue) => { const nextFrom = dateInputToIso(fromValue, workspaceSettings?.timezone ?? org?.timezone ?? undefined); const nextTo = dateInputToIso(toValue, workspaceSettings?.timezone ?? org?.timezone ?? undefined, true); if (!nextFrom || !nextTo || new Date(nextFrom) >= new Date(nextTo)) return; setPeriod("custom"); setParams((current) => { current.set("period", "custom"); current.set("from", nextFrom); current.set("to", nextTo); return current; }); setPage(0); }} environment={environmentValue} onEnvironmentChange={changeEnvironment} environmentOptions={environmentOptions} currency={reportingCurrency} currencyNote={currencyNote} timezone={workspaceSettings?.timezone ?? org?.timezone ?? undefined} /><><button className="ck-button ck-button-secondary" type="button" onClick={() => void saveView()} disabled={savingView}><Pin size={13} aria-hidden="true" /> {savingView ? "Saving" : "Save view"}</button><a className="ck-button ck-button-secondary" href={exportHref}><Download size={13} aria-hidden="true" /> Export</a></></>} />
    
    <TraceViewTabs view={view} onViewChange={changeView} />
    {compareIds.length === 2 && <div style={{ marginBottom: 16 }}><TraceCompare projectId={projectId} ids={compareIds} currency={reportingCurrency} fx={fx} onClose={() => setParams((current) => { current.delete("compare"); return current; })} /></div>}
    {(list.error || previewStateError) && <div className="ck-alert ck-alert-error" style={{ marginBottom: 16 }}><CircleAlert size={15} aria-hidden="true" /><div><strong>{view === "calls" ? "Some calls couldn’t load." : "Couldn’t refresh runs."}</strong> <span>Totals elsewhere are unaffected.</span> <button className="ck-button ck-button-quiet ck-inline-button" type="button" onClick={() => { list.refresh(); setReload((value) => value + 1); }}>Try again</button></div></div>}
    {explicitState === "partial" && <div className="ck-alert ck-partial-notice" role="status" style={{ marginBottom: 16 }}><CircleAlert size={15} aria-hidden="true" /><div><strong>Some calls have no price yet.</strong> Totals include only the calls we could price.</div></div>}
    {explicitState === "orphan" && <div className="ck-alert" role="status" style={{ marginBottom: 16 }}><Info size={15} aria-hidden="true" /><div><strong>This call wasn’t part of a run.</strong> You can still inspect it here.</div></div>}
    <Panel className="ck-traces-panel">
      <ListToolbar draft={draft} onDraftChange={setDraft} onSubmit={submit} sort={sort} onSort={changeSort} selectedCount={selected.size} onClearSelection={() => setSelected(new Set())} savedViews={savedViews} onSavedViewChange={applySavedView} activeViewId={params.get("view")} onDeleteView={(saved) => void deleteView(saved)} onCompare={compareSelected} filtersOpen={filtersOpen} onToggleFilters={() => setFiltersOpen((value) => !value)} onRefresh={() => list.refresh()} />
      {view === "traces" && <label className="ck-list-option"><input type="checkbox" checked={includeNoCalls} onChange={(event) => toggleNoCalls(event.target.checked)} /> Include runs with no model calls</label>}
      {filtersOpen && <TraceFiltersPopover filters={filters} options={filterOptions} optionsComplete={filterOptionsComplete} nextCursor={filterOptionsNextCursor} optionSearch={filterOptionSearch} onOptionSearchChange={(value) => { setFilterOptionSearch(value); setFilterOptionOffset(0); }} onLoadMore={() => { if (filterOptionsNextCursor) setFilterOptionOffset(Number(filterOptionsNextCursor)); }} onApply={applyFilters} onClear={clearFilters} />}
      {previewStateLoading || (list.loading && loadedRows === 0) ? <LoadingRows count={7} columns={view === "traces" ? 6 : 5} /> : view === "traces" && previewStateRows.length === 0 ? <EmptyPanel title={committedQuery || (isPrototypePreview() && explicitState === "no-matches") ? "No runs match" : "Ready for your first run"} body={committedQuery ? `Nothing matches “${committedQuery}” in this period.` : "Send a request from your app. Runs show up here with their cost, no labels needed."} illustration={committedQuery ? undefined : "first-light"} action={committedQuery ? <button className="ck-button ck-button-secondary" type="button" onClick={() => { setParams((current) => { current.delete("q"); current.delete("query"); return current; }); setDraft(""); }}>Clear search</button> : <Link className="ck-button ck-button-primary" to="/onboarding">Check setup <ArrowRight size={13} /></Link>} icon={<Route size={18} />} /> : view === "traces" ? <div {...listHold.bind}><TraceRows traces={previewStateRows} fresh={freshRows} selected={selected} onToggle={toggle} onToggleAll={toggleAll} onSort={changeSort} sort={sort} currency={reportingCurrency} fx={fx} /></div> : <div {...listHold.bind}><CallRows calls={previewStateCalls} fresh={freshRows} returnTo={returnTo} currency={reportingCurrency} fx={fx} /></div>}
      {loadedRows > 0 && <div className="ck-pagination"><span>{displayedTotal.toLocaleString()} {view === "traces" ? "runs" : "calls"}</span><div><label className="ck-pagination-size">Rows <select className="ck-select" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(0); }}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><button className="ck-button ck-button-quiet" type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</button><span className="ck-pagination-page">Page {page + 1} of {totalPages}</span><button className="ck-button ck-button-quiet" type="button" disabled={page + 1 >= totalPages} onClick={() => setPage((value) => value + 1)}>Next</button></div></div>}
    </Panel>
  </div>;
}


function TraceDetail({ projectId, traceId }: { projectId: string; traceId: string }) {
  const { user, workspaceSettings } = useAuth();
  const reportingCurrency = workspaceSettings?.reportingCurrency ?? "USD";
  const fx = workspaceSettings?.fx;
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { detail: trace, error, loading, status: liveStatus, updatedAt, refresh: refreshRun } = useRunDetail(projectId, traceId);
  const [copied, setCopied] = useState(false);
  const [shareFallback, setShareFallback] = useState<string | null>(null);
  const explicitState = prototypeState(searchParams);
  const effectiveRole = prototypeRole(searchParams, user?.role ?? "viewer");
  const requestedTab = inspectorTab(searchParams.get("tab"));

  const namedState = PrototypeStatePanel({ state: explicitState, family: "Run", title: explicitState === "no-access" ? "Access required" : explicitState === "not-found" ? "Run not found" : undefined, backHref: "/traces", retryHref: `/traces/${encodeURIComponent(traceId)}${window.location.search}` });
  if (namedState) return namedState;

  if (explicitState === "orphan") {
    return <><PageHeader title="A call outside a run" actions={<button className="ck-button ck-button-secondary" type="button" onClick={() => void navigator.clipboard.writeText(window.location.href)}><Copy size={13} /> Copy link</button>} /><div className="ck-alert" role="status"><Info size={15} /><div><strong>Not part of a run.</strong> You can still inspect this call on its own.</div></div><Panel><EmptyPanel title="One call" icon={<Route size={18} />} /></Panel></>;
  }

  if (loading) return <><PageHeader title="Loading run" /><Panel><LoadingRows count={6} columns={4} /></Panel></>;
  if (error || !trace) return <><PageHeader title="Run unavailable" actions={<Link className="ck-button ck-button-secondary" to="/traces"><ArrowLeft size={13} /> Back to runs</Link>} /><Panel><EmptyPanel title="Couldn’t open this run" body="It may have expired, or it belongs to a project you can’t open." action={<button className="ck-button ck-button-secondary" type="button" onClick={() => window.location.reload()}>Try again</button>} icon={<CircleAlert size={18} />} /></Panel></>;

  const model = runModel(trace, traceId, explicitState);
  const { summary, events, start, traceName } = model;
  const service = typeof summary.service === "string" ? summary.service : null;
  const customer = typeof summary.customer === "string" ? summary.customer : null;
  const release = typeof summary.release === "string" ? summary.release : null;
  const retryEvents = events.filter((event) => Boolean(event.parent_event_id));
  const retrySubtotal = retryEvents.reduce((total, event) => total + (event.cost_usd == null ? 0 : Number(event.cost_usd) || 0), 0);
  const timeZoneLabel = displayTimeZoneLabel();

  function share(): void {
    const sharedUrl = new URL(window.location.href);
    sharedUrl.searchParams.set("project", projectId);
    const link = sharedUrl.toString();
    setShareFallback(null);
    void navigator.clipboard.writeText(link).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(() => setShareFallback(link));
  }
  const returnTo = typeof location.state === "object" && location.state !== null && "returnTo" in location.state && typeof (location.state as { returnTo?: unknown }).returnTo === "string" ? (location.state as { returnTo: string }).returnTo : "/traces";
  const agentReturn = returnTo.match(/^\/agents\/([^/?#]+)/);
  const backLabel = agentReturn ? decodeURIComponent(agentReturn[1]) : "Traces";
  function changeCall(callId: string | null): void { setSearchParams((current) => { if (callId) current.set("call", callId); else current.delete("call"); return current; }, { replace: true }); }
  const feature = typeof summary.feature === "string" ? summary.feature : null;

  return <div className="prototype-trace-route">
    
    <PrototypeStateNotice state={explicitState} family="trace" role={effectiveRole} onRetry={() => window.location.reload()} />
    <div className="ck-detail-header prototype-trace-header"><div><Link className="ck-back-link" to={returnTo}><ArrowLeft size={13} aria-hidden="true" /> {backLabel}</Link><h1 className="ck-detail-title">{traceName}</h1><div className="ck-detail-id">{start ? `${formatAbsoluteDate(start)}${timeZoneLabel ? ` ${timeZoneLabel}` : ""} · ` : ""}<span className="mono">{traceId}</span></div>{shareFallback && <label className="ck-share-fallback">Copy this authenticated link manually<input readOnly value={shareFallback} onFocus={(event) => event.currentTarget.select()} /></label>}<div className="ck-pill-row ck-run-chips" style={{ marginTop: 12, marginBottom: 0 }}>
      {feature && <Link className="ck-chip-link" to={featureHref(feature)} title="Costs for this feature"><StatusPill tone="neutral" icon={false}>{feature}</StatusPill></Link>}
      {customer ? <Link className="ck-chip-link" to={userHref(customer)} title={`Usage for ${customer}`}><StatusPill tone="neutral" icon={false}><UserId id={customer} /></StatusPill></Link> : service && <StatusPill tone="neutral" icon={false}>{service}</StatusPill>}
      {[typeof summary.environment === "string" ? summary.environment : null, release ? `Release ${release}` : null].filter(Boolean).map((value) => <StatusPill tone="neutral" icon={false} key={String(value)}>{String(value)}</StatusPill>)}
    </div></div><div className="ck-detail-actions"><LiveStatus status={liveStatus} updatedAt={updatedAt} onRefresh={refreshRun} /><button className="ck-button ck-button-secondary" type="button" onClick={share}>{copied ? <Check size={13} /> : <Share size={13} />}{copied ? "Link copied" : shareFallback ? "Try copy again" : "Share"}</button><Link className="ck-button ck-button-secondary" to={`/compare?ids=${encodeURIComponent(traceId)}&project=${encodeURIComponent(projectId)}`}><GitCompare size={13} /> Compare</Link></div></div>
    <RunSummaryStrip model={model} currency={reportingCurrency} fx={fx} className="prototype-trace-summary" />
    {retryEvents.length > 0 && <div className="ck-alert ck-trace-context-notice"><Info size={15} aria-hidden="true" /><span><strong>{retryEvents.length} retr{retryEvents.length === 1 ? "y" : "ies"}:</strong> {formatReportedAmount(retrySubtotal, reportingCurrency, fx)}</span></div>}
    <RunFlow key={traceId} projectId={projectId} traceId={traceId} model={model} role={effectiveRole} currency={reportingCurrency} fx={fx} explicitState={explicitState} requestedTab={requestedTab} openChecks={searchParams.get("tab") === "checks"} initialCallId={searchParams.get("call")} onCallChange={changeCall} timeline />
  </div>;
}

export default function Traces() {
  const { currentProjectId, projects, setCurrentProjectId } = useAuth();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  const { traceId: routeTraceId } = useParams();
  const location = useLocation();
  const [sharedParams] = useSearchParams();
  // The prototype names the detail route `/trace?id=...`; the product route
  // uses `/traces/:traceId`. Support both so bookmarked prototype links remain
  // valid after the React port becomes the default console.
  const traceId = routeTraceId ?? sharedParams.get("id");
  const [period, setPeriod] = useState<Period>(() => parsePrototypePeriod(sharedParams.get("period")));
  const sharedProjectId = sharedParams.get("project");
  const requestedFrom = sharedParams.get("from");
  const requestedTo = sharedParams.get("to");
  const scopeOverride = requestedFrom && requestedTo && Number.isFinite(new Date(requestedFrom).getTime()) && Number.isFinite(new Date(requestedTo).getTime()) && new Date(requestedFrom) < new Date(requestedTo) ? { from: requestedFrom, to: requestedTo } : null;

  useEffect(() => {
    if (!sharedProjectId || !projects.some((project) => project.id === sharedProjectId)) return;
    if (sharedProjectId !== currentProjectId) setCurrentProjectId(sharedProjectId);
  }, [sharedProjectId, projects, currentProjectId, setCurrentProjectId]);

  if (sharedProjectId && projects.some((project) => project.id === sharedProjectId) && sharedProjectId !== currentProjectId) return <div className="ck-main-inner"><PageHeader title="Opening shared run" /><Panel><LoadingRows count={6} columns={4} /></Panel></div>;
  if (!projectId) return <div className="ck-main-inner"><PageHeader title="Traces" /><Panel><EmptyPanel illustration="first-light" title="Ready for your first run" body="Connect a project to start." action={<Link className="ck-button ck-button-primary" to="/onboarding">Connect a project</Link>} /></Panel></div>;
  const contextKey = sharedParams.get("contextKey");
  const contextValues = sharedParams.getAll("contextValue");
  const contextValue = contextValues.length > 0 ? contextValues : null;
  const explicitState = prototypeState(sharedParams);
  return <div className="ck-main-inner">{traceId ? <TraceDetail projectId={projectId} traceId={decodeURIComponent(traceId)} /> : <TraceList key={location.search} projectId={projectId} period={period} setPeriod={setPeriod} contextKey={contextKey} contextValue={contextValue} scopeOverride={scopeOverride} explicitState={explicitState} />}</div>;
}

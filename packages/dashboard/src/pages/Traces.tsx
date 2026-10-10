import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, CircleAlert, Copy, Download, ExternalLink, GitCompare, Info, Pin, RefreshCw, Route, Search, Share, SlidersHorizontal } from "lucide-react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  getEvent,
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
  type UsageComponent,
  type TraceSpan,
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
import { dateInputToIso, displayTimeZoneLabel, formatAbsoluteDate, formatCurrencyAmount, formatDateTime, formatProviders, formatReportedAmount, periodDates, reportingCurrencyNote, sourceAttributionStatus, type ReportingFx } from "../components/consoleFormatters";
import { restoreTraceView, serializeTraceView, TRACE_VIEW_FILTER_KEYS } from "./traceViewState";
import { formatDuration } from "../utils";
import { RunTree, SpanInspector } from "../components/RunTree";
import { buildRunTree, defaultCollapsed, flattenRunTree, type RunTreeNode, type RunTreeSpanNode } from "../components/runTreeModel";
import { prototypeRole, prototypeState, PrototypeStateNotice, PrototypeStatePanel, type PrototypeState } from "../components/PrototypeState";
import { isPrototypePreview } from "../prototypePreview";
import "./PrototypeRoute.css";

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

function isCallEvent(event: TraceEvent): boolean {
  return !event.event_type || event.event_type === "call";
}

function useTraceList(projectId: string | null, view: ListView, period: Period, query: string, filters: TraceFiltersState, sort: TraceSort, page: number, pageSize: number, reload: number, timezone?: string | null, contextKey?: string | null, contextValue?: string[] | null, scopeOverride?: { from: string; to: string } | null) {
  const filterKey = JSON.stringify(filters);
  const contextValueKey = JSON.stringify(contextValue ?? []);
  const overrideFrom = scopeOverride?.from;
  const overrideTo = scopeOverride?.to;
  const requestKey = [projectId ?? "none", view, period, query, filterKey, sort, page, pageSize, reload, timezone ?? "", contextKey ?? "", contextValueKey, overrideFrom ?? "", overrideTo ?? ""].join("\u0002");
  const [state, setState] = useState<{ key: string; traces: Trace[]; calls: EventRow[]; total: number; error: string | null }>({ key: "", traces: [], calls: [], total: 0, error: null });
  const [refreshing, setRefreshing] = useState(false);
  const loading = Boolean(projectId) && state.key !== requestKey;
  const traces = state.key === requestKey ? state.traces : [];
  const calls = state.key === requestKey ? state.calls : [];
  const total = state.key === requestKey ? state.total : 0;
  const error = state.key === requestKey ? state.error : null;

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const { from, to } = overrideFrom && overrideTo ? { from: overrideFrom, to: overrideTo } : periodDates(period, timezone ?? undefined);
    const requestFilters = JSON.parse(filterKey) as TraceFiltersState;
    const fail = (reason: unknown) => {
      if (!cancelled) setState({ key: requestKey, traces: [], calls: [], total: 0, error: reason instanceof Error ? reason.message : "Couldn’t load runs" });
    };
    const requestContextValues = JSON.parse(contextValueKey) as string[];
    const contextScope: Pick<TraceQuery, "groupBy" | "contextKey" | "contextValue"> = contextKey && requestContextValues.length > 0 ? { groupBy: "context", contextKey, contextValue: requestContextValues } : {};
    if (view === "traces") {
      void getTraces(projectId, { limit: pageSize, offset: page * pageSize, q: query || undefined, from, to, sort, ...requestFilters, ...contextScope } satisfies TraceQuery)
        .then((result) => { if (!cancelled) setState({ key: requestKey, traces: result.traces.map(normalizeTrace), calls: [], total: Number(result.total) || 0, error: null }); })
        .catch(fail)
        .finally(() => { if (!cancelled) setRefreshing(false); });
    } else {
      void getEvents(projectId, { limit: pageSize, offset: page * pageSize, q: query || undefined, from, to, sort, ...requestFilters, ...contextScope })
        .then((result) => { if (!cancelled) setState({ key: requestKey, traces: [], calls: result.events, total: Number(result.total) || 0, error: null }); })
        .catch(fail)
        .finally(() => { if (!cancelled) setRefreshing(false); });
    }
    return () => { cancelled = true; };
  }, [projectId, view, period, query, filterKey, sort, page, pageSize, reload, timezone, contextKey, contextValueKey, requestKey, overrideFrom, overrideTo]);

  return { traces, calls, total, loading, refreshing, error, refresh: () => setRefreshing(true) };
}

function TraceViewTabs({ view, onViewChange }: { view: ListView; onViewChange: (view: ListView) => void }) {
  return <div className="ck-trace-tabs-row"><div className="ck-tabs" role="tablist" aria-label="Show runs or calls"><button className={`ck-tab ${view === "traces" ? "active" : ""}`} role="tab" aria-selected={view === "traces"} type="button" onClick={() => onViewChange("traces")}>Runs</button><button className={`ck-tab ${view === "calls" ? "active" : ""}`} role="tab" aria-selected={view === "calls"} type="button" onClick={() => onViewChange("calls")}>Calls</button></div></div>;
}

function ListToolbar({ draft, onDraftChange, onSubmit, sort, onSort, selectedCount, onClearSelection, savedViews, onSavedViewChange, onCompare, filtersOpen, onToggleFilters, onRefresh }: { draft: string; onDraftChange: (value: string) => void; onSubmit: (event: FormEvent) => void; sort: TraceSort; onSort: (sort: TraceSort) => void; selectedCount: number; onClearSelection: () => void; savedViews: SavedView[]; onSavedViewChange: (view: SavedView) => void; onCompare: () => void; filtersOpen: boolean; onToggleFilters: () => void; onRefresh: () => void }) {
  return (
    <>
      <div className="ck-trace-toolbar">
        <div className="prototype-trace-toolbar-leading"><form className="ck-trace-search" onSubmit={onSubmit}><Search size={14} aria-hidden="true" /><label className="sr-only" htmlFor="trace-search">Search runs and calls</label><input id="trace-search" type="search" value={draft} onChange={(event) => onDraftChange(event.target.value)} placeholder="Search runs, models, functions" /><span className="ck-search-hint" aria-hidden="true">↵</span></form><label className="ck-saved-view-select"><span className="sr-only">Saved view</span><select className="ck-select" defaultValue="" aria-label="Saved views" onChange={(event) => { const match = savedViews.find((item) => item.id === event.target.value); if (match) onSavedViewChange(match); }}><option value="">Saved views</option>{savedViews.map((item) => <option key={item.id} value={item.id}>{item.name}{item.visibility === "workspace" ? " · workspace" : ""}</option>)}</select></label></div>
        <div className="ck-trace-toolbar-actions"><button className="ck-button ck-button-secondary" type="button" onClick={onToggleFilters} aria-expanded={filtersOpen}><SlidersHorizontal size={14} /> Filters</button><button className="ck-icon-button ck-trace-refresh" type="button" onClick={onRefresh} aria-label="Refresh runs"><RefreshCw size={16} aria-hidden="true" /></button>{selectedCount > 0 && <><span className="ck-table-note" style={{ border: 0, padding: 0 }}>{selectedCount}/2 selected</span><button className="ck-button ck-button-quiet" type="button" onClick={onClearSelection}>Clear</button></>}{selectedCount === 2 && <button className="ck-button ck-button-secondary" type="button" onClick={onCompare}>Compare <ExternalLink size={12} /></button>}<label className="ck-sort-hidden"><span className="sr-only">Sort runs</span><select className="ck-select" aria-label="Sort runs" value={sort} onChange={(event) => onSort(readTraceSort(event.target.value))}>{TRACE_SORTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div>
      </div>
    </>
  );
}

// The fixture adapter records a human call name in event metadata; prefer it
// for tree/step labels like the prototype ("Embed query"), falling back to
// the recorded function for live events that carry no friendly name.
function findSpanNode(nodes: RunTreeNode[], spanId: string): RunTreeSpanNode | null {
  for (const node of nodes) {
    if (node.type !== "span") continue;
    if (node.id === spanId) return node;
    const nested = findSpanNode(node.children, spanId);
    if (nested) return nested;
  }
  return null;
}

function eventDisplayName(event: { metadata?: unknown; bl_function?: string | null; model?: string | null }): string {
  try {
    const raw = event.metadata;
    const meta = typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
    const callName = (meta as { callName?: unknown } | null)?.callName;
    if (typeof callName === "string" && callName.trim()) return callName;
  } catch {
    /* fall through to the recorded function */
  }
  return event.bl_function || event.model || "Recorded call";
}

function runStatus(trace: Trace, cost: number | null): { tone: "good" | "warn" | "critical" | "neutral"; label: string } {
  const execution = String(trace.execution_state ?? "").toLowerCase();
  if (execution === "failed" || execution === "error") return { tone: "critical", label: "Failed" };
  if (execution === "running" || execution === "in_progress") return { tone: "neutral", label: "Running" };
  if ((trace.unpriced_count ?? 0) > 0) return { tone: "warn", label: "Partly priced" };
  if (cost == null) return { tone: "neutral", label: "Price pending" };
  return { tone: "good", label: "Complete" };
}


function TraceRows({ traces, selected, onToggle, onToggleAll, onSort, sort, currency, fx }: { traces: Trace[]; selected: Set<string>; onToggle: (traceId: string) => void; onToggleAll: () => void; onSort: (sort: TraceSort) => void; sort: TraceSort; currency: string; fx?: ReportingFx | null }) {
  const allSelected = traces.length > 0 && traces.every((trace) => selected.has(trace.trace_id));
  return <div className="ck-table-wrap"><table className="ck-table ck-traces-table"><thead><tr><th aria-label="Select"><input type="checkbox" checked={allSelected} onChange={onToggleAll} aria-label="Select loaded rows" /></th><th>Run</th><th className="ck-trace-hide-mobile"><button type="button" className="ck-table-sort" onClick={() => onSort("newest")}>Started{sort === "newest" && <span aria-hidden="true"> ↓</span>}</button></th><th className="numeric ck-trace-hide-mobile"><button type="button" className="ck-table-sort" onClick={() => onSort(sort === "duration_desc" ? "newest" : "duration_desc")}>Duration{sort === "duration_desc" && <span aria-hidden="true"> ↓</span>}</button></th><th className="numeric ck-trace-hide-mobile">Calls</th><th className="numeric"><button type="button" className="ck-table-sort" onClick={() => onSort(sort === "cost_desc" ? "newest" : "cost_desc")}>Cost ({currency}){sort === "cost_desc" && <span aria-hidden="true"> ↓</span>}</button></th></tr></thead><tbody>{traces.map((trace) => {
    const cost = knownTraceCost(trace);
    const status = runStatus(trace, cost);
    const agentShape = (trace.step_count ?? 0) > 0 || (trace.tool_count ?? 0) > 0
      ? [(trace.step_count ?? 0) > 0 ? `${trace.step_count} step${trace.step_count === 1 ? "" : "s"}` : null, (trace.tool_count ?? 0) > 0 ? `${trace.tool_count} tool call${trace.tool_count === 1 ? "" : "s"}` : null].filter(Boolean).join(", ")
      : null;
    const labels = [trace.feature, trace.environment, agentShape].filter(Boolean).join(" · ");
    return <tr key={trace.trace_id}><td><input type="checkbox" checked={selected.has(trace.trace_id)} onChange={() => onToggle(trace.trace_id)} aria-label={`Select ${traceLabel(trace)}`} /></td><td className="primary-cell"><Link className="ck-table-link" to={`/traces/${encodeURIComponent(trace.trace_id)}`} state={{ returnTo: `${window.location.pathname}${window.location.search}` }}>{traceLabel(trace)}</Link>{status.tone !== "good" && <> <StatusPill tone={status.tone}>{status.label}</StatusPill></>}{labels && <div className="muted">{labels}</div>}<span className="ck-trace-mobile-line muted">{formatDateTime(trace.started_at)}</span></td><td className="ck-trace-hide-mobile">{formatDateTime(trace.started_at)}</td><td className="numeric ck-trace-hide-mobile">{traceDuration(trace)}</td><td className="numeric ck-trace-hide-mobile">{trace.call_count.toLocaleString()}</td><td className="numeric ck-cost-cell">{cost == null ? <span title="Calls without a price are not counted as free">Unpriced</span> : formatTraceTableCost(cost, currency, fx)}</td></tr>;
  })}</tbody></table></div>;
}

function CallRows({ calls, returnTo, currency, fx }: { calls: EventRow[]; returnTo: string; currency: string; fx?: ReportingFx | null }) {
  if (calls.length === 0) return <EmptyPanel title="No calls match these filters" body="Clear the search, or try a longer period." action={<Link className="ck-button ck-button-secondary" to="/traces?tab=calls">Clear filters</Link>} icon={<Search size={18} />} />;
  return <div className="ck-table-wrap"><table className="ck-table"><thead><tr><th>Call</th><th className="ck-trace-hide-mobile">Run</th><th className="ck-trace-hide-mobile">Usage</th><th className="ck-trace-hide-mobile">Latency</th><th className="ck-trace-hide-mobile">Response</th><th className="numeric">Cost (USD)</th></tr></thead><tbody>{calls.map((call) => { const traceId = call.trace_id || contextTraceId(call.context); const usage = call.input_tokens != null || call.output_tokens != null ? `${Number(call.input_tokens ?? 0).toLocaleString()} in / ${Number(call.output_tokens ?? 0).toLocaleString()} out` : call.total_tokens != null ? `${Number(call.total_tokens).toLocaleString()} tokens` : "Not reported"; return <tr key={call.id}><td className="primary-cell"><Link className="ck-table-link" to={traceId ? `/traces/${encodeURIComponent(traceId)}?call=${encodeURIComponent(call.id)}` : `/traces?tab=calls&q=${encodeURIComponent(call.id)}`} state={{ returnTo }}>{call.model || call.id.slice(0, 12)}</Link><div className="muted">{formatProviders(call.provider)} · {eventDisplayName(call)}</div></td><td className="ck-trace-hide-mobile">{traceId ? <Link className="ck-table-link mono" to={`/traces/${encodeURIComponent(traceId)}`} state={{ returnTo }}>{traceId.slice(0, 16)}</Link> : <span className="muted">Not part of a run</span>}</td><td className="ck-trace-hide-mobile">{usage}<div className="muted">{call.unit || "tokens"}</div></td><td className="ck-trace-hide-mobile">{formatDuration(Number(call.duration_ms) || 0)}</td><td className="ck-trace-hide-mobile">{call.status_code == null ? <span className="muted">Not recorded</span> : `HTTP ${call.status_code}`}</td><td className="numeric ck-cost-cell">{call.cost_usd != null ? <><span>{formatTraceTableCost(Number(call.cost_usd), currency, fx)}</span>{call.cost_basis === "reported" && <div className="muted">Reported by provider</div>}</> : "Unpriced"}</td></tr>; })}</tbody></table></div>;
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
  return <Panel title="Compare runs"><div className="ck-compare-grid">{details.map((detail, detailIndex) => { const summary = detail.summary; const events = detail.events.filter(isCallEvent); const knownCost = summary.known_cost == null ? events.reduce((sum, event) => sum + (event.cost_usd == null ? 0 : Number(event.cost_usd) || 0), 0) : Number(summary.known_cost); const unpriced = summary.unpriced_count == null ? events.filter((event) => event.cost_usd == null).length : Number(summary.unpriced_count); return <div className="ck-compare-card" key={`${detailIndex}:${detail.traceId}`}><div className="ck-overline">Run</div><h3>{String(summary.trace_name ?? detail.traceId.slice(0, 12))}</h3><p>{detail.traceId}</p><dl><div><dt>Known cost</dt><dd>{summary.known_cost == null && unpriced > 0 ? "Partial · " : ""}{knownCost > 0 || summary.known_cost === 0 ? formatReportedAmount(knownCost, currency, fx) : "Unpriced"}</dd></div><div><dt>Calls</dt><dd>{events.length.toLocaleString()}</dd></div><div><dt>Input / output</dt><dd>{events.reduce((sum, event) => sum + Number(event.input_tokens ?? 0), 0).toLocaleString()} / {events.reduce((sum, event) => sum + Number(event.output_tokens ?? 0), 0).toLocaleString()}</dd></div><div><dt>Pricing</dt><dd>{unpriced > 0 ? `${unpriced} unpriced` : "All calls priced"}</dd></div></dl><div className="ck-compare-steps">{events.slice(0, 6).map((event) => <div key={event.id}><span>{eventDisplayName(event)}</span><strong>{event.cost_usd == null ? "Unpriced" : formatReportedAmount(Number(event.cost_usd), currency, fx)}</strong></div>)}</div></div>; })}</div><div className="ck-form-footer" style={{ padding: "14px 18px" }}><span className="ck-table-note" style={{ border: 0, padding: 0 }}>Calls are listed in the order they ran.</span><button className="ck-button ck-button-secondary" type="button" onClick={onClose}>Close comparison</button></div></Panel>;
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
  const list = useTraceList(projectId, view, period, committedQuery, filters, sort, page, pageSize, reload, workspaceSettings?.timezone ?? org?.timezone, contextKey, contextValue, scopeOverride);
  const reportingCurrency = workspaceSettings?.reportingCurrency ?? "USD";
  const fx = workspaceSettings?.fx;
  const currencyNote = reportingCurrencyNote(reportingCurrency, fx);
  const returnTo = `${window.location.pathname}${window.location.search}`;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/saved-views?projectId=${encodeURIComponent(projectId)}&kind=view`, { credentials: "include" }).then(async (response) => {
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
  async function saveView(): Promise<void> {
    const name = window.prompt("Name this saved view");
    if (!name?.trim()) return;
    setSavingView(true);
    try {
      const response = await fetch("/api/v1/saved-views", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), projectId, kind: "view", visibility: user?.role === "owner" || user?.role === "admin" ? "workspace" : "private", definition: serializeTraceView({ tab: view, query: committedQuery, period: scopeOverride ? "custom" : period, from: overrideFrom, to: overrideTo, sort, filters: Object.fromEntries(TRACE_FILTER_KEYS.map((key) => [key, filters[key]])) }) }) });
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
  const exportHref = `/api/v1/projects/${projectId}/export?${exportParams.toString()}`;
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
    <PageHeader title="Runs" actions={<><ScopeToolbar period={scopeOverride ? "custom" : period} onPeriodChange={(next) => { if (next === "custom") { const dates = periodDates("30d", workspaceSettings?.timezone ?? org?.timezone ?? undefined); setPeriod(next); setParams((current) => { current.set("period", "custom"); current.set("from", dates.from); current.set("to", dates.to); return current; }); } else { setPeriod(next); setParams((current) => { current.set("period", next); current.delete("from"); current.delete("to"); return current; }); } setPage(0); }} customFrom={scopeOverride?.from} customTo={scopeOverride?.to} onCustomRangeChange={(fromValue, toValue) => { const nextFrom = dateInputToIso(fromValue, workspaceSettings?.timezone ?? org?.timezone ?? undefined); const nextTo = dateInputToIso(toValue, workspaceSettings?.timezone ?? org?.timezone ?? undefined, true); if (!nextFrom || !nextTo || new Date(nextFrom) >= new Date(nextTo)) return; setPeriod("custom"); setParams((current) => { current.set("period", "custom"); current.set("from", nextFrom); current.set("to", nextTo); return current; }); setPage(0); }} environment={environmentValue} onEnvironmentChange={changeEnvironment} environmentOptions={environmentOptions} currency={reportingCurrency} currencyNote={currencyNote} timezone={workspaceSettings?.timezone ?? org?.timezone ?? undefined} /><><button className="ck-button ck-button-secondary" type="button" onClick={() => void saveView()} disabled={savingView}><Pin size={13} aria-hidden="true" /> {savingView ? "Saving" : "Save view"}</button><a className="ck-button ck-button-secondary" href={exportHref}><Download size={13} aria-hidden="true" /> Export</a></></>} />
    
    <TraceViewTabs view={view} onViewChange={changeView} />
    {compareIds.length === 2 && <div style={{ marginBottom: 16 }}><TraceCompare projectId={projectId} ids={compareIds} currency={reportingCurrency} fx={fx} onClose={() => setParams((current) => { current.delete("compare"); return current; })} /></div>}
    {(list.error || previewStateError) && <div className="ck-alert ck-alert-error" style={{ marginBottom: 16 }}><CircleAlert size={15} aria-hidden="true" /><div><strong>{view === "calls" ? "Some calls couldn’t load." : "Couldn’t refresh runs."}</strong> <span>Totals elsewhere are unaffected.</span> <button className="ck-button ck-button-quiet ck-inline-button" type="button" onClick={() => setReload((value) => value + 1)}>Try again</button></div></div>}
    {explicitState === "partial" && <div className="ck-alert ck-partial-notice" role="status" style={{ marginBottom: 16 }}><CircleAlert size={15} aria-hidden="true" /><div><strong>Some calls have no price yet.</strong> Totals include only the calls we could price.</div></div>}
    {explicitState === "orphan" && <div className="ck-alert" role="status" style={{ marginBottom: 16 }}><Info size={15} aria-hidden="true" /><div><strong>This call wasn’t part of a run.</strong> You can still inspect it here.</div></div>}
    <Panel className="ck-traces-panel">
      <ListToolbar draft={draft} onDraftChange={setDraft} onSubmit={submit} sort={sort} onSort={changeSort} selectedCount={selected.size} onClearSelection={() => setSelected(new Set())} savedViews={savedViews} onSavedViewChange={applySavedView} onCompare={compareSelected} filtersOpen={filtersOpen} onToggleFilters={() => setFiltersOpen((value) => !value)} onRefresh={() => setReload((value) => value + 1)} />
      {filtersOpen && <TraceFiltersPopover filters={filters} options={filterOptions} optionsComplete={filterOptionsComplete} nextCursor={filterOptionsNextCursor} optionSearch={filterOptionSearch} onOptionSearchChange={(value) => { setFilterOptionSearch(value); setFilterOptionOffset(0); }} onLoadMore={() => { if (filterOptionsNextCursor) setFilterOptionOffset(Number(filterOptionsNextCursor)); }} onApply={applyFilters} onClear={clearFilters} />}
      {previewStateLoading || (list.loading && loadedRows === 0) ? <LoadingRows count={7} columns={view === "traces" ? 6 : 5} /> : view === "traces" && previewStateRows.length === 0 ? <EmptyPanel title={committedQuery || (isPrototypePreview() && explicitState === "no-matches") ? "No runs match" : "Ready for your first run"} body={committedQuery ? `Nothing matches “${committedQuery}” in this period.` : "Send a request from your app. Runs show up here with their cost, no labels needed."} illustration={committedQuery ? undefined : "first-light"} action={committedQuery ? <button className="ck-button ck-button-secondary" type="button" onClick={() => { setParams((current) => { current.delete("q"); current.delete("query"); return current; }); setDraft(""); }}>Clear search</button> : <Link className="ck-button ck-button-primary" to="/onboarding">Check setup <ArrowRight size={13} /></Link>} icon={<Route size={18} />} /> : view === "traces" ? <TraceRows traces={previewStateRows} selected={selected} onToggle={toggle} onToggleAll={toggleAll} onSort={changeSort} sort={sort} currency={reportingCurrency} fx={fx} /> : <CallRows calls={previewStateCalls} returnTo={returnTo} currency={reportingCurrency} fx={fx} />}
      {loadedRows > 0 && <div className="ck-pagination"><span>{displayedTotal.toLocaleString()} {view === "traces" ? "runs" : "calls"}</span><div><label className="ck-pagination-size">Rows <select className="ck-select" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(0); }}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><button className="ck-button ck-button-quiet" type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</button><span className="ck-pagination-page">Page {page + 1} of {totalPages}</span><button className="ck-button ck-button-quiet" type="button" disabled={page + 1 >= totalPages} onClick={() => setPage((value) => value + 1)}>Next</button></div></div>}
    </Panel>
  </div>;
}

function parseJson(value: unknown): unknown {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function jsonText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

type InspectorTab = "content" | "cost" | "source" | "context";

function inspectorTab(value: string | null | undefined): InspectorTab {
  const normalized = value?.toLowerCase().replaceAll(" & ", "-").replaceAll(" ", "-");
  if (normalized === "cost-usage" || normalized === "cost") return "cost";
  if (normalized === "source") return "source";
  if (normalized === "context") return "context";
  return "content";
}

function CallInspector({ projectId, event, role, currency, fx, initialTab = "content", prototypeVariant = "default", forceError = false }: { projectId: string; event: TraceEvent; role: string; currency: string; fx?: ReportingFx | null; initialTab?: InspectorTab; prototypeVariant?: PrototypeState; forceError?: boolean }) {
  const requestKey = `${projectId}:${event.id}:${role}`;
  const [state, setState] = useState<{ key: string; detail: EventRow | null; error: string | null }>({ key: "", detail: null, error: null });
  const loading = role !== "viewer" && state.key !== requestKey;
  const detail = role === "viewer" ? event as unknown as EventRow : state.key === requestKey ? state.detail : null;
  const detailError = forceError ? "Call details could not be loaded" : role === "viewer" ? null : state.key === requestKey ? state.error : null;
  const [tab, setTab] = useState<InspectorTab>(initialTab);
  const canReadContent = role !== "viewer";

  useEffect(() => {
    let cancelled = false;
    if (role === "viewer") {
      return () => { cancelled = true; };
    }
    getEvent(projectId, event.id)
      .then((result) => { if (!cancelled) setState({ key: requestKey, detail: result.event, error: null }); })
      .catch((reason: unknown) => { if (!cancelled) setState({ key: requestKey, detail: null, error: reason instanceof Error ? reason.message : "Call detail could not be loaded" }); });
    return () => { cancelled = true; };
  }, [projectId, event.id, role, requestKey]);

  const content = detail ? parseJson(detail.request_body) : null;
  const output = detail ? parseJson(detail.response_body) : null;
  const context = parseJson(detail?.context ?? event.context);
  const frames = parseJson(detail?.call_site_frames ?? event.call_site_frames);
  const cost = detail?.cost_usd ?? event.cost_usd;

  return <Panel className="ck-inspector" title="Call">
    <div className="ck-tabs" role="tablist" aria-label="Call detail"><button className={`ck-tab ${tab === "content" ? "active" : ""}`} role="tab" aria-selected={tab === "content"} type="button" onClick={() => setTab("content")}>Content</button><button className={`ck-tab ${tab === "cost" ? "active" : ""}`} role="tab" aria-selected={tab === "cost"} type="button" onClick={() => setTab("cost")}>Cost &amp; usage</button><button className={`ck-tab ${tab === "source" ? "active" : ""}`} role="tab" aria-selected={tab === "source"} type="button" onClick={() => setTab("source")}>Source</button><button className={`ck-tab ${tab === "context" ? "active" : ""}`} role="tab" aria-selected={tab === "context"} type="button" onClick={() => setTab("context")}>Context</button></div>
      <div className="ck-inspector-body">
      <div className="ck-inspector-call"><div><div className="ck-inspector-heading">{eventDisplayName({ ...event, bl_function: detail?.bl_function ?? event.bl_function })}</div><div className="ck-inspector-subheading">{formatProviders(event.provider)} · {event.model || "Model not recorded"} · {formatAbsoluteDate(event.timestamp)}</div></div><strong className="ck-inspector-cost">{cost == null ? "Unpriced" : formatReportedAmount(Number(cost), currency, fx)}</strong></div>
      {loading && <div style={{ marginTop: 18 }}><LoadingRows count={3} columns={2} /></div>}
      {detailError && <div className="ck-alert" role="alert" style={{ marginTop: 16 }}><CircleAlert size={14} /><div><strong>Couldn’t load this call’s details.</strong> Its cost and timing are still accurate.</div></div>}
      {!loading && tab === "content" && <ContentTab canReadContent={canReadContent} input={content} output={output} contentStatus={prototypeVariant === "expired" ? "expired" : prototypeVariant === "uncaptured" ? "not_available" : prototypeVariant === "redacted" ? "redacted" : prototypeVariant === "long-content" ? "too_long" : prototypeVariant === "restricted" ? "restricted" : detail?.content_status ?? event.content_status} />}
      {!loading && tab === "cost" && <CostTab event={event} detail={detail} cost={cost} currency={currency} fx={fx} />}
      {!loading && tab === "source" && <SourceTab detail={prototypeVariant === "missing-source" ? null : detail} frames={prototypeVariant === "missing-source" ? [] : frames} canReadContent={canReadContent} />}
      {!loading && tab === "context" && <ContextTab context={context} />}
    </div>
  </Panel>;
}

function ContentTab({ canReadContent, input, output, contentStatus }: { canReadContent: boolean; input: unknown; output: unknown; contentStatus?: string | null }) {
  if (!canReadContent || contentStatus === "restricted") return <div className="ck-inspector-section"><div className="ck-inspector-restricted"><strong>Prompts and responses are hidden for your role.</strong><br />Viewers see cost and usage. Ask an Owner or Admin if you need more access.</div></div>;
  if (!input && !output) {
    const message = contentStatus === "metadata_only"
      ? { title: "Prompts aren’t captured", body: "This project records cost and usage only. You can turn on text capture in Settings." }
      : contentStatus === "redacted"
        ? { title: "Content removed", body: "This call’s prompt and response were deleted for privacy. Its cost and usage remain." }
        : contentStatus === "expired"
          ? { title: "Content expired", body: "Prompts are kept for a limited time and this one has expired. Its cost and usage remain." }
            : contentStatus === "not_available"
              ? { title: "No content for this call", body: "The provider didn’t return a prompt or response we could capture." }
              : contentStatus === "too_long"
                ? { title: "Too long to show here", body: "The content is stored, but it’s too large to display inline." }
            : { title: "No content for this call", body: "There’s no prompt or response stored for this call. Its cost and usage are still here." };
    return <div className="ck-inspector-section"><EmptyPanel title={message.title} body={message.body} /></div>;
  }
  return <><InspectorBlock title="Input" value={jsonText(input) || "Not captured"} /><InspectorBlock title="Output" value={jsonText(output) || "Not captured"} /></>;
}

function InspectorBlock({ title, value }: { title: string; value: string }) { return <div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>{title}</span><button className="ck-button ck-button-quiet" style={{ minHeight: 0, padding: 0 }} type="button" onClick={() => void navigator.clipboard.writeText(value)}><Copy size={11} /> Copy</button></div><pre className="ck-inspector-pre">{value}</pre></div>; }

function CostTab({ event, detail, cost, currency, fx }: { event: TraceEvent; detail: EventRow | null; cost: number | null | undefined; currency: string; fx?: ReportingFx | null }) {
  const input = event.input_tokens ?? detail?.input_tokens;
  const output = event.output_tokens ?? detail?.output_tokens;
  const total = event.total_tokens ?? detail?.total_tokens;
  const requestedModel = event.request_model ?? detail?.request_model;
  const basis = event.cost_basis ?? detail?.cost_basis;
  const source = event.cost_source ?? detail?.cost_source;
  const nativeUsage = event.unit_value == null ? "Tokens below" : `${Number(event.unit_value).toLocaleString()} ${event.unit_kind || event.unit || "units"}`;
  return <><div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>How this was priced</span></div><div className="ck-inspector-grid"><InspectorValue label="Cost" value={cost == null ? "Unpriced" : formatReportedAmount(Number(cost), currency, fx)} /><InspectorValue label="Price from" value={basis === "reported" ? "Reported by the provider" : basis === "estimated" ? "Estimated from list prices" : "Not known"} /><InspectorValue label="Provider" value={formatProviders(event.provider)} /><InspectorValue label="Model used" value={event.model || "Not recorded"} /><InspectorValue label="Model requested" value={requestedModel || "Not recorded"} /><InspectorValue label="Rate card" value={source || "Not recorded"} /><InspectorValue label="Usage" value={nativeUsage} /><InspectorValue label="Input tokens" value={input == null ? "—" : Number(input).toLocaleString()} /><InspectorValue label="Output tokens" value={output == null ? "—" : Number(output).toLocaleString()} /><InspectorValue label="Total tokens" value={total == null ? "—" : Number(total).toLocaleString()} /><InspectorValue label="Duration" value={formatDuration(Number(event.duration_ms) || 0)} /></div></div>{cost == null && <div className="ck-inspector-section"><div className="ck-inspector-restricted">We don’t have a price for this call yet, so it isn’t counted as $0.</div></div>}</>;
}

function InspectorValue({ label, value }: { label: string; value: string }) { return <div><div className="ck-inspector-key">{label}</div><div className="ck-inspector-value">{value}</div></div>; }

function SourceTab({ detail, frames, canReadContent }: { detail: EventRow | null; frames: unknown; canReadContent: boolean }) {
  if (!canReadContent) return <div className="ck-inspector-section"><div className="ck-inspector-restricted"><strong>Source is hidden for your role.</strong><br />Viewers don’t see file and function locations.</div></div>;
  const frameRows = Array.isArray(frames) ? frames as Array<Record<string, unknown>> : [];
  const attribution = sourceAttributionStatus(detail ? { featureSource: detail.feature_source, featureMappingId: detail.feature_mapping_id, functionName: detail.bl_function, fileName: detail.bl_file } : null);
  return <><div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>Where in your code</span></div><div className="ck-inspector-grid"><InspectorValue label="Function" value={detail?.bl_function || "Not recorded"} /><InspectorValue label="File" value={detail?.bl_file || "Not recorded"} /><InspectorValue label="Line" value={detail?.bl_line == null ? "—" : String(detail.bl_line)} /><InspectorValue label="Feature label" value={attribution === "Explicit" ? "Set in code" : attribution === "Mapped" ? "From a mapping" : attribution === "Inferred" ? "Inferred" : attribution === "Recorded location" ? "Not set" : "Not recorded"} /></div></div>{frameRows.length > 0 && <div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>Call stack</span></div><pre className="ck-inspector-pre">{frameRows.slice(0, 8).map((frame, index) => `${index + 1}. ${String(frame["functionName"] ?? "anonymous")} · ${String(frame["fileName"] ?? "file unavailable")}${frame["lineNumber"] ? `:${String(frame["lineNumber"])}` : ""}`).join("\n")}</pre></div>}{frameRows.length === 0 && <div className="ck-inspector-section"><div className="ck-inspector-restricted">No stack was recorded for this call. Its cost is unaffected.</div></div>}</>;
}

function ContextTab({ context }: { context: unknown }) {
  if (!context || (typeof context === "object" && Object.keys(context as object).length === 0)) return <div className="ck-inspector-section"><EmptyPanel title="No labels on this call" /></div>;
  return <div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>Labels from your app</span></div><pre className="ck-inspector-pre">{jsonText(context)}</pre><p className="ck-table-note" style={{ paddingLeft: 0, paddingRight: 0, borderTop: 0 }}>Shown exactly as your app sent them.</p></div>;
}

function TraceDetail({ projectId, traceId }: { projectId: string; traceId: string }) {
  const { user, workspaceSettings } = useAuth();
  const reportingCurrency = workspaceSettings?.reportingCurrency ?? "USD";
  const fx = workspaceSettings?.fx;
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestKey = `${projectId}:${traceId}`;
  const [state, setState] = useState<{ key: string; trace: { traceId: string; summary: Record<string, unknown>; events: TraceEvent[]; usageComponents?: UsageComponent[]; spans?: TraceSpan[] } | null; error: string | null }>({ key: "", trace: null, error: null });
  const loading = state.key !== requestKey;
  const trace = state.key === requestKey ? state.trace : null;
  const error = state.key === requestKey ? state.error : null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [collapsedState, setCollapsedState] = useState<Set<string> | null>(null);
  const [copied, setCopied] = useState(false);
  const [shareFallback, setShareFallback] = useState<string | null>(null);
  const explicitState = prototypeState(searchParams);
  const effectiveRole = prototypeRole(searchParams, user?.role ?? "viewer");
  const requestedTab = inspectorTab(searchParams.get("tab"));

  useEffect(() => {
    let cancelled = false;
    getTrace(projectId, traceId)
      .then((result) => { if (!cancelled) { const requestedRaw = new URLSearchParams(window.location.search).get("call"); const requested = requestedRaw ? result.events.filter(isCallEvent).find((event) => event.id === requestedRaw || event.id.endsWith(`:${requestedRaw}`))?.id : null; setState({ key: requestKey, trace: result, error: null }); setSelectedId(requested ?? "__root__"); } })
      .catch((reason: unknown) => { if (!cancelled) setState({ key: requestKey, trace: null, error: reason instanceof Error ? reason.message : "Run not found" }); });
    return () => { cancelled = true; };
  }, [projectId, traceId, requestKey]);


  const namedState = PrototypeStatePanel({ state: explicitState, family: "Run", title: explicitState === "no-access" ? "Access required" : explicitState === "not-found" ? "Run not found" : undefined, backHref: "/traces", retryHref: `/traces/${encodeURIComponent(traceId)}${window.location.search}` });
  if (namedState) return namedState;

  if (explicitState === "orphan") {
    return <><PageHeader title="A call outside a run" actions={<button className="ck-button ck-button-secondary" type="button" onClick={() => void navigator.clipboard.writeText(window.location.href)}><Copy size={13} /> Copy link</button>} /><div className="ck-alert" role="status"><Info size={15} /><div><strong>Not part of a run.</strong> You can still inspect this call on its own.</div></div><Panel><EmptyPanel title="One call" icon={<Route size={18} />} /></Panel></>;
  }

  if (loading) return <><PageHeader title="Loading run" /><Panel><LoadingRows count={6} columns={4} /></Panel></>;
  if (error || !trace) return <><PageHeader title="Run unavailable" actions={<Link className="ck-button ck-button-secondary" to="/traces"><ArrowLeft size={13} /> Back to runs</Link>} /><Panel><EmptyPanel title="Couldn’t open this run" body="It may have expired, or it belongs to a project you can’t open." action={<button className="ck-button ck-button-secondary" type="button" onClick={() => window.location.reload()}>Try again</button>} icon={<CircleAlert size={18} />} /></Panel></>;

  const summary = trace.summary;
  const allEvents = trace.events ?? [];
  const rawEvents = allEvents.filter(isCallEvent);
  const events = explicitState === "partial" ? rawEvents.map((event, index) => index === 2 ? { ...event, cost_usd: null, cost_basis: "unknown" as const } : event) : rawEvents;
  const selected = events.find((event) => event.id === selectedId) ?? null;
  const knownCost = explicitState === "partial"
    ? events.reduce<number>((sum, event) => sum + (event.cost_usd == null ? 0 : Number(event.cost_usd) || 0), 0)
    : summary.known_cost !== undefined
    ? (summary.known_cost == null ? null : Number(summary.known_cost) || 0)
    : events.reduce<number>((sum, event) => sum + (event.cost_usd == null ? 0 : Number(event.cost_usd) || 0), 0);
  const unpriced = explicitState === "partial" ? Math.max(1, events.filter((event) => event.cost_usd == null).length) : summary.unpriced_count == null
    ? events.filter((event) => event.cost_usd == null).length
    : Number(summary.unpriced_count) || 0;
  const start = String(summary.started_at ?? events[0]?.timestamp ?? "");
  const end = String(summary.ended_at ?? events[events.length - 1]?.timestamp ?? "");
  const fallbackStart = events.reduce((min, event) => Math.min(min, new Date(event.timestamp).getTime()), Number.POSITIVE_INFINITY);
  const fallbackEnd = events.reduce((max, event) => Math.max(max, new Date(event.timestamp).getTime() + (Number(event.duration_ms) || 0)), 0);
  const elapsed = summary.elapsed_ms == null
    ? (Number.isFinite(fallbackStart) && fallbackEnd > 0 ? fallbackEnd - fallbackStart : new Date(end).getTime() - new Date(start).getTime())
    : Number(summary.elapsed_ms);
  const executionState = explicitState === "in-progress" ? "in_progress" : explicitState === "interrupted" ? "interrupted" : String(summary.execution_state ?? "unknown");
  const accountingState = ["accounting", "in-progress"].includes(explicitState) ? "updating" : explicitState === "partial" ? "partial" : String(summary.accounting_state ?? (unpriced > 0 ? "partial" : "complete"));
  const mostExpensive = events.reduce<TraceEvent | null>((current, event) => event.cost_usd != null && (current == null || Number(event.cost_usd) > Number(current.cost_usd)) ? event : current, null);
  const traceName = String(summary.trace_name ?? traceId);
  const service = typeof summary.service === "string" ? summary.service : null;
  const customer = typeof summary.customer === "string" ? summary.customer : null;
  const release = typeof summary.release === "string" ? summary.release : null;
  const retryEvents = events.filter((event) => Boolean(event.parent_event_id));
  const retrySubtotal = retryEvents.reduce((total, event) => total + (event.cost_usd == null ? 0 : Number(event.cost_usd) || 0), 0);
  const orderedEvents = [...events].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const eventStartMs = orderedEvents.reduce((minimum, event) => Math.min(minimum, new Date(event.timestamp).getTime()), Number.POSITIVE_INFINITY);
  const eventEndMs = orderedEvents.reduce((maximum, event) => Math.max(maximum, new Date(event.timestamp).getTime() + (Number(event.duration_ms) || 0)), eventStartMs);
  const eventSpan = Number.isFinite(eventStartMs) && eventEndMs > eventStartMs ? eventEndMs - eventStartMs : Math.max(elapsed, 1);
  const spans = trace.spans ?? [];
  const treeRoots = buildRunTree(spans, events);
  const collapsed = collapsedState ?? defaultCollapsed(spans);
  const treeRows = flattenRunTree(treeRoots, collapsed);
  const selectedSpan = selectedSpanId ? findSpanNode(treeRoots, selectedSpanId) : null;
  const toggleSpan = (spanId: string): void => setCollapsedState((current) => {
    const next = new Set(current ?? defaultCollapsed(spans));
    if (next.has(spanId)) next.delete(spanId);
    else next.add(spanId);
    return next;
  });
  const detailStatus = runStatus({ execution_state: executionState, unpriced_count: unpriced } as Trace, knownCost);
  const timeZoneLabel = displayTimeZoneLabel();

  function share(): void {
    const sharedUrl = new URL(window.location.href);
    sharedUrl.searchParams.set("project", projectId);
    const link = sharedUrl.toString();
    setShareFallback(null);
    void navigator.clipboard.writeText(link).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(() => setShareFallback(link));
  }
  const returnTo = typeof location.state === "object" && location.state !== null && "returnTo" in location.state && typeof (location.state as { returnTo?: unknown }).returnTo === "string" ? (location.state as { returnTo: string }).returnTo : "/traces";
  function selectRoot(): void { setSelectedSpanId(null); setSelectedId("__root__"); setSearchParams((current) => { current.delete("call"); return current; }, { replace: true }); }
  function selectEvent(eventId: string): void { setSelectedSpanId(null); setSelectedId(eventId); setSearchParams((current) => { current.set("call", eventId); return current; }, { replace: true }); }
  const feature = typeof summary.feature === "string" ? summary.feature : null;
  const allowanceParams = new URLSearchParams({ project: projectId });
  if (feature) { allowanceParams.set("scopeDimension", "feature"); allowanceParams.set("scopeValue", feature); }

  return <div className="prototype-trace-route">
    
    <PrototypeStateNotice state={explicitState} family="trace" role={effectiveRole} onRetry={() => window.location.reload()} />
    <div className="ck-detail-header prototype-trace-header"><div><Link className="ck-back-link" to={returnTo}><ArrowLeft size={13} aria-hidden="true" /> Runs</Link><h1 className="ck-detail-title">{traceName}</h1><div className="ck-detail-id">{start ? `${formatAbsoluteDate(start)}${timeZoneLabel ? ` ${timeZoneLabel}` : ""} · ` : ""}<span className="mono">{traceId}</span></div>{shareFallback && <label className="ck-share-fallback">Copy this authenticated link manually<input readOnly value={shareFallback} onFocus={(event) => event.currentTarget.select()} /></label>}<div className="ck-pill-row" style={{ marginTop: 12, marginBottom: 0 }}>{[feature, customer ?? service, typeof summary.environment === "string" ? summary.environment : null, release ? `Release ${release}` : null].filter(Boolean).map((value) => <StatusPill tone="neutral" key={String(value)}>{String(value)}</StatusPill>)}</div></div><div className="ck-detail-actions"><button className="ck-button ck-button-secondary" type="button" onClick={share}>{copied ? <Check size={13} /> : <Share size={13} />}{copied ? "Link copied" : shareFallback ? "Try copy again" : "Share"}</button><Link className="ck-button ck-button-secondary" to={`/compare?ids=${encodeURIComponent(traceId)}&project=${encodeURIComponent(projectId)}`}><GitCompare size={13} /> Compare</Link></div></div>
    <div className="ck-summary-strip prototype-trace-summary"><div className="ck-summary-item"><div className="prototype-summary-label">Cost</div><div className="ck-summary-value">{knownCost == null ? "Unpriced" : formatReportedAmount(knownCost, reportingCurrency, fx)}</div>{unpriced > 0 && <div className="ck-summary-meta">{`${unpriced} of ${events.length} calls unpriced`}</div>}</div><div className="ck-summary-item"><div className="prototype-summary-label">Duration</div><div className="ck-summary-value">{Number.isFinite(elapsed) && elapsed >= 0 ? formatDuration(elapsed) : "Unknown"}</div></div><div className="ck-summary-item"><div className="prototype-summary-label">Calls</div><div className="ck-summary-value">{events.length.toLocaleString()}</div><div className="ck-summary-meta">{formatProviders([...new Set(events.map((event) => event.provider).filter(Boolean))].join(","))}</div></div><div className="ck-summary-item"><div className="prototype-summary-label">Status</div><div className="ck-summary-value"><StatusPill tone={detailStatus.tone}>{detailStatus.label}</StatusPill></div>{accountingState !== "complete" && <div className="ck-summary-meta">{accountingState === "updating" ? "Cost still updating" : "Some prices missing"}</div>}</div></div>
    {retryEvents.length > 0 && <div className="ck-alert ck-trace-context-notice"><Info size={15} aria-hidden="true" /><span><strong>{retryEvents.length} retr{retryEvents.length === 1 ? "y" : "ies"}:</strong> {formatReportedAmount(retrySubtotal, reportingCurrency, fx)}</span></div>}
    <div className={`ck-trace-layout prototype-trace-layout ${selected || selectedSpan ? "has-selection" : ""}`}><Panel className="ck-trace-tree" title={spans.length > 0 ? "Timeline" : "Calls"}>{eventSpan > 1 && <div className="ck-tree-ticks"><span>0 s</span><span>{formatDuration(eventSpan / 3)}</span><span>{formatDuration(eventSpan * 2 / 3)}</span><span>{formatDuration(eventSpan)}</span></div>}{events.length === 0 && spans.length === 0 ? <EmptyPanel title="No calls recorded" /> : <RunTree rows={treeRows} collapsed={collapsed} onToggle={toggleSpan} selectedId={selectedSpan ? `span:${selectedSpan.id}` : selectedId} onSelectRoot={selectRoot} onSelectCall={selectEvent} onSelectSpan={(spanId) => { setSelectedSpanId(spanId); setSelectedId(null); }} runName={traceName} runCost={knownCost} runDurationMs={elapsed} callCount={events.length} runStartMs={eventStartMs} runSpanMs={eventSpan} callName={eventDisplayName} currency={reportingCurrency} fx={fx} />}</Panel>{selectedSpan ? <SpanInspector node={selectedSpan} currency={reportingCurrency} fx={fx} /> : selected ? <CallInspector projectId={projectId} event={selected} role={effectiveRole} currency={reportingCurrency} fx={fx} initialTab={requestedTab} prototypeVariant={explicitState} forceError={explicitState === "child-error"} /> : <RootInspector summary={summary} context={events[0]?.context ?? null} knownCost={knownCost} unpriced={unpriced} usageComponents={trace.usageComponents} callEvents={events} mostExpensive={mostExpensive} currency={reportingCurrency} fx={fx} initialTab={requestedTab} />}</div>
  </div>;
}

function RootInspector({ summary, context, knownCost, unpriced, usageComponents, callEvents, mostExpensive, currency, fx, initialTab = "content" }: { summary: Record<string, unknown>; context: unknown; knownCost: number | null; unpriced: number; usageComponents?: UsageComponent[]; callEvents?: TraceEvent[]; mostExpensive?: TraceEvent | null; currency: string; fx?: ReportingFx | null; initialTab?: InspectorTab }) {
  const [tab, setTab] = useState<InspectorTab>(initialTab === "content" ? "cost" : initialTab);
  const callCount = Number(summary.call_count ?? callEvents?.length ?? 0) || 0;
  return <Panel className="ck-inspector"><div className="ck-inspector-call"><div><div className="ck-inspector-heading">This run</div><div className="ck-inspector-subheading">{callCount.toLocaleString()} call{callCount === 1 ? "" : "s"} · {String(summary.operation_name ?? summary.trace_name ?? "Unnamed run")}</div></div></div><div className="ck-tabs" role="tablist" aria-label="Run detail"><button className={`ck-tab ${tab === "cost" ? "active" : ""}`} role="tab" aria-selected={tab === "cost"} type="button" onClick={() => setTab("cost")}>Cost &amp; usage</button><button className={`ck-tab ${tab === "source" ? "active" : ""}`} role="tab" aria-selected={tab === "source"} type="button" onClick={() => setTab("source")}>Source</button><button className={`ck-tab ${tab === "context" ? "active" : ""}`} role="tab" aria-selected={tab === "context"} type="button" onClick={() => setTab("context")}>Context</button></div><div className="ck-inspector-body">{tab === "cost" && <><CostRootSummary knownCost={knownCost} unpriced={unpriced} mostExpensive={mostExpensive} usageComponents={usageComponents} currency={currency} fx={fx} /></>}{tab === "source" && <div className="ck-inspector-section"><h3>Where in your code</h3><p className="ck-panel-subtitle">Select a call to see its file and function. Missing locations don’t affect cost.</p><div className="ck-definition-list"><div><span>Feature label</span><strong>{summary.feature_source ? String(summary.feature_source) : "Not set"}</strong></div><div><span>Release</span><strong>{summary.release ? String(summary.release) : "Not recorded"}</strong></div></div></div>}{tab === "context" && <ContextTab context={context} />}</div></Panel>;
}

function CostRootSummary({ knownCost, unpriced, mostExpensive, usageComponents, currency, fx }: { knownCost: number | null; unpriced: number; mostExpensive?: TraceEvent | null; usageComponents?: UsageComponent[]; currency: string; fx?: ReportingFx | null }) {
  return <div className="ck-inspector-body"><div className="ck-inspector-section"><div className="ck-definition-list"><div><span>Cost</span><strong>{knownCost == null ? "Unpriced" : formatReportedAmount(knownCost, currency, fx)}</strong></div><div><span>Pricing</span><strong>{unpriced > 0 ? `${unpriced} unpriced` : "All calls priced"}</strong></div><div><span>Currency</span><strong>{currency}</strong></div></div></div>{mostExpensive && <div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>Most expensive call</span></div><div className="ck-component-row"><span>{mostExpensive.bl_function || mostExpensive.model || mostExpensive.id}</span><span>{mostExpensive.cost_usd == null ? "Unpriced" : formatReportedAmount(Number(mostExpensive.cost_usd), currency, fx)}</span></div></div>}{usageComponents && usageComponents.length > 0 && <div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>Usage reported separately</span></div><div className="ck-component-list">{usageComponents.map((component) => { const amount = component.amount == null ? "Unpriced" : component.currency && component.currency !== "USD" ? formatCurrencyAmount(component.amount, component.currency) : formatReportedAmount(component.amount, currency, fx); return <div className="ck-component-row" key={component.id}><span>{formatProviders(component.provider)} · {component.model || "Model not recorded"}</span><span>{component.unit_value == null ? "Usage not reported" : `${Number(component.unit_value).toLocaleString()} ${component.unit_kind || component.unit || "units"}`} · {amount}</span></div>; })}</div></div>}</div>;
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
  if (!projectId) return <div className="ck-main-inner"><PageHeader title="Runs" /><Panel><EmptyPanel illustration="first-light" title="Ready for your first run" body="Connect a project to start." action={<Link className="ck-button ck-button-primary" to="/onboarding">Connect a project</Link>} /></Panel></div>;
  const contextKey = sharedParams.get("contextKey");
  const contextValues = sharedParams.getAll("contextValue");
  const contextValue = contextValues.length > 0 ? contextValues : null;
  const explicitState = prototypeState(sharedParams);
  return <div className="ck-main-inner">{traceId ? <TraceDetail projectId={projectId} traceId={decodeURIComponent(traceId)} /> : <TraceList key={location.search} projectId={projectId} period={period} setPeriod={setPeriod} contextKey={contextKey} contextValue={contextValue} scopeOverride={scopeOverride} explicitState={explicitState} />}</div>;
}

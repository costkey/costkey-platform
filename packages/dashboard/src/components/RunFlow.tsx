import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { getEvent, getTrace, type EventRow, type Trace, type TraceEvent, type TraceSpan, type UsageComponent } from "../api";
import { EmptyPanel, LoadingRows, Panel, StatusPill } from "./ConsolePrimitives";
import { formatAbsoluteDate, formatCurrencyAmount, formatReportedAmount, sourceAttributionStatus, type ReportingFx } from "./consoleFormatters";
import { formatDuration } from "../utils";
import { RunTree, SpanInspector } from "./RunTree";
import { RunQualityChecks } from "./RunQualityChecks";
import { RunTimeline } from "./RunTimeline";
import { useLiveQuery, type LiveQuery } from "../hooks/useLiveQuery";
import { buildRunTree, defaultCollapsed, flattenRunTree, SPAN_KIND_LABEL, type RunTreeNode, type RunTreeSpanNode } from "./runTreeModel";
import type { PrototypeState } from "./PrototypeState";
import { ProviderLabel, ProviderLogo } from "./ProviderLogo";
import { callCostText, callFailure, isNoCharge } from "./callOutcome";
import { runCallSites, runLabel, siteLocation } from "./runCallSites";
import { defaultOpenFrame, frameViews, shortenPath, type CodeLine, type StackFrame } from "./stackFrames";
import { CallContent } from "./CallContent";
import { modelHref } from "./links";
import { billedUnitsText, cachedNote, cacheWriteText, callUsage, formatHitRate, formatTokenCount, hasTokens, reasoningNote, sumUnits, sumUsage, type CallUsage } from "./tokenUsage";
import { CostBreakdownTable } from "./CostBreakdown";
import { ProjectRelease } from "./Releases";

/**
 * One run's whole flow, shared by the run page and the inline run on the
 * agent page: the waterfall of agents, steps, tools and calls on one time
 * axis, and an inspector for the run, a span or a call.
 */

export type RunDetail = Awaited<ReturnType<typeof getTrace>>;

/** A run is still in progress while a span is open or the run has no end. */
export function runInProgress(detail: RunDetail): boolean {
  const state = String(detail.summary?.execution_state ?? "").toLowerCase();
  if (state === "running" || state === "in_progress") return true;
  return (detail.spans ?? []).some((span) => span.status === "running" || (span.started_at != null && span.ended_at == null));
}

/** Load one run and keep it current: every 10 s, every 3 s while it is still running. */
export function useRunDetail(projectId: string | null, traceId: string | null): LiveQuery<RunDetail> & { detail: RunDetail | null } {
  const live = useLiveQuery(projectId && traceId ? `${projectId}:${traceId}` : null, () => getTrace(projectId!, traceId!), { isFast: runInProgress });
  const current = live.data && (live.data.traceId === traceId || !live.loading) ? live.data : null;
  return { ...live, detail: current, error: live.error && !current ? live.error : null };
}

export interface RunStatusView {
  tone: "good" | "warn" | "critical" | "neutral";
  label: string;
  /** Shown on hover. */
  title?: string;
  /** The later attempt that completed this work item. */
  succeededBy?: string | null;
  succeededOnAttempt?: number | null;
}

export const PRICE_PENDING_HINT = "This model has no price yet. Set one in Settings, Prices.";

/** A run's status in words: retried attempts and runs without calls are not alarms. */
export function runStatus(trace: Pick<Trace, "execution_state" | "unpriced_count" | "call_count" | "accounting_state" | "retry">, cost: number | null): RunStatusView {
  const execution = String(trace.execution_state ?? "").toLowerCase();
  const retry = trace.retry;
  // The work item's outcome at a glance; the attempts are a detail inside the run.
  if (retry?.retried) return { tone: "good", label: "Succeeded", title: `This attempt failed${retry.errorType ? ` (${retry.errorType})` : ""}; attempt ${retry.succeededOnAttempt ?? 2} finished the work.`, succeededBy: retry.succeededBy, succeededOnAttempt: retry.succeededOnAttempt };
  // CostKey sees attempts, not the queue: a retry is shown once it happens, never promised.
  if (execution === "failed" || execution === "error") return { tone: "critical", label: "Failed", title: retry?.errorType ? `The run raised ${retry.errorType}.` : undefined };
  if (execution === "running" || execution === "in_progress" || execution === "started") return { tone: "neutral", label: "Running" };
  // A run with no model calls has nothing to price.
  if (trace.accounting_state === "no_calls" || Number(trace.call_count ?? 1) === 0) return { tone: "good", label: "Succeeded" };
  if ((trace.unpriced_count ?? 0) > 0) return cost == null
    ? { tone: "neutral", label: "Price pending", title: PRICE_PENDING_HINT }
    : { tone: "warn", label: "Partly priced", title: PRICE_PENDING_HINT };
  return { tone: "good", label: "Succeeded" };
}

/** The status pill, with the later attempt linked when a retry completed the work. */
export function RunStatusPill({ status, showLink = true }: { status: RunStatusView; showLink?: boolean }) {
  return <span className="ck-run-status" title={status.title}>
    <StatusPill tone={status.tone}>{status.label}</StatusPill>
    {showLink && status.succeededBy && <Link className="ck-run-status-link" to={`/traces/${encodeURIComponent(status.succeededBy)}`} onClick={(event) => event.stopPropagation()}>After a retry: attempt {status.succeededOnAttempt ?? 2}</Link>}
  </span>;
}

/** Everything the run page and the inline run derive from a loaded run. */
export interface RunModel {
  summary: Record<string, unknown>;
  events: TraceEvent[];
  spans: TraceSpan[];
  usageComponents?: UsageComponent[];
  knownCost: number | null;
  unpriced: number;
  start: string;
  elapsed: number;
  executionState: string;
  accountingState: string;
  status: { tone: "good" | "warn" | "critical" | "neutral"; label: string };
  mostExpensive: TraceEvent | null;
  traceName: string;
  eventStartMs: number;
  eventSpan: number;
  usage: CallUsage;
  /** Calls that failed or were cancelled. */
  failedCalls: number;
}

export function runModel(trace: RunDetail, traceId: string, explicitState: PrototypeState | string = "default"): RunModel {
  const summary = trace.summary;
  const rawEvents = (trace.events ?? []).filter(isCallEvent);
  const events = explicitState === "partial" ? rawEvents.map((event, index) => index === 2 ? { ...event, cost_usd: null, cost_basis: "unknown" as const } : event) : rawEvents;
  const eventsTotal = events.reduce<number>((sum, event) => sum + (event.cost_usd == null ? 0 : Number(event.cost_usd) || 0), 0);
  // A failed call without a price cost nothing: it isn't unpriced.
  const unpricedCalls = events.filter((event) => event.cost_usd == null && !isNoCharge(event)).length;
  const knownCost = explicitState === "partial"
    ? eventsTotal
    : events.length > 0 && unpricedCalls === 0
      ? eventsTotal
      : summary.known_cost !== undefined
        ? (summary.known_cost == null ? null : Number(summary.known_cost) || 0)
        : eventsTotal;
  const unpriced = explicitState === "partial" ? Math.max(1, unpricedCalls) : events.length > 0 || summary.unpriced_count == null
    ? unpricedCalls
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
  const eventStartMs = events.reduce((minimum, event) => Math.min(minimum, new Date(event.timestamp).getTime()), Number.POSITIVE_INFINITY);
  const eventEndMs = events.reduce((maximum, event) => Math.max(maximum, new Date(event.timestamp).getTime() + (Number(event.duration_ms) || 0)), eventStartMs);
  const eventSpan = Number.isFinite(eventStartMs) && eventEndMs > eventStartMs ? eventEndMs - eventStartMs : Math.max(elapsed, 1);
  return {
    summary, events, spans: trace.spans ?? [], usageComponents: trace.usageComponents,
    knownCost, unpriced, start, elapsed, executionState, accountingState,
    status: runStatus({ execution_state: executionState, unpriced_count: unpriced, call_count: events.length, accounting_state: events.length === 0 ? "no_calls" : undefined, retry: (summary.retry as Trace["retry"]) ?? null }, knownCost),
    mostExpensive, traceName: String(summary.trace_name ?? traceId), eventStartMs, eventSpan,
    usage: sumUsage(events.map(callUsage)),
    failedCalls: events.filter((event) => callFailure(event) != null).length,
  };
}

/** Cost, time, calls, usage and status across the top of a run. Token items only when calls reported tokens; other billed units beside them. */
export function RunSummaryStrip({ model, currency, fx, className = "" }: { model: RunModel; currency: string; fx?: ReportingFx | null; className?: string }) {
  const { usage } = model;
  const tokens = hasTokens(usage);
  const units = billedUnitsText(sumUnits(model.events.map((event) => event.native_units)));
  const inputMeta = [cachedNote(usage), usage.cacheHitRate != null ? `${formatHitRate(usage.cacheHitRate)} hit rate` : ""].filter(Boolean).join(" · ");
  const items: ReactNode[] = [
    <div className="ck-summary-item" key="cost"><div className="prototype-summary-label">Cost</div><div className="ck-summary-value">{model.events.length === 0 ? <span className="ck-muted-value">No model calls</span> : model.knownCost == null ? <span title={PRICE_PENDING_HINT}>Unpriced</span> : formatReportedAmount(model.knownCost, currency, fx)}</div>{model.unpriced > 0 ? <div className="ck-summary-meta">{`${model.unpriced} of ${model.events.length} calls unpriced`}</div> : model.usage.cacheSavings != null && model.usage.cacheSavings > 0 ? <div className="ck-summary-meta">{formatReportedAmount(model.usage.cacheSavings, currency, fx)} saved by cache</div> : null}</div>,
    <div className="ck-summary-item" key="duration"><div className="prototype-summary-label">Duration</div><div className="ck-summary-value">{Number.isFinite(model.elapsed) && model.elapsed >= 0 ? formatDuration(model.elapsed) : "Unknown"}</div></div>,
    <div className="ck-summary-item" key="calls"><div className="prototype-summary-label">Calls</div><div className="ck-summary-value">{model.events.length.toLocaleString()}</div><div className="ck-summary-meta"><RunModels events={model.events} /></div></div>,
  ];
  if (tokens || !units) {
    items.push(<div className="ck-summary-item" key="input"><div className="prototype-summary-label">Input tokens</div><div className="ck-summary-value">{formatTokenCount(usage.inputTokens)}</div>{inputMeta && <div className="ck-summary-meta">{inputMeta}</div>}</div>);
    items.push(<div className="ck-summary-item" key="output"><div className="prototype-summary-label">Output tokens</div><div className="ck-summary-value">{formatTokenCount(usage.outputTokens)}</div>{(reasoningNote(usage) || (tokens && units)) && <div className="ck-summary-meta">{[reasoningNote(usage), tokens && units ? `+ ${units}` : ""].filter(Boolean).join(" · ")}</div>}</div>);
  } else {
    items.push(<div className="ck-summary-item ck-summary-wide" key="usage"><div className="prototype-summary-label">Billed for</div><div className="ck-summary-value">{units}</div></div>);
  }
  items.push(<div className="ck-summary-item" key="status"><div className="prototype-summary-label">Status</div><div className="ck-summary-value"><RunStatusPill status={model.status} /></div>{model.failedCalls > 0 ? <div className="ck-summary-meta ck-tone-critical-text">{model.failedCalls} of {model.events.length} call{model.events.length === 1 ? "" : "s"} failed</div> : model.accountingState !== "complete" && model.unpriced > 0 && <div className="ck-summary-meta">{model.accountingState === "updating" ? "Cost still updating" : "Some prices missing"}</div>}</div>);
  return <div className={`ck-summary-strip ck-run-summary ${className}`} data-items={items.length}>{items}</div>;
}

/** Input with cache, output with reasoning, and what the cache saved. */
export function TokenUsageSection({ usage, currency, fx }: { usage: CallUsage; currency: string; fx?: ReportingFx | null }) {
  return <div className="ck-inspector-section">
    <div className="ck-inspector-section-title"><span>Tokens</span></div>
    <dl className="ck-definition-list ck-token-list">
      <div><dt>Input tokens</dt><dd>{formatTokenCount(usage.inputTokens)}</dd></div>
      <div className="is-part"><dt>Of which cached</dt><dd>{formatTokenCount(usage.cacheReadTokens)}</dd></div>
      <div className="is-part"><dt>Cache hit rate</dt><dd>{formatHitRate(usage.cacheHitRate)}</dd></div>
      <div className="is-part"><dt>Written to cache</dt><dd>{cacheWriteText(usage)}</dd></div>
      <div><dt>Output tokens</dt><dd>{formatTokenCount(usage.outputTokens)}</dd></div>
      <div className="is-part"><dt>Of which reasoning</dt><dd>{formatTokenCount(usage.reasoningTokens)}</dd></div>
      {usage.cacheSavings != null && <div><dt>Saved by cache</dt><dd>{formatReportedAmount(usage.cacheSavings, currency, fx)}</dd></div>}
    </dl>
  </div>;
}

/**
 * The waterfall beside its inspector. Selection lives here; a parent that
 * keeps the selected call in its URL passes `initialCallId` and `onCallChange`.
 */
export function RunFlow({ projectId, traceId, model, role, currency, fx, explicitState = "default", requestedTab = "content", openChecks = false, initialCallId = null, onCallChange, inline = false, timeline = false }: {
  projectId: string;
  traceId: string;
  model: RunModel;
  role: string;
  currency: string;
  fx?: ReportingFx | null;
  explicitState?: PrototypeState;
  requestedTab?: InspectorTab;
  openChecks?: boolean;
  initialCallId?: string | null;
  onCallChange?: (callId: string | null) => void;
  /** Inside a page section: the inspector stacks below the waterfall on narrow screens instead of replacing it. */
  inline?: boolean;
  /** Lead with the run's calls on one time axis, as the landing page shows them. */
  timeline?: boolean;
}) {
  const { events, spans } = model;
  const layoutRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => (initialCallId ? events.find((event) => event.id === initialCallId || event.id.endsWith(`:${initialCallId}`))?.id : null) ?? "__root__");
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [collapsedState, setCollapsedState] = useState<Set<string> | null>(null);
  const selected = events.find((event) => event.id === selectedId) ?? null;
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
  function selectRoot(): void { setSelectedSpanId(null); setSelectedId("__root__"); onCallChange?.(null); }
  function selectEvent(eventId: string): void { setSelectedSpanId(null); setSelectedId(eventId); onCallChange?.(eventId); }
  function selectSpan(spanId: string): void { setSelectedSpanId(spanId); setSelectedId(null); onCallChange?.(null); }
  /** From the timeline: on a narrow screen the inspector sits below it, so bring it into view. */
  function selectFromTimeline(eventId: string): void {
    selectEvent(eventId);
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 900px)").matches) {
      window.requestAnimationFrame(() => layoutRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  return <>{timeline && <RunTimeline traceId={traceId} runName={model.traceName} events={events} spans={spans} runCost={model.knownCost} unpriced={model.unpriced} runDurationMs={model.elapsed} selectedId={selectedSpan ? null : selectedId} onSelectCall={selectFromTimeline} currency={currency} fx={fx} />}<div ref={layoutRef} className={`ck-trace-layout prototype-trace-layout ${inline ? "ck-run-flow-inline" : ""} ${selected || selectedSpan ? "has-selection" : ""}`}>
    <Panel className="ck-trace-tree" title={spans.length > 0 ? (timeline ? "Steps and calls" : "Timeline") : "Calls"}>{events.length === 0 && spans.length === 0 ? <EmptyPanel title="No calls recorded" /> : <RunTree rows={treeRows} events={events} collapsed={collapsed} onToggle={toggleSpan} selectedId={selectedSpan ? `span:${selectedSpan.id}` : selectedId} onSelectRoot={selectRoot} onSelectCall={selectEvent} onSelectSpan={selectSpan} runName={model.traceName} runCost={model.knownCost} runDurationMs={model.elapsed} callCount={events.length} runStartMs={model.eventStartMs} runSpanMs={model.eventSpan} callName={eventDisplayName} currency={currency} fx={fx} showSplit={!timeline} />}</Panel>
    {selectedSpan
      ? <SpanInspector node={selectedSpan} currency={currency} fx={fx} />
      : selected
        ? <CallInspector projectId={projectId} event={selected} role={role} currency={currency} fx={fx} initialTab={requestedTab} prototypeVariant={explicitState} forceError={explicitState === "child-error"} />
        : <RootInspector projectId={projectId} traceId={traceId} openChecks={openChecks} summary={model.summary} context={events[0]?.context ?? null} knownCost={model.knownCost} unpriced={model.unpriced} usageComponents={model.usageComponents} callEvents={events} mostExpensive={model.mostExpensive} usage={model.usage} currency={currency} fx={fx} initialTab={requestedTab} onSelectCall={selectEvent} />}
  </div></>;
}

export function isCallEvent(event: TraceEvent): boolean {
  return !event.event_type || event.event_type === "call";
}

// The fixture adapter records a human call name in event metadata; prefer it
// for tree/step labels like the prototype ("Embed query"), falling back to
// the recorded function for live events that carry no friendly name.
export function findSpanNode(nodes: RunTreeNode[], spanId: string): RunTreeSpanNode | null {
  for (const node of nodes) {
    if (node.type !== "span") continue;
    if (node.id === spanId) return node;
    const nested = findSpanNode(node.children, spanId);
    if (nested) return nested;
  }
  return null;
}

export function eventDisplayName(event: { metadata?: unknown; bl_function?: string | null; model?: string | null }): string {
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

export function parseJson(value: unknown): unknown {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function jsonText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export type InspectorTab = "content" | "cost" | "source" | "context";

export function inspectorTab(value: string | null | undefined): InspectorTab {
  const normalized = value?.toLowerCase().replaceAll(" & ", "-").replaceAll(" ", "-");
  if (normalized === "cost-usage" || normalized === "cost") return "cost";
  if (normalized === "source") return "source";
  if (normalized === "context") return "context";
  return "content";
}

export function CallInspector({ projectId, event, role, currency, fx, initialTab = "content", prototypeVariant = "default", forceError = false }: { projectId: string; event: TraceEvent; role: string; currency: string; fx?: ReportingFx | null; initialTab?: InspectorTab; prototypeVariant?: PrototypeState; forceError?: boolean }) {
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
  const failure = callFailure(event);

  return <Panel className="ck-inspector ck-call-inspector" title="Call">
    <div className="ck-tabs" role="tablist" aria-label="Call detail"><button className={`ck-tab ${tab === "content" ? "active" : ""}`} role="tab" aria-selected={tab === "content"} type="button" onClick={() => setTab("content")}>Content</button><button className={`ck-tab ${tab === "cost" ? "active" : ""}`} role="tab" aria-selected={tab === "cost"} type="button" onClick={() => setTab("cost")}>Cost &amp; usage</button><button className={`ck-tab ${tab === "source" ? "active" : ""}`} role="tab" aria-selected={tab === "source"} type="button" onClick={() => setTab("source")}>Source</button><button className={`ck-tab ${tab === "context" ? "active" : ""}`} role="tab" aria-selected={tab === "context"} type="button" onClick={() => setTab("context")}>Context</button></div>
      <div className="ck-inspector-body">
      <div className="ck-inspector-call"><div><div className="ck-inspector-heading">{eventDisplayName({ ...event, bl_function: detail?.bl_function ?? event.bl_function })}</div><div className="ck-inspector-subheading"><ProviderLabel provider={event.provider} size={13} /> · {event.model ? <Link className="ck-inline-link" to={modelHref(event.provider, event.model)}>{event.model}</Link> : "Model not recorded"} · {formatAbsoluteDate(event.timestamp)}</div></div><div className="ck-inspector-outcome">{failure && <StatusPill tone="critical">{failure.label}</StatusPill>}<strong className="ck-inspector-cost">{callCostText({ ...event, cost_usd: cost }, (value) => formatReportedAmount(value, currency, fx))}</strong></div></div>{failure?.reason && <div className="ck-inspector-failure" role="status">{failure.reason}</div>}
      {loading && <div style={{ marginTop: 18 }}><LoadingRows count={3} columns={2} /></div>}
      {detailError && <div className="ck-alert" role="alert" style={{ marginTop: 16 }}><CircleAlert size={14} /><div><strong>Couldn’t load this call’s details.</strong> Its cost and timing are still accurate.</div></div>}
      {!loading && tab === "content" && <ContentTab canReadContent={canReadContent} provider={event.provider} model={event.model} canManageCapture={role === "owner" || role === "admin"} input={content} output={output} contentStatus={prototypeVariant === "expired" ? "expired" : prototypeVariant === "uncaptured" ? "not_available" : prototypeVariant === "redacted" ? "redacted" : prototypeVariant === "long-content" ? "too_long" : prototypeVariant === "restricted" ? "restricted" : detail?.content_status ?? event.content_status} />}
      {!loading && tab === "cost" && <CostTab event={event} detail={detail} cost={cost} currency={currency} fx={fx} />}
      {!loading && tab === "source" && <SourceTab detail={prototypeVariant === "missing-source" ? null : detail} frames={prototypeVariant === "missing-source" ? [] : frames} canReadContent={canReadContent} />}
      {!loading && tab === "context" && <ContextTab context={context} />}
    </div>
  </Panel>;
}

function ContentTab({ canReadContent, input, output, contentStatus, provider, model, canManageCapture }: { canReadContent: boolean; input: unknown; output: unknown; contentStatus?: string | null; provider?: string | null; model?: string | null; canManageCapture: boolean }) {
  // System prompt, conversation, configuration and output, read per provider shape.
  return <CallContent input={input} output={output} provider={provider} model={model} contentStatus={contentStatus} canReadContent={canReadContent} canManageCapture={canManageCapture} />;
}


/** The models a run called, each with its provider's logo: "gpt-6-luna", "+2 more". */
function RunModels({ events }: { events: TraceEvent[] }) {
  const seen = new Map<string, { provider: string | null; model: string }>();
  for (const event of events) {
    if (!event.model) continue;
    const key = `${event.provider ?? ""}\u0000${event.model}`;
    if (!seen.has(key)) seen.set(key, { provider: event.provider ?? null, model: event.model });
  }
  const models = [...seen.values()];
  if (models.length === 0) return <ProviderLabel provider={[...new Set(events.map((event) => event.provider).filter(Boolean))].join(",")} size={13} />;
  const shown = models.slice(0, 2);
  return <span className="ck-run-models" title={models.map((item) => item.model).join(", ")}>
    {shown.map((item) => <span key={`${item.provider}:${item.model}`}><ProviderLogo provider={item.provider} size={13} />{item.model}</span>)}
    {models.length > shown.length && <span>+{models.length - shown.length} more</span>}
  </span>;
}

function CostTab({ event, detail, cost, currency, fx }: { event: TraceEvent; detail: EventRow | null; cost: number | null | undefined; currency: string; fx?: ReportingFx | null }) {
  const usedModel = event.model || detail?.model || null;
  const requestedModel = event.request_model ?? detail?.request_model ?? null;
  const usage = callUsage({
    ...event,
    input_tokens: event.input_tokens ?? detail?.input_tokens ?? null,
    output_tokens: event.output_tokens ?? detail?.output_tokens ?? null,
    reasoning_tokens: event.reasoning_tokens ?? detail?.reasoning_tokens ?? null,
    cache_read_tokens: event.cache_read_tokens ?? detail?.cache_read_tokens ?? null,
    cache_creation_tokens: event.cache_creation_tokens ?? detail?.cache_creation_tokens ?? null,
  });
  const tokens = hasTokens(usage);
  const units = billedUnitsText(event.native_units);
  const billed = units || (tokens ? `${formatTokenCount((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))} tokens` : event.unit_value != null ? `${Number(event.unit_value).toLocaleString()} ${event.unit_kind || event.unit || "units"}` : null);
  // request_model is stored only when it differs from the model used.
  const modelText = usedModel
    ? <span className="ck-inspector-model"><ProviderLogo provider={event.provider} size={14} />{usedModel}{requestedModel && requestedModel !== usedModel && <span className="ck-inspector-value-note">Asked for {requestedModel}</span>}</span>
    : <span className="ck-muted-value">Not recorded</span>;
  return <><div className="ck-inspector-section"><div className="ck-inspector-grid">
    <InspectorValue label="Cost" value={callCostText({ ...event, cost_usd: cost }, (value) => formatReportedAmount(value, currency, fx))} />
    <InspectorValue label="Model" value={modelText} />
    <InspectorValue label="Billed for" value={billed ?? <span className="ck-muted-value">Not reported</span>} />
    <InspectorValue label="Duration" value={formatDuration(Number(event.duration_ms) || 0)} />
  </div></div>
  {detail?.cost_breakdown?.kind === "catalog" && cost != null && <div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>How the cost adds up</span></div>
    <CostBreakdownTable breakdown={{ lines: detail.cost_breakdown.lines, other: [], total: cost }} money={(value) => formatReportedAmount(value ?? 0, currency, fx)} />
  </div>}
  {tokens && <TokenUsageSection usage={usage} currency={currency} fx={fx} />}
  {cost == null && !isNoCharge(event) && <div className="ck-inspector-section"><div className="ck-inspector-restricted">We don’t have a price for this call yet, so it isn’t counted as $0.</div></div>}
  {cost == null && isNoCharge(event) && <div className="ck-inspector-section"><div className="ck-inspector-note">This call failed before the provider charged for it, so it counts as no charge.</div></div>}</>;
}

function InspectorValue({ label, value }: { label: string; value: ReactNode }) { return <div><div className="ck-inspector-key">{label}</div><div className="ck-inspector-value">{value}</div></div>; }

function SourceTab({ detail, frames, canReadContent }: { detail: EventRow | null; frames: unknown; canReadContent: boolean }) {
  if (!canReadContent) return <div className="ck-inspector-section"><div className="ck-inspector-restricted"><strong>Source is hidden for your role.</strong><br />Viewers don’t see file and function locations.</div></div>;
  const frameRows = Array.isArray(frames) ? frames as StackFrame[] : [];
  const attribution = sourceAttributionStatus(detail ? { featureSource: detail.feature_source, featureMappingId: detail.feature_mapping_id, functionName: detail.bl_function, fileName: detail.bl_file } : null);
  const location = detail?.bl_file ? shortenPath(detail.bl_file).short : null;
  const scope = detail?.scope_site && Array.isArray(detail.scope_site.frames) && detail.scope_site.frames.length > 0 ? detail.scope_site : null;
  return <><div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>Where in your code</span></div><dl className="ck-definition-list">
    <div><dt>Function</dt><dd className="mono">{detail?.bl_function || <span className="ck-muted-value">Not recorded</span>}</dd></div>
    <div><dt>File</dt><dd className="ck-path-value" title={detail?.bl_file ?? undefined}>{location ? <bdi>{location}{detail?.bl_line == null ? "" : `:${detail.bl_line}`}</bdi> : <span className="ck-muted-value">Not recorded</span>}</dd></div>
    <div><dt>Feature label</dt><dd>{attribution === "Explicit" ? "Set in code" : attribution === "Mapped" ? "From a mapping" : attribution === "Inferred" ? "Inferred" : <span className="ck-muted-value">Not set</span>}</dd></div>
  </dl></div>
  {scope
    // The call ran on a framework's own task: show the code that opened its agent or step.
    ? <><div className="ck-inspector-section"><p className="ck-inspector-note">Made by the framework inside {SPAN_KIND_LABEL[scope.kind]?.toLowerCase() ?? "span"} <strong>{scope.name}</strong>. This is the code that started it.</p></div>
      <CallStack key={`scope:${String(detail?.id ?? "")}`} frames={scope.frames} callSite={{ functionName: detail?.bl_function, file: detail?.bl_file, line: detail?.bl_line == null ? null : Number(detail.bl_line) }} /></>
    : frameRows.length > 0
      ? <CallStack key={String(detail?.id ?? "")} frames={frameRows} callSite={{ functionName: detail?.bl_function, file: detail?.bl_file, line: detail?.bl_line == null ? null : Number(detail.bl_line) }} />
      : <div className="ck-inspector-section"><p className="ck-inspector-note">No stack was recorded for this call. Its cost is unaffected.</p></div>}</>;
}

const STACK_PREVIEW = 8;

/** The call stack, one compact row per frame. Frames with recorded source open to show it; the first in-app one starts open. */
export function CallStack({ frames, callSite }: { frames: StackFrame[]; callSite: { functionName?: string | null; file?: string | null; line?: number | null } }) {
  const views = useMemo(() => frameViews(frames, callSite), [frames, callSite.functionName, callSite.file, callSite.line]);
  // The attributed frame is never hidden behind "Show all".
  const [showAll, setShowAll] = useState(() => views.findIndex((view) => view.isCallSite) >= STACK_PREVIEW);
  const [open, setOpen] = useState<Set<number>>(() => {
    const first = defaultOpenFrame(views);
    return new Set(first === null ? [] : [first]);
  });
  const shown = showAll ? views : views.slice(0, STACK_PREVIEW);
  function toggle(index: number): void {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }
  return <div className="ck-inspector-section">
    <div className="ck-inspector-section-title"><span>Call stack</span><span className="ck-muted-value">{views.length} frame{views.length === 1 ? "" : "s"}</span></div>
    <ol className="ck-callstack">{shown.map((frame, index) => {
      const expanded = frame.code !== null && open.has(index);
      const row = <>
        <span className="ck-callstack-fn">{frame.functionName}{frame.packageName && <em className="ck-callstack-package">{frame.packageName}</em>}{frame.isCallSite && <em className="ck-callstack-attributed" title="The function this call's cost is attributed to">Attributed</em>}</span>
        {frame.location && <span className="ck-callstack-path" title={frame.fullLocation ?? undefined}><bdi>{frame.location}</bdi></span>}
      </>;
      return <li key={index} className={`${frame.packageName ? "is-installed" : ""} ${expanded ? "is-open" : ""} ${frame.isCallSite ? "is-attributed" : ""}`}>
        {frame.code
          ? <button className="ck-callstack-row has-code" type="button" aria-expanded={expanded} onClick={() => toggle(index)}><span className="ck-callstack-chevron" aria-hidden="true" />{row}</button>
          : <div className="ck-callstack-row">{row}</div>}
        {expanded && frame.code && <CodeBlock lines={frame.code} label={frame.location ?? frame.functionName} />}
      </li>;
    })}</ol>
    {views.length > STACK_PREVIEW && <button className="ck-button ck-button-quiet ck-callstack-toggle" type="button" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>{showAll ? "Show fewer frames" : `Show all ${views.length} frames`}</button>}
  </div>;
}

/** Source lines with a line-number gutter, the call line marked, like a diff view. */
export function CodeBlock({ lines, label }: { lines: CodeLine[]; label: string }) {
  return <div className="ck-code" role="group" aria-label={`Source of ${label}`}>
    <table className="ck-code-table"><tbody>{lines.map((line, index) => <tr key={index} className={line.isCall ? "is-call" : undefined} aria-current={line.isCall ? "true" : undefined}>
      <td className="ck-code-num">{line.number ?? ""}</td>
      <td className="ck-code-text">{line.text || " "}</td>
    </tr>)}</tbody></table>
  </div>;
}

export function ContextTab({ context }: { context: unknown }) {
  if (!context || (typeof context === "object" && Object.keys(context as object).length === 0)) return <div className="ck-inspector-section"><EmptyPanel title="No labels on this call" /></div>;
  return <div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>Labels from your app</span></div><pre className="ck-inspector-pre">{jsonText(context)}</pre><p className="ck-table-note" style={{ paddingLeft: 0, paddingRight: 0, borderTop: 0 }}>Shown exactly as your app sent them.</p></div>;
}

export function RootInspector({ projectId, traceId, openChecks = false, summary, context, knownCost, unpriced, usageComponents, callEvents, mostExpensive, usage, currency, fx, initialTab = "content", onSelectCall }: { projectId: string; traceId: string; openChecks?: boolean; summary: Record<string, unknown>; context: unknown; knownCost: number | null; unpriced: number; usageComponents?: UsageComponent[]; callEvents?: TraceEvent[]; mostExpensive?: TraceEvent | null; usage?: CallUsage; onSelectCall?: (eventId: string) => void; currency: string; fx?: ReportingFx | null; initialTab?: InspectorTab }) {
  const [tab, setTab] = useState<InspectorTab | "checks">(openChecks ? "checks" : initialTab === "content" ? "cost" : initialTab);
  const callCount = Number(summary.call_count ?? callEvents?.length ?? 0) || 0;
  return <Panel className="ck-inspector"><div className="ck-inspector-call"><div><div className="ck-inspector-heading">This run</div><div className="ck-inspector-subheading">{callCount.toLocaleString()} call{callCount === 1 ? "" : "s"} · {String(summary.operation_name ?? summary.trace_name ?? "Unnamed run")}</div></div></div><div className="ck-tabs" role="tablist" aria-label="Run detail"><button className={`ck-tab ${tab === "cost" ? "active" : ""}`} role="tab" aria-selected={tab === "cost"} type="button" onClick={() => setTab("cost")}>Cost &amp; usage</button><button className={`ck-tab ${tab === "source" ? "active" : ""}`} role="tab" aria-selected={tab === "source"} type="button" onClick={() => setTab("source")}>Source</button><button className={`ck-tab ${tab === "context" ? "active" : ""}`} role="tab" aria-selected={tab === "context"} type="button" onClick={() => setTab("context")}>Context</button><button className={`ck-tab ${tab === "checks" ? "active" : ""}`} role="tab" aria-selected={tab === "checks"} type="button" onClick={() => setTab("checks")}>Checks</button></div><div className="ck-inspector-body">{tab === "cost" && <><CostRootSummary knownCost={knownCost} unpriced={unpriced} mostExpensive={mostExpensive} usageComponents={usageComponents} usage={usage} currency={currency} fx={fx} /></>}{tab === "source" && <RunSourceTab projectId={projectId} summary={summary} events={callEvents ?? []} currency={currency} fx={fx} onSelectCall={onSelectCall} />}{tab === "context" && <ContextTab context={context} />}{tab === "checks" && <RunQualityChecks projectId={projectId} traceId={traceId} />}</div></Panel>;
}

function CostRootSummary({ knownCost, unpriced, mostExpensive, usageComponents, usage, currency, fx }: { knownCost: number | null; unpriced: number; mostExpensive?: TraceEvent | null; usageComponents?: UsageComponent[]; usage?: CallUsage; currency: string; fx?: ReportingFx | null }) {
  return <div className="ck-inspector-body"><div className="ck-inspector-section"><div className="ck-definition-list"><div><span>Cost</span><strong>{knownCost == null ? "Unpriced" : formatReportedAmount(knownCost, currency, fx)}</strong></div></div>{unpriced > 0 && <p className="ck-inspector-note ck-pricing-note">{unpriced === 1 ? "1 call has" : `${unpriced} calls have`} no price yet. <Link className="ck-text-link" to="/settings?section=pricing">Set prices</Link></p>}</div>{usage && <TokenUsageSection usage={usage} currency={currency} fx={fx} />}{mostExpensive && <div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>Most expensive call</span></div><div className="ck-component-row"><span>{eventDisplayName(mostExpensive)}</span><span>{mostExpensive.cost_usd == null ? "Unpriced" : formatReportedAmount(Number(mostExpensive.cost_usd), currency, fx)}</span></div></div>}{usageComponents && usageComponents.length > 0 && <div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>Usage reported separately</span></div><div className="ck-component-list">{usageComponents.map((component) => { const amount = component.amount == null ? "Unpriced" : component.currency && component.currency !== "USD" ? formatCurrencyAmount(component.amount, component.currency) : formatReportedAmount(component.amount, currency, fx); return <div className="ck-component-row" key={component.id}><span><ProviderLabel provider={component.provider} size={13} /> · {component.model || "Model not recorded"}</span><span>{component.unit_value == null ? "Usage not reported" : `${Number(component.unit_value).toLocaleString()} ${component.unit_kind || component.unit || "units"}`} · {amount}</span></div>; })}</div></div>}</div>;
}

/** A value, or a muted "Not recorded" when there is none. */
function Recorded({ value }: { value: string | null }) {
  return value ? <>{value}</> : <span className="ck-muted-value">Not recorded</span>;
}

/** Where the run's money went in code: each call site with its calls and cost. */
function RunSourceTab({ projectId, summary, events, currency, fx, onSelectCall }: { projectId: string; summary: Record<string, unknown>; events: TraceEvent[]; currency: string; fx?: ReportingFx | null; onSelectCall?: (eventId: string) => void }) {
  const sites = runCallSites(events);
  const feature = runLabel(summary, events, "feature");
  const release = runLabel(summary, events, "release");
  return <>
    <div className="ck-inspector-section">
      <dl className="ck-definition-list">
        <div><dt>Feature</dt><dd><Recorded value={feature} /></dd></div>
        <div><dt>Release</dt><dd>{release ? <ProjectRelease projectId={projectId} release={release} /> : <Recorded value={null} />}</dd></div>
      </dl>
    </div>
    <div className="ck-inspector-section">
      <div className="ck-inspector-section-title"><span>Where the money went</span></div>
      {sites.length === 0
        ? <p className="ck-inspector-note ck-callsite-empty">No call in this run recorded where it ran in your code. Its cost is unaffected.</p>
        : <ul className="ck-callsite-list">{sites.map((site) => <li key={site.key}>
          <button className="ck-callsite" type="button" onClick={() => onSelectCall?.(site.firstCallId)}>
            <span className="ck-callsite-main">
              <span className="ck-callsite-fn">{site.functionName ?? "Unnamed function"}</span>
              {siteLocation(site) && <span className="ck-callsite-file">{siteLocation(site)}</span>}
              <span className="ck-callsite-model"><ProviderLabel provider={site.provider} size={12} /> · {site.model ?? "Model not recorded"}</span>
            </span>
            <span className="ck-callsite-numbers">
              <strong>{site.cost == null ? (site.unpriced > 0 ? "Unpriced" : "No charge") : formatReportedAmount(site.cost, currency, fx)}</strong>
              <span>{site.calls.toLocaleString()} call{site.calls === 1 ? "" : "s"}{site.unpriced > 0 && site.cost != null ? `, ${site.unpriced} unpriced` : ""}</span>
            </span>
          </button>
        </li>)}</ul>}
    </div>
  </>;
}

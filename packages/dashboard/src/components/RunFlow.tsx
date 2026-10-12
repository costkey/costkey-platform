import { type ReactNode, useEffect, useState } from "react";
import { CircleAlert, Copy } from "lucide-react";
import { getEvent, getTrace, type EventRow, type Trace, type TraceEvent, type TraceSpan, type UsageComponent } from "../api";
import { EmptyPanel, LoadingRows, Panel, StatusPill } from "./ConsolePrimitives";
import { formatAbsoluteDate, formatCurrencyAmount, formatReportedAmount, sourceAttributionStatus, type ReportingFx } from "./consoleFormatters";
import { formatDuration } from "../utils";
import { RunTree, SpanInspector } from "./RunTree";
import { RunQualityChecks } from "./RunQualityChecks";
import { buildRunTree, defaultCollapsed, flattenRunTree, type RunTreeNode, type RunTreeSpanNode } from "./runTreeModel";
import type { PrototypeState } from "./PrototypeState";
import { ProviderLabel } from "./ProviderLogo";
import { cachedNote, cacheWriteText, callUsage, formatHitRate, formatTokenCount, reasoningNote, sumUsage, type CallUsage } from "./tokenUsage";

/**
 * One run's whole flow, shared by the run page and the inline run on the
 * agent page: the waterfall of agents, steps, tools and calls on one time
 * axis, and an inspector for the run, a span or a call.
 */

export type RunDetail = Awaited<ReturnType<typeof getTrace>>;

/** Load one run. Keyed by project and run so a stale response never shows. */
export function useRunDetail(projectId: string | null, traceId: string | null): { detail: RunDetail | null; error: string | null; loading: boolean } {
  const requestKey = projectId && traceId ? `${projectId}:${traceId}` : "";
  const [state, setState] = useState<{ key: string; detail: RunDetail | null; error: string | null }>({ key: "", detail: null, error: null });
  useEffect(() => {
    if (!projectId || !traceId) return;
    let cancelled = false;
    getTrace(projectId, traceId)
      .then((result) => { if (!cancelled) setState({ key: requestKey, detail: result, error: null }); })
      .catch((reason: unknown) => { if (!cancelled) setState({ key: requestKey, detail: null, error: reason instanceof Error ? reason.message : "Run not found" }); });
    return () => { cancelled = true; };
  }, [projectId, traceId, requestKey]);
  const current = state.key === requestKey;
  return { detail: current ? state.detail : null, error: current ? state.error : null, loading: Boolean(requestKey) && !current };
}

export function runStatus(trace: Pick<Trace, "execution_state" | "unpriced_count">, cost: number | null): { tone: "good" | "warn" | "critical" | "neutral"; label: string } {
  const execution = String(trace.execution_state ?? "").toLowerCase();
  if (execution === "failed" || execution === "error") return { tone: "critical", label: "Failed" };
  if (execution === "running" || execution === "in_progress") return { tone: "neutral", label: "Running" };
  if ((trace.unpriced_count ?? 0) > 0) return { tone: "warn", label: "Partly priced" };
  if (cost == null) return { tone: "neutral", label: "Price pending" };
  return { tone: "good", label: "Complete" };
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
}

export function runModel(trace: RunDetail, traceId: string, explicitState: PrototypeState | string = "default"): RunModel {
  const summary = trace.summary;
  const rawEvents = (trace.events ?? []).filter(isCallEvent);
  const events = explicitState === "partial" ? rawEvents.map((event, index) => index === 2 ? { ...event, cost_usd: null, cost_basis: "unknown" as const } : event) : rawEvents;
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
  const eventStartMs = events.reduce((minimum, event) => Math.min(minimum, new Date(event.timestamp).getTime()), Number.POSITIVE_INFINITY);
  const eventEndMs = events.reduce((maximum, event) => Math.max(maximum, new Date(event.timestamp).getTime() + (Number(event.duration_ms) || 0)), eventStartMs);
  const eventSpan = Number.isFinite(eventStartMs) && eventEndMs > eventStartMs ? eventEndMs - eventStartMs : Math.max(elapsed, 1);
  return {
    summary, events, spans: trace.spans ?? [], usageComponents: trace.usageComponents,
    knownCost, unpriced, start, elapsed, executionState, accountingState,
    status: runStatus({ execution_state: executionState, unpriced_count: unpriced }, knownCost),
    mostExpensive, traceName: String(summary.trace_name ?? traceId), eventStartMs, eventSpan,
    usage: sumUsage(events.map(callUsage)),
  };
}

/** Cost, time, calls, tokens and status across the top of a run. */
export function RunSummaryStrip({ model, currency, fx, className = "" }: { model: RunModel; currency: string; fx?: ReportingFx | null; className?: string }) {
  const { usage } = model;
  const inputMeta = [cachedNote(usage), usage.cacheHitRate != null ? `${formatHitRate(usage.cacheHitRate)} hit rate` : ""].filter(Boolean).join(" · ");
  return <div className={`ck-summary-strip ck-run-summary ${className}`}>
    <div className="ck-summary-item"><div className="prototype-summary-label">Cost</div><div className="ck-summary-value">{model.knownCost == null ? "Unpriced" : formatReportedAmount(model.knownCost, currency, fx)}</div>{model.unpriced > 0 ? <div className="ck-summary-meta">{`${model.unpriced} of ${model.events.length} calls unpriced`}</div> : model.usage.cacheSavings != null && model.usage.cacheSavings > 0 ? <div className="ck-summary-meta">{formatReportedAmount(model.usage.cacheSavings, currency, fx)} saved by cache</div> : null}</div>
    <div className="ck-summary-item"><div className="prototype-summary-label">Duration</div><div className="ck-summary-value">{Number.isFinite(model.elapsed) && model.elapsed >= 0 ? formatDuration(model.elapsed) : "Unknown"}</div></div>
    <div className="ck-summary-item"><div className="prototype-summary-label">Calls</div><div className="ck-summary-value">{model.events.length.toLocaleString()}</div><div className="ck-summary-meta"><ProviderLabel provider={[...new Set(model.events.map((event) => event.provider).filter(Boolean))].join(",")} size={13} /></div></div>
    <div className="ck-summary-item"><div className="prototype-summary-label">Input tokens</div><div className="ck-summary-value">{formatTokenCount(usage.inputTokens)}</div>{inputMeta && <div className="ck-summary-meta">{inputMeta}</div>}</div>
    <div className="ck-summary-item"><div className="prototype-summary-label">Output tokens</div><div className="ck-summary-value">{formatTokenCount(usage.outputTokens)}</div>{reasoningNote(usage) && <div className="ck-summary-meta">{reasoningNote(usage)}</div>}</div>
    <div className="ck-summary-item"><div className="prototype-summary-label">Status</div><div className="ck-summary-value"><StatusPill tone={model.status.tone}>{model.status.label}</StatusPill></div>{model.accountingState !== "complete" && <div className="ck-summary-meta">{model.accountingState === "updating" ? "Cost still updating" : "Some prices missing"}</div>}</div>
  </div>;
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
export function RunFlow({ projectId, traceId, model, role, currency, fx, explicitState = "default", requestedTab = "content", openChecks = false, initialCallId = null, onCallChange, inline = false }: {
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
}) {
  const { events, spans } = model;
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

  return <div className={`ck-trace-layout prototype-trace-layout ${inline ? "ck-run-flow-inline" : ""} ${selected || selectedSpan ? "has-selection" : ""}`}>
    <Panel className="ck-trace-tree" title={spans.length > 0 ? "Timeline" : "Calls"}>{events.length === 0 && spans.length === 0 ? <EmptyPanel title="No calls recorded" /> : <RunTree rows={treeRows} events={events} collapsed={collapsed} onToggle={toggleSpan} selectedId={selectedSpan ? `span:${selectedSpan.id}` : selectedId} onSelectRoot={selectRoot} onSelectCall={selectEvent} onSelectSpan={selectSpan} runName={model.traceName} runCost={model.knownCost} runDurationMs={model.elapsed} callCount={events.length} runStartMs={model.eventStartMs} runSpanMs={model.eventSpan} callName={eventDisplayName} currency={currency} fx={fx} />}</Panel>
    {selectedSpan
      ? <SpanInspector node={selectedSpan} currency={currency} fx={fx} />
      : selected
        ? <CallInspector projectId={projectId} event={selected} role={role} currency={currency} fx={fx} initialTab={requestedTab} prototypeVariant={explicitState} forceError={explicitState === "child-error"} />
        : <RootInspector projectId={projectId} traceId={traceId} openChecks={openChecks} summary={model.summary} context={events[0]?.context ?? null} knownCost={model.knownCost} unpriced={model.unpriced} usageComponents={model.usageComponents} callEvents={events} mostExpensive={model.mostExpensive} usage={model.usage} currency={currency} fx={fx} initialTab={requestedTab} />}
  </div>;
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

  return <Panel className="ck-inspector" title="Call">
    <div className="ck-tabs" role="tablist" aria-label="Call detail"><button className={`ck-tab ${tab === "content" ? "active" : ""}`} role="tab" aria-selected={tab === "content"} type="button" onClick={() => setTab("content")}>Content</button><button className={`ck-tab ${tab === "cost" ? "active" : ""}`} role="tab" aria-selected={tab === "cost"} type="button" onClick={() => setTab("cost")}>Cost &amp; usage</button><button className={`ck-tab ${tab === "source" ? "active" : ""}`} role="tab" aria-selected={tab === "source"} type="button" onClick={() => setTab("source")}>Source</button><button className={`ck-tab ${tab === "context" ? "active" : ""}`} role="tab" aria-selected={tab === "context"} type="button" onClick={() => setTab("context")}>Context</button></div>
      <div className="ck-inspector-body">
      <div className="ck-inspector-call"><div><div className="ck-inspector-heading">{eventDisplayName({ ...event, bl_function: detail?.bl_function ?? event.bl_function })}</div><div className="ck-inspector-subheading"><ProviderLabel provider={event.provider} size={13} /> · {event.model || "Model not recorded"} · {formatAbsoluteDate(event.timestamp)}</div></div><strong className="ck-inspector-cost">{cost == null ? "Unpriced" : formatReportedAmount(Number(cost), currency, fx)}</strong></div>
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
  const requestedModel = event.request_model ?? detail?.request_model;
  const basis = event.cost_basis ?? detail?.cost_basis;
  const source = event.cost_source ?? detail?.cost_source;
  const usage = callUsage({
    ...event,
    input_tokens: event.input_tokens ?? detail?.input_tokens ?? null,
    output_tokens: event.output_tokens ?? detail?.output_tokens ?? null,
    reasoning_tokens: event.reasoning_tokens ?? detail?.reasoning_tokens ?? null,
    cache_read_tokens: event.cache_read_tokens ?? detail?.cache_read_tokens ?? null,
    cache_creation_tokens: event.cache_creation_tokens ?? detail?.cache_creation_tokens ?? null,
  });
  const nativeUsage = event.unit_value == null ? "Tokens below" : `${Number(event.unit_value).toLocaleString()} ${event.unit_kind || event.unit || "units"}`;
  return <><div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>How this was priced</span></div><div className="ck-inspector-grid"><InspectorValue label="Cost" value={cost == null ? "Unpriced" : formatReportedAmount(Number(cost), currency, fx)} /><InspectorValue label="Price from" value={basis === "reported" ? "Reported by the provider" : basis === "estimated" ? "Estimated from list prices" : "Not known"} /><InspectorValue label="Provider" value={<ProviderLabel provider={event.provider} />} /><InspectorValue label="Model used" value={event.model || "Not recorded"} /><InspectorValue label="Model requested" value={requestedModel || "Not recorded"} /><InspectorValue label="Rate card" value={source || "Not recorded"} /><InspectorValue label="Usage" value={nativeUsage} /><InspectorValue label="Duration" value={formatDuration(Number(event.duration_ms) || 0)} /></div></div><TokenUsageSection usage={usage} currency={currency} fx={fx} />{cost == null && <div className="ck-inspector-section"><div className="ck-inspector-restricted">We don’t have a price for this call yet, so it isn’t counted as $0.</div></div>}</>;
}

function InspectorValue({ label, value }: { label: string; value: ReactNode }) { return <div><div className="ck-inspector-key">{label}</div><div className="ck-inspector-value">{value}</div></div>; }

function SourceTab({ detail, frames, canReadContent }: { detail: EventRow | null; frames: unknown; canReadContent: boolean }) {
  if (!canReadContent) return <div className="ck-inspector-section"><div className="ck-inspector-restricted"><strong>Source is hidden for your role.</strong><br />Viewers don’t see file and function locations.</div></div>;
  const frameRows = Array.isArray(frames) ? frames as Array<Record<string, unknown>> : [];
  const attribution = sourceAttributionStatus(detail ? { featureSource: detail.feature_source, featureMappingId: detail.feature_mapping_id, functionName: detail.bl_function, fileName: detail.bl_file } : null);
  return <><div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>Where in your code</span></div><div className="ck-inspector-grid"><InspectorValue label="Function" value={detail?.bl_function || "Not recorded"} /><InspectorValue label="File" value={detail?.bl_file || "Not recorded"} /><InspectorValue label="Line" value={detail?.bl_line == null ? "—" : String(detail.bl_line)} /><InspectorValue label="Feature label" value={attribution === "Explicit" ? "Set in code" : attribution === "Mapped" ? "From a mapping" : attribution === "Inferred" ? "Inferred" : attribution === "Recorded location" ? "Not set" : "Not recorded"} /></div></div>{frameRows.length > 0 && <div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>Call stack</span></div><pre className="ck-inspector-pre">{frameRows.slice(0, 8).map((frame, index) => `${index + 1}. ${String(frame["functionName"] ?? "anonymous")} · ${String(frame["fileName"] ?? "file unavailable")}${frame["lineNumber"] ? `:${String(frame["lineNumber"])}` : ""}`).join("\n")}</pre></div>}{frameRows.length === 0 && <div className="ck-inspector-section"><div className="ck-inspector-restricted">No stack was recorded for this call. Its cost is unaffected.</div></div>}</>;
}

export function ContextTab({ context }: { context: unknown }) {
  if (!context || (typeof context === "object" && Object.keys(context as object).length === 0)) return <div className="ck-inspector-section"><EmptyPanel title="No labels on this call" /></div>;
  return <div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>Labels from your app</span></div><pre className="ck-inspector-pre">{jsonText(context)}</pre><p className="ck-table-note" style={{ paddingLeft: 0, paddingRight: 0, borderTop: 0 }}>Shown exactly as your app sent them.</p></div>;
}

export function RootInspector({ projectId, traceId, openChecks = false, summary, context, knownCost, unpriced, usageComponents, callEvents, mostExpensive, usage, currency, fx, initialTab = "content" }: { projectId: string; traceId: string; openChecks?: boolean; summary: Record<string, unknown>; context: unknown; knownCost: number | null; unpriced: number; usageComponents?: UsageComponent[]; callEvents?: TraceEvent[]; mostExpensive?: TraceEvent | null; usage?: CallUsage; currency: string; fx?: ReportingFx | null; initialTab?: InspectorTab }) {
  const [tab, setTab] = useState<InspectorTab | "checks">(openChecks ? "checks" : initialTab === "content" ? "cost" : initialTab);
  const callCount = Number(summary.call_count ?? callEvents?.length ?? 0) || 0;
  return <Panel className="ck-inspector"><div className="ck-inspector-call"><div><div className="ck-inspector-heading">This run</div><div className="ck-inspector-subheading">{callCount.toLocaleString()} call{callCount === 1 ? "" : "s"} · {String(summary.operation_name ?? summary.trace_name ?? "Unnamed run")}</div></div></div><div className="ck-tabs" role="tablist" aria-label="Run detail"><button className={`ck-tab ${tab === "cost" ? "active" : ""}`} role="tab" aria-selected={tab === "cost"} type="button" onClick={() => setTab("cost")}>Cost &amp; usage</button><button className={`ck-tab ${tab === "source" ? "active" : ""}`} role="tab" aria-selected={tab === "source"} type="button" onClick={() => setTab("source")}>Source</button><button className={`ck-tab ${tab === "context" ? "active" : ""}`} role="tab" aria-selected={tab === "context"} type="button" onClick={() => setTab("context")}>Context</button><button className={`ck-tab ${tab === "checks" ? "active" : ""}`} role="tab" aria-selected={tab === "checks"} type="button" onClick={() => setTab("checks")}>Checks</button></div><div className="ck-inspector-body">{tab === "cost" && <><CostRootSummary knownCost={knownCost} unpriced={unpriced} mostExpensive={mostExpensive} usageComponents={usageComponents} usage={usage} currency={currency} fx={fx} /></>}{tab === "source" && <div className="ck-inspector-section"><h3>Where in your code</h3><p className="ck-panel-subtitle">Select a call to see its file and function. Missing locations don’t affect cost.</p><div className="ck-definition-list"><div><span>Feature label</span><strong>{summary.feature_source ? String(summary.feature_source) : "Not set"}</strong></div><div><span>Release</span><strong>{summary.release ? String(summary.release) : "Not recorded"}</strong></div></div></div>}{tab === "context" && <ContextTab context={context} />}{tab === "checks" && <RunQualityChecks projectId={projectId} traceId={traceId} />}</div></Panel>;
}

function CostRootSummary({ knownCost, unpriced, mostExpensive, usageComponents, usage, currency, fx }: { knownCost: number | null; unpriced: number; mostExpensive?: TraceEvent | null; usageComponents?: UsageComponent[]; usage?: CallUsage; currency: string; fx?: ReportingFx | null }) {
  return <div className="ck-inspector-body"><div className="ck-inspector-section"><div className="ck-definition-list"><div><span>Cost</span><strong>{knownCost == null ? "Unpriced" : formatReportedAmount(knownCost, currency, fx)}</strong></div><div><span>Pricing</span><strong>{unpriced > 0 ? `${unpriced} unpriced` : "All calls priced"}</strong></div><div><span>Currency</span><strong>{currency}</strong></div></div></div>{usage && <TokenUsageSection usage={usage} currency={currency} fx={fx} />}{mostExpensive && <div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>Most expensive call</span></div><div className="ck-component-row"><span>{eventDisplayName(mostExpensive)}</span><span>{mostExpensive.cost_usd == null ? "Unpriced" : formatReportedAmount(Number(mostExpensive.cost_usd), currency, fx)}</span></div></div>}{usageComponents && usageComponents.length > 0 && <div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>Usage reported separately</span></div><div className="ck-component-list">{usageComponents.map((component) => { const amount = component.amount == null ? "Unpriced" : component.currency && component.currency !== "USD" ? formatCurrencyAmount(component.amount, component.currency) : formatReportedAmount(component.amount, currency, fx); return <div className="ck-component-row" key={component.id}><span><ProviderLabel provider={component.provider} size={13} /> · {component.model || "Model not recorded"}</span><span>{component.unit_value == null ? "Usage not reported" : `${Number(component.unit_value).toLocaleString()} ${component.unit_kind || component.unit || "units"}`} · {amount}</span></div>; })}</div></div>}</div>;
}

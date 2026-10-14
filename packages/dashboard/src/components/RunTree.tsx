import { ChevronDown, ChevronRight } from "lucide-react";
import { attributeRows, valueText } from "./spanAttributes";
import type { TraceEvent } from "../api";
import { formatDuration } from "../utils";
import { formatDateTime, formatReportedAmount, providerName, type ReportingFx } from "./consoleFormatters";
import { Panel, StatusPill } from "./ConsolePrimitives";
import { SPAN_KIND_LABEL, spanTitle, type RunTreeNode, type RunTreeSpanNode } from "./runTreeModel";
import { ProviderLogo, providerId } from "./ProviderLogo";
import { billedUnitsText, callUsage, callUsageLine } from "./tokenUsage";
import { callCostText, callFailure } from "./callOutcome";

const BAR_TONE: Record<string, string> = {
  agent: "var(--ck-ink)",
  step: "var(--ck-chart, #476d9c)",
  tool: "#d9a43c",
  judge: "#8f7cc0",
};

/** Brand-ish bar colours, so each provider reads at a glance on the timeline. */
const PROVIDER_TONE: Record<string, string> = {
  openai: "#10a37f", anthropic: "#c4704f", google: "#4285f4", vertex: "#4285f4", azure: "#0078d4", bedrock: "#e7962a",
  mistral: "#f2a73b", deepseek: "#4d6bfe", groq: "#f55036", xai: "#2b2b2b", together: "#0f6fff", fireworks: "#6720ff",
  openrouter: "#6467f2", cohere: "#39594d", perplexity: "#20808d", cerebras: "#f15a29", deepgram: "#1d8a5b",
  elevenlabs: "#2b2b2b", assemblyai: "#2545d3", cartesia: "#7a5fb0", tavily: "#6c5ce7", exa: "#1f40ed",
  firecrawl: "#f97316", voyage: "#5b4bdb", jina: "#d1316f", huggingface: "#f5b625", nvidia: "#76b900",
};

function providerTone(provider: string | null | undefined): string {
  return PROVIDER_TONE[providerId(provider)] ?? "var(--ck-chart, #476d9c)";
}

/** What a call used, in the units it is billed in. */
export function usageText(event: TraceEvent): string {
  // Tokens: input with cache, output with reasoning, and the cache hit rate when reported.
  const tokens = callUsageLine(callUsage(event));
  if (tokens) return tokens;
  const units = billedUnitsText(event.native_units);
  if (units) return units;
  if (event.total_tokens) return `${Math.round(event.total_tokens).toLocaleString()} tokens`;
  return "";
}

/** The run as a waterfall: agents, steps and tools, with every call on a shared time axis. */
export function RunTree({
  rows,
  events,
  collapsed,
  onToggle,
  selectedId,
  onSelectRoot,
  onSelectCall,
  onSelectSpan,
  runName,
  runCost,
  runDurationMs,
  callCount,
  runStartMs,
  runSpanMs,
  callName,
  currency,
  fx,
  showSplit = true,
}: {
  rows: RunTreeNode[];
  events: TraceEvent[];
  collapsed: ReadonlySet<string>;
  onToggle: (spanId: string) => void;
  selectedId: string | null;
  onSelectRoot: () => void;
  onSelectCall: (eventId: string) => void;
  onSelectSpan: (spanId: string) => void;
  runName: string;
  runCost: number | null;
  runDurationMs: number;
  callCount: number;
  runStartMs: number;
  runSpanMs: number;
  callName: (event: TraceEvent) => string;
  currency: string;
  fx?: ReportingFx | null;
  /** The run page's timeline already shows the provider split. */
  showSplit?: boolean;
}) {
  const money = (value: number | null) => value == null ? "Unpriced" : formatReportedAmount(value, currency, fx);
  const bar = (startMs: number, endMs: number, color: string) => {
    const offset = Number.isFinite(startMs) && Number.isFinite(runStartMs) && runSpanMs > 0
      ? Math.max(0, Math.min(99, (startMs - runStartMs) / runSpanMs * 100))
      : 0;
    const width = Number.isFinite(endMs) && Number.isFinite(startMs) && runSpanMs > 0
      ? Math.max(0.8, Math.min(100 - offset, (endMs - startMs) / runSpanMs * 100))
      : 0.8;
    return <span className="ck-wf-lane"><span style={{ left: `${offset}%`, width: `${width}%`, background: color }} /></span>;
  };
  const providers = new Set(events.map((event) => providerId(event.provider)).filter(Boolean));
  return (
    <div className="ck-wf" role="tree" aria-label="Run timeline">
      {runSpanMs > 1 && (
        <div className="ck-wf-row ck-wf-axis" aria-hidden="true">
          <span />
          <span className="ck-wf-ticks">{[0, 0.5, 1].map((at) => <i key={at} style={{ left: `${at * 100}%` }}>{at === 0 ? "0 s" : formatDuration(runSpanMs * at)}</i>)}</span>
          <span /><span />
        </div>
      )}
      <button className={`ck-wf-row ck-wf-root ${selectedId === "__root__" ? "selected" : ""}`} type="button" role="treeitem" onClick={onSelectRoot}>
        <span className="ck-wf-name">
          <span className="ck-wf-title">{runName}</span>
          <span className="ck-wf-sub">Whole run · {callCount} call{callCount === 1 ? "" : "s"}{providers.size > 1 ? ` · ${providers.size} providers` : ""}</span>
        </span>
        {bar(runStartMs, runStartMs + runSpanMs, "var(--ck-ink)")}
        <span className="ck-wf-time">{formatDuration(runDurationMs)}</span>
        <span className="ck-wf-cost">{money(runCost)}</span>
      </button>
      {rows.map((node) => { if (node.type === "span") return <SpanRow key={node.id} node={node} open={!collapsed.has(node.id)} selected={selectedId === `span:${node.id}`} onToggle={onToggle} onSelect={onSelectSpan} money={money} bar={bar} />;
        const failure = callFailure(node.event);
        return (
          <button key={node.id} className={`ck-wf-row ${selectedId === node.id ? "selected" : ""} ${failure ? "is-failed" : ""}`} type="button" role="treeitem" aria-level={node.depth + 2} onClick={() => onSelectCall(node.id)}>
            <span className="ck-wf-name" style={{ paddingLeft: indent(node.depth, true) }}>
              <span className="ck-wf-tile" title={providerName(node.event.provider || "")}><ProviderLogo provider={node.event.provider} size={15} /></span>
              <span className="ck-wf-text">
                <span className="ck-wf-title"><span className="ck-wf-mono ck-wf-name-text">{callName(node.event)}</span>{node.event.parent_event_id && <em className="ck-wf-tag">Retry</em>}</span>
                <span className="ck-wf-sub">{failure && <><StatusPill tone="critical">{failure.label}</StatusPill> {failure.reason && <span className="ck-tone-critical-text">{failure.reason}</span>}{failure.reason ? " · " : null}</>}{[callName(node.event) === node.event.model ? null : node.event.model || "Model not recorded", usageText(node.event) || null].filter(Boolean).join(" · ") || node.event.model}</span>
              </span>
            </span>
            {bar(node.startMs, node.endMs, failure ? "var(--ck-critical, #a33d32)" : providerTone(node.event.provider))}
            <span className="ck-wf-time">{formatDuration(Number(node.event.duration_ms) || 0)}</span>
            <span className={`ck-wf-cost ${node.event.cost_usd == null && failure ? "is-muted" : ""}`}>{callCostText(node.event, (value) => formatReportedAmount(value, currency, fx))}</span>
          </button>
        ); })}
      {showSplit && <ProviderSplit events={events} />}
    </div>
  );
}

/** Where the run's money went, by provider. */
function ProviderSplit({ events }: { events: TraceEvent[] }) {
  const totals = new Map<string, number>();
  for (const event of events) {
    const cost = Number(event.cost_usd);
    if (event.cost_usd == null || !Number.isFinite(cost) || cost <= 0) continue;
    const id = providerId(event.provider) || "unknown";
    totals.set(id, (totals.get(id) ?? 0) + cost);
  }
  const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
  if (totals.size < 2 || total <= 0) return null;
  const parts = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const share = (value: number) => { const pct = value / total * 100; return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`; };
  return (
    <div className="ck-wf-split" aria-label="Cost by provider">
      <div className="ck-wf-split-bar">{parts.map(([id, value]) => <span key={id} style={{ width: `${value / total * 100}%`, background: providerTone(id) }} title={`${providerName(id)} ${share(value)}`} />)}</div>
      <div className="ck-wf-split-legend">{parts.map(([id, value]) => <span key={id}><i style={{ background: providerTone(id) }} />{providerName(id)} {share(value)}</span>)}</div>
    </div>
  );
}

function indent(depth: number, leaf = false): number {
  return depth * 16 + (leaf ? 22 : 0);
}

function SpanRow({ node, open, selected, onToggle, onSelect, money, bar }: {
  node: RunTreeSpanNode;
  open: boolean;
  selected: boolean;
  onToggle: (spanId: string) => void;
  onSelect: (spanId: string) => void;
  money: (value: number | null) => string;
  bar: (startMs: number, endMs: number, color: string) => React.ReactNode;
}) {
  const span = node.span;
  const hasChildren = node.children.length > 0;
  const duration = Number.isFinite(node.endMs) && Number.isFinite(node.startMs) ? node.endMs - node.startMs : null;
  return (
    <div className={`ck-wf-row ck-wf-span ${selected ? "selected" : ""} ${span.status === "error" ? "is-error" : ""}`} role="treeitem" aria-level={node.depth + 2} aria-expanded={hasChildren ? open : undefined} onClick={() => onSelect(node.id)}>
      <span className="ck-wf-name" style={{ paddingLeft: indent(node.depth) }}>
        {hasChildren
          ? <button className="ck-span-toggle" type="button" onClick={(event) => { event.stopPropagation(); onToggle(node.id); }} aria-label={open ? `Collapse ${spanTitle(span)}` : `Expand ${spanTitle(span)}`}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
          : <span className="ck-span-toggle" aria-hidden="true" />}
        <button className="ck-wf-text ck-span-select" type="button" onClick={(event) => { event.stopPropagation(); onSelect(node.id); }}>
          <span className="ck-wf-title"><span className={`ck-span-kind kind-${span.kind}`}>{SPAN_KIND_LABEL[span.kind] ?? "Span"}</span>{spanTitle(span)}</span>
          <span className="ck-wf-sub">
            {node.calls > 0 ? `${node.calls} call${node.calls === 1 ? "" : "s"}` : "No model calls"}
            {span.status === "running" && " · Running"}
            {span.status === "error" && <span className="ck-tone-critical-text"> · Failed{span.error_type ? `: ${span.error_type}` : ""}</span>}
          </span>
        </button>
      </span>
      {bar(node.startMs, node.endMs, span.status === "error" ? "var(--ck-critical, #a33d32)" : BAR_TONE[span.kind] ?? "var(--ck-slate)")}
      <span className="ck-wf-time">{duration == null ? "—" : formatDuration(duration)}</span>
      <span className="ck-wf-cost">{node.calls === 0 ? "—" : node.cost === 0 && node.unpriced === 0 && node.failed === node.calls ? "No charge" : money(node.cost)}</span>
    </div>
  );
}

const CONTENT_KEYS = new Set(["input", "output"]);

/** Details for one selected span: what it is, what it cost, how long it took. */
export function SpanInspector({ node, currency, fx }: { node: RunTreeSpanNode; currency: string; fx?: ReportingFx | null }) {
  const span = node.span;
  const attributes = Object.entries(span.attributes ?? {}).filter(([key]) => !CONTENT_KEYS.has(key));
  const content = Object.entries(span.attributes ?? {}).filter(([key]) => CONTENT_KEYS.has(key));
  const duration = Number.isFinite(node.endMs) && Number.isFinite(node.startMs) ? node.endMs - node.startMs : null;
  const tone = span.status === "ok" ? "good" : span.status === "error" ? "critical" : "neutral";
  const statusLabel = span.status === "ok" ? "Succeeded" : span.status === "error" ? "Failed" : span.status === "cancelled" ? "Cancelled" : "Running";
  return (
    <Panel className="ck-inspector">
      <div className="ck-inspector-call">
        <div>
          <div className="ck-inspector-heading">{spanTitle(span)}</div>
          <div className="ck-inspector-subheading">{SPAN_KIND_LABEL[span.kind] ?? "Span"}</div>
        </div>
        <StatusPill tone={tone}>{statusLabel}</StatusPill>
      </div>
      <div className="ck-inspector-body">
        <dl className="ck-definition-list">
          <div><dt>Cost</dt><dd>{node.calls === 0 ? "No model calls" : node.cost == null ? "Unpriced" : formatReportedAmount(node.cost, currency, fx)}{node.unpriced > 0 && node.cost != null ? ` · ${node.unpriced} unpriced` : ""}</dd></div>
          <div><dt>Calls</dt><dd>{node.calls.toLocaleString()}</dd></div>
          <div><dt>Duration</dt><dd>{duration == null ? "—" : formatDuration(duration)}</dd></div>
          <div><dt>Started</dt><dd>{span.started_at ? formatDateTime(span.started_at) : "—"}</dd></div>
          {span.error_type && <div><dt>Error</dt><dd>{span.error_type}</dd></div>}
          {attributeRows(Object.fromEntries(attributes)).map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}
        </dl>
        {content.map(([key, value]) => (
          <div className="ck-inspector-section" key={key}>
            <div className="ck-inspector-section-title"><span>{key === "input" ? "Input" : "Output"}</span></div>
            <pre className="ck-inspector-pre">{valueText(value)}</pre>
          </div>
        ))}
      </div>
    </Panel>
  );
}

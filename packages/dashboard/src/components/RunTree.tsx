import { ChevronDown, ChevronRight } from "lucide-react";
import type { TraceEvent } from "../api";
import { formatDuration } from "../utils";
import { formatDateTime, formatProviders, formatReportedAmount, type ReportingFx } from "./consoleFormatters";
import { Panel, StatusPill } from "./ConsolePrimitives";
import { SPAN_KIND_LABEL, spanTitle, type RunTreeNode, type RunTreeSpanNode } from "./runTreeModel";

const BAR_TONE: Record<string, string> = {
  agent: "var(--ck-ink)",
  step: "var(--ck-chart, #476d9c)",
  tool: "var(--ck-lamp, #f5cc68)",
  judge: "var(--ck-slate)",
};

/** The run as a tree: agents, steps and tools with the calls made inside them. */
export function RunTree({
  rows,
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
}: {
  rows: RunTreeNode[];
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
}) {
  const money = (value: number | null) => value == null ? "Unpriced" : formatReportedAmount(value, currency, fx);
  const bar = (startMs: number, endMs: number, color: string) => {
    const offset = Number.isFinite(startMs) && Number.isFinite(runStartMs) && runSpanMs > 0
      ? Math.max(0, Math.min(97, (startMs - runStartMs) / runSpanMs * 100))
      : 0;
    const width = Number.isFinite(endMs) && Number.isFinite(startMs) && runSpanMs > 0
      ? Math.max(2, Math.min(100 - offset, (endMs - startMs) / runSpanMs * 100))
      : 2;
    return <span className="ck-waterfall"><span style={{ width: `${width}%`, marginLeft: `${offset}%`, background: color }} /></span>;
  };
  return (
    <div className="ck-trace-steps ck-run-tree" role="tree" aria-label="Run timeline">
      <button className={`ck-step ${selectedId === "__root__" ? "selected" : ""}`} type="button" role="treeitem" onClick={onSelectRoot}>
        <span className="ck-step-rail" aria-hidden="true" />
        <span className="ck-step-body">
          <span className="ck-step-name">{runName}</span>
          <span className="ck-step-meta"><span>Whole run · {callCount} call{callCount === 1 ? "" : "s"}</span></span>
          {bar(runStartMs, runStartMs + runSpanMs, "var(--ck-ink)")}
        </span>
        <span className="ck-step-cost">{money(runCost)}<small>{formatDuration(runDurationMs)}</small></span>
      </button>
      {rows.map((node) => node.type === "span"
        ? <SpanRow key={node.id} node={node} open={!collapsed.has(node.id)} selected={selectedId === `span:${node.id}`} onToggle={onToggle} onSelect={onSelectSpan} money={money} bar={bar} />
        : (
          <button key={node.id} className={`ck-step ${selectedId === node.id ? "selected" : ""}`} type="button" role="treeitem" aria-level={node.depth + 2} onClick={() => onSelectCall(node.id)} style={{ paddingLeft: indent(node.depth, true) }}>
            <span className="ck-step-rail" aria-hidden="true" />
            <span className="ck-step-body">
              <span className="ck-step-name">{callName(node.event)}</span>
              <span className="ck-step-meta"><span>{formatProviders(node.event.provider)} · {node.event.model || "Model not recorded"}</span>{node.event.parent_event_id && <span>Retry</span>}</span>
              {bar(node.startMs, node.endMs, "var(--ck-blue)")}
            </span>
            <span className="ck-step-cost">{node.event.cost_usd == null ? "Unpriced" : formatReportedAmount(Number(node.event.cost_usd), currency, fx)}<small>{formatDuration(Number(node.event.duration_ms) || 0)}</small></span>
          </button>
        ))}
    </div>
  );
}

function indent(depth: number, leaf = false): number {
  return 18 + depth * 18 + (leaf ? 20 : 0);
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
    <div className={`ck-step ck-span-row ${selected ? "selected" : ""} ${span.status === "error" ? "is-error" : ""}`} role="treeitem" aria-level={node.depth + 2} aria-expanded={hasChildren ? open : undefined} style={{ paddingLeft: indent(node.depth) }}>
      {hasChildren
        ? <button className="ck-span-toggle" type="button" onClick={() => onToggle(node.id)} aria-label={open ? `Collapse ${spanTitle(span)}` : `Expand ${spanTitle(span)}`}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        : <span className="ck-span-toggle" aria-hidden="true" />}
      <button className="ck-span-select" type="button" onClick={() => onSelect(node.id)}>
        <span className="ck-step-body">
          <span className="ck-step-name"><span className={`ck-span-kind kind-${span.kind}`}>{SPAN_KIND_LABEL[span.kind] ?? "Span"}</span>{spanTitle(span)}</span>
          <span className="ck-step-meta">
            {node.calls > 0 && <span>{node.calls} call{node.calls === 1 ? "" : "s"}</span>}
            {span.status === "running" && <span>Running</span>}
            {span.status === "error" && <span className="ck-tone-critical-text">Failed{span.error_type ? ` · ${span.error_type}` : ""}</span>}
          </span>
          {bar(node.startMs, node.endMs, BAR_TONE[span.kind] ?? "var(--ck-slate)")}
        </span>
        <span className="ck-step-cost">{node.calls === 0 ? "—" : money(node.cost)}<small>{duration == null ? "—" : formatDuration(duration)}</small></span>
      </button>
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
  const statusLabel = span.status === "ok" ? "Completed" : span.status === "error" ? "Failed" : span.status === "cancelled" ? "Cancelled" : "Running";
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
          {attributes.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value ?? "—")}</dd></div>)}
        </dl>
        {content.map(([key, value]) => (
          <div className="ck-inspector-section" key={key}>
            <div className="ck-inspector-section-title"><span>{key === "input" ? "Input" : "Output"}</span></div>
            <pre className="ck-inspector-pre">{String(value)}</pre>
          </div>
        ))}
      </div>
    </Panel>
  );
}

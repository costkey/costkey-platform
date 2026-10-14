import { useMemo, useState } from "react";
import type { TraceEvent, TraceSpan } from "../api";
import { formatDuration } from "../utils";
import { formatReportedAmount, providerName, type ReportingFx } from "./consoleFormatters";
import { ProviderLogo } from "./ProviderLogo";
import { axisTicks, barGeometry, buildTimeline, providerColor, providerShares, shortRunId, TIMELINE_PREVIEW } from "./runTimelineModel";
import "./RunTimeline.css";

function providerLabel(id: string): string {
  return id ? providerName(id) : "Unknown provider";
}

function durationText(ms: number): string {
  return ms > 0 ? formatDuration(ms) : "0 ms";
}

/**
 * The run on one time axis, one row per model call in start order: who served
 * it, what it used, when it ran and what it cost, then each provider's share.
 */
export function RunTimeline({ traceId, runName, events, spans, runCost, unpriced, runDurationMs, selectedId, onSelectCall, currency, fx }: {
  traceId: string;
  runName: string;
  events: TraceEvent[];
  spans: TraceSpan[];
  runCost: number | null;
  unpriced: number;
  runDurationMs: number;
  selectedId: string | null;
  onSelectCall: (eventId: string) => void;
  currency: string;
  fx?: ReportingFx | null;
}) {
  const timeline = useMemo(() => buildTimeline(events, spans), [events, spans]);
  const ticks = useMemo(() => axisTicks(timeline.spanMs), [timeline.spanMs]);
  const shares = useMemo(() => providerShares(timeline.calls), [timeline.calls]);
  const [showAll, setShowAll] = useState(false);
  if (timeline.calls.length === 0) return null;

  const money = (value: number) => formatReportedAmount(value, currency, fx);
  const shown = showAll ? timeline.calls : timeline.calls.slice(0, TIMELINE_PREVIEW);
  const callCount = timeline.calls.length;
  const providerCount = timeline.providers.length;
  const meta = [
    `Run ${shortRunId(traceId)}`,
    `${callCount.toLocaleString()} call${callCount === 1 ? "" : "s"}`,
    `${providerCount} provider${providerCount === 1 ? "" : "s"}`,
    unpriced > 0 ? `${unpriced} unpriced` : null,
  ].filter(Boolean).join(" · ");

  return <section className="ck-tl" aria-label="Run timeline">
    <div className="ck-tl-head">
      <div className="ck-tl-run">
        <h2 className="ck-tl-name">{runName}</h2>
        <div className="ck-tl-meta" title={traceId}>{meta}</div>
      </div>
      <div className="ck-tl-total">
        <small>Whole run</small>
        <b>{runCost == null ? "Unpriced" : money(runCost)}</b>
        {Number.isFinite(runDurationMs) && runDurationMs > 0 && <small>{formatDuration(runDurationMs)}</small>}
      </div>
    </div>
    {ticks.length > 0 && <div className="ck-tl-axis" aria-hidden="true">
      <span /><span />
      <span className="ck-tl-ticks">{ticks.map((tick) => <i key={tick.at} className={tick.at > 90 ? "is-end" : undefined} style={{ left: `${tick.at}%` }}>{tick.label}</i>)}</span>
      <span /><span />
    </div>}
    <ol className="ck-tl-body">
      {shown.map((call) => {
        const { left, width } = barGeometry(call.startMs, call.durationMs, timeline.startMs, timeline.spanMs);
        const color = call.failure ? "var(--ck-critical, #a33d32)" : providerColor(call.provider);
        const offset = Number.isFinite(call.startMs) ? call.startMs - timeline.startMs : 0;
        const selected = selectedId === call.id;
        return <li key={call.id}>
          <button className={`ck-tl-row${selected ? " is-selected" : ""}${call.failure ? " is-failed" : ""}`} type="button" aria-pressed={selected} onClick={() => onSelectCall(call.id)}>
            <span className="ck-tl-prov" title={providerLabel(call.provider)}>
              <span className="ck-tl-logo"><ProviderLogo provider={call.provider} size={14} /></span>
              <span className="ck-tl-prov-name">{providerLabel(call.provider)}</span>
            </span>
            <span className="ck-tl-call">
              <span className="ck-tl-fn">{call.name}</span>
              <small>{call.failure && <em className="ck-tl-failed">{call.failure.label}{call.failure.reason ? `: ${call.failure.reason}` : ""}</em>}{call.detail}</small>
            </span>
            <span className="ck-tl-lane" title={`Started ${durationText(offset)} into the run`}>
              <b style={{ left: `min(${left}%, calc(100% - 4px))`, width: `${width}%`, background: color }} />
            </span>
            <span className="ck-tl-time">{durationText(call.durationMs)}</span>
            <span className={`ck-tl-cost${call.cost == null ? " is-muted" : ""}`}>{call.cost != null ? money(call.cost) : call.failure ? "No charge" : "Unpriced"}</span>
          </button>
        </li>;
      })}
    </ol>
    {callCount > TIMELINE_PREVIEW && <button className="ck-button ck-button-quiet ck-tl-more" type="button" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
      {showAll ? `Show the first ${TIMELINE_PREVIEW} calls` : `Show all ${callCount.toLocaleString()} calls`}
    </button>}
    {shares.length > 0 && <div className="ck-tl-split" aria-label="Cost by provider">
      <div className="ck-tl-bar">{shares.map((share) => <b key={share.provider} style={{ width: `${share.share}%`, background: providerColor(share.provider) }} title={`${providerLabel(share.provider)} ${share.label}`} />)}</div>
      <div className="ck-tl-legend">{shares.map((share) => <span key={share.provider}><i style={{ background: providerColor(share.provider) }} />{providerLabel(share.provider)} {share.label}</span>)}</div>
    </div>}
  </section>;
}

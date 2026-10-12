import { useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { BoardBucketUnit, OverviewBoard, OverviewBoardUsage } from "../api";
import { formatDuration } from "../utils";
import { ProviderLogo } from "./ProviderLogo";
import { providerName } from "./consoleFormatters";
import { Link } from "react-router-dom";
import { checkHref, modelHref, ownerHref, toolHref } from "./links";
import { billedUnitsText, callUsage, formatHitRate, sumUnits } from "./tokenUsage";
import { alignSeries, bucketLabel, compactNumber, formatScore, kpiDelta, niceCeiling, signedPercent, tickIndexes } from "./overviewBoardModel";

/** Validated categorical order for series on the light raised surface. */
const SERIES = ["#3a6db0", "#b8741a", "#16907c", "#9c4fa8"];

type Kind = "agents" | "workflows" | "tools";
const KINDS: Array<{ value: Kind; label: string }> = [{ value: "agents", label: "Agents" }, { value: "workflows", label: "Workflows" }, { value: "tools", label: "Tools" }];

export function Pills<T extends string>({ options, value, onChange, label }: { options: Array<{ value: T; label: string }>; value: T; onChange: (value: T) => void; label: string }) {
  return (
    <div className="ck-board-pills" role="group" aria-label={label}>
      {options.map((option) => <button key={option.value} type="button" className={option.value === value ? "active" : ""} aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}
    </div>
  );
}

function BoardPanel({ title, subtitle, total, totalLabel, controls, children, className = "" }: { title: string; subtitle: string; total?: ReactNode; totalLabel?: string; controls?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`ck-panel ck-board-panel ${className}`}>
      <header className="ck-board-head">
        <div className="min-w-0">
          <h2 className="ck-board-title">{title}</h2>
          <p className="ck-board-sub">{subtitle}</p>
        </div>
        {total != null && <div className="ck-board-total"><strong>{total}</strong>{totalLabel && <span>{totalLabel}</span>}</div>}
      </header>
      {controls && <div className="ck-board-controls">{controls}</div>}
      <div className="ck-board-body">{children}</div>
    </section>
  );
}

function BoardEmpty({ children }: { children: ReactNode }) {
  return <p className="ck-board-empty">{children}</p>;
}

/* ── KPI cards ─────────────────────────────────────────────────────── */

export function KpiCard({ label, value, current, previous, previousLabel, higherIsBetter, loading, fact, note, to }: { /** Where the card leads: the list behind the number. */ to?: string; label: string; value: string; current: number | null; previous: number | null; previousLabel: string; higherIsBetter: boolean; loading?: boolean; /** Shown when there's nothing earlier to compare with. */ fact?: ReactNode; /** A second line under the value, e.g. other billed units. */ note?: ReactNode }) {
  const delta = kpiDelta(current, previous, higherIsBetter);
  const card = (
    <article className="ck-metric-card ck-board-kpi">
      <div className="ck-board-kpi-label">{label}</div>
      {loading ? <div className="ck-skeleton ck-skeleton-metric" /> : <div className="ck-board-kpi-value">{value}</div>}
      {!loading && note && <div className="ck-board-kpi-note">{note}</div>}
      {!loading && (delta.kind !== "none" || fact) && (
        <div className="ck-board-delta">
          {delta.kind === "none" ? <span>{fact}</span>
            : delta.kind === "same" ? <span>Same as previous {previousLabel}</span>
              : <>
                <span className={delta.good ? "ck-board-delta-good" : "ck-board-delta-bad"}>
                  <span aria-hidden="true">{delta.rising ? "▲" : "▼"}</span> {signedPercent(delta.percent)}
                </span>
                <span> vs previous {previousLabel}</span>
              </>}
        </div>
      )}
    </article>
  );
  // The card leads to the list behind its number.
  return to ? <Link className="ck-metric-link" to={to} aria-label={`${label}: ${value}. Open the details`}>{card}</Link> : card;
}

/* ── Cost by model ─────────────────────────────────────────────────── */

const MODEL_ROWS = 7;

export function CostByModel({ board, totalCost, money }: { board: OverviewBoard | null; totalCost: string; money: (value: number | null | undefined) => string }) {
  // Every model with calls counts, whatever it bills, so the costs add up to the total. Rows come sorted by cost.
  const all = board?.models ?? [];
  const rows = all.length > MODEL_ROWS + 1 ? all.slice(0, MODEL_ROWS) : all;
  const rest = all.slice(rows.length);
  const restCost = rest.some((row) => row.cost != null) ? rest.reduce((sum, row) => sum + (row.cost ?? 0), 0) : null;
  return (
    <BoardPanel title="Cost by model" subtitle="Spend and usage by model" total={totalCost} totalLabel="Total cost">
      {all.length === 0 ? <BoardEmpty>No model calls in this period.</BoardEmpty> : (
        <div className="ck-board-table-wrap">
          <table className="ck-board-table">
            <thead>
              <tr><th>Model</th><th className="numeric">Usage</th><th className="numeric" title="Share of input tokens read from cache">Cache hit</th><th className="numeric">Cost</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const usage = callUsage({ provider: row.provider ?? "", model: row.model, input_tokens: row.input, output_tokens: row.output, cache_read_tokens: row.cacheRead, cache_creation_tokens: row.cacheWrite });
                const tokens = (row.input ?? 0) > 0 || (row.output ?? 0) > 0;
                return (
                  <tr key={`${row.provider}:${row.model}`} className="ck-row-link">
                    <td className="ck-board-model-cell"><Link className="ck-board-link ck-stretch-link ck-board-model" to={modelHref(row.provider, row.model)}><ProviderLogo provider={row.provider} size={14} /><span title={`${providerName(row.provider ?? "")} · ${row.model}`}>{row.model}</span></Link></td>
                    <td className="numeric" title={tokens ? `${compactNumber(usage.inputTokens)} in, ${compactNumber(usage.outputTokens)} out` : undefined}>{tokens ? `${compactNumber((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))} tokens` : <span className="ck-board-units">{billedUnitsText(row.units) || "No usage reported"}</span>}</td>
                    <td className="numeric">{formatHitRate(usage.cacheHitRate)}</td>
                    <td className="numeric ck-board-cost">{row.cost == null ? (row.unpriced > 0 ? "Unpriced" : "—") : money(row.cost)}</td>
                  </tr>
                );
              })}
              {rest.length > 0 && <tr className="ck-board-other">
                <td>{rest.length} other model{rest.length === 1 ? "" : "s"}</td>
                <td className="numeric">{rest.reduce((sum, row) => sum + row.calls, 0).toLocaleString("en-US")} calls</td>
                <td className="numeric" />
                <td className="numeric ck-board-cost">{money(restCost)}</td>
              </tr>}
            </tbody>
          </table>
        </div>
      )}
    </BoardPanel>
  );
}

/* ── Usage by agent or workflow ────────────────────────────────────── */

type UsageKind = "agents" | "workflows";

export function UsageByAgent({ board, money }: { board: OverviewBoard | null; money: (value: number | null | undefined) => string }) {
  const [mode, setMode] = useState<"usage" | "cost">("usage");
  const [picked, setKind] = useState<UsageKind | null>(null);
  const kind: UsageKind = picked ?? ((board?.agents.length ?? 0) === 0 && (board?.workflows?.length ?? 0) > 0 ? "workflows" : "agents");
  const owners = (kind === "agents" ? board?.agents : board?.workflows) ?? [];
  const tokensOf = (owner: OverviewBoardUsage) => owner.input + owner.output;
  const value = (owner: OverviewBoardUsage) => mode === "usage" ? tokensOf(owner) : owner.cost ?? 0;
  const rows = [...owners].sort((a, b) => value(b) - value(a) || (b.cost ?? 0) - (a.cost ?? 0)).slice(0, 6);
  const max = Math.max(...rows.map(value), 0);
  const total = owners.reduce((sum, owner) => sum + value(owner), 0);
  const otherUnits = billedUnitsText(sumUnits(owners.map((owner) => owner.units)));
  const totalText = owners.length === 0 ? undefined : mode === "cost" ? money(total) : total > 0 ? compactNumber(total) : otherUnits || "0";
  return (
    <BoardPanel
      title={kind === "agents" ? "Usage by agent" : "Usage by workflow"}
      subtitle={kind === "agents" ? "Grouped by agent" : "Grouped by workflow"}
      total={totalText}
      totalLabel={mode === "cost" ? "Total cost" : total > 0 ? (otherUnits ? `Tokens, + ${otherUnits}` : "Total tokens") : "Billed usage"}
      controls={<div className="ck-board-control-row"><Pills label="Measure" value={mode} onChange={setMode} options={[{ value: "usage", label: "Usage" }, { value: "cost", label: "Cost" }]} /><Pills label="Group" value={kind} onChange={setKind} options={[{ value: "agents", label: "Agents" }, { value: "workflows", label: "Workflows" }]} /></div>}
    >
      {rows.length === 0 ? <BoardEmpty>{kind === "agents" ? "No agent runs in this period." : "No workflow runs in this period."}</BoardEmpty> : <>
        <ul className="ck-board-bars">
          {rows.map((owner) => {
            const amount = value(owner);
            const width = max > 0 ? amount / max * 100 : 0;
            const tokens = tokensOf(owner);
            const units = billedUnitsText(owner.units);
            const shown = mode === "cost" ? money(owner.cost) : tokens > 0 ? compactNumber(tokens) : units || "0";
            return (
              <li key={owner.name}><Link className="ck-board-link" to={ownerHref(kind, owner.name)}>
                <div className="ck-board-bar-line"><span className="ck-board-bar-name" title={owner.name}>{owner.name}</span><span className="ck-board-bar-value">{shown}{mode === "usage" && tokens > 0 && units && <small>+ {units}</small>}</span></div>
                <div className="ck-board-track" title={mode === "usage" && tokens > 0 ? `${compactNumber(owner.input)} input, ${compactNumber(owner.output)} output` : undefined}>
                  {mode === "usage" && tokens > 0
                    ? <span className="ck-board-fill-split" style={{ width: `${width}%` }}><i className="input" style={{ flexGrow: owner.input }} /><i className="output" style={{ flexGrow: owner.output }} /></span>
                    : <span className="ck-board-fill" style={{ width: `${width}%` }} />}
                </div>
              </Link></li>
            );
          })}
        </ul>
        {mode === "usage"
          ? <div className="ck-board-legend"><span><i className="swatch input" />Input tokens</span><span><i className="swatch output" />Output tokens</span>{otherUnits && <span>Bars show tokens; other units are listed.</span>}</div>
          : <div className="ck-board-legend"><span>Cost is not split by input and output.</span></div>}
      </>}
    </BoardPanel>
  );
}

/* ── Line chart ────────────────────────────────────────────────────── */

/** The element's width, kept current. A callback ref, so it also measures an element that
 * mounts after the first render (a chart that replaces its loading state). */
export function useWidth<T extends HTMLElement>(fallback = 520): [(element: T | null) => void, number] {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!element) return;
    const measured = Math.round(element.getBoundingClientRect().width);
    if (measured > 0) setWidth(measured);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}

interface ChartSeries { key: string; label: string; color: string; values: Array<number | null> }

export function LineChart({ buckets, unit, series, format, yMax, label }: { buckets: string[]; unit: BoardBucketUnit; series: ChartSeries[]; format: (value: number) => string; yMax?: number; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 190;
  const left = 46;
  const right = 12;
  const top = 10;
  const bottom = 26;
  const peak = Math.max(0, ...series.flatMap((item) => item.values.filter((value): value is number => value != null)));
  const max = yMax ?? niceCeiling(peak * 1.1);
  const x = (index: number) => left + (width - left - right) * (buckets.length <= 1 ? 0.5 : index / (buckets.length - 1));
  const y = (value: number) => top + (height - top - bottom) * (1 - value / max);
  const ticks = [0, max / 2, max];
  const xTicks = tickIndexes(buckets.length, width < 420 ? 3 : 5);
  const multiDay = unit === "hour" && buckets.length > 0 && buckets[0].slice(0, 10) !== buckets[buckets.length - 1].slice(0, 10);
  const paths = series.map((item) => {
    let d = "";
    const dots: number[] = [];
    item.values.forEach((value, index) => {
      if (value == null) return;
      const previous = index > 0 ? item.values[index - 1] : null;
      const next = index < item.values.length - 1 ? item.values[index + 1] : null;
      d += `${previous == null ? "M" : "L"}${x(index).toFixed(1)} ${y(value).toFixed(1)} `;
      if (previous == null && next == null) dots.push(index);
    });
    return { ...item, d, dots };
  });
  const onMove = (event: ReactMouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    if (buckets.length === 0) return;
    const index = Math.round((px - left) / Math.max(1, width - left - right) * (buckets.length - 1));
    setHover(Math.min(buckets.length - 1, Math.max(0, index)));
  };
  const tooltipLeft = hover == null ? 0 : Math.min(Math.max(x(hover), 70), width - 70);
  return (
    <div className="ck-board-chart" ref={ref}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((tick) => <g key={tick}><line className="grid" x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} /><text x={left - 8} y={y(tick) + 4} textAnchor="end">{format(tick)}</text></g>)}
        {xTicks.map((index, position) => <text key={index} x={x(index)} y={height - 6} textAnchor={index === 0 ? "start" : index === buckets.length - 1 ? "end" : "middle"}>{bucketLabel(buckets[index], unit, multiDay && (position === 0 || buckets[index].slice(0, 10) !== buckets[xTicks[position - 1]].slice(0, 10)))}</text>)}
        {hover != null && <line className="cursor" x1={x(hover)} x2={x(hover)} y1={top} y2={height - bottom} />}
        {paths.map((item) => <g key={item.key}>
          <path d={item.d} fill="none" stroke={item.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {item.dots.map((index) => <circle key={index} cx={x(index)} cy={y(item.values[index] ?? 0)} r={3} fill={item.color} />)}
          {hover != null && item.values[hover] != null && <circle cx={x(hover)} cy={y(item.values[hover] ?? 0)} r={4} fill={item.color} stroke="var(--ck-raised)" strokeWidth={2} />}
        </g>)}
      </svg>
      {hover != null && (
        <div className="ck-board-tooltip" style={{ left: tooltipLeft }}>
          <div className="ck-board-tooltip-title">{bucketLabel(buckets[hover], unit, unit === "hour")}</div>
          {series.map((item) => <div key={item.key} className="ck-board-tooltip-row"><i style={{ background: item.color }} />{item.label}<strong>{item.values[hover] == null ? "No data" : format(item.values[hover] ?? 0)}</strong></div>)}
        </div>
      )}
    </div>
  );
}

function SeriesLegend({ series }: { series: Array<{ key: string; label: string; color: string }> }) {
  return <div className="ck-board-legend">{series.map((item) => <span key={item.key}><i className="line" style={{ background: item.color }} />{item.label}</span>)}</div>;
}

/* ── Scores ────────────────────────────────────────────────────────── */

export function ScoresPanel({ board }: { board: OverviewBoard | null }) {
  const [view, setView] = useState<"time" | "summary">("time");
  const checks = board?.scores.checks ?? [];
  const charted = checks.filter((check) => check.unitScale).slice(0, SERIES.length);
  const series = charted.map((check, index) => ({
    key: check.name, label: check.name, color: SERIES[index], values: alignSeries(board?.buckets ?? [], check.series, (point) => point.avg),
  }));
  const avg = board?.scores.current.avg ?? null;
  return (
    <BoardPanel
      title="Scores"
      subtitle="Quality check performance"
      total={checks.length === 0 ? undefined : avg == null ? "—" : `avg ${formatScore(avg)}`}
      totalLabel="Across all checks"
      controls={checks.length > 0 ? <Pills label="Scores view" value={view} onChange={setView} options={[{ value: "time", label: "Over time" }, { value: "summary", label: "Summary" }]} /> : undefined}
    >
      {checks.length === 0 ? <BoardEmpty>No scored runs in this period. Scores from judges and checks show up here.</BoardEmpty>
        : view === "time" ? (charted.length === 0 ? <BoardEmpty>These checks are not scored from 0 to 1. See the summary.</BoardEmpty> : <>
          <LineChart buckets={board?.buckets ?? []} unit={board?.window.bucket ?? "day"} series={series} format={(value) => value.toFixed(2)} yMax={1} label={`Average score over time for ${charted.map((check) => check.name).join(", ")}`} />
          <SeriesLegend series={series} />
        </>) : (
          <ul className="ck-board-summary">
            {checks.map((check) => (
              <li key={check.name}><Link className="ck-board-link" to={checkHref(check.name)}>
                <div className="ck-board-bar-line"><span className="ck-board-bar-name" title={check.name}>{check.name}</span><span className="ck-board-bar-value">{formatScore(check.avg)}</span></div>
                {check.unitScale && <div className="ck-board-track"><span className="ck-board-fill" style={{ width: `${Math.max(0, Math.min(1, check.avg ?? 0)) * 100}%` }} /></div>}
                <div className="ck-board-note">{check.count.toLocaleString()} {check.count === 1 ? "score" : "scores"} on {check.runs.toLocaleString()} {check.runs === 1 ? "run" : "runs"}{check.unitScale ? "" : ", not on a 0 to 1 scale"}</div>
              </Link></li>
            ))}
          </ul>
        )}
    </BoardPanel>
  );
}

/* ── Run volume ────────────────────────────────────────────────────── */

function defaultKind(board: OverviewBoard | null): Kind {
  return board && board.volume.agents.length === 0 && board.volume.workflows.length > 0 ? "workflows" : "agents";
}

export function RunVolume({ board }: { board: OverviewBoard | null }) {
  const [picked, setKind] = useState<Kind | null>(null);
  const kind = picked ?? defaultKind(board);
  const rows = board?.volume[kind] ?? [];
  const tools = kind === "tools";
  const value = (row: { runs: number; calls: number }) => tools ? row.calls : row.runs;
  const shown = rows.slice(0, 7);
  const max = Math.max(0, ...shown.map(value));
  const total = rows.reduce((sum, row) => sum + value(row), 0);
  return (
    <BoardPanel
      title="Run volume"
      subtitle="Runs and call count"
      total={rows.length === 0 ? undefined : total.toLocaleString("en-US")}
      totalLabel={tools ? "Tool calls" : "Total runs"}
      controls={<Pills label="Run type" value={kind} onChange={setKind} options={KINDS} />}
    >
      {rows.length === 0 ? <BoardEmpty>{tools ? "No tool calls in this period." : kind === "agents" ? "No agent runs in this period." : "No workflow runs in this period."}</BoardEmpty> : (
        <ul className="ck-board-bars">
          {shown.map((row) => (
            <li key={row.name}><Link className="ck-board-link" to={tools ? toolHref(row.name) : ownerHref(kind, row.name)}>
              <div className="ck-board-bar-line">
                <span className="ck-board-bar-name" title={row.name}>{row.name}</span>
                <span className="ck-board-bar-value">{tools
                  ? <>{row.calls.toLocaleString("en-US")} {row.calls === 1 ? "call" : "calls"}<small>in {row.runs.toLocaleString("en-US")} {row.runs === 1 ? "run" : "runs"}</small></>
                  : <>{row.runs.toLocaleString("en-US")} {row.runs === 1 ? "run" : "runs"}<small>{row.calls.toLocaleString("en-US")} {row.calls === 1 ? "call" : "calls"}</small></>}</span>
              </div>
              <div className="ck-board-track"><span className="ck-board-fill" style={{ width: `${max > 0 ? value(row) / max * 100 : 0}%` }} /></div>
            </Link></li>
          ))}
        </ul>
      )}
    </BoardPanel>
  );
}

/* ── Latency ───────────────────────────────────────────────────────── */

export function LatencyPanel({ board }: { board: OverviewBoard | null }) {
  const [picked, setKind] = useState<Kind | null>(null);
  const kind = picked ?? defaultKind(board);
  const latency = board?.latency[kind];
  const buckets = board?.buckets ?? [];
  const series = latency ? [
    { key: "p50", label: "p50", color: SERIES[0], values: alignSeries(buckets, latency.series, (point) => point.p50Ms) },
    { key: "p95", label: "p95", color: SERIES[1], values: alignSeries(buckets, latency.series, (point) => point.p95Ms) },
  ] : [];
  const empty = !latency || latency.count === 0;
  return (
    <BoardPanel
      title="Latency"
      subtitle="p50 and p95"
      total={empty ? undefined : formatDuration(latency?.p50Ms ?? 0)}
      totalLabel="p50 for the period"
      controls={<Pills label="Run type" value={kind} onChange={setKind} options={KINDS} />}
    >
      {empty ? <BoardEmpty>{kind === "tools" ? "No timed tool calls in this period." : kind === "agents" ? "No agent runs in this period." : "No workflow runs in this period."}</BoardEmpty> : <>
        <LineChart buckets={buckets} unit={board?.window.bucket ?? "day"} series={series} format={(value) => value === 0 ? "0" : formatDuration(value)} label={`${kind} latency p50 and p95 over time`} />
        <SeriesLegend series={series} />
      </>}
    </BoardPanel>
  );
}

export function BoardSkeleton({ height = 220 }: { height?: number }) {
  return <section className="ck-panel ck-board-panel"><div className="ck-board-body"><div className="ck-skeleton" style={{ height, width: "100%" }} /></div></section>;
}

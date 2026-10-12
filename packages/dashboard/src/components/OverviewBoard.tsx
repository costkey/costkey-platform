import { useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { BoardBucketUnit, OverviewBoard } from "../api";
import { formatDuration } from "../utils";
import { ProviderLogo } from "./ProviderLogo";
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

export function KpiCard({ label, value, current, previous, previousLabel, higherIsBetter, loading }: { label: string; value: string; current: number | null; previous: number | null; previousLabel: string; higherIsBetter: boolean; loading?: boolean }) {
  const delta = kpiDelta(current, previous, higherIsBetter);
  return (
    <article className="ck-metric-card ck-board-kpi">
      <div className="ck-board-kpi-label">{label}</div>
      {loading ? <div className="ck-skeleton ck-skeleton-metric" /> : <div className="ck-board-kpi-value">{value}</div>}
      {!loading && (
        <div className="ck-board-delta">
          {delta.kind === "none" ? <span>No previous value to compare</span>
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
}

/* ── Cost by model ─────────────────────────────────────────────────── */

export function CostByModel({ board, totalCost }: { board: OverviewBoard | null; totalCost: string }) {
  // Calls with no token counts (speech, search) still count in the total cost.
  const rows = (board?.models ?? []).filter((row) => [row.input, row.output, row.cacheRead, row.cacheWrite].some((value) => value != null)).slice(0, 8);
  const hasCache = rows.some((row) => row.cacheRead != null || row.cacheWrite != null);
  return (
    <BoardPanel title="Cost by model" subtitle="Token consumption by model" total={totalCost} totalLabel="Total cost">
      {rows.length === 0 ? <BoardEmpty>No model calls in this period.</BoardEmpty> : (
        <div className="ck-board-table-wrap">
          <table className="ck-board-table">
            <thead>
              <tr>
                <th>Model</th>
                {hasCache ? <><th className="numeric">Input</th><th className="numeric">Output</th><th className="numeric">Cache read</th><th className="numeric">Cache write</th></>
                  : <><th className="numeric">Calls</th><th className="numeric">Input</th><th className="numeric">Output</th></>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.provider}:${row.model}`}>
                  <td className="ck-board-model-cell"><span className="ck-board-model"><ProviderLogo provider={row.provider} size={14} /><span title={row.model}>{row.model}</span></span></td>
                  {hasCache ? <><td className="numeric">{compactNumber(row.input)}</td><td className="numeric">{compactNumber(row.output)}</td><td className="numeric">{compactNumber(row.cacheRead)}</td><td className="numeric">{compactNumber(row.cacheWrite)}</td></>
                    : <><td className="numeric">{compactNumber(row.calls)}</td><td className="numeric">{compactNumber(row.input)}</td><td className="numeric">{compactNumber(row.output)}</td></>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </BoardPanel>
  );
}

/* ── Usage by agent ────────────────────────────────────────────────── */

export function UsageByAgent({ board, money }: { board: OverviewBoard | null; money: (value: number | null | undefined) => string }) {
  const [mode, setMode] = useState<"tokens" | "cost">("tokens");
  const agents = board?.agents ?? [];
  const value = (agent: OverviewBoard["agents"][number]) => mode === "tokens" ? agent.input + agent.output : agent.cost ?? 0;
  const rows = [...agents].sort((a, b) => value(b) - value(a)).slice(0, 6);
  const max = Math.max(...rows.map(value), 0);
  const total = agents.reduce((sum, agent) => sum + value(agent), 0);
  return (
    <BoardPanel
      title="Usage by agent"
      subtitle="Grouped by agent"
      total={agents.length === 0 ? undefined : mode === "tokens" ? compactNumber(total) : money(total)}
      totalLabel={mode === "tokens" ? "Total tokens" : "Total cost"}
      controls={<Pills label="Measure" value={mode} onChange={setMode} options={[{ value: "tokens", label: "Tokens" }, { value: "cost", label: "Cost" }]} />}
    >
      {rows.length === 0 ? <BoardEmpty>No agent runs in this period.</BoardEmpty> : <>
        <ul className="ck-board-bars">
          {rows.map((agent) => {
            const amount = value(agent);
            const width = max > 0 ? amount / max * 100 : 0;
            const tokens = agent.input + agent.output;
            return (
              <li key={agent.name}>
                <div className="ck-board-bar-line"><span className="ck-board-bar-name" title={agent.name}>{agent.name}</span><span className="ck-board-bar-value">{mode === "tokens" ? compactNumber(amount) : money(agent.cost)}</span></div>
                <div className="ck-board-track" title={mode === "tokens" ? `${compactNumber(agent.input)} input, ${compactNumber(agent.output)} output` : undefined}>
                  {mode === "tokens" && tokens > 0
                    ? <span className="ck-board-fill-split" style={{ width: `${width}%` }}><i className="input" style={{ flexGrow: agent.input }} /><i className="output" style={{ flexGrow: agent.output }} /></span>
                    : <span className="ck-board-fill" style={{ width: `${width}%` }} />}
                </div>
              </li>
            );
          })}
        </ul>
        {mode === "tokens"
          ? <div className="ck-board-legend"><span><i className="swatch input" />Input</span><span><i className="swatch output" />Output</span></div>
          : <div className="ck-board-legend"><span>Cost is not split by input and output.</span></div>}
      </>}
    </BoardPanel>
  );
}

/* ── Line chart ────────────────────────────────────────────────────── */

/** The element's width, kept current. A callback ref, so it also measures an element that
 * mounts after the first render (a chart that replaces its loading state). */
function useWidth<T extends HTMLElement>(fallback = 520): [(element: T | null) => void, number] {
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
              <li key={check.name}>
                <div className="ck-board-bar-line"><span className="ck-board-bar-name" title={check.name}>{check.name}</span><span className="ck-board-bar-value">{formatScore(check.avg)}</span></div>
                {check.unitScale && <div className="ck-board-track"><span className="ck-board-fill" style={{ width: `${Math.max(0, Math.min(1, check.avg ?? 0)) * 100}%` }} /></div>}
                <div className="ck-board-note">{check.count.toLocaleString()} {check.count === 1 ? "score" : "scores"} on {check.runs.toLocaleString()} {check.runs === 1 ? "run" : "runs"}{check.unitScale ? "" : ", not on a 0 to 1 scale"}</div>
              </li>
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
            <li key={row.name}>
              <div className="ck-board-bar-line">
                <span className="ck-board-bar-name" title={row.name}>{row.name}</span>
                <span className="ck-board-bar-value">{value(row).toLocaleString("en-US")}<small>{tools ? `in ${row.runs.toLocaleString("en-US")} ${row.runs === 1 ? "run" : "runs"}` : `${row.calls.toLocaleString("en-US")} ${row.calls === 1 ? "call" : "calls"}`}</small></span>
              </div>
              <div className="ck-board-track"><span className="ck-board-fill" style={{ width: `${max > 0 ? value(row) / max * 100 : 0}%` }} /></div>
            </li>
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

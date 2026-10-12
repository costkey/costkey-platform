import { useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Link } from "react-router-dom";
import { getSpendSeries, type SpendPoint } from "../budgetsApi";
import { useAuth } from "../contexts/useAuth";
import { useLiveQuery } from "../hooks/useLiveQuery";
import { StatusPill } from "./ConsolePrimitives";
import { periodDates, type ConsolePeriod } from "./consoleFormatters";
import { Pills, useWidth } from "./OverviewBoard";
import { niceCeiling, tickIndexes } from "./overviewBoardModel";
import { formatBudgetAmount, healthCounts, limitInUsd, periodText, projectMoneyBudget } from "./budgetModel";
import { useProjectBudgets } from "./ScopeBudget";
import { budgetLineValue, chartRange, LONG_RANGE_DAYS, spendKeyLabel } from "./spendSeriesModel";
import "./Budgets.css";

type Bucket = "day" | "month";

function SpendBars({ points, bucket, line, format, axisFormat, label }: { points: SpendPoint[]; bucket: Bucket; line: Array<number | null>; format: (value: number) => string; axisFormat: (value: number) => string; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 200;
  const left = 54;
  const right = 12;
  const top = 10;
  const bottom = 26;
  const peak = Math.max(0, ...points.map((point) => point.cost), ...line.filter((value): value is number => value != null));
  const max = niceCeiling(peak * 1.1);
  const plot = Math.max(1, width - left - right);
  const slot = plot / Math.max(1, points.length);
  const barWidth = Math.max(2, Math.min(36, slot * 0.66));
  const x = (index: number) => left + slot * index + slot / 2;
  const y = (value: number) => top + (height - top - bottom) * (1 - value / max);
  const ticks = [0, max / 2, max];
  const xTicks = tickIndexes(points.length, width < 420 ? 4 : bucket === "month" ? 12 : 7);
  const spansYears = points.length > 0 && points[0].key.slice(0, 4) !== points[points.length - 1].key.slice(0, 4);
  // The budget line steps with each bar, so a month with fewer days shows its own daily share.
  let linePath = "";
  line.forEach((value, index) => {
    if (value == null) return;
    const previous = index > 0 ? line[index - 1] : null;
    linePath += `${previous == null ? "M" : "L"}${(x(index) - slot / 2).toFixed(1)} ${y(value).toFixed(1)} L${(x(index) + slot / 2).toFixed(1)} ${y(value).toFixed(1)} `;
  });
  const onMove = (event: ReactMouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const index = Math.floor((event.clientX - rect.left - left) / slot);
    setHover(index >= 0 && index < points.length ? index : null);
  };
  const tooltipLeft = hover == null ? 0 : Math.min(Math.max(x(hover), 80), width - 80);
  return (
    <div className="ck-board-chart ck-spend-chart" ref={ref}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((tick) => <g key={tick}><line className="grid" x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} /><text x={left - 8} y={y(tick) + 4} textAnchor="end">{axisFormat(tick)}</text></g>)}
        {points.map((point, index) => {
          const over = line[index] != null && point.cost > (line[index] ?? 0);
          const barHeight = Math.max(point.cost > 0 ? 1 : 0, y(0) - y(point.cost));
          return <rect key={point.key} className={`bar ${over ? "is-over" : ""} ${hover === index ? "is-hover" : ""}`} x={x(index) - barWidth / 2} y={y(0) - barHeight} width={barWidth} height={barHeight} rx={Math.min(3, barWidth / 3)} />;
        })}
        {linePath && <path className="budget-line" d={linePath} />}
        {xTicks.map((index) => <text key={index} x={x(index)} y={height - 6} textAnchor={xTicks.length > 1 && index === 0 && slot < 40 ? "start" : xTicks.length > 1 && index === points.length - 1 && slot < 40 ? "end" : "middle"}>{spendKeyLabel(points[index].key, bucket, bucket === "month" && spansYears && (index === 0 || points[index].key.endsWith("-01")))}</text>)}
      </svg>
      {hover != null && points[hover] && (
        <div className="ck-board-tooltip" style={{ left: tooltipLeft }}>
          <div className="ck-board-tooltip-title">{spendKeyLabel(points[hover].key, bucket, true)}</div>
          <div className="ck-board-tooltip-row"><i style={{ background: "var(--ck-chart)" }} />Spend<strong>{format(points[hover].cost)}</strong></div>
          {line[hover] != null && <div className="ck-board-tooltip-row"><i style={{ background: "var(--ck-warn)" }} />Budget<strong>{format(line[hover] ?? 0)}</strong></div>}
          {points[hover].unpriced > 0 && <div className="ck-board-tooltip-row">{points[hover].unpriced.toLocaleString("en-US")} unpriced {points[hover].unpriced === 1 ? "call" : "calls"}</div>}
        </div>
      )}
    </div>
  );
}

function BudgetGlance({ projectId, budgets }: { projectId: string; budgets: ReturnType<typeof useProjectBudgets>["budgets"] }) {
  const counts = healthCounts(budgets);
  const total = budgets.filter((budget) => budget.status !== "archived").length;
  if (total === 0) return <div className="ck-spend-glance"><span className="ck-spend-note">No budgets yet.</span><Link className="ck-text-link" to={`/policy-edit?project=${encodeURIComponent(projectId)}`}>Set a budget</Link></div>;
  return <div className="ck-spend-glance" aria-label="Budgets at a glance">
    {counts.over > 0 && <StatusPill tone="critical">{counts.over} over</StatusPill>}
    {counts.at_risk > 0 && <StatusPill tone="warn">{counts.at_risk} at risk</StatusPill>}
    {counts.on_track > 0 && <StatusPill tone="good">{counts.on_track} on track</StatusPill>}
    <Link className="ck-text-link" to="/budgets">Budgets</Link>
  </div>;
}

/** Spend by day or month for the selected period, against the project's budget. */
export function SpendOverTime({ projectId, period, range, environment, money }: { projectId: string | null; period: ConsolePeriod; range?: { from?: string; to?: string } | null; environment?: string; money: (value: number | null | undefined) => string }) {
  const { workspaceSettings, org } = useAuth();
  const timezone = workspaceSettings?.timezone ?? org?.timezone ?? undefined;
  const selected = (): { from: string; to: string } => {
    const dates = periodDates(period, timezone);
    return { from: range?.from ?? dates.from, to: range?.to ?? dates.to };
  };
  const initial = selected();
  const long = (new Date(initial.to).getTime() - new Date(initial.from).getTime()) / 86_400_000 > LONG_RANGE_DAYS;
  const [picked, setBucket] = useState<Bucket | null>(null);
  const bucket: Bucket = picked ?? (long ? "month" : "day");
  // Dates are worked out on each load so "now" stays current between refreshes.
  const key = projectId ? ["spend", projectId, period, range?.from ?? "", range?.to ?? "", environment ?? "all", bucket, timezone ?? ""].join("|") : null;
  const series = useLiveQuery(key, () => {
    const shown = chartRange(selected(), bucket, timezone);
    return getSpendSeries(projectId!, { ...shown, bucket, environment }).then((result) => ({ ...result, widened: shown.widened }));
  });
  const { budgets } = useProjectBudgets(projectId);
  if (!projectId) return null;
  const points = series.data?.bucket === bucket ? series.data.points : [];
  const budget = projectMoneyBudget(budgets);
  const limit = budget ? limitInUsd(budget) : null;
  const line = points.map((point) => budget && limit != null ? budgetLineValue(point.key, bucket, limit, budget.window) : null);
  const total = points.reduce((sum, point) => sum + point.cost, 0);
  const subtitle = bucket === "month" ? (series.data?.widened ? "By month, last 6 months" : "By month") : "By day";
  const format = (value: number) => money(value);
  // Axis ticks drop trailing zeros: "$20", "$0.5".
  const axisFormat = (value: number) => money(value).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  const lineLabel = budget ? bucket === "month"
    ? `${budget.name || "Project budget"}: ${formatBudgetAmount(budget, budget.allowance)} ${periodText(budget.window).toLowerCase()}`
    : budget.window === "calendar_month" ? `Daily share of the ${formatBudgetAmount(budget, budget.allowance)} monthly budget` : `${budget.name || "Project budget"}: ${formatBudgetAmount(budget, budget.allowance)} daily`
    : null;
  return (
    <section className="ck-panel ck-board-panel ck-spend-panel">
      <header className="ck-board-head">
        <div className="min-w-0">
          <h2 className="ck-board-title">Spend over time</h2>
          <p className="ck-board-sub">{subtitle}</p>
        </div>
        <div className="ck-spend-head-right">
          <BudgetGlance projectId={projectId} budgets={budgets} />
          <Pills label="Group spend by" value={bucket} onChange={setBucket} options={[{ value: "day", label: "Day" }, { value: "month", label: "Month" }]} />
        </div>
      </header>
      <div className="ck-board-body">
        {series.error && !series.data ? <p className="ck-board-empty">Couldn’t load spend over time.</p>
          : series.loading && points.length === 0 ? <div className="ck-skeleton" style={{ height: 200, width: "100%" }} />
            : points.length === 0 || total === 0 ? <p className="ck-board-empty">No priced spend in this period.</p>
              : <>
                <SpendBars points={points} bucket={bucket} line={line} format={format} axisFormat={axisFormat} label={`Spend ${subtitle.toLowerCase()}, ${money(total)} in total${lineLabel ? `, against ${lineLabel}` : ""}`} />
                <div className="ck-board-legend">
                  <span><i className="swatch" style={{ background: "var(--ck-chart)" }} />Spend, {money(total)} total</span>
                  {lineLabel && <span><i className="dash" />{lineLabel}</span>}
                  {lineLabel && line.some((value, index) => value != null && points[index].cost > value) && <span><i className="swatch" style={{ background: "var(--ck-critical)" }} />Over the budget</span>}
                </div>
              </>}
      </div>
    </section>
  );
}

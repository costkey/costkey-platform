import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { getCostBreakdown, getOverview, getOverviewBoard, getReliability, type Overview, type OverviewBoard, type Reliability } from "../api";
import { useAuth } from "../contexts/useAuth";
import { EmptyPanel, LoadingRows, PageHeader, Panel } from "../components/ConsolePrimitives";
import { PrototypeIcon } from "../components/PrototypeIcon";
import { ProviderLogo } from "../components/ProviderLogo";
import { Pills } from "../components/OverviewBoard";
import { compactNumber, formatScore } from "../components/overviewBoardModel";
import { formatReportedAmount } from "../components/consoleFormatters";
import { modelHref } from "../components/links";
import { comparedPeriods, defaultCustomDays, metricChange, pairModels, parsePreset, rangeText, sameLength, type ComparePreset, type CustomDays, type MetricChange, type TimeRange } from "../components/periodCompare";
import { formatDuration } from "../utils";

interface PeriodData {
  overview: Overview | null;
  board: OverviewBoard | null;
  reliability: Reliability | null;
}

const PRESETS: Array<{ value: ComparePreset; label: string }> = [
  { value: "today", label: "Today vs yesterday" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "custom", label: "Custom" },
];

async function loadPeriod(projectId: string, range: TimeRange, environment?: string): Promise<PeriodData> {
  const [overview, board, reliability] = await Promise.allSettled([
    getOverview(projectId, range.from, range.to, environment),
    getOverviewBoard(projectId, { ...range, environment }),
    getReliability(projectId, { ...range, environment }),
  ]);
  if (overview.status === "rejected" && board.status === "rejected" && reliability.status === "rejected") throw reliability.reason;
  return {
    overview: overview.status === "fulfilled" ? overview.value.overview : null,
    board: board.status === "fulfilled" ? board.value : null,
    reliability: reliability.status === "fulfilled" ? reliability.value : null,
  };
}

function num(value: unknown): number | null {
  if (value == null) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function percent(rate: number | null): string {
  return rate == null ? "—" : `${(rate * 100).toFixed(rate > 0 && rate < 0.001 ? 2 : 1)}%`;
}

function ms(value: number | null): string {
  return value == null ? "—" : formatDuration(value);
}

function Change({ change }: { change: MetricChange }) {
  if (!change.text) return <span className="muted">—</span>;
  return <span className={change.tone === "good" ? "ck-board-delta-good" : change.tone === "bad" ? "ck-board-delta-bad" : "ck-board-delta-flat"}>{change.text}</span>;
}

interface MetricRow {
  label: string;
  a: number | null;
  b: number | null;
  format: (value: number | null) => string;
  better: "lower" | "higher" | null;
  rate?: boolean;
  /** A total: only compared when both windows are the same length. */
  total?: boolean;
  /** Under each period's value. */
  notes?: [ReactNode, ReactNode];
}

export default function ComparePeriods() {
  const { currentProjectId, projects, org, workspaceSettings } = useAuth();
  const [params, setParams] = useSearchParams();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  const timezone = workspaceSettings?.timezone ?? org?.timezone ?? null;
  const currency = workspaceSettings?.reportingCurrency ?? "USD";
  const fx = workspaceSettings?.fx;
  const money = (value: number | null | undefined) => formatReportedAmount(value, currency, fx);
  const preset = parsePreset(params.get("preset"));
  const environment = params.get("environment") ?? "all";
  const env = environment !== "all" ? environment : undefined;
  // "Now" moves only when the comparison changes, so a window stays put while it loads.
  const [now, setNow] = useState(() => new Date());
  const defaults = useMemo(() => defaultCustomDays(now, timezone), [now, timezone]);
  const custom: CustomDays = {
    aFrom: params.get("aFrom") ?? defaults.aFrom,
    aTo: params.get("aTo") ?? defaults.aTo,
    bFrom: params.get("bFrom") ?? defaults.bFrom,
    bTo: params.get("bTo") ?? defaults.bTo,
  };
  const customKey = [custom.aFrom, custom.aTo, custom.bFrom, custom.bTo].join(",");
  const periods = useMemo(() => comparedPeriods(preset, now, timezone, custom),
    // custom is rebuilt every render; its key says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preset, now, timezone, customKey]);
  const requestKey = periods ? [projectId, env ?? "", periods.a.from, periods.a.to, periods.b.from, periods.b.to].join("\u0001") : null;
  const [result, setResult] = useState<{ key: string; a: PeriodData; b: PeriodData } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [environments, setEnvironments] = useState<string[]>([]);

  useEffect(() => {
    if (!projectId || !periods || !requestKey) return;
    let cancelled = false;
    Promise.all([loadPeriod(projectId, periods.a, env), loadPeriod(projectId, periods.b, env)])
      .then(([a, b]) => { if (!cancelled) { setResult({ key: requestKey, a, b }); setError(null); } })
      .catch((reason: unknown) => { if (!cancelled) setError({ key: requestKey, message: reason instanceof Error ? reason.message : "Could not load these periods" }); });
    return () => { cancelled = true; };
    // requestKey covers the project, environment and both windows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  useEffect(() => {
    if (!projectId || !periods) return;
    let cancelled = false;
    getCostBreakdown(projectId, { groupBy: "feature", from: periods.a.from, to: periods.b.to, limit: 1 })
      .then((response) => { if (!cancelled) setEnvironments(response.availableFilters?.environments ?? []); })
      .catch(() => undefined);
    return () => { cancelled = true; };
    // Environments only need refreshing when the outer window moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, periods?.a.from, periods?.b.to]);

  const update = (change: (next: URLSearchParams) => void) => {
    setNow(new Date());
    setParams((current) => { const next = new URLSearchParams(current); change(next); return next; });
  };
  const setPreset = (next: ComparePreset) => update((query) => {
    query.set("preset", next);
    if (next !== "custom") for (const key of ["aFrom", "aTo", "bFrom", "bTo"]) query.delete(key);
  });
  const setDay = (key: keyof CustomDays, value: string) => update((query) => {
    for (const [name, current] of Object.entries(custom)) if (!query.get(name)) query.set(name, current);
    query.set(key, value);
  });
  const setEnvironment = (next: string) => update((query) => { if (next === "all") query.delete("environment"); else query.set("environment", next); });

  const environmentOptions = [...new Set(["all", ...environments.filter((value) => value !== "all"), environment])];
  const overviewSearch = new URLSearchParams();
  if (projectId) overviewSearch.set("project", projectId);
  if (env) overviewSearch.set("environment", env);
  const header = <PageHeader
    title="Compare periods"
    actions={<div className="ck-period-badge">
      <Link className="ck-text-link" to={`/overview?${overviewSearch.toString()}`}><ArrowLeft size={13} /> Overview</Link>
      {environmentOptions.length > 1 && <span className="ck-pill-select"><select aria-label="Environment" value={environment} onChange={(event) => setEnvironment(event.target.value)}>{environmentOptions.map((value) => <option key={value} value={value}>{value === "all" ? "All environments" : value}</option>)}</select><PrototypeIcon name="down" size={12} /></span>}
    </div>}
  />;

  const controls = <div className="ck-period-compare-controls">
    <Pills label="Periods" value={preset} onChange={setPreset} options={PRESETS} />
    {preset === "custom" && <div className="ck-period-compare-days">
      <span className="ck-scope-dates"><strong>A</strong><input aria-label="Period A from" type="date" value={custom.aFrom} onChange={(event) => setDay("aFrom", event.target.value)} /><span aria-hidden="true">–</span><input aria-label="Period A to" type="date" value={custom.aTo} onChange={(event) => setDay("aTo", event.target.value)} /></span>
      <span className="ck-scope-dates"><strong>B</strong><input aria-label="Period B from" type="date" value={custom.bFrom} onChange={(event) => setDay("bFrom", event.target.value)} /><span aria-hidden="true">–</span><input aria-label="Period B to" type="date" value={custom.bTo} onChange={(event) => setDay("bTo", event.target.value)} /></span>
    </div>}
  </div>;

  if (!projectId) {
    return <div className="ck-main-inner">{header}<Panel><EmptyPanel illustration="first-light" title="Ready for your first run" body="Connect a project to start." action={<Link className="ck-button ck-button-primary" to="/onboarding">Connect a project</Link>} /></Panel></div>;
  }
  if (!periods) {
    return <div className="ck-main-inner">{header}{controls}<Panel><EmptyPanel title="Pick two periods" body="Each period needs a start day on or before its end day, and can’t start in the future." /></Panel></div>;
  }

  const current = result?.key === requestKey ? result : null;
  const failed = error?.key === requestKey ? error.message : null;
  const a = current?.a;
  const b = current?.b;
  const comparableTotals = sameLength(periods.a, periods.b);
  const runP95 = (data: PeriodData | undefined, kind: "agents" | "workflows") => {
    const latency = data?.board?.latency[kind];
    return latency && latency.count > 0 ? latency.p95Ms : null;
  };
  const tokens = (data: PeriodData | undefined) => {
    const overview = data?.overview;
    if (!overview) return null;
    return (num(overview.total_input_tokens) ?? 0) + (num(overview.total_output_tokens) ?? 0);
  };
  const calls = (data: PeriodData | undefined) => num(data?.overview?.observations ?? data?.overview?.total_calls);
  // A period without calls cost nothing; one with only unpriced calls has no known cost.
  const cost = (data: PeriodData | undefined) => calls(data) === 0 ? 0 : num(data?.overview?.known_cost);
  const unpriced = (data: PeriodData | undefined) => num(data?.overview?.unpriced_count) ?? 0;
  const unpricedNote = (data: PeriodData | undefined) => unpriced(data) > 0 ? <span className="ck-period-compare-note">{unpriced(data).toLocaleString("en-US")} unpriced</span> : null;
  const totals = (data: PeriodData | undefined) => data?.reliability?.totals;
  const streamed = (totals(a)?.streams ?? 0) + (totals(b)?.streams ?? 0) > 0;
  const scored = (a?.board?.scores.current.count ?? 0) + (b?.board?.scores.current.count ?? 0) > 0;

  const sections: Array<{ title: string; rows: MetricRow[] }> = [
    { title: "Latency", rows: [
      { label: "Call p50", a: totals(a)?.p50DurationMs ?? null, b: totals(b)?.p50DurationMs ?? null, format: ms, better: "lower" },
      { label: "Call p95", a: totals(a)?.p95DurationMs ?? null, b: totals(b)?.p95DurationMs ?? null, format: ms, better: "lower" },
      ...(streamed ? [{ label: "Time to first token p95", a: totals(a)?.p95TtftMs ?? null, b: totals(b)?.p95TtftMs ?? null, format: ms, better: "lower" as const }] : []),
      ...(runP95(a, "agents") != null || runP95(b, "agents") != null ? [{ label: "Agent run p95", a: runP95(a, "agents"), b: runP95(b, "agents"), format: ms, better: "lower" as const }] : []),
      ...(runP95(a, "workflows") != null || runP95(b, "workflows") != null ? [{ label: "Workflow run p95", a: runP95(a, "workflows"), b: runP95(b, "workflows"), format: ms, better: "lower" as const }] : []),
    ] },
    { title: "Errors", rows: [
      { label: "Error rate", a: totals(a)?.errorRate ?? null, b: totals(b)?.errorRate ?? null, format: percent, better: "lower", rate: true },
      { label: "Failed calls", a: totals(a)?.errors ?? null, b: totals(b)?.errors ?? null, format: (value) => value == null ? "—" : value.toLocaleString("en-US"), better: "lower", total: true },
      { label: "Retry rate", a: totals(a)?.retryRate ?? null, b: totals(b)?.retryRate ?? null, format: percent, better: "lower", rate: true },
    ] },
    { title: "Volume and cost", rows: [
      { label: "Runs", a: a?.board?.runs.current.runs ?? null, b: b?.board?.runs.current.runs ?? null, format: (value) => value == null ? "—" : value.toLocaleString("en-US"), better: null, total: true },
      { label: "Calls", a: calls(a), b: calls(b), format: (value) => value == null ? "—" : value.toLocaleString("en-US"), better: null, total: true },
      { label: "Model cost", a: cost(a), b: cost(b), format: (value) => value == null ? "—" : money(value), better: "lower", total: true, notes: [unpricedNote(a), unpricedNote(b)] },
      { label: "Tokens", a: tokens(a), b: tokens(b), format: compactNumber, better: null, total: true },
    ] },
    ...(scored ? [{ title: "Quality", rows: [
      { label: "Avg score", a: a?.board?.scores.current.avg ?? null, b: b?.board?.scores.current.avg ?? null, format: (value: number | null) => formatScore(value), better: "higher" as const },
    ] }] : []),
  ];

  const empty = current != null && !calls(a) && !calls(b) && !(a?.board?.runs.current.runs) && !(b?.board?.runs.current.runs);
  const models = pairModels(a?.reliability?.byModel ?? [], b?.reliability?.byModel ?? []);

  return (
    <div className="ck-main-inner ck-period-compare">
      {header}
      {controls}
      {failed && <div className="ck-alert ck-alert-error" role="alert"><AlertCircle size={15} aria-hidden="true" /><div><strong>Couldn’t load these periods.</strong> {failed}</div></div>}
      {empty ? <Panel><EmptyPanel illustration="a-closer-look" title="No calls in either period" body="Pick other periods, or another environment." /></Panel> : <>
      <Panel className="ck-compare-metrics">
        <div className="ck-compare-table">
          <div className="ck-compare-row head">
            <strong></strong>
            <strong>{periods.aLabel}<span className="ck-period-compare-range">{rangeText(periods.a, now, timezone)}</span></strong>
            <strong>{periods.bLabel}<span className="ck-period-compare-range">{rangeText(periods.b, now, timezone)}</span></strong>
            <strong>Change</strong>
          </div>
          {!current && !failed ? <LoadingRows count={6} columns={4} /> : sections.map((section) => <div key={section.title}>
            <div className="ck-compare-row ck-period-compare-section"><span>{section.title}</span></div>
            {section.rows.map((row) => {
              const change = row.total && !comparableTotals ? { text: "", tone: "flat" as const } : metricChange(row.a, row.b, row.better, row.rate, (value) => row.format(value));
              return <div className="ck-compare-row" key={row.label}>
                <span>{row.label}</span>
                <span className="ck-period-compare-value">{row.format(row.a)}{row.notes?.[0]}</span>
                <span className="ck-period-compare-value">{row.format(row.b)}{row.notes?.[1]}</span>
                <span className="ck-period-compare-value"><Change change={change} /></span>
              </div>;
            })}
          </div>)}
        </div>
        {current && !comparableTotals && <p className="ck-table-note">Totals aren’t compared: the periods are different lengths.</p>}
      </Panel>
      <Panel title="By model" subtitle="Call latency and errors per model">
        {!current && !failed ? <LoadingRows count={4} columns={6} /> : models.length === 0 ? <EmptyPanel title="No model calls in either period" body="Runs here made no provider calls." /> : (
          <div className="ck-table-wrap">
            <table className="ck-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="numeric">Calls</th>
                  <th className="numeric">{periods.aLabel} p95</th>
                  <th className="numeric">{periods.bLabel} p95</th>
                  <th className="numeric">Change</th>
                  <th className="numeric hide-mobile">Error rate</th>
                </tr>
              </thead>
              <tbody>
                {models.map((pair) => <tr key={`${pair.provider}:${pair.model}`}>
                  <td><Link className="ck-board-link ck-board-model" to={modelHref(pair.provider, pair.model)}><ProviderLogo provider={pair.provider} size={14} /><span>{pair.model}</span></Link></td>
                  <td className="numeric">{(pair.a?.calls ?? 0).toLocaleString("en-US")} → {(pair.b?.calls ?? 0).toLocaleString("en-US")}</td>
                  <td className="numeric">{ms(pair.a?.p95DurationMs ?? null)}</td>
                  <td className="numeric">{ms(pair.b?.p95DurationMs ?? null)}</td>
                  <td className="numeric"><Change change={metricChange(pair.a?.p95DurationMs, pair.b?.p95DurationMs, "lower")} /></td>
                  <td className="numeric hide-mobile">{percent(pair.a?.errorRate ?? null)} → {percent(pair.b?.errorRate ?? null)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      </>}
    </div>
  );
}

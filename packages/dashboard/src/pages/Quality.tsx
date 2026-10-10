import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { Line, LineChart, YAxis } from "recharts";
import { useAuth } from "../contexts/useAuth";
import { EmptyPanel, LoadingRows, MetricCard, PageHeader, Panel, ScopeToolbar, StatusPill, type Period } from "../components/ConsolePrimitives";
import { dateInputToIso, formatReportedAmount, parsePeriod, periodDates, type ReportingFx } from "../components/consoleFormatters";
import {
  errorTone,
  formatDuration,
  formatRate,
  formatScore,
  qualityPath,
  reliabilityRows,
  trendPoints,
  type QualityReliabilityResponse,
  type QualityScore,
  type QualityScoresResponse,
} from "./qualityView";

interface QualityData {
  scores: QualityScoresResponse | null;
  reliability: QualityReliabilityResponse | null;
}

const EMPTY: QualityData = { scores: null, reliability: null };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include" });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function useQualityData(projectId: string | null, period: Period, timezone: string | null | undefined, override: { from: string; to: string } | null, environment: string, reload: number) {
  const key = [projectId ?? "none", period, timezone ?? "", override?.from ?? "", override?.to ?? "", environment, reload].join("\u0001");
  const [state, setState] = useState<{ key: string; data: QualityData; error: boolean }>({ key: "", data: EMPTY, error: false });
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const dates = override ?? periodDates(period, timezone ?? undefined);
    const scope = { ...dates, environment };
    void Promise.allSettled([
      getJson<QualityScoresResponse>(qualityPath(projectId, "scores", scope)),
      getJson<QualityReliabilityResponse>(qualityPath(projectId, "reliability", scope)),
    ]).then(([scores, reliability]) => {
      if (cancelled) return;
      setState({
        key,
        data: {
          scores: scores.status === "fulfilled" ? scores.value : null,
          reliability: reliability.status === "fulfilled" ? reliability.value : null,
        },
        error: scores.status === "rejected" || reliability.status === "rejected",
      });
    });
    return () => { cancelled = true; };
    // key captures every input above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const current = state.key === key;
  return { loading: Boolean(projectId) && !current, data: current ? state.data : EMPTY, error: current && state.error };
}

function Sparkline({ score }: { score: QualityScore }) {
  const points = trendPoints(score);
  if (points.length < 2) return null;
  return (
    <LineChart width={160} height={36} data={points} margin={{ top: 4, right: 2, bottom: 4, left: 2 }} aria-label={`${score.name} daily average`}>
      <YAxis hide domain={["dataMin", "dataMax"]} />
      <Line type="monotone" dataKey="avg" stroke="var(--ck-blue)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
    </LineChart>
  );
}

function ScoreCard({ score, money }: { score: QualityScore; money: (value: number | null) => string }) {
  return (
    <MetricCard
      label={score.name}
      value={formatScore(score.avg)}
      detail={<>
        <Sparkline score={score} />
        <div>{score.count.toLocaleString()} score{score.count === 1 ? "" : "s"}{score.passRate != null && ` · ${formatRate(score.passRate)} pass`}</div>
        {score.costPerPassingRun != null && <div>{money(score.costPerPassingRun)} per passing run</div>}
      </>}
    />
  );
}

function ScoresSection({ scores, loading, money }: { scores: QualityScore[]; loading: boolean; money: (value: number | null) => string }) {
  const [selected, setSelected] = useState<string | null>(null);
  if (loading) return <Panel title="Scores"><LoadingRows count={3} columns={3} /></Panel>;
  if (scores.length === 0) return <Panel title="Scores"><EmptyPanel title="No scores yet" body="Send one with CostKey.score()." /></Panel>;
  const active = scores.find((score) => score.name === selected) ?? scores[0];
  return (
    <>
      <div className="ck-metric-grid">
        {scores.map((score) => <ScoreCard key={score.name} score={score} money={money} />)}
      </div>
      <Panel
        title="By agent"
        actions={scores.length > 1 && <span className="ck-pill-select"><select aria-label="Score" value={active.name} onChange={(event) => setSelected(event.target.value)}>{scores.map((score) => <option key={score.name} value={score.name}>{score.name}</option>)}</select></span>}
      >
        <div className="ck-table-wrap">
          <table className="ck-table">
            <thead><tr><th>Agent</th><th className="numeric">Runs</th><th className="numeric">Avg</th><th className="numeric">P10</th><th className="numeric">Pass</th></tr></thead>
            <tbody>
              {active.byRun.map((row) => (
                <tr key={row.name}>
                  <td className="primary-cell">{row.name === "(unnamed)" ? "Unnamed" : row.name}</td>
                  <td className="numeric">{row.runs.toLocaleString()}</td>
                  <td className="numeric">{formatScore(row.avg)}</td>
                  <td className="numeric">{formatScore(row.p10)}</td>
                  <td className="numeric">{formatRate(row.passRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function ReliabilitySection({ data, loading, money }: { data: QualityReliabilityResponse | null; loading: boolean; money: (value: number | null) => string }) {
  const [by, setBy] = useState<"model" | "agent">("model");
  const rows = reliabilityRows(data, by);
  const toggle = (
    <div className="ck-segmented" role="group" aria-label="Group by">
      {(["model", "agent"] as const).map((option) => <button key={option} type="button" className={by === option ? "active" : ""} aria-pressed={by === option} onClick={() => setBy(option)}>{option === "model" ? "Model" : "Agent"}</button>)}
    </div>
  );
  return (
    <Panel title="Reliability" actions={toggle}>
      {loading ? <LoadingRows count={4} columns={7} /> : rows.length === 0 ? <EmptyPanel title={by === "agent" ? "No agent calls" : "No calls in this period"} /> : (
        <div className="ck-table-wrap">
          <table className="ck-table">
            <thead><tr><th>{by === "model" ? "Model" : "Agent"}</th><th className="numeric">Calls</th><th className="numeric">p50</th><th className="numeric">p95</th><th className="numeric">Errors</th><th className="numeric">Retries</th><th className="numeric">Wasted</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const tone = errorTone(row.errorRate);
                return (
                  <tr key={row.key}>
                    <td className="primary-cell">{row.name}{row.secondary && <div className="muted">{row.secondary}</div>}</td>
                    <td className="numeric">{row.calls.toLocaleString()}</td>
                    <td className="numeric">{formatDuration(row.p50DurationMs)}</td>
                    <td className="numeric">{formatDuration(row.p95DurationMs)}</td>
                    <td className="numeric">{tone === "neutral" ? formatRate(row.errorRate) : <StatusPill tone={tone} icon={false}>{formatRate(row.errorRate)}</StatusPill>}</td>
                    <td className="numeric">{formatRate(row.retryRate)}</td>
                    <td className="numeric">{row.wastedCost ? money(row.wastedCost) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export default function Quality() {
  const { currentProjectId, projects, org, workspaceSettings } = useAuth();
  const projectId = currentProjectId ?? projects[0]?.id ?? null;
  const [searchParams, setSearchParams] = useSearchParams();
  const [reload, setReload] = useState(0);
  const timezone = workspaceSettings?.timezone ?? org?.timezone;
  const currency = workspaceSettings?.reportingCurrency ?? "USD";
  const fx: ReportingFx | null | undefined = workspaceSettings?.fx;
  const environment = searchParams.get("environment") ?? "all";
  const period = parsePeriod(searchParams.get("period"));
  const requestedFrom = searchParams.get("from");
  const requestedTo = searchParams.get("to");
  const override = requestedFrom && requestedTo && Number.isFinite(new Date(requestedFrom).getTime()) && Number.isFinite(new Date(requestedTo).getTime()) && new Date(requestedFrom) < new Date(requestedTo) ? { from: requestedFrom, to: requestedTo } : null;
  const toolbarPeriod: Period = override ? "custom" : period;
  const resource = useQualityData(projectId, period, timezone, override, environment, reload);
  const money = (value: number | null) => formatReportedAmount(value, currency, fx);

  const changePeriod = (next: Period): void => {
    if (next === "custom") {
      const dates = periodDates("30d", timezone ?? undefined);
      setSearchParams((current) => { current.set("period", "custom"); current.set("from", dates.from); current.set("to", dates.to); return current; });
      return;
    }
    setSearchParams((current) => { current.set("period", next); current.delete("from"); current.delete("to"); return current; });
  };
  const changeCustomRange = (from: string, to: string): void => {
    const nextFrom = dateInputToIso(from, timezone ?? undefined);
    const nextTo = dateInputToIso(to, timezone ?? undefined, true);
    if (!nextFrom || !nextTo || new Date(nextFrom) >= new Date(nextTo)) return;
    setSearchParams((current) => { current.set("period", "custom"); current.set("from", nextFrom); current.set("to", nextTo); return current; });
  };

  if (!projectId) {
    return <div className="ck-main-inner"><PageHeader title="Quality" /><Panel><EmptyPanel illustration="first-light" title="Ready for your first run" action={<Link className="ck-button ck-button-primary" to="/onboarding">Connect a project</Link>} /></Panel></div>;
  }

  return (
    <div className="ck-main-inner">
      <PageHeader title="Quality" actions={<ScopeToolbar period={toolbarPeriod} onPeriodChange={changePeriod} customFrom={override?.from} customTo={override?.to} onCustomRangeChange={changeCustomRange} timezone={timezone ?? undefined} />} />
      {resource.error && <div className="ck-alert ck-alert-error" role="alert"><AlertCircle size={15} aria-hidden="true" /><div><strong>Couldn’t load everything.</strong> <button type="button" className="ck-button ck-button-quiet ck-inline-button" onClick={() => setReload((value) => value + 1)}>Try again</button></div></div>}
      <ScoresSection scores={resource.data.scores?.scores ?? []} loading={resource.loading} money={money} />
      <ReliabilitySection data={resource.data.reliability} loading={resource.loading} money={money} />
    </div>
  );
}

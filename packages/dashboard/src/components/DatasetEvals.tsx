import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Check, Copy, FlaskConical, ImageOff, X } from "lucide-react";
import { frameUrl } from "../api";
import { getEvalRun, type EvalCase, type EvalRun } from "../datasetsApi";
import { EmptyPanel, LoadingRows, MetricCard, PageHeader, Panel, StatusPill } from "./ConsolePrimitives";
import { formatDateTime, formatReportedAmount, type ReportingFx } from "./consoleFormatters";
import { configurationPairs, costChange, labelTone, passShare, percent, shareTone, timeAgo } from "./datasetView";
import { actionFrom, actionTitle } from "./replayModel";
import "../pages/Datasets.css";

export function LabelPill({ label, count }: { label: string; count?: number }) {
  return <span className={`ck-ds-pill is-${labelTone(label)}`}>{label}{count != null && <b>{count.toLocaleString()}</b>}</span>;
}

/** "50%" with a bar split into passed and failed. */
export function PassBar({ passed, failed }: { passed: number; failed: number }) {
  const share = passShare(passed, failed);
  if (share == null) return <span className="ck-ds-muted">Unscored</span>;
  return <span className={`ck-ds-passbar is-${shareTone(share)}`} title={`${passed} of ${passed + failed} passed`}>
    <b>{percent(share)}</b>
    <span className="ck-ds-passbar-track" aria-hidden="true"><i style={{ width: `${share * 100}%` }} /></span>
  </span>;
}

export interface ShotMarker {
  x: number;
  y: number;
  kind: "original" | "candidate";
}

/** A screenshot the model saw, with where it clicked; placeholders when there's none or it expired. */
export function Screenshot({ projectId, sha256, markers = [], className = "" }: { projectId: string; sha256: string | null; markers?: ShotMarker[]; className?: string }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  if (!sha256 || failed) {
    return <div className={`ck-ds-shot is-empty ${className}`}><ImageOff size={18} aria-hidden="true" /><span>{failed ? "Screenshot expired" : "No screenshot"}</span></div>;
  }
  return <div className={`ck-ds-shot ${className}`}>
    <img src={frameUrl(projectId, sha256)} alt="" loading="lazy" decoding="async" onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setFailed(true)} />
    {size && markers.filter((marker) => marker.x <= size.width && marker.y <= size.height).map((marker, index) => <span
      key={`${marker.kind}${index}`}
      className={`ck-ds-marker is-${marker.kind}`}
      style={{ left: `${(marker.x / size.width) * 100}%`, top: `${(marker.y / size.height) * 100}%` }}
      aria-hidden="true"
    />)}
  </div>;
}

/** The snippet behind "Run eval": evals run in your environment, with your keys. */
function evalSnippet(datasetName: string): string {
  return `import Anthropic from "@anthropic-ai/sdk";
import { CostKey } from "costkey";

CostKey.init({ dsn: process.env.COSTKEY_DSN });
const anthropic = new Anthropic();

// Reads the dataset with COSTKEY_API_TOKEN (a read-only personal access token).
const summary = await CostKey.runEval({
  dataset: ${JSON.stringify(datasetName)},
  configuration: { model: "claude-haiku-4-5" },
  task: (item) => anthropic.messages.create({ ...item.input, model: "claude-haiku-4-5" }),
});
console.log(\`\${summary.passed} of \${summary.scored} passed\`);
await CostKey.shutdown();`;
}

export function RunEvalPanel({ datasetName, onClose }: { datasetName: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const snippet = evalSnippet(datasetName);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <Panel
    className="ck-eval-panel"
    title="Run an eval"
    subtitle="It runs in your environment with your own model keys. CostKey never calls a model for you."
    actions={<button className="ck-button ck-button-quiet ck-icon-button" type="button" aria-label="Close" onClick={onClose}><X size={16} /></button>}
  >
    <div className="ck-eval-layout">
      <ol className="ck-eval-steps">
        <li><b>Get a token</b><span>Create a personal access token in Settings, under MCP &amp; coding agents, and set it as <code>COSTKEY_API_TOKEN</code>. It can only read.</span></li>
        <li><b>Change one thing</b><span>Swap the model or prompt inside <code>task</code>, and say what you changed in <code>configuration</code> so runs are easy to tell apart.</span></li>
        <li><b>Run it</b><span>Each call is replayed with its prompt and screenshot. Good calls pass when the new answer takes the same action; Bad calls pass when it doesn't repeat it.</span></li>
      </ol>
      <div className="ck-eval-snippet">
        <div className="ck-eval-snippet-head"><span>eval.ts</span><button className="ck-eval-copy" type="button" onClick={() => { void navigator.clipboard?.writeText(snippet).then(() => setCopied(true)); }}>{copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{copied ? "Copied" : "Copy"}</button></div>
        <pre><code>{snippet}</code></pre>
      </div>
    </div>
  </Panel>;
}

export function EvalRunsPanel({ datasetId, runs, error, currency, fx, onRunEval }: { datasetId: string; runs: EvalRun[] | null; error: string | null; currency: string; fx?: ReportingFx | null; onRunEval: () => void }) {
  const navigate = useNavigate();
  const money = (value: number | null) => (value == null ? "—" : formatReportedAmount(value, currency, fx));
  return <Panel title="Eval runs" subtitle={runs && runs.length > 0 ? "Each run replayed this dataset with one change. Select one to compare case by case." : undefined}>
    {runs === null ? <LoadingRows count={2} columns={5} />
      : error ? <EmptyPanel title="Eval runs couldn't be loaded" body={error} />
        : runs.length === 0 ? <EmptyPanel icon={<FlaskConical size={20} />} title="No eval runs yet" body="Run this dataset against another model or prompt to see how it does." action={<button className="ck-button ck-button-secondary" type="button" onClick={onRunEval}>Run eval</button>} />
          : <div className="ck-table-wrap"><table className="ck-table ck-ds-table">
            <thead><tr><th>Run</th><th>Pass rate</th><th className="numeric">Cost</th><th className="numeric">Original calls</th><th className="numeric">Started</th></tr></thead>
            <tbody>{runs.map((run) => {
              const change = costChange(run.cost, run.originalCost);
              return <tr key={run.executionId} className="ck-row-link" onClick={() => navigate(`/datasets/${datasetId}/evals/${encodeURIComponent(run.executionId)}`)}>
                <td className="primary-cell">
                  <Link className="ck-table-link ck-stretch-link" to={`/datasets/${datasetId}/evals/${encodeURIComponent(run.executionId)}`} onClick={(event) => event.stopPropagation()}>{run.name ?? "Eval run"}</Link>
                  <div className="ck-ds-chips">{configurationPairs(run.configuration).map((pair) => <span key={pair.key} className="ck-ds-chip"><em>{pair.key}</em> {pair.value}</span>)}</div>
                </td>
                <td><PassBar passed={run.passed} failed={run.failed} /><div className="ck-ds-muted">{run.passed} of {run.passed + run.failed} passed{run.cases > run.passed + run.failed ? ` · ${run.cases - run.passed - run.failed} unscored` : ""}</div></td>
                <td className="numeric">{money(run.cost)}{change && <div className={`ck-ds-change is-${change.tone}`}>{change.text}</div>}</td>
                <td className="numeric ck-ds-muted">{money(run.originalCost)}</td>
                <td className="numeric ck-ds-muted">{run.startedAt ? timeAgo(run.startedAt) : ""}</td>
              </tr>;
            })}</tbody>
          </table></div>}
  </Panel>;
}

function ActionLine({ who, body }: { who: string; body: unknown }) {
  const action = actionFrom(body);
  return <div className="ck-eval-action">
    <span className="ck-eval-who">{who}</span>
    {action ? <span>{actionTitle(action.label)}{action.x != null && action.y != null ? <span className="ck-ds-muted"> at {Math.round(action.x)}, {Math.round(action.y)}</span> : null}{action.text ? <span className="ck-ds-muted"> “{action.text}”</span> : null}</span> : <span className="ck-ds-muted">No screen action</span>}
  </div>;
}

type CaseFilter = "all" | "failed" | "passed" | "unscored";

export function EvalRunDetail({ projectId, datasetId, executionId, currency, fx }: { projectId: string; datasetId: string; executionId: string; currency: string; fx?: ReportingFx | null }) {
  const [state, setState] = useState<{ data: Awaited<ReturnType<typeof getEvalRun>> | null; error: string | null }>({ data: null, error: null });
  const [filter, setFilter] = useState<CaseFilter>("all");
  useEffect(() => {
    let cancelled = false;
    getEvalRun(projectId, datasetId, executionId)
      .then((data) => { if (!cancelled) setState({ data, error: null }); })
      .catch((reason: unknown) => { if (!cancelled) setState({ data: null, error: reason instanceof Error ? reason.message : "The eval run couldn't be loaded" }); });
    return () => { cancelled = true; };
  }, [projectId, datasetId, executionId]);
  const money = (value: number | null | undefined) => (value == null ? "—" : formatReportedAmount(value, currency, fx));
  const cases = useMemo<EvalCase[]>(() => state.data?.cases ?? [], [state.data]);
  const passed = cases.filter((item) => item.pass === true).length;
  const failed = cases.filter((item) => item.pass === false).length;
  const unscored = cases.length - passed - failed;
  const sum = (values: Array<number | null>) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
  const cost = sum(cases.map((item) => item.cost));
  const original = sum(cases.map((item) => item.originalCost));
  const change = costChange(cost, original);
  const share = passShare(passed, failed);
  const shown = cases.filter((item) => filter === "all" || (filter === "passed" ? item.pass === true : filter === "failed" ? item.pass === false : item.pass === null));
  const run = state.data?.run;

  return <div className="ck-main-inner ck-ds-page">
    <Link className="ck-back-link" to={`/datasets/${datasetId}`}><ArrowLeft size={13} /> Dataset</Link>
    <PageHeader title={run?.name ?? "Eval run"} description={run?.startedAt ? `Started ${formatDateTime(run.startedAt)}` : undefined} />
    {run && configurationPairs(run.configuration).length > 0 && <div className="ck-ds-chips ck-ds-chips-header">{configurationPairs(run.configuration).map((pair) => <span key={pair.key} className="ck-ds-chip"><em>{pair.key}</em> {pair.value}</span>)}</div>}
    {state.error ? <Panel><EmptyPanel title="This eval run couldn't be loaded" body={state.error} /></Panel> : <>
      <div className="ck-metric-grid ck-metric-grid-4">
        <MetricCard icon="quality" label="Pass rate" value={percent(share)} tone={shareTone(share)} loading={!state.data} detail={state.data ? `${passed} of ${passed + failed} passed${unscored ? ` · ${unscored} unscored` : ""}` : undefined} />
        <MetricCard icon="cost" label="Candidate cost" value={money(cost)} loading={!state.data} detail={state.data ? `${money(original)} for the original calls` : undefined} />
        <MetricCard icon="activity" label="Cost change" value={change?.text ?? "—"} tone={change?.tone === "good" ? "good" : change?.tone === "warn" ? "warn" : "neutral"} loading={!state.data} detail={change ? "Against the calls in the dataset" : undefined} />
        <MetricCard icon="flask" label="Cases" value={state.data ? cases.length.toLocaleString() : ""} loading={!state.data} detail={state.data ? `${sum(cases.map((item) => item.calls)).toLocaleString()} model calls` : undefined} />
      </div>
      <Panel
        title="Cases"
        subtitle="Where the original call clicked, and where the candidate did."
        actions={cases.length > 0 && <div className="ck-ds-filter" role="group" aria-label="Show">
          {(["all", "failed", "passed", "unscored"] as const).filter((key) => key === "all" || (key === "failed" ? failed : key === "passed" ? passed : unscored) > 0).map((key) => <button key={key} type="button" aria-pressed={filter === key} className={filter === key ? "is-on" : ""} onClick={() => setFilter(key)}>
            {key === "all" ? "All" : key[0]!.toUpperCase() + key.slice(1)} <span>{key === "all" ? cases.length : key === "failed" ? failed : key === "passed" ? passed : unscored}</span>
          </button>)}
        </div>}
      >
        {!state.data ? <LoadingRows count={3} columns={4} />
          : cases.length === 0 ? <EmptyPanel title="No cases yet" body="Cases appear here as the run sends its calls." />
            : <>
              <div className="ck-eval-legend" aria-hidden="true"><span><i className="is-original" /> Original</span><span><i className="is-candidate" /> Candidate</span></div>
              <div className="ck-ds-grid">{shown.map((item) => {
                const originalAction = actionFrom(item.originalOutput);
                const candidateAction = actionFrom(item.candidateOutput);
                const markers: Array<{ x: number; y: number; kind: "original" | "candidate" }> = [];
                if (originalAction?.x != null && originalAction.y != null) markers.push({ x: originalAction.x, y: originalAction.y, kind: "original" });
                if (candidateAction?.x != null && candidateAction.y != null) markers.push({ x: candidateAction.x, y: candidateAction.y, kind: "candidate" });
                return <article key={item.itemId} className={`ck-ds-card is-${item.pass === true ? "good" : item.pass === false ? "critical" : "neutral"}`}>
                  <Screenshot projectId={projectId} sha256={item.frameSha256} markers={markers} className="ck-ds-card-shot" />
                  <div className="ck-ds-card-body">
                    <div className="ck-ds-card-top">
                      {item.pass === null ? <StatusPill>Unscored</StatusPill> : item.pass ? <StatusPill tone="good">Pass</StatusPill> : <StatusPill tone="critical">Fail</StatusPill>}
                      <LabelPill label={item.label} />
                    </div>
                    {item.reason && <p className="ck-ds-note">{item.reason}</p>}
                    <ActionLine who="Original" body={item.originalOutput} />
                    <ActionLine who="Candidate" body={item.candidateOutput} />
                    <div className="ck-ds-card-meta">
                      <span>{money(item.cost)} <span className="ck-ds-muted">· was {money(item.originalCost)}</span></span>
                      <span className="ck-ds-links">
                        {item.sourceTraceId && <Link className="ck-inline-link" to={`/traces/${encodeURIComponent(item.sourceTraceId)}?call=${encodeURIComponent(item.sourceEventId)}`}>Original</Link>}
                        <Link className="ck-inline-link" to={`/traces/${encodeURIComponent(item.traceId)}`}>Candidate</Link>
                      </span>
                    </div>
                  </div>
                </article>;
              })}</div>
            </>}
      </Panel>
    </>}
  </div>;
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, Copy } from "lucide-react";
import { frameUrl } from "../api";
import { getEvalRun, listEvalRuns, type EvalCase, type EvalRun } from "../datasetsApi";
import { EmptyPanel, LoadingRows, PageHeader, Panel, StatusPill } from "./ConsolePrimitives";
import { formatAbsoluteDate, formatReportedAmount, type ReportingFx } from "./consoleFormatters";
import { actionFrom, actionTitle } from "./replayModel";

/** The snippet behind "Run eval": evals run in your environment, with your keys. */
function evalSnippet(datasetName: string): string {
  return `import Anthropic from "@anthropic-ai/sdk";
import { CostKey } from "costkey";

CostKey.init({ dsn: process.env.COSTKEY_DSN });
const anthropic = new Anthropic();

// Reads the dataset with COSTKEY_API_TOKEN (a personal access token).
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
  return <Panel title="Run an eval" subtitle="Runs in your environment with your own model keys. Each item's input is replayed with its screenshots, the answer is scored against the label, and the run appears below with its cost." actions={<button className="ck-button ck-button-quiet" type="button" onClick={onClose}>Close</button>}>
    <div className="ck-eval-snippet">
      <pre><code>{snippet}</code></pre>
      <button className="ck-button ck-button-secondary" type="button" onClick={() => { void navigator.clipboard?.writeText(snippet).then(() => setCopied(true)); }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy"}</button>
    </div>
    <ul className="ck-eval-notes">
      <li>Set <code>COSTKEY_API_TOKEN</code> to a personal access token from Settings, MCP &amp; coding agents. It only reads.</li>
      <li>Change the model or prompt inside <code>task</code>. Put what you changed in <code>configuration</code> so runs are easy to tell apart.</li>
      <li>Items labelled Good pass when the new answer takes the same action. Items labelled Bad pass when it doesn't repeat it. Pass <code>score</code> to use your own check.</li>
    </ul>
  </Panel>;
}

function configurationText(configuration: Record<string, unknown> | null): string {
  if (!configuration) return "";
  return Object.entries(configuration).slice(0, 3).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · ");
}

function passRate(run: Pick<EvalRun, "passed" | "failed">): string {
  const scored = run.passed + run.failed;
  return scored === 0 ? "Unscored" : `${run.passed.toLocaleString()} of ${scored.toLocaleString()} (${Math.round((run.passed / scored) * 100)}%)`;
}

export function EvalRunsPanel({ projectId, datasetId, currency, fx }: { projectId: string; datasetId: string; currency: string; fx?: ReportingFx | null }) {
  const [state, setState] = useState<{ runs: EvalRun[] | null; error: string | null }>({ runs: null, error: null });
  useEffect(() => {
    let cancelled = false;
    listEvalRuns(projectId, datasetId)
      .then((result) => { if (!cancelled) setState({ runs: result.runs, error: null }); })
      .catch((reason: unknown) => { if (!cancelled) setState({ runs: [], error: reason instanceof Error ? reason.message : "Eval runs couldn't be loaded" }); });
    return () => { cancelled = true; };
  }, [projectId, datasetId]);
  if (state.runs === null) return <Panel title="Eval runs"><LoadingRows count={2} columns={4} /></Panel>;
  if (state.error) return <Panel title="Eval runs"><div className="ck-ds-error" role="alert">{state.error}</div></Panel>;
  if (state.runs.length === 0) return null;
  const money = (value: number | null) => (value == null ? "Unpriced" : formatReportedAmount(value, currency, fx));
  return <Panel title="Eval runs">
    <div className="ck-table-wrap"><table className="ck-table">
      <thead><tr><th>Run</th><th>Started</th><th>Passed</th><th>Cost</th><th>Original calls</th></tr></thead>
      <tbody>{state.runs.map((run) => <tr key={run.executionId}>
        <td><Link className="ck-inline-link" to={`/datasets/${datasetId}/evals/${encodeURIComponent(run.executionId)}`}>{run.name ?? "Eval run"}</Link>{run.configuration && <div className="ck-ds-muted">{configurationText(run.configuration)}</div>}</td>
        <td>{run.startedAt ? formatAbsoluteDate(run.startedAt) : ""}</td>
        <td>{passRate(run)}</td>
        <td>{money(run.cost)}</td>
        <td>{money(run.originalCost)}</td>
      </tr>)}</tbody>
    </table></div>
  </Panel>;
}

function ActionText({ body }: { body: unknown }) {
  const action = actionFrom(body);
  if (!action) return <span className="ck-ds-muted">No screen action</span>;
  return <>{actionTitle(action.label)}{action.x != null && action.y != null ? ` at ${Math.round(action.x)}, ${Math.round(action.y)}` : ""}{action.text ? ` “${action.text}”` : ""}</>;
}

export function EvalRunDetail({ projectId, datasetId, executionId, currency, fx }: { projectId: string; datasetId: string; executionId: string; currency: string; fx?: ReportingFx | null }) {
  const [state, setState] = useState<{ data: Awaited<ReturnType<typeof getEvalRun>> | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let cancelled = false;
    getEvalRun(projectId, datasetId, executionId)
      .then((data) => { if (!cancelled) setState({ data, error: null }); })
      .catch((reason: unknown) => { if (!cancelled) setState({ data: null, error: reason instanceof Error ? reason.message : "The eval run couldn't be loaded" }); });
    return () => { cancelled = true; };
  }, [projectId, datasetId, executionId]);
  const money = (value: number | null) => (value == null ? "Unpriced" : formatReportedAmount(value, currency, fx));
  const cases: EvalCase[] = state.data?.cases ?? [];
  const passed = cases.filter((item) => item.pass === true).length;
  const failed = cases.filter((item) => item.pass === false).length;
  const sum = (values: Array<number | null>) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
  return <>
    <Link className="ck-ds-back" to={`/datasets/${datasetId}`}><ArrowLeft size={14} /> Dataset</Link>
    <PageHeader
      title={state.data?.run.name ?? "Eval run"}
      description={state.data ? [configurationText(state.data.run.configuration), passRate({ passed, failed }) + " passed", `${money(sum(cases.map((item) => item.cost)))} vs ${money(sum(cases.map((item) => item.originalCost)))} originally`].filter(Boolean).join(" · ") : undefined}
    />
    <Panel>
      {state.error ? <div className="ck-ds-error" role="alert">{state.error}</div>
        : !state.data ? <LoadingRows count={4} columns={6} />
          : cases.length === 0 ? <EmptyPanel title="No cases recorded yet" body="Cases appear as the run sends its calls." />
            : <div className="ck-table-wrap"><table className="ck-table ck-ds-items">
              <thead><tr><th>Screenshot</th><th>Label</th><th>Original</th><th>Candidate</th><th>Verdict</th><th>Cost</th></tr></thead>
              <tbody>{cases.map((item) => <tr key={item.itemId}>
                <td>{item.frameSha256 ? <img className="ck-ds-thumb" src={frameUrl(projectId, item.frameSha256)} alt="" loading="lazy" /> : <span className="ck-ds-muted">None</span>}</td>
                <td>{item.label}{item.note && <div className="ck-ds-muted">{item.note}</div>}</td>
                <td><ActionText body={item.originalOutput} />{item.sourceTraceId && <div><Link className="ck-inline-link" to={`/traces/${encodeURIComponent(item.sourceTraceId)}?call=${encodeURIComponent(item.sourceEventId)}`}>Original call</Link></div>}</td>
                <td><ActionText body={item.candidateOutput} /><div><Link className="ck-inline-link" to={`/traces/${encodeURIComponent(item.traceId)}`}>Candidate run</Link></div></td>
                <td>{item.pass === null ? <StatusPill>Unscored</StatusPill> : item.pass ? <StatusPill tone="good">Pass</StatusPill> : <StatusPill tone="critical">Fail</StatusPill>}{item.reason && <div className="ck-ds-muted">{item.reason}</div>}</td>
                <td>{money(item.cost)}<div className="ck-ds-muted">was {money(item.originalCost)}</div></td>
              </tr>)}</tbody>
            </table></div>}
    </Panel>
  </>;
}

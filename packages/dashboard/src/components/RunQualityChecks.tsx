import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getRunQualityChecks, type RunCheckResult } from "../qualityChecksApi";
import { EmptyPanel, LoadingRows, StatusPill } from "./ConsolePrimitives";
import { runStateView } from "./qualityChecksModel";
import "./QualityChecks.css";

/** One run's check results: score, label and reason, or why a check didn't run. */
export function RunCheckList({ results }: { results: RunCheckResult[] }) {
  return <ul className="qc-run-list">{results.map((result) => {
    const view = runStateView(result);
    return <li key={result.checkId} className="qc-run-item">
      <div className="qc-run-head">
        <span className="qc-run-name">{result.name}<small>{result.kind === "judge" ? "Rubric" : "Rule"}</small></span>
        <span className="qc-run-verdict">
          {result.score != null && <span className="qc-run-score">{result.score.toFixed(2)}</span>}
          <StatusPill tone={view.tone}>{view.label}</StatusPill>
        </span>
      </div>
      {result.label && !["pass", "passed", "fail", "failed"].includes(result.label.toLowerCase()) && <div className="qc-run-label">{result.label}</div>}
      {result.reason && <p className="qc-run-reason">{result.reason}</p>}
      {result.detail && <p className="qc-run-detail">{result.detail}</p>}
    </li>;
  })}</ul>;
}

export function RunQualityChecks({ projectId, traceId }: { projectId: string; traceId: string }) {
  const [state, setState] = useState<{ key: string; results: RunCheckResult[] | null; error: string | null }>({ key: "", results: null, error: null });
  const key = `${projectId}|${traceId}`;
  useEffect(() => {
    let alive = true;
    getRunQualityChecks(projectId, traceId)
      .then((data) => { if (alive) setState({ key, results: data.results, error: null }); })
      .catch((error: unknown) => { if (alive) setState({ key, results: null, error: error instanceof Error ? error.message : "Couldn't load checks." }); });
    return () => { alive = false; };
  }, [projectId, traceId, key]);

  if (state.key !== key) return <div className="ck-inspector-section"><LoadingRows count={3} columns={2} /></div>;
  if (state.error) return <div className="ck-inspector-section"><EmptyPanel title="Couldn't load checks" body={state.error} /></div>;
  if (!state.results || state.results.length === 0) {
    return <div className="ck-inspector-section"><EmptyPanel title="No quality checks yet" body="Add a judge or rule check and every finished run gets a score." action={<Link className="ck-button ck-button-secondary" to="/quality?view=checks">Set up checks</Link>} /></div>;
  }
  return <div className="ck-inspector-section"><div className="ck-inspector-section-title"><span>Quality checks</span></div><RunCheckList results={state.results} /></div>;
}

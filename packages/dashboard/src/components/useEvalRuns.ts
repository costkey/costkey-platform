import { useEffect, useState } from "react";
import { listEvalRuns, type EvalRun } from "../datasetsApi";

/** A dataset's eval runs, newest first; loaded once per dataset. */
export function useEvalRuns(projectId: string, datasetId: string): { runs: EvalRun[] | null; error: string | null } {
  const key = `${projectId}:${datasetId}`;
  const [state, setState] = useState<{ key: string; runs: EvalRun[] | null; error: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    listEvalRuns(projectId, datasetId)
      .then((result) => { if (!cancelled) setState({ key, runs: result.runs, error: null }); })
      .catch((reason: unknown) => { if (!cancelled) setState({ key, runs: [], error: reason instanceof Error ? reason.message : "Eval runs couldn't be loaded" }); });
    return () => { cancelled = true; };
  }, [key, projectId, datasetId]);
  return state?.key === key ? { runs: state.runs, error: state.error } : { runs: null, error: null };
}

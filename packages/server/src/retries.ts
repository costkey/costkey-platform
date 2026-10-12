import type pg from "pg";
import { WORK_ID_SQL } from "./insights-api.js";

/**
 * Attempts of one work item. A job that raises a retryable error runs again
 * as a new run carrying the same context.work_id; a failed attempt that a
 * later attempt completed is "retried", not failed.
 */
export interface RunRetry {
  workId: string;
  /** 1 for the first attempt. */
  attempt: number;
  attempts: number;
  /** This attempt failed and a later one completed. */
  retried: boolean;
  succeededBy: string | null;
  succeededOnAttempt: number | null;
  /** Failed with a retryable error and no later attempt has completed yet. */
  willRetry: boolean;
  errorType: string | null;
}

interface Attempt { traceId: string; workId: string; startedAt: number; state: string; errorType: string | null }

const FAILED = new Set(["failed", "error"]);
const RUNNING = new Set(["started", "running", "in_progress"]);

/** Resolve attempts for a set of runs, from the attempts of the same work items. */
export function resolveRetries(traceIds: string[], attempts: Attempt[]): Map<string, RunRetry> {
  const byWork = new Map<string, Attempt[]>();
  for (const attempt of attempts) byWork.set(attempt.workId, [...(byWork.get(attempt.workId) ?? []), attempt]);
  for (const list of byWork.values()) list.sort((a, b) => a.startedAt - b.startedAt || a.traceId.localeCompare(b.traceId));
  const result = new Map<string, RunRetry>();
  for (const traceId of traceIds) {
    const own = attempts.find((attempt) => attempt.traceId === traceId);
    if (!own) continue;
    const list = byWork.get(own.workId) ?? [own];
    const index = list.findIndex((attempt) => attempt.traceId === traceId);
    const failed = FAILED.has(own.state);
    const later = failed ? list.slice(index + 1).find((attempt) => !FAILED.has(attempt.state) && !RUNNING.has(attempt.state)) : undefined;
    result.set(traceId, {
      workId: own.workId,
      attempt: index + 1,
      attempts: list.length,
      retried: Boolean(later),
      succeededBy: later?.traceId ?? null,
      succeededOnAttempt: later ? list.indexOf(later) + 1 : null,
      willRetry: failed && !later && /retry/i.test(own.errorType ?? ""),
      errorType: own.errorType,
    });
  }
  return result;
}

/** Load the attempts behind these runs and resolve each run's retry state. */
export async function loadRetries(pool: pg.Pool | pg.PoolClient, projectId: string, traceIds: string[]): Promise<Map<string, RunRetry>> {
  if (traceIds.length === 0) return new Map();
  const result = await pool.query(
    `WITH keyed AS (
       SELECT trace_id, MAX(work_id) AS work_id, MIN(started_at) AS started_at FROM (
         SELECT e.trace_id, ${WORK_ID_SQL("e")} AS work_id, e.timestamp AS started_at FROM events e
          WHERE e.project_id = $1 AND e.trace_id = ANY($2::text[])
         UNION ALL
         SELECT t.id, ${WORK_ID_SQL("t")}, COALESCE(t.started_at, t.created_at) FROM traces t WHERE t.project_id = $1 AND t.id = ANY($2::text[])
       ) mine GROUP BY trace_id HAVING MAX(work_id) IS NOT NULL
     ), attempts AS (
       SELECT trace_id, MAX(work_id) AS work_id, MIN(started_at) AS started_at FROM (
         -- Retries follow within days: bound the search so it stays on the timestamp index.
         SELECT e.trace_id, ${WORK_ID_SQL("e")} AS work_id, e.timestamp AS started_at FROM events e
          WHERE e.project_id = $1 AND e.trace_id IS NOT NULL
            AND e.timestamp >= (SELECT MIN(started_at) FROM keyed) - INTERVAL '1 day'
            AND e.timestamp <= (SELECT MAX(started_at) FROM keyed) + INTERVAL '7 days'
            AND ${WORK_ID_SQL("e")} IN (SELECT work_id FROM keyed)
         UNION ALL
         SELECT t.id, ${WORK_ID_SQL("t")}, COALESCE(t.started_at, t.created_at) FROM traces t
          WHERE t.project_id = $1 AND ${WORK_ID_SQL("t")} IN (SELECT work_id FROM keyed)
       ) found GROUP BY trace_id
     )
     SELECT a.trace_id, a.work_id, a.started_at,
            CASE WHEN COALESCE(t.state, '') IN ('failed', 'error') OR COALESCE(s.failed, FALSE) THEN 'failed'
                 ELSE COALESCE(t.state, 'unknown') END AS state,
            t.error_type
     FROM attempts a
     LEFT JOIN traces t ON t.project_id = $1 AND t.id = a.trace_id
     LEFT JOIN LATERAL (
       SELECT BOOL_OR(sp.status = 'error' AND sp.parent_span_id IS NULL) AS failed FROM spans sp WHERE sp.project_id = $1 AND sp.trace_id = a.trace_id
     ) s ON TRUE`,
    [projectId, traceIds],
  );
  const attempts: Attempt[] = result.rows.map((row) => ({
    traceId: String(row.trace_id),
    workId: String(row.work_id),
    startedAt: row.started_at ? new Date(row.started_at as string).getTime() : 0,
    state: String(row.state ?? "unknown").toLowerCase(),
    errorType: row.error_type == null ? null : String(row.error_type),
  }));
  return resolveRetries(traceIds, attempts);
}

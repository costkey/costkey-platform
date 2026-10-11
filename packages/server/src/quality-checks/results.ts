import type pg from "pg";
import { loadRunFacts } from "./rules.js";
import { listChecks, publicCheck, scoreIdFor, type QualityCheck } from "./store.js";
import { checkWantsRun, projectCapture } from "./worker.js";

/** Read models for the console: checks with period stats, and per-run results. */

export type CheckStatus = "active" | "paused" | "needs_capture" | "needs_key" | "error";

export function checkStatus(check: QualityCheck, textCapture: boolean, lastError: string | null): CheckStatus {
  if (!check.enabled) return "paused";
  if (check.kind === "judge" && !textCapture) return "needs_capture";
  if (check.kind === "judge" && !check.judgeKeyEncrypted) return "needs_key";
  if (lastError) return "error";
  return "active";
}

const PASSED_SQL = `CASE WHEN lower(COALESCE(s.label, '')) IN ('pass', 'passed') THEN TRUE
  WHEN lower(COALESCE(s.label, '')) IN ('fail', 'failed') THEN FALSE
  ELSE s.value >= 0.5 END`;

export async function loadChecksWithStats(pool: pg.Pool, projectId: string, from: string, to: string): Promise<{ checks: Array<Record<string, unknown>>; textCapture: boolean }> {
  const [checks, capture] = await Promise.all([listChecks(pool, projectId), projectCapture(pool, projectId)]);
  if (checks.length === 0) return { checks: [], textCapture: capture.textCapture };
  const [scores, jobs] = await Promise.all([
    pool.query(
      `SELECT c.id, COUNT(s.id)::int AS scored, AVG(s.value) AS avg,
              COUNT(s.id) FILTER (WHERE ${PASSED_SQL})::int AS passed,
              MAX(s.timestamp) AS last_scored_at
       FROM quality_checks c
       LEFT JOIN scores s ON s.project_id = c.project_id AND s.name = c.name
         AND left(s.id, length('qc:' || c.id || ':')) = 'qc:' || c.id || ':'
         AND s.timestamp >= $2::timestamptz AND s.timestamp <= $3::timestamptz
       WHERE c.project_id = $1
       GROUP BY c.id`,
      [projectId, from, to],
    ),
    pool.query(
      `SELECT check_id,
              COUNT(*) FILTER (WHERE status IN ('pending', 'running'))::int AS queued,
              COUNT(*) FILTER (WHERE status IN ('pending', 'running') AND origin = 'backfill')::int AS backfilling,
              COUNT(*) FILTER (WHERE status = 'failed' AND updated_at >= $2::timestamptz)::int AS failed,
              COUNT(*) FILTER (WHERE status = 'skipped' AND skip_reason = 'needs_capture' AND updated_at >= $2::timestamptz)::int AS needs_capture,
              (ARRAY_AGG(last_error ORDER BY updated_at DESC) FILTER (WHERE status = 'failed' AND updated_at >= NOW() - INTERVAL '1 day'))[1] AS last_error
       FROM quality_check_jobs WHERE project_id = $1
       GROUP BY check_id`,
      [projectId, from],
    ),
  ]);
  const scoreById = new Map((scores.rows as Array<Record<string, unknown>>).map((row) => [String(row.id), row]));
  const jobById = new Map((jobs.rows as Array<Record<string, unknown>>).map((row) => [String(row.check_id), row]));
  return {
    textCapture: capture.textCapture,
    checks: checks.map((check) => {
      const score = scoreById.get(check.id);
      const job = jobById.get(check.id);
      const scored = Number(score?.scored ?? 0);
      const lastError = job?.last_error == null ? null : String(job.last_error);
      const lastScoredAt = score?.last_scored_at instanceof Date ? score.last_scored_at.toISOString() : score?.last_scored_at ?? null;
      return {
        ...publicCheck(check),
        status: checkStatus(check, capture.textCapture, lastError),
        lastError,
        stats: {
          scored,
          passRate: scored > 0 ? Number(score?.passed ?? 0) / scored : null,
          avg: score?.avg == null ? null : Number(score.avg),
          lastScoredAt,
          queued: Number(job?.queued ?? 0),
          backfilling: Number(job?.backfilling ?? 0),
          failed: Number(job?.failed ?? 0),
          needsCapture: Number(job?.needs_capture ?? 0),
        },
      };
    }),
  };
}

export type RunCheckState =
  | "passed" | "failed" | "scored"
  | "queued" | "error"
  | "needs_capture" | "needs_key" | "no_text" | "not_applicable"
  | "not_sampled" | "paused" | "waiting";

export interface RunCheckResult {
  checkId: string;
  name: string;
  kind: string;
  state: RunCheckState;
  score: number | null;
  label: string | null;
  reason: string | null;
  detail: string | null;
  evaluatedAt: string | null;
}

/** Every check's result on one run, including why a check did not run. */
export async function loadRunCheckResults(pool: pg.Pool, projectId: string, traceId: string, canReadContent: boolean): Promise<RunCheckResult[]> {
  const checks = await listChecks(pool, projectId);
  if (checks.length === 0) return [];
  const [jobs, scores, facts, capture] = await Promise.all([
    pool.query(
      "SELECT check_id, status, skip_reason, last_error, completed_at FROM quality_check_jobs WHERE project_id = $1 AND trace_id = $2",
      [projectId, traceId],
    ),
    pool.query(
      `SELECT id, value, label, comment, timestamp, created_at FROM scores
       WHERE project_id = $1 AND trace_id = $2 AND left(id, 3) = 'qc:'`,
      [projectId, traceId],
    ),
    loadRunFacts(pool, projectId, traceId),
    projectCapture(pool, projectId),
  ]);
  const jobByCheck = new Map((jobs.rows as Array<Record<string, unknown>>).map((row) => [String(row.check_id), row]));
  const scoreById = new Map((scores.rows as Array<Record<string, unknown>>).map((row) => [String(row.id), row]));
  return checks.map((check) => {
    const job = jobByCheck.get(check.id);
    const score = scoreById.get(scoreIdFor(check.id, traceId));
    const base = { checkId: check.id, name: check.name, kind: check.kind, score: null, label: null, reason: null, detail: null, evaluatedAt: null };
    const running = job && (job.status === "pending" || job.status === "running");
    if (score && !running) {
      const label = score.label == null ? null : String(score.label);
      const value = Number(score.value);
      const passed = label ? ["pass", "passed"].includes(label.toLowerCase()) || (!["fail", "failed"].includes(label.toLowerCase()) && value >= 0.5) : value >= 0.5;
      const evaluated = job?.completed_at ?? score.created_at;
      return {
        ...base,
        state: passed ? "passed" : "failed",
        score: value,
        label,
        // Judge reasons can quote the run, so they follow content access.
        reason: score.comment == null || (check.kind === "judge" && !canReadContent) ? null : String(score.comment),
        detail: check.kind === "judge" && !canReadContent && score.comment != null ? "The judge's reason is hidden for your role." : null,
        evaluatedAt: evaluated instanceof Date ? evaluated.toISOString() : evaluated == null ? null : String(evaluated),
      };
    }
    if (job) {
      if (running) return { ...base, state: "queued" };
      if (job.status === "failed") return { ...base, state: "error", detail: job.last_error == null ? null : String(job.last_error) };
      if (job.status === "skipped") {
        const reason = String(job.skip_reason ?? "");
        const state: RunCheckState = reason === "needs_capture" || reason === "needs_key" || reason === "no_text" || reason === "not_applicable" ? reason : "paused";
        return { ...base, state, detail: job.last_error == null ? null : String(job.last_error) };
      }
    }
    if (!check.enabled) return { ...base, state: "paused" };
    if (check.kind === "judge" && !capture.textCapture) return { ...base, state: "needs_capture" };
    if (facts) {
      const wants = checkWantsRun(check, facts);
      if (wants !== "yes") return { ...base, state: wants };
    }
    return { ...base, state: "waiting" };
  });
}


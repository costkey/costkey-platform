import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { orgScope } from "./middleware.js";
import { requireAuth } from "./auth.js";
import { chargesCte } from "./charge-cohort.js";
import { roleCanManageWorkspace, roleCanReadContent } from "./permissions.js";
import { DEFAULT_JUDGE_MODELS, JUDGE_PROVIDERS, JUDGE_TEMPLATES, RULES } from "./quality-checks/templates.js";
import { CheckInputError, createCheck, deleteCheck, getCheck, parseCheckInput, publicCheck, updateCheck } from "./quality-checks/store.js";
import { BackfillBusyError, MAX_BACKFILL_RUNS, backfillCheck } from "./quality-checks/worker.js";
import { loadChecksWithStats, loadRunCheckResults } from "./quality-checks/results.js";

/**
 * Quality: judge/eval scores on runs, and latency & reliability of the calls
 * underneath them. Every query is scoped to one project and period. Quality
 * check configuration (server-side judges and rules) is managed here too.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SCORE_NAMES = 50;
const MAX_RUNS_PER_SCORE = 10;
const MAX_RELIABILITY_ROWS = 50;

export interface QualityScope {
  from: string;
  to: string;
  environments: string[] | null;
}

class QualityInputError extends Error {}

function text(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

function list(raw: unknown): string[] | null {
  const items = (Array.isArray(raw) ? raw : [raw])
    .flatMap((item) => typeof item === "string" ? item.split(",") : [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== "all");
  return items.length > 0 ? items : null;
}

/** `from`/`to`/`environment` like the accounting API; defaults to the last 30 days. */
export function readQualityScope(query: Request["query"], now = new Date()): QualityScope {
  const fromRaw = text(query["from"]);
  const toRaw = text(query["to"]);
  const from = fromRaw ? new Date(fromRaw) : new Date(now.getTime() - 30 * DAY_MS);
  const to = toRaw ? new Date(toRaw) : now;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new QualityInputError("from and to must be valid dates");
  }
  if (from >= to) throw new QualityInputError("from must be before to");
  return { from: from.toISOString(), to: to.toISOString(), environments: list(query["environment"]) };
}

/** An explicit pass threshold, or null to infer 0.5 for scores that live in 0..1. */
export function readThreshold(raw: unknown): number | null {
  const value = text(raw);
  if (value === undefined) return null;
  const threshold = Number(value);
  if (!Number.isFinite(threshold)) throw new QualityInputError("threshold must be a number");
  return threshold;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function int(value: unknown): number {
  return num(value) ?? 0;
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

export async function workspaceTimezone(pool: pg.Pool, projectId: string): Promise<string> {
  try {
    const result = await pool.query(
      `SELECT COALESCE(ws.timezone, 'UTC') AS timezone
       FROM projects p LEFT JOIN workspace_settings ws ON ws.org_id = p.org_id
       WHERE p.id = $1`,
      [projectId],
    );
    const timezone = String(result.rows[0]?.timezone ?? "UTC");
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return "UTC";
  }
}

/**
 * Scores in scope, each attached to its run. A score sent with only a span id
 * takes that span's trace; the run's name is its root agent/workflow span,
 * falling back to the trace name. Params: $1 project, $2 from, $3 to,
 * $4 environments (text[] or null), $5 explicit threshold (or null).
 */
const SCORE_CTES = `
  scoped_scores AS (
    SELECT s.id, s.name, s.value, s.label, s.source, s.timestamp,
           COALESCE(s.trace_id, owner.trace_id) AS trace_id
    FROM scores s
    LEFT JOIN spans owner
      ON s.trace_id IS NULL AND owner.project_id = s.project_id AND owner.id = s.span_id
    WHERE s.project_id = $1
      AND s.timestamp >= $2::timestamptz AND s.timestamp <= $3::timestamptz
  ), scored AS (
    SELECT ss.*,
           COALESCE(
             (SELECT r.name FROM spans r
               WHERE r.project_id = $1 AND r.trace_id = ss.trace_id AND r.kind IN ('agent', 'workflow')
               ORDER BY (r.parent_span_id IS NULL) DESC, r.started_at ASC NULLS LAST, r.id
               LIMIT 1),
             NULLIF(t.trace_name, ''),
             '(unnamed)'
           ) AS run_name,
           COALESCE(
             NULLIF(t.context->>'environment', ''),
             (SELECT NULLIF(e.context->>'environment', '') FROM events e
               WHERE e.project_id = $1 AND e.trace_id = ss.trace_id AND e.context ? 'environment'
               LIMIT 1),
             '(unassigned)'
           ) AS environment
    FROM scoped_scores ss
    LEFT JOIN traces t ON t.project_id = $1 AND t.id = ss.trace_id
  ), filtered AS (
    SELECT * FROM scored WHERE $4::text[] IS NULL OR environment = ANY($4::text[])
  ), thresholds AS (
    SELECT name,
           CASE WHEN $5::double precision IS NOT NULL THEN $5::double precision
                WHEN MIN(value) >= 0 AND MAX(value) <= 1 THEN 0.5
                ELSE NULL END AS threshold
    FROM filtered GROUP BY name
  ), judged AS (
    SELECT f.*, th.threshold,
           CASE WHEN lower(f.label) IN ('pass', 'passed') THEN TRUE
                WHEN lower(f.label) IN ('fail', 'failed') THEN FALSE
                WHEN th.threshold IS NOT NULL THEN f.value >= th.threshold
                ELSE FALSE END AS passed
    FROM filtered f JOIN thresholds th ON th.name = f.name
  )`;

export interface ScoreRunRow {
  name: string;
  count: number;
  runs: number;
  avg: number | null;
  p10: number | null;
  passRate: number | null;
}

export interface ScoreSummary {
  name: string;
  count: number;
  runs: number;
  avg: number | null;
  p10: number | null;
  min: number | null;
  max: number | null;
  passRate: number | null;
  threshold: number | null;
  latest: { value: number | null; label: string | null; timestamp: string | null };
  trend: Array<{ day: string; avg: number | null; count: number }>;
  byRun: ScoreRunRow[];
  scoredRuns: number;
  passingRuns: number;
  scoredCost: number | null;
  costPerPassingRun: number | null;
}

export async function loadScoreQuality(
  pool: pg.Pool,
  projectId: string,
  scope: QualityScope,
  threshold: number | null,
  timezone = "UTC",
): Promise<ScoreSummary[]> {
  const params = [projectId, scope.from, scope.to, scope.environments, threshold];
  const [summary, trend, byRun, cost] = await Promise.all([
    pool.query(
      `WITH ${SCORE_CTES}
       SELECT name, COUNT(*)::int AS count, COUNT(DISTINCT trace_id)::int AS runs,
              AVG(value) AS avg,
              percentile_cont(0.1) WITHIN GROUP (ORDER BY value) AS p10,
              MIN(value) AS min, MAX(value) AS max,
              COUNT(*) FILTER (WHERE passed)::int AS passed,
              MAX(threshold) AS threshold,
              (ARRAY_AGG(value ORDER BY timestamp DESC, id DESC))[1] AS latest_value,
              (ARRAY_AGG(label ORDER BY timestamp DESC, id DESC))[1] AS latest_label,
              MAX(timestamp) AS latest_at
       FROM judged GROUP BY name
       ORDER BY count DESC, name
       LIMIT ${MAX_SCORE_NAMES}`,
      params,
    ),
    pool.query(
      `WITH ${SCORE_CTES}
       SELECT name, to_char((timestamp AT TIME ZONE $6::text)::date, 'YYYY-MM-DD') AS day,
              AVG(value) AS avg, COUNT(*)::int AS count
       FROM judged GROUP BY name, day
       ORDER BY name, day`,
      [...params, timezone],
    ),
    pool.query(
      `WITH ${SCORE_CTES}, per_run AS (
         SELECT name, run_name, COUNT(*)::int AS count, COUNT(DISTINCT trace_id)::int AS runs,
                AVG(value) AS avg,
                percentile_cont(0.1) WITHIN GROUP (ORDER BY value) AS p10,
                COUNT(*) FILTER (WHERE passed)::int AS passed
         FROM judged GROUP BY name, run_name
       ), ranked AS (
         SELECT per_run.*, ROW_NUMBER() OVER (PARTITION BY name ORDER BY count DESC, run_name) AS rank
         FROM per_run
       )
       SELECT * FROM ranked WHERE rank <= ${MAX_RUNS_PER_SCORE} ORDER BY name, rank`,
      params,
    ),
    pool.query(
      `${chargesCte()}, ${SCORE_CTES}, latest AS (
         SELECT DISTINCT ON (name, trace_id) name, trace_id, passed
         FROM judged WHERE trace_id IS NOT NULL
         ORDER BY name, trace_id, timestamp DESC, id DESC
       ), run_costs AS (
         SELECT c.trace_id, SUM(c.cost_usd) AS cost
         FROM charges c
         WHERE c.project_id = $1 AND c.trace_id IN (SELECT trace_id FROM latest)
         GROUP BY c.trace_id
       )
       SELECT l.name, COUNT(*)::int AS scored_runs,
              COUNT(*) FILTER (WHERE l.passed)::int AS passing_runs,
              SUM(rc.cost) AS scored_cost
       FROM latest l LEFT JOIN run_costs rc ON rc.trace_id = l.trace_id
       GROUP BY l.name`,
      params,
    ),
  ]);

  const trends = new Map<string, ScoreSummary["trend"]>();
  for (const row of trend.rows as Array<Record<string, unknown>>) {
    const name = String(row.name);
    const series = trends.get(name) ?? [];
    series.push({ day: String(row.day), avg: num(row.avg), count: int(row.count) });
    trends.set(name, series);
  }
  const runs = new Map<string, ScoreRunRow[]>();
  for (const row of byRun.rows as Array<Record<string, unknown>>) {
    const name = String(row.name);
    const rows = runs.get(name) ?? [];
    const count = int(row.count);
    rows.push({
      name: String(row.run_name),
      count,
      runs: int(row.runs),
      avg: num(row.avg),
      p10: num(row.p10),
      passRate: ratio(int(row.passed), count),
    });
    runs.set(name, rows);
  }
  const costs = new Map<string, Record<string, unknown>>();
  for (const row of cost.rows as Array<Record<string, unknown>>) costs.set(String(row.name), row);

  return (summary.rows as Array<Record<string, unknown>>).map((row) => {
    const name = String(row.name);
    const count = int(row.count);
    const costRow = costs.get(name);
    const scoredCost = num(costRow?.scored_cost);
    const passingRuns = int(costRow?.passing_runs);
    const latestAt = row.latest_at instanceof Date ? row.latest_at.toISOString() : row.latest_at == null ? null : String(row.latest_at);
    return {
      name,
      count,
      runs: int(row.runs),
      avg: num(row.avg),
      p10: num(row.p10),
      min: num(row.min),
      max: num(row.max),
      passRate: ratio(int(row.passed), count),
      threshold: num(row.threshold),
      latest: { value: num(row.latest_value), label: row.latest_label == null ? null : String(row.latest_label), timestamp: latestAt },
      trend: trends.get(name) ?? [],
      byRun: runs.get(name) ?? [],
      scoredRuns: int(costRow?.scored_runs),
      passingRuns,
      scoredCost,
      costPerPassingRun: scoredCost != null && passingRuns > 0 ? scoredCost / passingRuns : null,
    };
  });
}

export interface ReliabilityRow {
  calls: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  p95TtftMs: number | null;
  streams: number;
  errors: number;
  errorRate: number | null;
  retries: number;
  retryRate: number | null;
  cost: number | null;
  wastedCost: number | null;
}

export interface ReliabilityResponse {
  totals: ReliabilityRow;
  byModel: Array<ReliabilityRow & { provider: string; model: string }>;
  byAgent: Array<ReliabilityRow & { agent: string; runs: number; failedRuns: number }>;
}

/**
 * Provider calls in scope. A call failed when the provider returned >= 400 or
 * the span it ran inside ended in error. A retry is a call that names the
 * attempt it replaced (parent_event_id); the replaced attempt's cost and every
 * failed call's cost are wasted.
 */
const CALL_CTES = `
  retried AS (
    SELECT DISTINCT parent_event_id AS id FROM events
    WHERE project_id = $1 AND parent_event_id IS NOT NULL
      AND timestamp >= $2::timestamptz AND timestamp <= $3::timestamptz + interval '1 day'
  ), calls AS (
    SELECT e.id, e.provider, COALESCE(NULLIF(e.model, ''), 'unknown') AS model,
           NULLIF(e.context->>'agent', '') AS agent,
           e.duration_ms, e.ttft, COALESCE(e.streaming, FALSE) AS streaming, e.cost_usd,
           (e.parent_event_id IS NOT NULL) AS is_retry,
           (r.id IS NOT NULL) AS was_retried,
           (COALESCE(e.status_code, 0) >= 400 OR COALESCE(sp.status, '') = 'error') AS failed
    FROM events e
    LEFT JOIN spans sp ON sp.project_id = e.project_id AND sp.id = e.span_id
    LEFT JOIN retried r ON r.id = e.id
    WHERE e.project_id = $1 AND COALESCE(e.event_type, 'call') = 'call'
      AND e.timestamp >= $2::timestamptz AND e.timestamp <= $3::timestamptz
      AND ($4::text[] IS NULL OR COALESCE(NULLIF(e.context->>'environment', ''), '(unassigned)') = ANY($4::text[]))
  )`;

const CALL_AGGREGATES = `
  COUNT(*)::int AS calls,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS p95,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft) FILTER (WHERE streaming AND ttft IS NOT NULL) AS p95_ttft,
  COUNT(*) FILTER (WHERE streaming)::int AS streams,
  COUNT(*) FILTER (WHERE failed)::int AS errors,
  COUNT(*) FILTER (WHERE is_retry)::int AS retries,
  SUM(cost_usd) AS cost,
  COALESCE(SUM(cost_usd) FILTER (WHERE failed OR was_retried), 0) AS wasted_cost`;

function reliabilityRow(row: Record<string, unknown> | undefined): ReliabilityRow {
  const calls = int(row?.calls);
  const errors = int(row?.errors);
  const retries = int(row?.retries);
  return {
    calls,
    p50DurationMs: num(row?.p50),
    p95DurationMs: num(row?.p95),
    p95TtftMs: num(row?.p95_ttft),
    streams: int(row?.streams),
    errors,
    errorRate: ratio(errors, calls),
    retries,
    retryRate: ratio(retries, calls),
    cost: num(row?.cost),
    wastedCost: calls > 0 ? num(row?.wasted_cost) ?? 0 : null,
  };
}

export async function loadReliability(pool: pg.Pool, projectId: string, scope: QualityScope): Promise<ReliabilityResponse> {
  const params = [projectId, scope.from, scope.to, scope.environments];
  const [totals, byModel, byAgent, agentRuns] = await Promise.all([
    pool.query(`WITH ${CALL_CTES} SELECT ${CALL_AGGREGATES} FROM calls`, params),
    pool.query(
      `WITH ${CALL_CTES}
       SELECT provider, model, ${CALL_AGGREGATES}
       FROM calls GROUP BY provider, model
       ORDER BY calls DESC, provider, model
       LIMIT ${MAX_RELIABILITY_ROWS}`,
      params,
    ),
    pool.query(
      `WITH ${CALL_CTES}
       SELECT agent, ${CALL_AGGREGATES}
       FROM calls WHERE agent IS NOT NULL GROUP BY agent
       ORDER BY calls DESC, agent
       LIMIT ${MAX_RELIABILITY_ROWS}`,
      params,
    ),
    pool.query(
      `SELECT name AS agent, COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE status = 'error')::int AS failed_runs
       FROM spans
       WHERE project_id = $1 AND kind = 'agent'
         AND started_at >= $2::timestamptz AND started_at <= $3::timestamptz
         AND ($4::text[] IS NULL OR COALESCE(NULLIF(context->>'environment', ''), '(unassigned)') = ANY($4::text[]))
       GROUP BY name`,
      params,
    ),
  ]);
  const runs = new Map<string, { runs: number; failedRuns: number }>();
  for (const row of agentRuns.rows as Array<Record<string, unknown>>) {
    runs.set(String(row.agent), { runs: int(row.runs), failedRuns: int(row.failed_runs) });
  }
  return {
    totals: reliabilityRow(totals.rows[0] as Record<string, unknown> | undefined),
    byModel: (byModel.rows as Array<Record<string, unknown>>).map((row) => ({
      provider: String(row.provider ?? "unknown"),
      model: String(row.model ?? "unknown"),
      ...reliabilityRow(row),
    })),
    byAgent: (byAgent.rows as Array<Record<string, unknown>>).map((row) => {
      const agent = String(row.agent);
      return { agent, ...reliabilityRow(row), runs: runs.get(agent)?.runs ?? 0, failedRuns: runs.get(agent)?.failedRuns ?? 0 };
    }),
  };
}

function fail(res: Response, error: unknown, label: string): void {
  if (error instanceof QualityInputError) {
    res.status(400).json({ error: error.message });
    return;
  }
  console.error(`[costkey] ${label} error:`, error);
  res.status(500).json({ error: "Could not load quality data" });
}

export function createQualityRouter(pool: pg.Pool): Router {
  const router = createRouter();
  router.use("/api/v1/projects/:projectId", requireAuth, orgScope(pool));

  router.get("/api/v1/projects/:projectId/quality/scores", async (req, res) => {
    try {
      const projectId = req.params["projectId"] as string;
      const scope = readQualityScope(req.query);
      const threshold = readThreshold(req.query["threshold"]);
      const timezone = await workspaceTimezone(pool, projectId);
      const scores = await loadScoreQuality(pool, projectId, scope, threshold, timezone);
      res.json({ from: scope.from, to: scope.to, timezone, currency: "USD", scores });
    } catch (error) {
      fail(res, error, "Quality scores");
    }
  });

  router.get("/api/v1/projects/:projectId/quality/reliability", async (req, res) => {
    try {
      const projectId = req.params["projectId"] as string;
      const scope = readQualityScope(req.query);
      const reliability = await loadReliability(pool, projectId, scope);
      res.json({ from: scope.from, to: scope.to, currency: "USD", ...reliability });
    } catch (error) {
      fail(res, error, "Quality reliability");
    }
  });

  // ── Quality checks: server-side judges and rules ───────────────────────
  const userOf = (req: Request) => (req as Request & { user?: { id?: string; role?: string } }).user;
  const canManageChecks = (req: Request, res: Response): boolean => {
    if (roleCanManageWorkspace(userOf(req)?.role)) return true;
    res.status(403).json({ error: "Only owners and admins can manage quality checks" });
    return false;
  };
  const checkFail = (res: Response, error: unknown, label: string) => {
    if (error instanceof CheckInputError) { res.status(400).json({ error: error.message }); return; }
    if (error instanceof BackfillBusyError) { res.status(409).json({ error: error.message }); return; }
    fail(res, error, label);
  };

  router.get("/api/v1/projects/:projectId/quality/checks", async (req, res) => {
    try {
      const projectId = req.params["projectId"] as string;
      const scope = readQualityScope(req.query);
      const { checks, textCapture } = await loadChecksWithStats(pool, projectId, scope.from, scope.to);
      res.json({
        from: scope.from,
        to: scope.to,
        canManage: roleCanManageWorkspace(userOf(req)?.role),
        textCapture,
        maxBackfillRuns: MAX_BACKFILL_RUNS,
        checks,
        templates: JUDGE_TEMPLATES,
        rules: RULES,
        providers: JUDGE_PROVIDERS.map((id) => ({ id, defaultModel: DEFAULT_JUDGE_MODELS[id] })),
      });
    } catch (error) {
      checkFail(res, error, "Quality checks");
    }
  });

  router.post("/api/v1/projects/:projectId/quality/checks", async (req, res) => {
    if (!canManageChecks(req, res)) return;
    try {
      const projectId = req.params["projectId"] as string;
      const input = parseCheckInput(req.body);
      const check = await createCheck(pool, projectId, input, userOf(req)?.id ?? null);
      res.status(201).json({ check: publicCheck(check) });
    } catch (error) {
      checkFail(res, error, "Create quality check");
    }
  });

  router.patch("/api/v1/projects/:projectId/quality/checks/:checkId", async (req, res) => {
    if (!canManageChecks(req, res)) return;
    try {
      const projectId = req.params["projectId"] as string;
      const existing = await getCheck(pool, projectId, req.params["checkId"] as string);
      if (!existing) { res.status(404).json({ error: "Check not found" }); return; }
      const input = parseCheckInput(req.body, existing);
      const check = await updateCheck(pool, existing, input, userOf(req)?.id ?? null);
      res.json({ check: publicCheck(check) });
    } catch (error) {
      checkFail(res, error, "Update quality check");
    }
  });

  router.delete("/api/v1/projects/:projectId/quality/checks/:checkId", async (req, res) => {
    if (!canManageChecks(req, res)) return;
    try {
      const removed = await deleteCheck(pool, req.params["projectId"] as string, req.params["checkId"] as string);
      if (!removed) { res.status(404).json({ error: "Check not found" }); return; }
      res.status(204).end();
    } catch (error) {
      checkFail(res, error, "Delete quality check");
    }
  });

  router.post("/api/v1/projects/:projectId/quality/checks/:checkId/backfill", async (req, res) => {
    if (!canManageChecks(req, res)) return;
    try {
      const check = await getCheck(pool, req.params["projectId"] as string, req.params["checkId"] as string);
      if (!check) { res.status(404).json({ error: "Check not found" }); return; }
      if (!check.enabled) { res.status(400).json({ error: "Turn the check on before running it" }); return; }
      const rawLimit = (req.body as Record<string, unknown> | undefined)?.["limit"];
      const limit = rawLimit === undefined ? MAX_BACKFILL_RUNS : Number(rawLimit);
      if (!Number.isFinite(limit) || limit < 1) { res.status(400).json({ error: `limit must be between 1 and ${MAX_BACKFILL_RUNS}` }); return; }
      const result = await backfillCheck(pool, check, limit);
      res.status(202).json(result);
    } catch (error) {
      checkFail(res, error, "Quality check backfill");
    }
  });

  router.get("/api/v1/projects/:projectId/quality/runs/:traceId/checks", async (req, res) => {
    try {
      const results = await loadRunCheckResults(
        pool,
        req.params["projectId"] as string,
        req.params["traceId"] as string,
        roleCanReadContent(userOf(req)?.role),
      );
      res.json({ traceId: req.params["traceId"], results });
    } catch (error) {
      checkFail(res, error, "Run quality checks");
    }
  });

  return router;
}

import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import { orgScope } from "./middleware.js";

/**
 * Workflows, Agents and Errors: runs grouped the way people think about
 * them. A run is one trace; an agent run is a trace whose root span is an
 * agent, everything else is grouped by its workflow (root workflow span or
 * trace name).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

interface Window {
  from: string;
  to: string;
  environment: string | null;
}

function text(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function windowFrom(req: Request): Window {
  const now = Date.now();
  const parse = (raw: unknown, fallback: number) => {
    const value = text(raw);
    const time = value ? Date.parse(value) : NaN;
    return new Date(Number.isNaN(time) ? fallback : time).toISOString();
  };
  const environment = text(req.query["environment"]);
  return {
    from: parse(req.query["from"], now - 30 * DAY_MS),
    to: parse(req.query["to"], now + 60_000),
    environment: environment && environment !== "all" ? environment : null,
  };
}

/** One row per run in the window, with its root span. Params: $1 project, $2 from, $3 to, $4 environment. */
export const RUNS_CTE = `
  calls AS (
    SELECT e.id, e.trace_id, e.trace_name, e.cost_usd, e.duration_ms, e.status_code, e.timestamp, e.parent_event_id,
           e.model, e.provider, e.span_id, e.context, e.group_kind, e.group_name
    FROM events e
    WHERE e.project_id = $1 AND COALESCE(e.event_type, 'call') = 'call' AND e.trace_id IS NOT NULL
      AND e.timestamp >= $2 AND e.timestamp < $3
      AND ($4::text IS NULL OR COALESCE(NULLIF(e.context->>'environment', ''), '(unassigned)') = $4)
  ),
  runs AS (
    SELECT trace_id, MAX(trace_name) AS trace_name,
           SUM(cost_usd) AS cost, COUNT(*)::int AS calls,
           COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced,
           MIN(timestamp) AS started_at,
           MAX(timestamp + COALESCE(duration_ms, 0) * INTERVAL '1 millisecond') AS ended_at,
           BOOL_OR(COALESCE(status_code, 200) >= 400) AS failed_call,
           MAX(context->>'userId') AS user_id,
           MAX(group_kind) AS group_kind, MAX(group_name) AS group_name
    FROM calls GROUP BY trace_id
  ),
  roots AS (
    SELECT DISTINCT ON (s.trace_id) s.trace_id, s.kind, s.name, s.status, s.started_at, s.ended_at
    FROM spans s
    WHERE s.project_id = $1 AND s.parent_span_id IS NULL AND s.trace_id IN (SELECT trace_id FROM runs)
    ORDER BY s.trace_id, s.started_at NULLS LAST
  ),
  shape AS (
    SELECT s.trace_id,
           COUNT(*) FILTER (WHERE s.kind = 'step')::int AS steps,
           COUNT(*) FILTER (WHERE s.kind = 'tool')::int AS tools,
           BOOL_OR(s.status = 'error') AS failed_span
    FROM spans s
    WHERE s.project_id = $1 AND s.trace_id IN (SELECT trace_id FROM runs)
    GROUP BY s.trace_id
  ),
  run_rows AS (
    SELECT r.*, ro.kind AS root_kind, ro.name AS root_name, ro.status AS root_status,
           COALESCE(sh.steps, 0) AS steps, COALESCE(sh.tools, 0) AS tools,
           (r.failed_call OR COALESCE(sh.failed_span, FALSE)) AS failed,
           EXTRACT(EPOCH FROM (COALESCE(ro.ended_at, r.ended_at) - COALESCE(ro.started_at, r.started_at))) * 1000 AS duration_ms
    FROM runs r
    LEFT JOIN roots ro ON ro.trace_id = r.trace_id
    LEFT JOIN shape sh ON sh.trace_id = r.trace_id
  )`;

export const GROUP_COLUMNS = `
  COUNT(*)::int AS runs,
  SUM(cost) AS cost,
  SUM(cost) FILTER (WHERE unpriced = 0) / NULLIF(COUNT(*) FILTER (WHERE unpriced = 0), 0) AS cost_per_run,
  COUNT(*) FILTER (WHERE unpriced > 0)::int AS partly_priced_runs,
  SUM(calls)::int AS calls,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
  COUNT(*) FILTER (WHERE failed)::int AS failed_runs,
  AVG(steps)::float AS avg_steps,
  AVG(tools)::float AS avg_tools,
  MAX(started_at) AS last_run`;

function number(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function groupRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    name: row.name,
    runs: number(row.runs) ?? 0,
    cost: number(row.cost),
    costPerRun: number(row.cost_per_run),
    partlyPricedRuns: number(row.partly_priced_runs) ?? 0,
    calls: number(row.calls) ?? 0,
    p50Ms: number(row.p50_ms),
    p95Ms: number(row.p95_ms),
    failedRuns: number(row.failed_runs) ?? 0,
    avgSteps: number(row.avg_steps),
    avgTools: number(row.avg_tools),
    lastRun: row.last_run,
  };
}

function fail(res: Response, label: string, error: unknown): void {
  console.error(`[costkey] ${label} error:`, error);
  res.status(500).json({ error: `Couldn't load ${label.toLowerCase()}` });
}

export function createInsightsRouter(pool: pg.Pool): Router {
  const router = Router();
  router.use("/api/v1/projects/:projectId", requireAuth, orgScope(pool));

  router.get("/api/v1/projects/:projectId/workflows", async (req: Request, res: Response) => {
    const window = windowFrom(req);
    try {
      const result = await pool.query(
        `WITH ${RUNS_CTE}
         SELECT COALESCE(CASE WHEN root_kind = 'workflow' THEN root_name END, NULLIF(group_name, ''), NULLIF(trace_name, ''), root_name, 'Unnamed') AS name,
                ${GROUP_COLUMNS}
         FROM run_rows
         -- A batch, evaluation or experiment groups as one workflow.
         WHERE root_kind IS DISTINCT FROM 'agent'
         GROUP BY 1
         ORDER BY SUM(cost) DESC NULLS LAST, COUNT(*) DESC
         LIMIT 200`,
        [req.params["projectId"], window.from, window.to, window.environment],
      );
      res.json({ workflows: result.rows.map(groupRow) });
    } catch (error) { fail(res, "Workflows", error); }
  });

  router.get("/api/v1/projects/:projectId/agents", async (req: Request, res: Response) => {
    const window = windowFrom(req);
    try {
      const result = await pool.query(
        `WITH ${RUNS_CTE}
         SELECT root_name AS name, ${GROUP_COLUMNS}
         FROM run_rows
         WHERE root_kind = 'agent'
         GROUP BY root_name
         ORDER BY SUM(cost) DESC NULLS LAST, COUNT(*) DESC
         LIMIT 200`,
        [req.params["projectId"], window.from, window.to, window.environment],
      );
      res.json({ agents: result.rows.map(groupRow) });
    } catch (error) { fail(res, "Agents", error); }
  });

  router.get("/api/v1/projects/:projectId/agents/:name", async (req: Request, res: Response) => {
    const window = windowFrom(req);
    const params = [req.params["projectId"], window.from, window.to, window.environment, req.params["name"]];
    const scoped = `WITH ${RUNS_CTE}, agent_runs AS (SELECT * FROM run_rows WHERE root_kind = 'agent' AND root_name = $5)`;
    try {
      const [summary, runs, tools, models, subagents] = await Promise.all([
        pool.query(`${scoped} SELECT $5::text AS name, ${GROUP_COLUMNS} FROM agent_runs`, params),
        pool.query(
          `${scoped}
           SELECT trace_id, started_at, cost, unpriced, calls, steps, tools, failed, duration_ms, user_id
           FROM agent_runs ORDER BY started_at DESC LIMIT 50`,
          params,
        ),
        pool.query(
          `${scoped}
           SELECT s.name, COUNT(*)::int AS calls,
                  AVG(EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) * 1000) AS avg_ms,
                  COUNT(*) FILTER (WHERE s.status = 'error')::int AS failed,
                  COALESCE(SUM(c.cost), 0) AS cost
           FROM spans s
           LEFT JOIN LATERAL (SELECT SUM(cl.cost_usd) AS cost FROM calls cl WHERE cl.span_id = s.id) c ON TRUE
           WHERE s.project_id = $1 AND s.kind = 'tool' AND s.trace_id IN (SELECT trace_id FROM agent_runs)
           GROUP BY s.name ORDER BY COUNT(*) DESC LIMIT 50`,
          params,
        ),
        pool.query(
          `${scoped}
           SELECT COALESCE(cl.model, 'unknown') AS model, cl.provider, COUNT(*)::int AS calls, SUM(cl.cost_usd) AS cost
           FROM calls cl WHERE cl.trace_id IN (SELECT trace_id FROM agent_runs)
           GROUP BY 1, 2 ORDER BY SUM(cl.cost_usd) DESC NULLS LAST LIMIT 20`,
          params,
        ),
        pool.query(
          `${scoped}
           SELECT s.name, COUNT(*)::int AS runs
           FROM spans s
           WHERE s.project_id = $1 AND s.kind = 'agent' AND s.parent_span_id IS NOT NULL
             AND s.trace_id IN (SELECT trace_id FROM agent_runs)
           GROUP BY s.name ORDER BY COUNT(*) DESC LIMIT 20`,
          params,
        ),
      ]);
      res.json({
        agent: groupRow(summary.rows[0] ?? { name: req.params["name"] }),
        runs: runs.rows.map((row) => ({
          traceId: row.trace_id, startedAt: row.started_at, cost: row.unpriced > 0 && row.cost == null ? null : number(row.cost),
          unpriced: number(row.unpriced) ?? 0, calls: number(row.calls) ?? 0, steps: number(row.steps) ?? 0,
          tools: number(row.tools) ?? 0, failed: Boolean(row.failed), durationMs: number(row.duration_ms), userId: row.user_id ?? null,
        })),
        tools: tools.rows.map((row) => ({ name: row.name, calls: number(row.calls) ?? 0, avgMs: number(row.avg_ms), failed: number(row.failed) ?? 0, cost: number(row.cost) })),
        models: models.rows.map((row) => ({ model: row.model, provider: row.provider, calls: number(row.calls) ?? 0, cost: number(row.cost) })),
        subagents: subagents.rows.map((row) => ({ name: row.name, runs: number(row.runs) ?? 0 })),
      });
    } catch (error) { fail(res, "Agent", error); }
  });

  /** Spend by model across agent runs or workflow runs, with the names that use each model most. */
  router.get("/api/v1/projects/:projectId/insights/models", async (req: Request, res: Response) => {
    const window = windowFrom(req);
    const agents = req.query["kind"] === "agent";
    try {
      const result = await pool.query(
        `WITH ${RUNS_CTE},
         scoped AS (
           SELECT trace_id,
                  ${agents
                    ? "root_name"
                    : "COALESCE(CASE WHEN root_kind = 'workflow' THEN root_name END, NULLIF(group_name, ''), NULLIF(trace_name, ''), root_name, 'Unnamed')"} AS owner
           FROM run_rows
           WHERE ${agents ? "root_kind = 'agent'" : "root_kind IS DISTINCT FROM 'agent'"}
         ),
         by_owner AS (
           SELECT COALESCE(c.model, 'unknown') AS model, c.provider, s.owner,
                  COUNT(*)::int AS calls, SUM(c.cost_usd) AS cost, COUNT(DISTINCT c.trace_id)::int AS runs
           FROM calls c JOIN scoped s ON s.trace_id = c.trace_id
           GROUP BY 1, 2, 3
         )
         SELECT model, provider, SUM(calls)::int AS calls, SUM(runs)::int AS runs, SUM(cost) AS cost,
                (ARRAY_AGG(owner ORDER BY cost DESC NULLS LAST))[1:3] AS top_owners
         FROM by_owner GROUP BY model, provider
         ORDER BY SUM(cost) DESC NULLS LAST LIMIT 100`,
        [req.params["projectId"], window.from, window.to, window.environment],
      );
      res.json({ models: result.rows.map((row) => ({ model: row.model, provider: row.provider, calls: number(row.calls) ?? 0, runs: number(row.runs) ?? 0, cost: number(row.cost), topOwners: row.top_owners ?? [] })) });
    } catch (error) { fail(res, "Models", error); }
  });

  /**
   * Quality: did a run go wrong, where, and what did it cost. A run (one
   * agent execution or workflow run) fails when it errors, a model call fails
   * with no successful retry, a tool or step fails, or a judge fails it.
   */
  router.get("/api/v1/projects/:projectId/quality/summary", async (req: Request, res: Response) => {
    const window = windowFrom(req);
    const owner = text(req.query["owner"]);
    const params = [req.params["projectId"], window.from, window.to, window.environment];
    const qualityCte = `WITH ${RUNS_CTE},
      owned AS (
        SELECT r.*,
               CASE WHEN root_kind = 'agent' THEN 'agent' ELSE 'workflow' END AS owner_kind,
               CASE WHEN root_kind = 'agent' THEN root_name
                    ELSE COALESCE(CASE WHEN root_kind = 'workflow' THEN root_name END, NULLIF(group_name, ''), NULLIF(trace_name, ''), root_name, 'Unnamed') END AS owner
        FROM run_rows r
      ),
      call_quality AS (
        SELECT c.trace_id,
               COUNT(*) FILTER (WHERE COALESCE(c.status_code, 200) >= 400 AND NOT EXISTS (
                 SELECT 1 FROM calls retry WHERE retry.parent_event_id = c.id AND COALESCE(retry.status_code, 200) < 400))::int AS failed_calls,
               COUNT(*) FILTER (WHERE c.parent_event_id IS NOT NULL)::int AS retries,
               COALESCE(SUM(c.cost_usd) FILTER (WHERE COALESCE(c.status_code, 200) >= 400
                 OR EXISTS (SELECT 1 FROM calls retry WHERE retry.parent_event_id = c.id)), 0) AS wasted_cost,
               (ARRAY_AGG(COALESCE(c.model, 'model') || ' returned ' || c.status_code ORDER BY c.timestamp)
                 FILTER (WHERE COALESCE(c.status_code, 200) >= 400))[1] AS first_call_error
        FROM calls c GROUP BY c.trace_id
      ),
      span_quality AS (
        SELECT s.trace_id,
               BOOL_OR(s.status = 'error' AND s.kind = 'tool') AS tool_failed,
               BOOL_OR(s.status = 'error' AND s.kind <> 'tool' AND s.parent_span_id IS NOT NULL) AS step_failed,
               (ARRAY_AGG(s.name || COALESCE(': ' || s.error_type, '') ORDER BY COALESCE(s.ended_at, s.started_at))
                 FILTER (WHERE s.status = 'error'))[1] AS first_span_error
        FROM spans s
        WHERE s.project_id = $1 AND s.trace_id IN (SELECT trace_id FROM runs)
        GROUP BY s.trace_id
      ),
      judged AS (
        SELECT sc.trace_id,
               BOOL_OR(LOWER(COALESCE(sc.label, '')) IN ('fail', 'failed')
                 OR (sc.label IS NULL AND sc.value >= 0 AND sc.value < 0.5)) AS judged_fail,
               (ARRAY_AGG(sc.name ORDER BY sc.timestamp DESC) FILTER (WHERE LOWER(COALESCE(sc.label, '')) IN ('fail', 'failed')
                 OR (sc.label IS NULL AND sc.value >= 0 AND sc.value < 0.5)))[1] AS failed_score
        FROM scores sc
        WHERE sc.project_id = $1 AND sc.trace_id IN (SELECT trace_id FROM runs)
        GROUP BY sc.trace_id
      ),
      quality AS (
        SELECT o.trace_id, o.owner, o.owner_kind, o.started_at, o.cost, o.calls, o.duration_ms,
               COALESCE(cq.failed_calls, 0) AS failed_calls, COALESCE(cq.retries, 0) AS retries, COALESCE(cq.wasted_cost, 0) AS wasted_cost,
               o.root_status = 'error' AS run_failed,
               COALESCE(sq.tool_failed, FALSE) AS tool_failed, COALESCE(sq.step_failed, FALSE) AS step_failed,
               COALESCE(j.judged_fail, FALSE) AS judged_fail, j.trace_id IS NOT NULL AS judged,
               COALESCE(sq.first_span_error, cq.first_call_error, CASE WHEN j.judged_fail THEN j.failed_score || ' scored failing' END) AS first_error
        FROM owned o
        LEFT JOIN call_quality cq ON cq.trace_id = o.trace_id
        LEFT JOIN span_quality sq ON sq.trace_id = o.trace_id
        LEFT JOIN judged j ON j.trace_id = o.trace_id
      ),
      verdict AS (
        SELECT q.*, (run_failed OR tool_failed OR step_failed OR failed_calls > 0 OR judged_fail) AS failed FROM quality q
      )`;
    try {
      const [totals, owners, models, failures] = await Promise.all([
        pool.query(
          `${qualityCte}
           SELECT COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE failed)::int AS failed_runs,
                  COALESCE(SUM(calls), 0)::int AS calls, COALESCE(SUM(failed_calls), 0)::int AS failed_calls,
                  COALESCE(SUM(retries), 0)::int AS retries,
                  COALESCE(SUM(wasted_cost), 0) + COALESCE(SUM(cost) FILTER (WHERE failed AND failed_calls = 0), 0) AS wasted_cost,
                  COUNT(*) FILTER (WHERE judged)::int AS judged_runs, COUNT(*) FILTER (WHERE judged_fail)::int AS judged_failed,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
                  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
           FROM verdict`,
          params,
        ),
        pool.query(
          `${qualityCte}
           SELECT owner, owner_kind, COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE failed)::int AS failed_runs,
                  COUNT(*) FILTER (WHERE judged)::int AS judged_runs, COUNT(*) FILTER (WHERE judged_fail)::int AS judged_failed,
                  SUM(failed_calls)::int AS failed_calls, SUM(retries)::int AS retries,
                  SUM(wasted_cost) + COALESCE(SUM(cost) FILTER (WHERE failed AND failed_calls = 0), 0) AS wasted_cost,
                  COUNT(*) FILTER (WHERE tool_failed)::int AS tool_failures
           FROM verdict GROUP BY owner, owner_kind
           ORDER BY COUNT(*) FILTER (WHERE failed) DESC, COUNT(*) DESC LIMIT 100`,
          params,
        ),
        pool.query(
          `WITH ${RUNS_CTE}
           SELECT COALESCE(c.model, 'unknown') AS model, c.provider, COUNT(*)::int AS calls,
                  COUNT(*) FILTER (WHERE COALESCE(c.status_code, 200) >= 400)::int AS failed_calls,
                  COUNT(*) FILTER (WHERE c.parent_event_id IS NOT NULL)::int AS retries,
                  percentile_cont(0.95) WITHIN GROUP (ORDER BY c.duration_ms) AS p95_ms,
                  COALESCE(SUM(c.cost_usd) FILTER (WHERE COALESCE(c.status_code, 200) >= 400
                    OR EXISTS (SELECT 1 FROM calls retry WHERE retry.parent_event_id = c.id)), 0) AS wasted_cost,
                  ARRAY_REMOVE(ARRAY_AGG(DISTINCT c.status_code) FILTER (WHERE COALESCE(c.status_code, 200) >= 400), NULL) AS status_codes
           FROM calls c GROUP BY 1, 2
           ORDER BY COUNT(*) FILTER (WHERE COALESCE(c.status_code, 200) >= 400) DESC, COUNT(*) DESC LIMIT 100`,
          params,
        ),
        pool.query(
          `${qualityCte}
           SELECT trace_id, owner, owner_kind, started_at, cost, run_failed, tool_failed, step_failed, failed_calls, judged_fail, first_error
           FROM verdict WHERE failed AND ($5::text IS NULL OR owner = $5)
           ORDER BY started_at DESC LIMIT 100`,
          [...params, owner],
        ),
      ]);
      const total = totals.rows[0] ?? {};
      res.json({
        totals: {
          runs: number(total.runs) ?? 0, failedRuns: number(total.failed_runs) ?? 0, calls: number(total.calls) ?? 0, failedCalls: number(total.failed_calls) ?? 0,
          retries: number(total.retries) ?? 0, wastedCost: number(total.wasted_cost) ?? 0,
          judgedRuns: number(total.judged_runs) ?? 0, judgedFailed: number(total.judged_failed) ?? 0, p50Ms: number(total.p50_ms), p95Ms: number(total.p95_ms),
        },
        owners: owners.rows.map((row) => ({
          name: row.owner, kind: row.owner_kind, runs: row.runs, failedRuns: row.failed_runs, judgedRuns: row.judged_runs,
          judgedFailed: row.judged_failed, failedCalls: number(row.failed_calls) ?? 0, retries: number(row.retries) ?? 0,
          toolFailures: row.tool_failures, wastedCost: number(row.wasted_cost) ?? 0,
        })),
        models: models.rows.map((row) => ({
          model: row.model, provider: row.provider, calls: row.calls, failedCalls: row.failed_calls, retries: row.retries,
          p95Ms: number(row.p95_ms), wastedCost: number(row.wasted_cost) ?? 0, statusCodes: (row.status_codes ?? []).map(Number),
        })),
        failures: failures.rows.map((row) => ({
          traceId: row.trace_id, name: row.owner, kind: row.owner_kind, startedAt: row.started_at, cost: number(row.cost),
          reasons: [
            row.run_failed && "Run failed", Number(row.failed_calls) > 0 && "Model call failed", row.tool_failed && "Tool failed",
            row.step_failed && "Step failed", row.judged_fail && "Judged failing",
          ].filter(Boolean),
          detail: row.first_error ?? null,
        })),
      });
    } catch (error) { fail(res, "Quality", error); }
  });

  router.get("/api/v1/projects/:projectId/errors", async (req: Request, res: Response) => {
    const window = windowFrom(req);
    const params = [req.params["projectId"], window.from, window.to, window.environment];
    const callFilter = `e.project_id = $1 AND COALESCE(e.event_type, 'call') = 'call'
      AND e.timestamp >= $2 AND e.timestamp < $3
      AND ($4::text IS NULL OR COALESCE(NULLIF(e.context->>'environment', ''), '(unassigned)') = $4)`;
    try {
      const [totals, failedCalls, retries, failedSpans] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS calls,
                  COUNT(*) FILTER (WHERE COALESCE(e.status_code, 200) >= 400)::int AS failed_calls,
                  COUNT(*) FILTER (WHERE e.parent_event_id IS NOT NULL)::int AS retries,
                  COALESCE(SUM(e.cost_usd) FILTER (WHERE COALESCE(e.status_code, 200) >= 400 OR e.parent_event_id IS NOT NULL), 0) AS wasted_cost
           FROM events e WHERE ${callFilter}`,
          params,
        ),
        pool.query(
          `SELECT e.provider, COALESCE(e.model, e.request_model, 'unknown') AS model, e.status_code,
                  COUNT(*)::int AS calls, COUNT(DISTINCT e.trace_id)::int AS runs,
                  SUM(e.cost_usd) AS cost, MAX(e.timestamp) AS last_seen,
                  (ARRAY_AGG(e.trace_id ORDER BY e.timestamp DESC) FILTER (WHERE e.trace_id IS NOT NULL))[1] AS sample_trace_id
           FROM events e WHERE ${callFilter} AND COALESCE(e.status_code, 200) >= 400
           GROUP BY 1, 2, 3 ORDER BY COUNT(*) DESC LIMIT 100`,
          params,
        ),
        pool.query(
          `SELECT COALESCE(e.model, e.request_model, 'unknown') AS model, e.provider,
                  COUNT(*)::int AS retries, SUM(e.cost_usd) AS cost, MAX(e.timestamp) AS last_seen
           FROM events e WHERE ${callFilter} AND e.parent_event_id IS NOT NULL
           GROUP BY 1, 2 ORDER BY COUNT(*) DESC LIMIT 50`,
          params,
        ),
        pool.query(
          `SELECT s.kind, s.name, s.error_type, COUNT(*)::int AS failures, MAX(COALESCE(s.ended_at, s.started_at)) AS last_seen,
                  (ARRAY_AGG(s.trace_id ORDER BY COALESCE(s.ended_at, s.started_at) DESC))[1] AS sample_trace_id
           FROM spans s
           WHERE s.project_id = $1 AND s.status = 'error'
             AND COALESCE(s.ended_at, s.started_at) >= $2 AND COALESCE(s.ended_at, s.started_at) < $3
             AND ($4::text IS NULL OR COALESCE(NULLIF(s.context->>'environment', ''), '(unassigned)') = $4)
           GROUP BY 1, 2, 3 ORDER BY COUNT(*) DESC LIMIT 100`,
          params,
        ),
      ]);
      const total = totals.rows[0] ?? {};
      res.json({
        totals: { calls: number(total.calls) ?? 0, failedCalls: number(total.failed_calls) ?? 0, retries: number(total.retries) ?? 0, wastedCost: number(total.wasted_cost) ?? 0 },
        failedCalls: failedCalls.rows.map((row) => ({ provider: row.provider, model: row.model, statusCode: row.status_code, calls: row.calls, runs: row.runs, cost: number(row.cost), lastSeen: row.last_seen, sampleTraceId: row.sample_trace_id })),
        retries: retries.rows.map((row) => ({ model: row.model, provider: row.provider, retries: row.retries, cost: number(row.cost), lastSeen: row.last_seen })),
        failedSpans: failedSpans.rows.map((row) => ({ kind: row.kind, name: row.name, errorType: row.error_type, failures: row.failures, lastSeen: row.last_seen, sampleTraceId: row.sample_trace_id })),
      });
    } catch (error) { fail(res, "Errors", error); }
  });

  return router;
}

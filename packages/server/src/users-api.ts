import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import { orgScope } from "./middleware.js";
import { workspaceTimezone } from "./quality-api.js";
import { BILLED_UNITS, retryInfo, RUNS_CTE } from "./insights-api.js";
import { USAGE_SUM_COLUMNS, usageFrom, type TokenUsage } from "./token-usage.js";

/**
 * Users: spend and usage per end user of the app, the id a run's calls carry
 * in context.userId, user_id, customer or customerId (RUNS_CTE's user_id).
 * Each endpoint is one query, so RUNS_CTE runs once per request.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsersWindow {
  from: string;
  to: string;
  environment: string | null;
}

function text(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function windowFrom(req: Request): UsersWindow {
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

function number(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

type Units = Record<string, number>;

function unitsFrom(raw: unknown): Units {
  const units: Units = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return units;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = number(value);
    if (parsed != null) units[key] = parsed;
  }
  return units;
}

function addUnits(target: Units, source: Units): Units {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
  return target;
}

/** Billed native units per call. `alias.native_units` must be in scope; adds a WHERE. */
const UNIT_ROWS = (alias: string) => `
  CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(${alias}.native_units) = 'object' THEN ${alias}.native_units ELSE '{}'::jsonb END) u
  WHERE u.key = ANY(ARRAY['${BILLED_UNITS.join("','")}']) AND u.value ~ '^[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$'`;

/** A run's agent or workflow, the way the Agents and Workflows pages name it. Columns of run_rows. */
const OWNER_KIND = "CASE WHEN root_kind = 'agent' THEN 'agent' ELSE 'workflow' END";
const OWNER_NAME = "CASE WHEN root_kind = 'agent' THEN root_name ELSE COALESCE(CASE WHEN root_kind = 'workflow' THEN root_name END, NULLIF(group_name, ''), NULLIF(trace_name, ''), root_name, 'Unnamed') END";

/** Runs that carry a user id, with their owner. Follows RUNS_CTE. */
const USER_RUNS_CTE = `
  user_runs AS (
    SELECT r.*, ${OWNER_KIND} AS owner_kind, ${OWNER_NAME} AS owner
    FROM run_rows r
    WHERE NULLIF(r.user_id, '') IS NOT NULL
  )`;

export interface UserRow {
  userId: string;
  runs: number;
  calls: number;
  cost: number | null;
  usage: TokenUsage;
  units: Units;
  /** Top 3 agents and workflows by spend. */
  agents: string[];
  lastRun: string | null;
}

export interface UsersList {
  users: UserRow[];
  totals: { runs: number; runsWithoutUser: number; cost: number | null };
}

/** Users in the window by spend (at most 200), optionally those whose id contains `q`. */
export async function loadUsers(pool: pg.Pool, projectId: string, window: UsersWindow, q: string | null = null): Promise<UsersList> {
  const result = await pool.query(
    `WITH ${RUNS_CTE}, ${USER_RUNS_CTE},
     matched AS (
       SELECT * FROM user_runs WHERE $5::text IS NULL OR strpos(LOWER(user_id), LOWER($5::text)) > 0
     ),
     by_user AS (
       SELECT user_id, COUNT(*)::int AS runs, SUM(calls)::int AS calls, SUM(cost) AS cost, MAX(started_at) AS last_run,
              ${USAGE_SUM_COLUMNS()}
       FROM matched GROUP BY user_id
       ORDER BY SUM(cost) DESC NULLS LAST, COUNT(*) DESC, user_id
       LIMIT 200
     ),
     owner_rank AS (
       SELECT user_id, owner,
              ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY SUM(cost) DESC NULLS LAST, COUNT(*) DESC, owner) AS rank
       FROM matched WHERE user_id IN (SELECT user_id FROM by_user)
       GROUP BY user_id, owner
     ),
     unit_sums AS (
       SELECT r.user_id, u.key AS unit, SUM(u.value::float) AS total
       FROM matched r JOIN calls c ON c.trace_id = r.trace_id ${UNIT_ROWS("c")}
         AND r.user_id IN (SELECT user_id FROM by_user)
       GROUP BY 1, 2
     ),
     totals AS (
       SELECT COUNT(*)::int AS total_runs,
              COUNT(*) FILTER (WHERE NULLIF(user_id, '') IS NULL)::int AS runs_without_user,
              SUM(cost) AS total_cost
       FROM run_rows
     )
     SELECT t.total_runs, t.runs_without_user, t.total_cost, b.*,
            (SELECT ARRAY_AGG(o.owner ORDER BY o.rank) FROM owner_rank o WHERE o.user_id = b.user_id AND o.rank <= 3) AS agents,
            (SELECT jsonb_object_agg(us.unit, us.total) FROM unit_sums us WHERE us.user_id = b.user_id) AS units
     FROM totals t LEFT JOIN by_user b ON TRUE
     ORDER BY b.cost DESC NULLS LAST, b.runs DESC, b.user_id`,
    [projectId, window.from, window.to, window.environment, q],
  );
  const rows = result.rows as Array<Record<string, unknown>>;
  const first = rows[0] ?? {};
  return {
    users: rows.filter((row) => row.user_id != null).map((row) => ({
      userId: String(row.user_id),
      runs: number(row.runs) ?? 0,
      calls: number(row.calls) ?? 0,
      cost: number(row.cost),
      usage: usageFrom(row),
      units: unitsFrom(row.units),
      agents: Array.isArray(row.agents) ? row.agents.map(String) : [],
      lastRun: iso(row.last_run),
    })),
    totals: { runs: number(first.total_runs) ?? 0, runsWithoutUser: number(first.runs_without_user) ?? 0, cost: number(first.total_cost) },
  };
}

export interface UserDetail {
  userId: string;
  window: UsersWindow & { timezone: string; bucket: "day" };
  summary: {
    runs: number; failedRuns: number; retriedRuns: number; calls: number; cost: number | null;
    usage: TokenUsage; units: Units; firstRun: string | null; lastRun: string | null;
  };
  series: Array<{ bucket: string; cost: number; runs: number }>;
  owners: Array<{ kind: "agent" | "workflow"; name: string; runs: number; cost: number | null }>;
  models: Array<{ provider: string | null; model: string; calls: number; cost: number | null; usage: TokenUsage; units: Units }>;
  runs: Array<{
    traceId: string; name: string; kind: "agent" | "workflow"; startedAt: string | null; cost: number | null; calls: number;
    durationMs: number | null; failed: boolean; retry: ReturnType<typeof retryInfo>; usage: TokenUsage;
  }>;
}

/** One user's spend, daily series (workspace time zone, every day zero-filled), agents and workflows, models and latest 50 runs. */
export async function loadUserDetail(pool: pg.Pool, projectId: string, userId: string, window: UsersWindow, timezone: string): Promise<UserDetail> {
  const result = await pool.query(
    `WITH ${RUNS_CTE},
     user_runs AS (
       SELECT r.*, ${OWNER_KIND} AS owner_kind, ${OWNER_NAME} AS owner
       FROM run_rows r WHERE r.user_id = $5::text
     ),
     -- Spend counts every call of the user's runs, as the run totals do.
     user_calls AS (
       SELECT c.* FROM calls c WHERE c.trace_id IN (SELECT trace_id FROM user_runs)
     ),
     summary AS (
       SELECT COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE failed)::int AS failed_runs,
              COUNT(*) FILTER (WHERE retried)::int AS retried_runs, COALESCE(SUM(calls), 0)::int AS calls,
              SUM(cost) AS cost, MIN(started_at) AS first_run, MAX(started_at) AS last_run,
              ${USAGE_SUM_COLUMNS()}
       FROM user_runs
     ),
     days AS (
       SELECT to_char(b, 'YYYY-MM-DD"T"HH24:MI') AS bucket
       FROM generate_series(
         date_trunc('day', $2::timestamptz AT TIME ZONE $6::text),
         date_trunc('day', LEAST($3::timestamptz - INTERVAL '1 millisecond', NOW()) AT TIME ZONE $6::text),
         INTERVAL '1 day') b
       LIMIT 2000
     ),
     daily AS (
       SELECT to_char(date_trunc('day', started_at AT TIME ZONE $6::text), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
              SUM(cost) AS cost, COUNT(*)::int AS runs
       FROM user_runs GROUP BY 1
     ),
     owners AS (
       SELECT owner_kind AS kind, owner AS name, COUNT(*)::int AS runs, SUM(cost) AS cost
       FROM user_runs GROUP BY 1, 2
     ),
     models AS (
       SELECT c.provider, COALESCE(c.model, c.request_model, 'unknown') AS model, COUNT(*)::int AS calls, SUM(c.cost_usd) AS cost,
              ${USAGE_SUM_COLUMNS("c.")}
       FROM user_calls c GROUP BY 1, 2
     ),
     model_units AS (
       SELECT x.provider, x.model, jsonb_object_agg(x.unit, x.total) AS units
       FROM (
         SELECT c.provider, COALESCE(c.model, c.request_model, 'unknown') AS model, u.key AS unit, SUM(u.value::float) AS total
         FROM user_calls c ${UNIT_ROWS("c")}
         GROUP BY 1, 2, 3
       ) x
       GROUP BY 1, 2
     ),
     latest AS (
       SELECT trace_id, owner AS name, owner_kind AS kind, started_at, cost, calls, duration_ms, failed, retried,
              retried_by, retried_on_attempt, attempt, work_id, error_type,
              prompt_tokens, cache_read_tokens, cache_write_tokens, completion_tokens, reasoning_tokens, cache_reported
       FROM user_runs ORDER BY started_at DESC, trace_id LIMIT 50
     )
     SELECT
       (SELECT row_to_json(s) FROM summary s) AS summary,
       (SELECT COALESCE(json_agg(json_build_object('bucket', d.bucket, 'cost', COALESCE(dl.cost, 0), 'runs', COALESCE(dl.runs, 0)) ORDER BY d.bucket), '[]'::json)
          FROM days d LEFT JOIN daily dl ON dl.bucket = d.bucket) AS series,
       (SELECT COALESCE(json_agg(o ORDER BY o.cost DESC NULLS LAST, o.runs DESC, o.name), '[]'::json) FROM owners o) AS owners,
       (SELECT COALESCE(json_agg(json_build_object('row', m, 'units', mu.units) ORDER BY m.cost DESC NULLS LAST, m.calls DESC, m.model), '[]'::json)
          FROM models m LEFT JOIN model_units mu ON mu.provider IS NOT DISTINCT FROM m.provider AND mu.model = m.model) AS models,
       (SELECT COALESCE(json_agg(l ORDER BY l.started_at DESC, l.trace_id), '[]'::json) FROM latest l) AS runs`,
    [projectId, window.from, window.to, window.environment, userId, timezone],
  );
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const summary = (row.summary ?? {}) as Record<string, unknown>;
  const models = (Array.isArray(row.models) ? row.models : []) as Array<{ row: Record<string, unknown>; units: unknown }>;
  const units: Units = {};
  for (const model of models) addUnits(units, unitsFrom(model.units));
  return {
    userId,
    window: { ...window, timezone, bucket: "day" },
    summary: {
      runs: number(summary.runs) ?? 0,
      failedRuns: number(summary.failed_runs) ?? 0,
      retriedRuns: number(summary.retried_runs) ?? 0,
      calls: number(summary.calls) ?? 0,
      cost: number(summary.cost),
      usage: usageFrom(summary),
      units,
      firstRun: iso(summary.first_run),
      lastRun: iso(summary.last_run),
    },
    series: ((Array.isArray(row.series) ? row.series : []) as Array<Record<string, unknown>>).map((point) => ({
      bucket: String(point.bucket), cost: number(point.cost) ?? 0, runs: number(point.runs) ?? 0,
    })),
    owners: ((Array.isArray(row.owners) ? row.owners : []) as Array<Record<string, unknown>>).map((owner) => ({
      kind: owner.kind === "agent" ? "agent" : "workflow", name: String(owner.name), runs: number(owner.runs) ?? 0, cost: number(owner.cost),
    })),
    models: models.map(({ row: model, units: modelUnits }) => ({
      provider: model.provider == null ? null : String(model.provider),
      model: String(model.model),
      calls: number(model.calls) ?? 0,
      cost: number(model.cost),
      usage: usageFrom(model),
      units: unitsFrom(modelUnits),
    })),
    runs: ((Array.isArray(row.runs) ? row.runs : []) as Array<Record<string, unknown>>).map((run) => ({
      traceId: String(run.trace_id),
      name: String(run.name),
      kind: run.kind === "agent" ? "agent" : "workflow",
      startedAt: iso(run.started_at),
      cost: number(run.cost),
      calls: number(run.calls) ?? 0,
      durationMs: number(run.duration_ms),
      failed: Boolean(run.failed),
      retry: retryInfo(run),
      usage: usageFrom(run),
    })),
  };
}

function fail(res: Response, label: string, error: unknown): void {
  console.error(`[costkey] ${label} error:`, error);
  res.status(500).json({ error: `Couldn't load ${label.toLowerCase()}` });
}

export function createUsersRouter(pool: pg.Pool): Router {
  const router = Router();
  router.use("/api/v1/projects/:projectId", requireAuth, orgScope(pool));

  router.get("/api/v1/projects/:projectId/users", async (req: Request, res: Response) => {
    const window = windowFrom(req);
    if (Date.parse(window.from) >= Date.parse(window.to)) {
      res.status(400).json({ error: "from must be before to" });
      return;
    }
    try {
      res.json(await loadUsers(pool, req.params["projectId"] as string, window, text(req.query["q"])));
    } catch (error) { fail(res, "Users", error); }
  });

  // The id is a query parameter: user ids can hold slashes or anything else.
  router.get("/api/v1/projects/:projectId/users/detail", async (req: Request, res: Response) => {
    const userId = typeof req.query["user"] === "string" ? req.query["user"] : "";
    if (!userId) {
      res.status(400).json({ error: "user is required" });
      return;
    }
    const window = windowFrom(req);
    if (Date.parse(window.from) >= Date.parse(window.to)) {
      res.status(400).json({ error: "from must be before to" });
      return;
    }
    try {
      const projectId = req.params["projectId"] as string;
      res.json(await loadUserDetail(pool, projectId, userId, window, await workspaceTimezone(pool, projectId)));
    } catch (error) { fail(res, "User", error); }
  });

  return router;
}

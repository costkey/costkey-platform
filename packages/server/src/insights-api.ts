import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import { orgScope } from "./middleware.js";
import { workspaceTimezone } from "./quality-api.js";
import { chargesCte, scopeClauses } from "./charge-cohort.js";
import {
  CACHE_REPORTED_SQL, CACHE_WRITE_SQL, OUTPUT_TOKENS_SQL, PROMPT_TOKENS_SQL, SAVINGS_COLUMNS, SAVINGS_ROW_LIMIT,
  sumCacheSavings, USAGE_SUM_COLUMNS, usageFrom, type TokenUsage,
} from "./token-usage.js";

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
  /** One release (deploy) only; null for every release. */
  release: string | null;
}

/**
 * The scope filter queries take as $4: environment and release as one jsonb,
 * so every query keeps its parameter positions.
 */
export function scopeParam(window: { environment: string | null; release?: string | null }): string {
  return JSON.stringify({ environment: window.environment, release: window.release ?? null });
}

/** A call's release: its context, or the column older calls carry it in. Spans only have context. */
export const RELEASE_SQL = (alias: string, column = true) => column
  ? `COALESCE(NULLIF(${alias}.context->>'release', ''), NULLIF(${alias}.release, ''))`
  : `NULLIF(${alias}.context->>'release', '')`;

/** Rows (aliased `alias`) inside the $4 scope; `calls` is false for spans. */
export const SCOPE_FILTER = (alias: string, calls = true) => `(($4::jsonb->>'environment') IS NULL OR COALESCE(NULLIF(${alias}.context->>'environment', ''), '(unassigned)') = $4::jsonb->>'environment')
      AND (($4::jsonb->>'release') IS NULL OR ${RELEASE_SQL(alias, calls)} = $4::jsonb->>'release')`;

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
    release: text(req.query["release"]),
  };
}

/** The work item a run is an attempt of: runs that share it are retries of one job. */
export const WORK_ID_SQL = (e: string) => `NULLIF(COALESCE(${e}.context->>'work_id', ${e}.context->>'workId', ${e}.context->>'attempt_key'), '')`;

/**
 * What calls cost: the priced ones' total, and 0 when every unpriced call
 * failed (a failed call without a price costs nothing). Null only while some
 * call that went through has no price yet.
 */
export const KNOWN_COST_SQL = (cost: string, failed: string) =>
  `COALESCE(SUM(${cost}), CASE WHEN COUNT(*) FILTER (WHERE ${cost} IS NULL AND NOT ${failed}) = 0 THEN 0 END)`;

/** One row per run in the window, with its root span. Params: $1 project, $2 from, $3 to, $4 scope (scopeParam). */
export const RUNS_CTE = `
  calls AS (
    SELECT e.id, e.trace_id, e.trace_name, e.cost_usd, e.duration_ms, e.status_code, e.timestamp, e.parent_event_id,
           e.model, e.provider, e.span_id, e.context, e.group_kind, e.group_name,
           e.input_tokens, e.output_tokens, e.reasoning_tokens, e.cache_read_tokens, e.cache_creation_tokens,
           ${CACHE_WRITE_SQL("e")} AS cache_write_tokens,
           ${PROMPT_TOKENS_SQL("e")} AS prompt_tokens,
           ${OUTPUT_TOKENS_SQL("e")} AS completion_tokens,
           ${CACHE_REPORTED_SQL("e")} AS cache_reported,
           e.request_model, e.url, e.cost_basis, e.cost_source, e.pricing_id, e.image_output_tokens, e.native_units,
           e.lifecycle_state, e.lifecycle_error_type,
           (COALESCE(e.lifecycle_state, '') IN ('failed', 'cancelled') OR COALESCE(e.status_code, 200) >= 400) AS call_failed,
           ${WORK_ID_SQL("e")} AS work_id
    FROM events e
    WHERE e.project_id = $1 AND COALESCE(e.event_type, 'call') = 'call' AND e.trace_id IS NOT NULL
      AND e.timestamp >= $2 AND e.timestamp < $3
      AND ${SCOPE_FILTER("e")}
  ),
  runs AS (
    SELECT trace_id, MAX(trace_name) AS trace_name,
           ${KNOWN_COST_SQL("cost_usd", "call_failed")} AS cost, COUNT(*)::int AS calls,
           -- A failed call without a price cost nothing; it isn't unpriced.
           COUNT(*) FILTER (WHERE cost_usd IS NULL AND NOT call_failed)::int AS unpriced,
           MIN(timestamp) AS started_at,
           MAX(timestamp + COALESCE(duration_ms, 0) * INTERVAL '1 millisecond') AS ended_at,
           BOOL_OR(COALESCE(status_code, 200) >= 400) AS failed_call,
           MAX(COALESCE(context->>'userId', context->>'user_id', context->>'customer', context->>'customerId')) AS user_id,
           MAX(group_kind) AS group_kind, MAX(group_name) AS group_name,
           SUM(prompt_tokens)::bigint AS prompt_tokens, SUM(cache_read_tokens)::bigint AS cache_read_tokens,
           SUM(cache_write_tokens)::bigint AS cache_write_tokens, SUM(completion_tokens)::bigint AS completion_tokens,
           SUM(reasoning_tokens)::bigint AS reasoning_tokens, BOOL_OR(cache_reported) AS cache_reported,
           MAX(work_id) AS work_id
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
  run_base AS (
    SELECT r.*, ro.kind AS root_kind, ro.name AS root_name, ro.status AS root_status,
           COALESCE(sh.steps, 0) AS steps, COALESCE(sh.tools, 0) AS tools,
           (r.failed_call OR COALESCE(sh.failed_span, FALSE) OR COALESCE(t.state IN ('failed', 'error'), FALSE)) AS raw_failed,
           t.error_type,
           EXTRACT(EPOCH FROM (COALESCE(ro.ended_at, r.ended_at) - COALESCE(ro.started_at, r.started_at))) * 1000 AS duration_ms
    FROM runs r
    LEFT JOIN roots ro ON ro.trace_id = r.trace_id
    LEFT JOIN shape sh ON sh.trace_id = r.trace_id
    LEFT JOIN traces t ON t.project_id = $1 AND t.id = r.trace_id
  ),
  -- Attempts of one work item (context.work_id) are separate runs. A retry
  -- that found nothing left to do has no calls, so attempts come from the
  -- run list and from the runs table.
  attempts AS (
    SELECT trace_id, work_id, started_at, raw_failed AS failed, FALSE AS running FROM run_base WHERE work_id IS NOT NULL
    UNION ALL
    SELECT t.id, ${WORK_ID_SQL("t")}, COALESCE(t.started_at, t.created_at), t.state IN ('failed', 'error'), t.state IN ('started', 'running', 'in_progress')
    FROM traces t
    WHERE t.project_id = $1 AND ${WORK_ID_SQL("t")} IN (SELECT work_id FROM run_base WHERE work_id IS NOT NULL)
      AND t.id NOT IN (SELECT trace_id FROM run_base)
  ),
  -- A failed attempt that a later attempt completed is "retried", not failed:
  -- failure counts only the work item's last attempt.
  run_rows AS (
    SELECT b.*,
           (b.raw_failed AND later.trace_id IS NOT NULL) AS retried,
           (b.raw_failed AND later.trace_id IS NULL) AS failed,
           later.trace_id AS retried_by,
           later.attempt AS retried_on_attempt,
           CASE WHEN b.work_id IS NULL THEN 1
                ELSE (SELECT COUNT(*) FROM attempts o WHERE o.work_id = b.work_id AND (o.started_at, o.trace_id) <= (b.started_at, b.trace_id))::int END AS attempt
    FROM run_base b
    LEFT JOIN LATERAL (
      SELECT o.trace_id,
             (SELECT COUNT(*) FROM attempts p WHERE p.work_id = o.work_id AND (p.started_at, p.trace_id) <= (o.started_at, o.trace_id))::int AS attempt
      FROM attempts o
      WHERE b.raw_failed AND b.work_id IS NOT NULL AND o.work_id = b.work_id
        AND (o.started_at, o.trace_id) > (b.started_at, b.trace_id) AND NOT o.failed AND NOT o.running
      ORDER BY o.started_at, o.trace_id LIMIT 1
    ) later ON TRUE
  )`;

export const GROUP_COLUMNS = `
  COUNT(*)::int AS runs,
  SUM(cost) AS cost,
  SUM(cost) FILTER (WHERE unpriced = 0) / NULLIF(COUNT(*) FILTER (WHERE unpriced = 0), 0) AS cost_per_run,
  -- What each successful run really costs: every priced run's spend, failed
  -- runs included, over the priced runs that succeeded.
  SUM(cost) FILTER (WHERE unpriced = 0) / NULLIF(COUNT(*) FILTER (WHERE unpriced = 0 AND NOT raw_failed), 0) AS cost_per_success,
  COUNT(*) FILTER (WHERE unpriced > 0)::int AS partly_priced_runs,
  SUM(calls)::int AS calls,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
  COUNT(*) FILTER (WHERE failed)::int AS failed_runs,
  COUNT(*) FILTER (WHERE retried)::int AS retried_runs,
  AVG(steps)::float AS avg_steps,
  AVG(tools)::float AS avg_tools,
  MAX(started_at) AS last_run,
  ${USAGE_SUM_COLUMNS()}`;

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
    costPerSuccess: number(row.cost_per_success),
    partlyPricedRuns: number(row.partly_priced_runs) ?? 0,
    calls: number(row.calls) ?? 0,
    p50Ms: number(row.p50_ms),
    p95Ms: number(row.p95_ms),
    failedRuns: number(row.failed_runs) ?? 0,
    retriedRuns: number(row.retried_runs) ?? 0,
    avgSteps: number(row.avg_steps),
    avgTools: number(row.avg_tools),
    lastRun: row.last_run,
    usage: usageFrom(row),
  };
}

/** The window of equal length that ends where this one starts. */
export function previousWindow(from: string, to: string): { from: string; to: string } {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const length = Math.max(0, end - start);
  return { from: new Date(start - length).toISOString(), to: new Date(start).toISOString() };
}

/** Hourly buckets for short windows, daily otherwise. */
export function boardBucket(from: string, to: string): "hour" | "day" {
  return Date.parse(to) - Date.parse(from) <= 2 * DAY_MS + 5 * 60_000 ? "hour" : "day";
}

/** Run name for a non-agent run: workflow root span, batch/eval group, trace name. */
const WORKFLOW_NAME = "COALESCE(CASE WHEN root_kind = 'workflow' THEN root_name END, NULLIF(group_name, ''), NULLIF(trace_name, ''), root_name, 'Unnamed')";

/**
 * Scores on runs in the window. A score sent with only a span id takes that
 * span's trace. `checks.unit_scale` marks checks scored on 0..1, the only ones
 * that go into the overall average. Follows RUNS_CTE.
 */
const SCORED_CTE = `
  scored AS (
    SELECT sc.name, sc.value, r.trace_id, r.started_at
    FROM scores sc
    LEFT JOIN spans owner ON sc.trace_id IS NULL AND owner.project_id = sc.project_id AND owner.id = sc.span_id
    JOIN run_rows r ON r.trace_id = COALESCE(sc.trace_id, owner.trace_id)
    WHERE sc.project_id = $1
  ),
  checks AS (
    SELECT name, AVG(value) AS avg, COUNT(*)::int AS count, COUNT(DISTINCT trace_id)::int AS runs,
           (MIN(value) >= 0 AND MAX(value) <= 1) AS unit_scale
    FROM scored GROUP BY name
  )`;

/** Units a provider bills besides tokens, as ingest stores them in events.native_units. */
export const BILLED_UNITS = ["characters", "audioSeconds", "images", "searchQueries", "webSearchRequests", "pages", "credits", "requests"] as const;

/** Sum of billed native units per group. `alias.native_units` must be in scope. */
const UNIT_ROWS = (alias: string) => `
  CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(${alias}.native_units) = 'object' THEN ${alias}.native_units ELSE '{}'::jsonb END) u
  WHERE u.key = ANY(ARRAY['${BILLED_UNITS.join("','")}']) AND u.value ~ '^[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$'`;

type Units = Record<string, number>;

function unitsByKey(rows: Array<Record<string, unknown>>, keyOf: (row: Record<string, unknown>) => string): Map<string, Units> {
  const map = new Map<string, Units>();
  for (const row of rows) {
    const key = keyOf(row);
    const units = map.get(key) ?? {};
    units[String(row.unit)] = (units[String(row.unit)] ?? 0) + (number(row.total) ?? 0);
    map.set(key, units);
  }
  return map;
}

/** Local bucket label for a timestamp. Params: $5 bucket unit, $6 timezone. */
const BUCKET = (column: string) => `to_char(date_trunc($5::text, ${column} AT TIME ZONE $6::text), 'YYYY-MM-DD"T"HH24:MI')`;

export interface BoardWindow { from: string; to: string; environment: string | null; release?: string | null }

/** Everything the Overview board needs beyond spend totals, for one window and the one before it. */
export async function loadOverviewBoard(pool: pg.Pool, projectId: string, window: BoardWindow, timezone: string) {
  const previous = previousWindow(window.from, window.to);
  const bucket = boardBucket(window.from, window.to);
  const params = [projectId, window.from, window.to, scopeParam(window)];
  const previousParams = [projectId, previous.from, previous.to, scopeParam(window)];
  const bucketParams = [...params, bucket, timezone];
  const runCounts = `WITH ${RUNS_CTE}
    SELECT COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE root_kind = 'agent')::int AS agent_runs FROM run_rows`;
  const scoreTotals = `WITH ${RUNS_CTE}, ${SCORED_CTE}
    SELECT AVG(s.value) FILTER (WHERE c.unit_scale) AS avg,
           COUNT(*) FILTER (WHERE c.unit_scale)::int AS count,
           COUNT(*)::int AS all_count
    FROM scored s JOIN checks c ON c.name = s.name`;
  // Cost per model comes from the same charges the Overview's spend total
  // counts, so the table adds up to that total whatever the model bills.
  const chargeParams: unknown[] = [projectId];
  const chargeClauses = scopeClauses({ from: window.from, to: window.to, environment: window.environment ?? undefined, release: window.release ?? undefined }, chargeParams, "c");
  const eventFilter = `e.project_id = $1 AND COALESCE(e.event_type, 'call') = 'call'
    AND e.timestamp >= $2 AND e.timestamp < $3
    AND ${SCOPE_FILTER("e")}`;
  const unitTotals = `SELECT u.key AS unit, SUM(u.value::float) AS total FROM events e ${UNIT_ROWS("e")} AND ${eventFilter} GROUP BY 1`;
  const [modelCosts, modelUnits, unitsNow, unitsBefore, ownerUnits] = await Promise.all([
    pool.query(
      `${chargesCte(chargeParams)}
       SELECT c.provider, COALESCE(c.model, 'unknown') AS model, COUNT(*)::int AS charges,
              SUM(c.cost_usd) FILTER (WHERE c.cost_usd IS NOT NULL) AS cost,
              COUNT(*) FILTER (WHERE c.cost_usd IS NULL AND NOT c.no_charge)::int AS unpriced
       FROM charges c WHERE ${chargeClauses.join(" AND ")}
       GROUP BY 1, 2`,
      chargeParams,
    ),
    pool.query(`SELECT e.provider, COALESCE(e.model, e.request_model, 'unknown') AS model, u.key AS unit, SUM(u.value::float) AS total
       FROM events e ${UNIT_ROWS("e")} AND ${eventFilter} GROUP BY 1, 2, 3`, params),
    pool.query(unitTotals, params),
    pool.query(unitTotals, previousParams),
    pool.query(
      `WITH ${RUNS_CTE}
       SELECT CASE WHEN r.root_kind = 'agent' THEN 'agents' ELSE 'workflows' END AS kind,
              CASE WHEN r.root_kind = 'agent' THEN r.root_name ELSE ${WORKFLOW_NAME.replaceAll("root_kind", "r.root_kind").replaceAll("root_name", "r.root_name").replaceAll("group_name", "r.group_name").replaceAll("trace_name", "r.trace_name")} END AS name,
              u.key AS unit, SUM(u.value::float) AS total
       FROM run_rows r JOIN calls c ON c.trace_id = r.trace_id ${UNIT_ROWS("c")}
       GROUP BY 1, 2, 3`,
      params,
    ),
  ]);
  const [runsNow, runsBefore, scoresNow, scoresBefore, checks, scoreSeries, buckets, models, agents, volume, tools, latency] = await Promise.all([
    pool.query(runCounts, params),
    pool.query(runCounts, previousParams),
    pool.query(scoreTotals, params),
    pool.query(scoreTotals, previousParams),
    pool.query(`WITH ${RUNS_CTE}, ${SCORED_CTE} SELECT * FROM checks ORDER BY count DESC, name LIMIT 20`, params),
    pool.query(
      `WITH ${RUNS_CTE}, ${SCORED_CTE}
       SELECT name, ${BUCKET("started_at")} AS bucket, AVG(value) AS avg, COUNT(*)::int AS count
       FROM scored GROUP BY 1, 2 ORDER BY 1, 2`,
      bucketParams,
    ),
    pool.query(
      `SELECT to_char(b, 'YYYY-MM-DD"T"HH24:MI') AS bucket
       FROM generate_series(
         date_trunc($1::text, $2::timestamptz AT TIME ZONE $4::text),
         date_trunc($1::text, LEAST($3::timestamptz - INTERVAL '1 millisecond', NOW()) AT TIME ZONE $4::text),
         ('1 ' || $1::text)::interval) b
       LIMIT 2000`,
      [bucket, window.from, window.to, timezone],
    ),
    pool.query(
      `SELECT e.provider, COALESCE(e.model, e.request_model, 'unknown') AS model, COUNT(*)::int AS calls,
              -- The whole prompt and output with reasoning, as every token count in the console.
              SUM(${PROMPT_TOKENS_SQL("e")})::bigint AS input, SUM(${OUTPUT_TOKENS_SQL("e")})::bigint AS output,
              SUM(e.cache_read_tokens)::bigint AS cache_read, SUM(${CACHE_WRITE_SQL("e")})::bigint AS cache_write
       FROM events e
       WHERE e.project_id = $1 AND COALESCE(e.event_type, 'call') = 'call'
         AND e.timestamp >= $2 AND e.timestamp < $3
         AND ${SCOPE_FILTER("e")}
       GROUP BY 1, 2`,
      params,
    ),
    pool.query(
      `WITH ${RUNS_CTE}
       SELECT r.root_name AS name, COUNT(DISTINCT r.trace_id)::int AS runs,
              COALESCE(SUM(c.prompt_tokens), 0)::bigint AS input, COALESCE(SUM(c.completion_tokens), 0)::bigint AS output,
              ${KNOWN_COST_SQL("c.cost_usd", "c.call_failed")} AS cost, COUNT(*) FILTER (WHERE c.cost_usd IS NULL AND NOT c.call_failed)::int AS unpriced
       FROM run_rows r JOIN calls c ON c.trace_id = r.trace_id
       WHERE r.root_kind = 'agent'
       GROUP BY r.root_name
       ORDER BY SUM(c.cost_usd) DESC NULLS LAST, COUNT(*) DESC
       LIMIT 20`,
      params,
    ),
    pool.query(
      `WITH ${RUNS_CTE},
       owned AS (
         SELECT CASE WHEN root_kind = 'agent' THEN 'agents' ELSE 'workflows' END AS kind,
                CASE WHEN root_kind = 'agent' THEN root_name ELSE ${WORKFLOW_NAME} END AS name, calls
         FROM run_rows
       ),
       grouped AS (
         SELECT kind, name, COUNT(*)::int AS runs, SUM(calls)::int AS calls,
                ROW_NUMBER() OVER (PARTITION BY kind ORDER BY COUNT(*) DESC, name) AS rank
         FROM owned GROUP BY kind, name
       )
       SELECT kind, name, runs, calls FROM grouped WHERE rank <= 20 ORDER BY kind, rank`,
      params,
    ),
    pool.query(
      `WITH ${RUNS_CTE}
       SELECT s.name, COUNT(*)::int AS calls, COUNT(DISTINCT s.trace_id)::int AS runs
       FROM spans s
       WHERE s.project_id = $1 AND s.kind = 'tool' AND s.trace_id IN (SELECT trace_id FROM runs)
       GROUP BY s.name ORDER BY COUNT(*) DESC, s.name LIMIT 20`,
      params,
    ),
    pool.query(
      `WITH ${RUNS_CTE},
       samples AS (
         SELECT CASE WHEN root_kind = 'agent' THEN 'agents' ELSE 'workflows' END AS kind, ${BUCKET("started_at")} AS bucket, duration_ms
         FROM run_rows WHERE duration_ms IS NOT NULL
         UNION ALL
         SELECT 'tools', ${BUCKET("s.started_at")}, EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) * 1000
         FROM spans s
         WHERE s.project_id = $1 AND s.kind = 'tool' AND s.started_at IS NOT NULL AND s.ended_at IS NOT NULL
           AND s.trace_id IN (SELECT trace_id FROM runs)
       )
       SELECT kind, bucket, COUNT(*)::int AS count,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95
       FROM samples
       GROUP BY GROUPING SETS ((kind, bucket), (kind))
       ORDER BY kind, bucket NULLS FIRST`,
      bucketParams,
    ),
  ]);

  const workflowUsage = await pool.query(
    `WITH ${RUNS_CTE}
     SELECT ${WORKFLOW_NAME.replaceAll("root_kind", "r.root_kind").replaceAll("root_name", "r.root_name").replaceAll("group_name", "r.group_name").replaceAll("trace_name", "r.trace_name")} AS name,
            COUNT(DISTINCT r.trace_id)::int AS runs,
            COALESCE(SUM(c.prompt_tokens), 0)::bigint AS input, COALESCE(SUM(c.completion_tokens), 0)::bigint AS output,
            ${KNOWN_COST_SQL("c.cost_usd", "c.call_failed")} AS cost, COUNT(*) FILTER (WHERE c.cost_usd IS NULL AND NOT c.call_failed)::int AS unpriced
     FROM run_rows r JOIN calls c ON c.trace_id = r.trace_id
     WHERE r.root_kind IS DISTINCT FROM 'agent'
     GROUP BY 1
     ORDER BY SUM(c.cost_usd) DESC NULLS LAST, COUNT(*) DESC
     LIMIT 20`,
    params,
  );
  const ownerUnitMap = unitsByKey(ownerUnits.rows, (unit) => `${String(unit.kind)}\u0000${String(unit.name)}`);
  const counts = (row: Record<string, unknown> | undefined) => ({ runs: number(row?.runs) ?? 0, agentRuns: number(row?.agent_runs) ?? 0 });
  const scoreTotal = (row: Record<string, unknown> | undefined) => ({ avg: number(row?.avg), count: number(row?.count) ?? 0, allCount: number(row?.all_count) ?? 0 });
  const series = new Map<string, Array<{ bucket: string; avg: number | null; count: number }>>();
  for (const row of scoreSeries.rows as Array<Record<string, unknown>>) {
    const name = String(row.name);
    series.set(name, [...(series.get(name) ?? []), { bucket: String(row.bucket), avg: number(row.avg), count: number(row.count) ?? 0 }]);
  }
  const latencyKind = (kind: string) => {
    const rows = (latency.rows as Array<Record<string, unknown>>).filter((row) => row.kind === kind);
    const total = rows.find((row) => row.bucket == null);
    return {
      count: number(total?.count) ?? 0,
      p50Ms: number(total?.p50),
      p95Ms: number(total?.p95),
      series: rows.filter((row) => row.bucket != null).map((row) => ({ bucket: String(row.bucket), count: number(row.count) ?? 0, p50Ms: number(row.p50), p95Ms: number(row.p95) })),
    };
  };
  const volumeKind = (kind: string) => (volume.rows as Array<Record<string, unknown>>)
    .filter((row) => row.kind === kind)
    .map((row) => ({ name: String(row.name), runs: number(row.runs) ?? 0, calls: number(row.calls) ?? 0 }));

  return {
    window: { from: window.from, to: window.to, environment: window.environment, timezone, bucket },
    previous,
    buckets: (buckets.rows as Array<{ bucket: string }>).map((row) => row.bucket),
    runs: { current: counts(runsNow.rows[0]), previous: counts(runsBefore.rows[0]) },
    scores: {
      current: scoreTotal(scoresNow.rows[0]),
      previous: scoreTotal(scoresBefore.rows[0]),
      checks: (checks.rows as Array<Record<string, unknown>>).map((row) => ({
        name: String(row.name), avg: number(row.avg), count: number(row.count) ?? 0, runs: number(row.runs) ?? 0,
        unitScale: Boolean(row.unit_scale), series: series.get(String(row.name)) ?? [],
      })),
    },
    // Every model with calls or charges in the period, whatever it bills:
    // tokens, characters, audio seconds, images or searches.
    models: boardModels(models.rows, modelCosts.rows, modelUnits.rows),
    units: { current: unitsByKey(unitsNow.rows, () => "").get("") ?? {}, previous: unitsByKey(unitsBefore.rows, () => "").get("") ?? {} },
    agents: (agents.rows as Array<Record<string, unknown>>).map((row) => ({
      name: String(row.name), runs: number(row.runs) ?? 0, input: number(row.input) ?? 0, output: number(row.output) ?? 0,
      cost: number(row.cost), unpriced: number(row.unpriced) ?? 0,
      units: ownerUnitMap.get(`agents\u0000${String(row.name)}`) ?? {},
    })),
    workflows: (workflowUsage.rows as Array<Record<string, unknown>>).map((row) => ({
      name: String(row.name), runs: number(row.runs) ?? 0, input: number(row.input) ?? 0, output: number(row.output) ?? 0,
      cost: number(row.cost), unpriced: number(row.unpriced) ?? 0,
      units: ownerUnitMap.get(`workflows\u0000${String(row.name)}`) ?? {},
    })),
    volume: {
      agents: volumeKind("agents"),
      workflows: volumeKind("workflows"),
      tools: (tools.rows as Array<Record<string, unknown>>).map((row) => ({ name: String(row.name), runs: number(row.runs) ?? 0, calls: number(row.calls) ?? 0 })),
    },
    latency: { agents: latencyKind("agents"), workflows: latencyKind("workflows"), tools: latencyKind("tools") },
  };
}

/** How long after a retryable failure a retry is still expected. Queues retry within
 * minutes; past this, a run with no later attempt simply failed. */
export const RETRY_WAIT_MS = 15 * 60_000;

/** A run that raised a retryable error (by its name) is waiting for a retry only shortly
 * after it ended. A queue can drop the retry, so "will retry" is never shown for good. */
export function retryExpected(errorType: string | null, startedAt: unknown, durationMs: number | null = null, now = Date.now()): boolean {
  if (!/retry/i.test(errorType ?? "")) return false;
  const started = startedAt instanceof Date ? startedAt.getTime() : typeof startedAt === "string" || typeof startedAt === "number" ? new Date(startedAt).getTime() : NaN;
  if (!Number.isFinite(started)) return false;
  return now - (started + (durationMs ?? 0)) < RETRY_WAIT_MS;
}

/** How a run relates to other attempts of the same work item. */
export function retryInfo(row: Record<string, unknown>): { workId: string | null; attempt: number; retried: boolean; succeededBy: string | null; succeededOnAttempt: number | null; willRetry: boolean; errorType: string | null } {
  const errorType = row.error_type == null ? null : String(row.error_type);
  const retried = Boolean(row.retried);
  return {
    workId: row.work_id == null ? null : String(row.work_id),
    attempt: number(row.attempt) ?? 1,
    retried,
    succeededBy: retried && row.retried_by != null ? String(row.retried_by) : null,
    succeededOnAttempt: retried ? number(row.retried_on_attempt) : null,
    willRetry: !retried && Boolean(row.failed) && retryExpected(errorType, row.started_at, number(row.duration_ms)),
    errorType,
  };
}

/** Cache savings are kept per provider and model. */
function modelKey(row: Record<string, unknown>): string {
  return `${String(row.provider ?? "")}\u0000${String(row.model ?? "unknown")}`;
}

/** A model row's savings: null when it had no cache hits or one couldn't be checked. */
function savingsFor(savings: { byKey: Map<string, number | null> }, row: Record<string, unknown>): number | null {
  return savings.byKey.get(modelKey(row)) ?? null;
}

/** Board model rows: charges give cost, calls give tokens and billed units. Sorted by cost. */
function boardModels(tokenRows: Array<Record<string, unknown>>, costRows: Array<Record<string, unknown>>, unitRows: Array<Record<string, unknown>>) {
  const key = (row: Record<string, unknown>) => `${row.provider == null ? "" : String(row.provider)}\u0000${String(row.model)}`;
  const units = unitsByKey(unitRows, key);
  const rows = new Map<string, { provider: string | null; model: string; calls: number; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; cost: number | null; unpriced: number; units: Units }>();
  const row = (source: Record<string, unknown>) => {
    const id = key(source);
    const existing = rows.get(id) ?? { provider: source.provider == null ? null : String(source.provider), model: String(source.model), calls: 0, input: null, output: null, cacheRead: null, cacheWrite: null, cost: null, unpriced: 0, units: units.get(id) ?? {} };
    rows.set(id, existing);
    return existing;
  };
  for (const source of tokenRows) {
    const target = row(source);
    target.calls = number(source.calls) ?? 0;
    target.input = number(source.input);
    target.output = number(source.output);
    target.cacheRead = number(source.cache_read);
    target.cacheWrite = number(source.cache_write);
  }
  for (const source of costRows) {
    const target = row(source);
    target.cost = number(source.cost);
    target.unpriced = number(source.unpriced) ?? 0;
    if (target.calls === 0) target.calls = number(source.charges) ?? 0;
  }
  return [...rows.values()].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.calls - a.calls || a.model.localeCompare(b.model));
}

function fail(res: Response, label: string, error: unknown): void {
  console.error(`[costkey] ${label} error:`, error);
  res.status(500).json({ error: `Couldn't load ${label.toLowerCase()}` });
}

/** An agent's or workflow's page: summary, recent runs, tools, models, sub-agents and users. */
async function loadGroupDetail(pool: pg.Pool, req: Request, kind: "agent" | "workflow", name: string) {
  const window = windowFrom(req);
  const params = [req.params["projectId"], window.from, window.to, scopeParam(window), name];
  // The runs list is paged: `limit` (1-200, default 50) newest runs from `offset`.
  const runsLimit = Math.min(200, Math.max(1, Math.floor(Number(req.query["limit"])) || 50));
  const runsOffset = Math.max(0, Math.floor(Number(req.query["offset"])) || 0);
  // The agent's or workflow's runs, and only their calls, are worked out once
  // into temporary tables on one connection; every section below reads those.
  // Building them per section ran the whole window's runs nine times at once,
  // spilled each to disk and took every connection in the pool.
  const groupFilter = kind === "agent" ? "root_kind = 'agent' AND root_name = $5" : `root_kind IS DISTINCT FROM 'agent' AND ${WORKFLOW_NAME} = $5`;
  const client = await pool.connect();
  let results: pg.QueryResult[];
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE gd_runs ON COMMIT DROP AS WITH ${RUNS_CTE} SELECT * FROM run_rows WHERE ${groupFilter}`, params);
    await client.query(`CREATE TEMP TABLE gd_calls ON COMMIT DROP AS WITH ${RUNS_CTE} SELECT * FROM calls WHERE trace_id IN (SELECT trace_id FROM pg_temp.gd_runs)`, params.slice(0, 4));
    const projectId = params[0];
    const sections: Array<[string, unknown[]]> = [
      [`SELECT $1::text AS name, ${GROUP_COLUMNS} FROM gd_runs`, [name]],
      [`SELECT trace_id, started_at, cost, unpriced, calls, steps, tools, failed, retried, retried_by, retried_on_attempt, attempt, work_id, error_type, duration_ms, user_id,
              prompt_tokens, cache_read_tokens, cache_write_tokens, completion_tokens, reasoning_tokens, cache_reported
       FROM gd_runs ORDER BY started_at DESC, trace_id LIMIT ${runsLimit} OFFSET ${runsOffset}`, []],
      [`SELECT s.name, COUNT(*)::int AS calls,
              AVG(EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) * 1000) AS avg_ms,
              COUNT(*) FILTER (WHERE s.status = 'error')::int AS failed,
              COALESCE(SUM(c.cost), 0) AS cost
       FROM spans s
       LEFT JOIN (SELECT span_id, SUM(cost_usd) AS cost FROM gd_calls WHERE span_id IS NOT NULL GROUP BY span_id) c ON c.span_id = s.id
       WHERE s.project_id = $1 AND s.kind = 'tool' AND s.trace_id IN (SELECT trace_id FROM gd_runs)
       GROUP BY s.name ORDER BY COUNT(*) DESC LIMIT 50`, [projectId]],
      [`SELECT COALESCE(cl.model, 'unknown') AS model, cl.provider, COUNT(*)::int AS calls, SUM(cl.cost_usd) AS cost,
              ${USAGE_SUM_COLUMNS("cl.")}
       FROM gd_calls cl
       GROUP BY 1, 2 ORDER BY SUM(cl.cost_usd) DESC NULLS LAST LIMIT 20`, []],
      [`SELECT s.name, COUNT(DISTINCT s.trace_id)::int AS runs
       FROM spans s
       WHERE s.project_id = $1 AND s.kind = 'agent' AND s.parent_span_id IS NOT NULL
         AND s.trace_id IN (SELECT trace_id FROM gd_runs)${kind === "agent" ? " AND s.name <> $2" : ""}
       GROUP BY s.name ORDER BY COUNT(*) DESC LIMIT 20`, kind === "agent" ? [projectId, name] : [projectId]],
      [`SELECT ${SAVINGS_COLUMNS("cl")}
       FROM gd_calls cl WHERE cl.cache_read_tokens > 0
       LIMIT ${SAVINGS_ROW_LIMIT + 1}`, []],
      [`SELECT COALESCE(cl.model, 'unknown') AS model, cl.provider, u.key AS unit, SUM(u.value::float) AS total
       FROM gd_calls cl ${UNIT_ROWS("cl")}
       GROUP BY 1, 2, 3`, []],
      // Who the runs were for: context.customer or userId on their calls.
      [`SELECT user_id, COUNT(*)::int AS runs, SUM(calls)::int AS calls, SUM(cost) AS cost,
              COUNT(*) FILTER (WHERE failed)::int AS failed_runs, MAX(started_at) AS last_run,
              ${USAGE_SUM_COLUMNS()}
       FROM gd_runs WHERE user_id IS NOT NULL
       GROUP BY user_id ORDER BY SUM(cost) DESC NULLS LAST, COUNT(*) DESC LIMIT 20`, []],
      [`SELECT r.user_id, u.key AS unit, SUM(u.value::float) AS total
       FROM gd_runs r JOIN gd_calls c ON c.trace_id = r.trace_id ${UNIT_ROWS("c")} AND r.user_id IS NOT NULL
       GROUP BY 1, 2`, []],
    ];
    results = [];
    for (const [sql, values] of sections) results.push(await client.query(sql, values));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const [summary, runs, tools, models, subagents, cacheHits, modelUnits, users, userUnits] = results as [pg.QueryResult, pg.QueryResult, pg.QueryResult, pg.QueryResult, pg.QueryResult, pg.QueryResult, pg.QueryResult, pg.QueryResult, pg.QueryResult];
  const unitsByUser = unitsByKey(userUnits.rows, (row) => String(row.user_id));
  const unitsByModel = unitsByKey(modelUnits.rows, modelKey);
  const savings = sumCacheSavings(cacheHits.rows, modelKey);
  const agent = groupRow(summary.rows[0] ?? { name });
  (agent.usage as TokenUsage).cacheSavings = savings.total;
  return {
    agent,
    runs: runs.rows.map((row) => ({
      traceId: row.trace_id, startedAt: row.started_at, cost: row.unpriced > 0 && row.cost == null ? null : number(row.cost),
      unpriced: number(row.unpriced) ?? 0, calls: number(row.calls) ?? 0, steps: number(row.steps) ?? 0,
      tools: number(row.tools) ?? 0, failed: Boolean(row.failed), durationMs: number(row.duration_ms), userId: row.user_id ?? null,
      retry: retryInfo(row),
      usage: usageFrom(row),
    })),
    runsPage: { offset: runsOffset, limit: runsLimit, total: Number(agent.runs) || 0 },
    tools: tools.rows.map((row) => ({ name: row.name, calls: number(row.calls) ?? 0, avgMs: number(row.avg_ms), failed: number(row.failed) ?? 0, cost: number(row.cost) })),
    models: models.rows.map((row) => ({
      model: row.model, provider: row.provider, calls: number(row.calls) ?? 0, cost: number(row.cost),
      usage: { ...usageFrom(row), cacheSavings: savingsFor(savings, row) },
      units: unitsByModel.get(modelKey(row)) ?? {},
    })),
    subagents: subagents.rows.map((row) => ({ name: row.name, runs: number(row.runs) ?? 0 })),
    users: users.rows.map((row) => ({
      userId: String(row.user_id), runs: number(row.runs) ?? 0, calls: number(row.calls) ?? 0, cost: number(row.cost),
      failedRuns: number(row.failed_runs) ?? 0, lastRun: row.last_run, usage: usageFrom(row), units: unitsByUser.get(String(row.user_id)) ?? {},
    })),
  };
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
        [req.params["projectId"], window.from, window.to, scopeParam(window)],
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
        [req.params["projectId"], window.from, window.to, scopeParam(window)],
      );
      res.json({ agents: result.rows.map(groupRow) });
    } catch (error) { fail(res, "Agents", error); }
  });

  router.get("/api/v1/projects/:projectId/agents/:name", async (req: Request, res: Response) => {
    try { res.json(await loadGroupDetail(pool, req, "agent", String(req.params["name"]))); } catch (error) { fail(res, "Agent", error); }
  });

  router.get("/api/v1/projects/:projectId/workflows/:name", async (req: Request, res: Response) => {
    try { res.json(await loadGroupDetail(pool, req, "workflow", String(req.params["name"]))); } catch (error) { fail(res, "Workflow", error); }
  });

  /** Spend by model across agent runs or workflow runs, with the names that use each model most. */
  router.get("/api/v1/projects/:projectId/insights/models", async (req: Request, res: Response) => {
    const window = windowFrom(req);
    const agents = req.query["kind"] === "agent";
    const params = [req.params["projectId"], window.from, window.to, scopeParam(window)];
    const scopedRuns = `
         scoped AS (
           SELECT trace_id,
                  ${agents ? "root_name" : WORKFLOW_NAME} AS owner
           FROM run_rows
           WHERE ${agents ? "root_kind = 'agent'" : "root_kind IS DISTINCT FROM 'agent'"}
         )`;
    try {
      const result = await pool.query(
        `WITH ${RUNS_CTE}, ${scopedRuns},
         by_owner AS (
           SELECT COALESCE(c.model, 'unknown') AS model, c.provider, s.owner,
                  COUNT(*)::int AS calls, SUM(c.cost_usd) AS cost, COUNT(DISTINCT c.trace_id)::int AS runs,
                  SUM(c.prompt_tokens) AS prompt_tokens, SUM(c.cache_read_tokens) AS cache_read_tokens,
                  SUM(c.cache_write_tokens) AS cache_write_tokens, SUM(c.completion_tokens) AS completion_tokens,
                  SUM(c.reasoning_tokens) AS reasoning_tokens, BOOL_OR(c.cache_reported) AS cache_reported
           FROM calls c JOIN scoped s ON s.trace_id = c.trace_id
           GROUP BY 1, 2, 3
         )
         SELECT model, provider, SUM(calls)::int AS calls, SUM(runs)::int AS runs, SUM(cost) AS cost,
                (ARRAY_AGG(owner ORDER BY cost DESC NULLS LAST))[1:3] AS top_owners,
                ${USAGE_SUM_COLUMNS()}
         FROM by_owner GROUP BY model, provider
         ORDER BY SUM(cost) DESC NULLS LAST LIMIT 100`,
        params,
      );
      const cacheHits = await pool.query(
        `WITH ${RUNS_CTE}, ${scopedRuns}
         SELECT ${SAVINGS_COLUMNS("c")}
         FROM calls c WHERE c.trace_id IN (SELECT trace_id FROM scoped) AND c.cache_read_tokens > 0
         LIMIT ${SAVINGS_ROW_LIMIT + 1}`,
        params,
      );
      const savings = sumCacheSavings(cacheHits.rows, modelKey);
      const modelUnits = await pool.query(
        `WITH ${RUNS_CTE}, ${scopedRuns}
         SELECT COALESCE(c.model, 'unknown') AS model, c.provider, u.key AS unit, SUM(u.value::float) AS total
         FROM calls c ${UNIT_ROWS("c")} AND c.trace_id IN (SELECT trace_id FROM scoped)
         GROUP BY 1, 2, 3`,
        params,
      );
      const unitsByModel = unitsByKey(modelUnits.rows, modelKey);
      res.json({ models: result.rows.map((row) => ({
        model: row.model, provider: row.provider, calls: number(row.calls) ?? 0, runs: number(row.runs) ?? 0, cost: number(row.cost), topOwners: row.top_owners ?? [],
        usage: { ...usageFrom(row), cacheSavings: savingsFor(savings, row) },
        units: unitsByModel.get(modelKey(row)) ?? {},
      })) });
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
    const params = [req.params["projectId"], window.from, window.to, scopeParam(window)];
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
    const params = [req.params["projectId"], window.from, window.to, scopeParam(window)];
    const callFilter = `e.project_id = $1 AND COALESCE(e.event_type, 'call') = 'call'
      AND e.timestamp >= $2 AND e.timestamp < $3
      AND ${SCOPE_FILTER("e")}`;
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
             AND ${SCOPE_FILTER("s", false)}
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

  /** The Overview board: runs, scores, model tokens, agent usage, volume and latency for one window. */
  router.get("/api/v1/projects/:projectId/insights/board", async (req: Request, res: Response) => {
    const window = windowFrom(req);
    if (Date.parse(window.from) >= Date.parse(window.to)) {
      res.status(400).json({ error: "from must be before to" });
      return;
    }
    try {
      const projectId = req.params["projectId"] as string;
      res.json(await loadOverviewBoard(pool, projectId, window, await workspaceTimezone(pool, projectId)));
    } catch (error) { fail(res, "Overview board", error); }
  });

  return router;
}

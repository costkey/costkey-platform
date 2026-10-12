import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import { orgScope } from "./middleware.js";
import { workspaceTimezone } from "./quality-api.js";
import { BILLED_UNITS, boardBucket, RUNS_CTE } from "./insights-api.js";
import { getPriceCatalog } from "./price-catalog/catalog.js";
import type { PriceRates } from "./price-catalog/types.js";
import {
  CACHE_REPORTED_SQL, CACHE_WRITE_SQL, OUTPUT_TOKENS_SQL, PROMPT_TOKENS_SQL, SAVINGS_COLUMNS, SAVINGS_ROW_LIMIT,
  sumCacheSavings, sumCostBreakdown, USAGE_SUM_COLUMNS, usageFrom, type TokenUsage,
} from "./token-usage.js";

/**
 * One model's page: what it cost, who uses it, how it is priced and its
 * latest calls, for one provider and model in a window.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ModelDetailQuery {
  provider: string;
  model: string;
  from: string;
  to: string;
  environment: string | null;
  timezone: string;
}

/** Token rates are per 1M tokens; every other rate is per one unit. */
const TOKEN_RATES = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "inputAudio", "outputAudio", "inputImage", "outputImage"] as const;
const UNIT_RATES = ["perCharacter", "perSecond", "perQuery", "perRequest", "perPage", "perCredit", "perInputImage", "perOutputImage", "searchPerQuery", "mapsPerQuery", "perExtraResult"] as const;

export type ModelPriceRates = Partial<Record<(typeof TOKEN_RATES)[number] | (typeof UNIT_RATES)[number], number>>;

/** Run name for a non-agent run (mirrors insights-api WORKFLOW_NAME): workflow root span, batch/eval group, trace name. */
const WORKFLOW_NAME = (r: string) => `COALESCE(CASE WHEN ${r}.root_kind = 'workflow' THEN ${r}.root_name END, NULLIF(${r}.group_name, ''), NULLIF(${r}.trace_name, ''), ${r}.root_name, 'Unnamed')`;

/** A failed or cancelled call, or one the provider refused. */
const FAILED_SQL = (e: string) => `(COALESCE(${e}.lifecycle_state, '') IN ('failed', 'cancelled') OR COALESCE(${e}.status_code, 200) >= 400)`;

/**
 * This model's calls in the window. Params: $1 project, $2 from, $3 to,
 * $4 environment, $5 provider, $6 model. project_id and timestamp lead so
 * idx_events_project_ts does the work.
 */
const MODEL_CALLS = `e.project_id = $1 AND e.timestamp >= $2 AND e.timestamp < $3
  AND COALESCE(e.event_type, 'call') = 'call'
  AND ($4::text IS NULL OR COALESCE(NULLIF(e.context->>'environment', ''), '(unassigned)') = $4)
  AND e.provider = $5 AND COALESCE(e.model, e.request_model) = $6`;

/** A native_units number, or null when it isn't one. */
const UNIT_VALUE = (e: string, key: string) => `CASE WHEN jsonb_typeof(${e}.native_units -> '${key}') = 'number' THEN (${e}.native_units ->> '${key}')::float END`;

/**
 * RUNS_CTE limited to the runs that called this model, so the run table
 * isn't built for the whole project every refresh. Falls back to the whole
 * CTE if its call filter ever changes shape.
 */
function modelRunsCte(): string {
  const anchor = "e.trace_id IS NOT NULL";
  const scoped = RUNS_CTE.replace(anchor, `${anchor} AND e.trace_id IN (SELECT trace_id FROM model_traces)`);
  return `model_traces AS (SELECT DISTINCT e.trace_id FROM events e WHERE ${MODEL_CALLS} AND e.trace_id IS NOT NULL),${scoped === RUNS_CTE ? RUNS_CTE : scoped}`;
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

function numericUnits(value: unknown): Record<string, number> {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const units: Record<string, number> = {};
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const amount = number(raw);
    if (amount != null) units[key] = amount;
  }
  return units;
}

/** Catalog rates as people read them: token rates per 1M tokens, the rest per unit. */
export function displayRates(rates: PriceRates): ModelPriceRates {
  const out: ModelPriceRates = {};
  for (const key of TOKEN_RATES) {
    const value = rates[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value * 1_000_000;
  }
  for (const key of UNIT_RATES) {
    const value = rates[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** The current list price for a model, when the catalog has one. */
function currentPrice(provider: string, model: string) {
  const match = getPriceCatalog().resolve({ provider, model, at: new Date() });
  if (!match) return null;
  const { price } = match;
  return {
    source: "catalog" as const,
    catalogSource: price.source,
    match: match.match,
    provider: price.provider,
    model: price.model,
    effectiveFrom: price.effectiveFrom,
    rates: displayRates(price.rates),
    longContext: (price.rates.longContext ?? []).map((tier) => ({ threshold: tier.threshold, ...displayRates(tier) })),
  };
}

export async function loadModelDetail(pool: pg.Pool, projectId: string, query: ModelDetailQuery) {
  const params = [projectId, query.from, query.to, query.environment, query.provider, query.model];
  const bucket = boardBucket(query.from, query.to);
  const [summary, units, series, owners, recent, sources, cacheHits, pricedCalls] = await Promise.all([
    pool.query(
      `WITH c AS (
         SELECT e.cost_usd, e.duration_ms, e.cache_read_tokens, e.reasoning_tokens,
                ${CACHE_WRITE_SQL("e")} AS cache_write_tokens,
                ${PROMPT_TOKENS_SQL("e")} AS prompt_tokens,
                ${OUTPUT_TOKENS_SQL("e")} AS completion_tokens,
                ${CACHE_REPORTED_SQL("e")} AS cache_reported,
                ${FAILED_SQL("e")} AS failed,
                ${UNIT_VALUE("e", "cacheCreation5mTokens")} AS write_5m,
                ${UNIT_VALUE("e", "cacheCreation1hTokens")} AS write_1h
         FROM events e WHERE ${MODEL_CALLS}
       )
       SELECT COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE failed)::int AS failed_calls,
              SUM(cost_usd) AS cost, COUNT(cost_usd)::int AS priced_calls,
              -- A failed call without a price cost nothing; it isn't unpriced.
              COUNT(*) FILTER (WHERE cost_usd IS NULL AND NOT failed)::int AS unpriced_calls,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
              SUM(write_5m) AS write_5m, SUM(write_1h) AS write_1h,
              ${USAGE_SUM_COLUMNS()}
       FROM c`,
      params,
    ),
    pool.query(
      `SELECT u.key AS unit, SUM(u.value::float) AS total
       FROM events e
       CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(e.native_units) = 'object' THEN e.native_units ELSE '{}'::jsonb END) u
       WHERE ${MODEL_CALLS} AND u.key = ANY($7::text[]) AND u.value ~ '^[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$'
       GROUP BY 1`,
      [...params, [...BILLED_UNITS]],
    ),
    pool.query(
      `WITH buckets AS (
         SELECT to_char(b, 'YYYY-MM-DD"T"HH24:MI') AS bucket
         FROM generate_series(
           date_trunc($7::text, $2::timestamptz AT TIME ZONE $8::text),
           date_trunc($7::text, LEAST($3::timestamptz - INTERVAL '1 millisecond', NOW()) AT TIME ZONE $8::text),
           ('1 ' || $7::text)::interval) b
         LIMIT 2000
       ),
       spend AS (
         SELECT to_char(date_trunc($7::text, e.timestamp AT TIME ZONE $8::text), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
                SUM(e.cost_usd) AS cost, COUNT(*)::int AS calls
         FROM events e WHERE ${MODEL_CALLS}
         GROUP BY 1
       )
       SELECT b.bucket, COALESCE(s.cost, 0) AS cost, COALESCE(s.calls, 0)::int AS calls
       FROM buckets b LEFT JOIN spend s ON s.bucket = b.bucket
       ORDER BY b.bucket`,
      [...params, bucket, query.timezone],
    ),
    pool.query(
      `WITH ${modelRunsCte()},
       model_calls AS (
         SELECT c.trace_id, c.cost_usd FROM calls c
         WHERE c.provider = $5 AND COALESCE(c.model, c.request_model) = $6
       )
       SELECT CASE WHEN r.root_kind = 'agent' THEN 'agent' ELSE 'workflow' END AS kind,
              CASE WHEN r.root_kind = 'agent' THEN r.root_name ELSE ${WORKFLOW_NAME("r")} END AS name,
              COUNT(DISTINCT r.trace_id)::int AS runs, COUNT(*)::int AS calls, SUM(mc.cost_usd) AS cost
       FROM run_rows r JOIN model_calls mc ON mc.trace_id = r.trace_id
       GROUP BY 1, 2
       ORDER BY SUM(mc.cost_usd) DESC NULLS LAST, COUNT(*) DESC, 2
       LIMIT 50`,
      params,
    ),
    pool.query(
      `SELECT e.id, e.timestamp, e.trace_id, e.trace_name, e.cost_usd, e.cost_basis, e.cost_source, e.duration_ms,
              e.input_tokens, e.output_tokens, e.cache_read_tokens, e.native_units,
              e.lifecycle_state, e.lifecycle_error_type, e.status_code, ${FAILED_SQL("e")} AS failed
       FROM events e WHERE ${MODEL_CALLS}
       ORDER BY e.timestamp DESC
       LIMIT 25`,
      params,
    ),
    pool.query(
      // A failed call with no price cost nothing: it is its own row, not "no price".
      `SELECT CASE WHEN e.cost_usd IS NULL AND ${FAILED_SQL("e")} THEN 'failed' WHEN e.cost_usd IS NULL THEN 'unpriced' ELSE COALESCE(e.cost_basis, 'unknown') END AS basis,
              e.cost_source AS source,
              COUNT(*)::int AS calls, SUM(e.cost_usd) AS cost
       FROM events e WHERE ${MODEL_CALLS}
       GROUP BY 1, 2
       ORDER BY COUNT(*) DESC, 1, 2`,
      params,
    ),
    pool.query(
      `SELECT ${SAVINGS_COLUMNS("e")}
       FROM events e WHERE ${MODEL_CALLS} AND e.cache_read_tokens > 0
       LIMIT ${SAVINGS_ROW_LIMIT + 1}`,
      params,
    ),
    // Every priced call, to show how the period's cost adds up.
    pool.query(
      `SELECT ${SAVINGS_COLUMNS("e")}
       FROM events e WHERE ${MODEL_CALLS} AND e.cost_usd IS NOT NULL
       LIMIT ${SAVINGS_ROW_LIMIT + 1}`,
      params,
    ),
  ]);

  const total = (summary.rows[0] ?? {}) as Record<string, unknown>;
  const usage: TokenUsage = { ...usageFrom(total), cacheSavings: sumCacheSavings(cacheHits.rows).total };
  const unitTotals: Record<string, number> = {};
  for (const row of units.rows as Array<Record<string, unknown>>) unitTotals[String(row.unit)] = number(row.total) ?? 0;

  return {
    provider: query.provider,
    model: query.model,
    window: { from: query.from, to: query.to, environment: query.environment, timezone: query.timezone, bucket },
    summary: {
      calls: number(total.calls) ?? 0,
      failedCalls: number(total.failed_calls) ?? 0,
      cost: number(total.cost),
      pricedCalls: number(total.priced_calls) ?? 0,
      unpricedCalls: number(total.unpriced_calls) ?? 0,
      usage,
      units: unitTotals,
      p50Ms: number(total.p50_ms),
      p95Ms: number(total.p95_ms),
    },
    series: (series.rows as Array<Record<string, unknown>>).map((row) => ({
      bucket: String(row.bucket), cost: number(row.cost) ?? 0, calls: number(row.calls) ?? 0,
    })),
    owners: (owners.rows as Array<Record<string, unknown>>).map((row) => ({
      kind: row.kind === "agent" ? "agent" as const : "workflow" as const,
      name: String(row.name ?? "Unnamed"),
      runs: number(row.runs) ?? 0,
      calls: number(row.calls) ?? 0,
      cost: number(row.cost),
    })),
    recentCalls: (recent.rows as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      timestamp: iso(row.timestamp),
      traceId: row.trace_id == null ? null : String(row.trace_id),
      traceName: row.trace_name == null ? null : String(row.trace_name),
      costUsd: number(row.cost_usd),
      costBasis: row.cost_basis == null ? null : String(row.cost_basis),
      costSource: row.cost_source == null ? null : String(row.cost_source),
      durationMs: number(row.duration_ms),
      inputTokens: number(row.input_tokens),
      outputTokens: number(row.output_tokens),
      cacheReadTokens: number(row.cache_read_tokens),
      units: numericUnits(row.native_units),
      failed: row.failed === true,
      status: {
        lifecycleState: row.lifecycle_state == null ? null : String(row.lifecycle_state),
        errorType: row.lifecycle_error_type == null ? null : String(row.lifecycle_error_type),
        statusCode: number(row.status_code),
      },
    })),
    price: {
      current: currentPrice(query.provider, query.model),
      breakdown: sumCostBreakdown(pricedCalls.rows as Array<Record<string, unknown>>),
      sources: (sources.rows as Array<Record<string, unknown>>).map((row) => ({
        basis: String(row.basis),
        source: row.source == null ? null : String(row.source),
        calls: number(row.calls) ?? 0,
        cost: number(row.cost),
      })),
    },
    cacheWrites: {
      total: usage.cacheWriteTokens,
      fiveMinute: number(total.write_5m),
      oneHour: number(total.write_1h),
    },
  };
}

export type ModelDetail = Awaited<ReturnType<typeof loadModelDetail>>;

function text(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** Same window rules as the other insight routes: 30 days back by default. */
function windowFrom(req: Request): { from: string; to: string; environment: string | null } {
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

export function createModelDetailRouter(pool: pg.Pool): Router {
  const router = Router();
  router.use("/api/v1/projects/:projectId", requireAuth, orgScope(pool));

  /** Model names can hold slashes, so provider and model are query params. */
  router.get("/api/v1/projects/:projectId/model-detail", async (req: Request, res: Response) => {
    const provider = text(req.query["provider"]);
    const model = text(req.query["model"]);
    if (!provider || !model) {
      res.status(400).json({ error: "provider and model are required" });
      return;
    }
    const window = windowFrom(req);
    if (Date.parse(window.from) >= Date.parse(window.to)) {
      res.status(400).json({ error: "from must be before to" });
      return;
    }
    try {
      const projectId = req.params["projectId"] as string;
      const timezone = await workspaceTimezone(pool, projectId);
      res.json(await loadModelDetail(pool, projectId, { provider, model, ...window, timezone }));
    } catch (error) {
      console.error("[costkey] Model detail error:", error);
      res.status(500).json({ error: "Couldn't load this model" });
    }
  });

  return router;
}

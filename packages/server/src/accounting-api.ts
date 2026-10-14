import type { Request, Response, Router } from "express";
import { scopeSite } from "./scope-site.js";
import { findBusinessLogicFrame } from "./ingest.js";
import type { StackFrame } from "@costkey/shared";
import { Router as createRouter } from "express";
import type pg from "pg";
import { randomBytes } from "node:crypto";
import { orgScope } from "./middleware.js";
import { requireAuth } from "./auth.js";
import { roleCanManageWorkspace, roleCanPublishSharedView, roleCanReadContent } from "./permissions.js";
import {
  acknowledgeFinding,
  DEFAULT_FINDING_THRESHOLDS,
  getFinding,
  loadFindingThresholds,
  listFindings,
  refreshFindings,
  scheduleFindingsRefresh,
  type FindingThresholds,
} from "./findings.js";
import {
  createCredit,
  deleteCredit,
  listCredits,
  parseCreditInput,
  updateCredit,
} from "./credits.js";
import { calculateForecast, ForecastInputError, type ForecastScope, zonedMidnight } from "./forecast.js";
import {
  assertCanManageEffectivePrices,
  createEffectivePrice,
  deleteEffectivePrice,
  EffectivePriceConflictError,
  EffectivePriceInputError,
  EffectivePricePermissionError,
  listEffectivePrices,
  normalizeEffectivePriceInput,
  repriceHistoricalForEffectivePrice,
  updateEffectivePrice,
  type EffectivePriceInput,
} from "./effective-prices.js";
import { invalidateProjectPrices } from "./billing.js";
import {
  chargesCte,
  dimensionExpression,
  financialFields,
  loadDailyAggregates,
  loadCanonicalCharges,
  numeric,
  scopeClauses,
  type ChargeScope,
  type ScopeValues,
} from "./charge-cohort.js";
import { callCacheSavings, callCostBreakdown } from "./token-usage.js";
import { loadRetries } from "./retries.js";

type ScopeDimension = "feature" | "function" | "customer" | "model" | "provider" | "context";
type ExplorerSort = "newest" | "cost_desc" | "duration_desc" | "calls_desc";

const SAFE_CONTEXT_KEYS = new Set([
  "environment", "service", "release", "operation", "feature", "function", "functionName",
  "group", "groupName", "groupType", "executionId", "execution_id", "phase", "caseId", "case_id",
  "datasetRevision", "dataset_revision", "customer", "customerId", "customer_id", "traceId", "trace_id",
  "traceName", "trace_name", "runtime", "task",
  "agent", "tool", "userId", "conversationId", "voiceSessionId",
]);

interface ExplorerScope {
  from: string;
  to: string;
  environment?: ScopeValues;
  feature?: ScopeValues;
  function?: ScopeValues;
  file?: ScopeValues;
  functionName?: ScopeValues;
  customer?: ScopeValues;
  service?: ScopeValues;
  release?: ScopeValues;
  model?: ScopeValues;
  provider?: ScopeValues;
  traceId?: ScopeValues;
  executionId?: ScopeValues;
  q?: string;
  groupBy?: ScopeDimension;
  groupValue?: ScopeValues;
  contextKey?: string;
  contextValue?: ScopeValues;
  searchSource?: boolean;
  timezone?: string;
}

function value(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result.length > 0 ? result : undefined;
}

function queryValues(raw: unknown): string | string[] | undefined {
  if (Array.isArray(raw)) {
    const values = raw.flatMap((item) => typeof item === "string" ? [item.trim()] : []).filter(Boolean);
    return values.length === 0 ? undefined : values.length === 1 ? values[0] : values;
  }
  return value(raw);
}

/**
 * Keep explorer ordering server-owned.  The client may persist an old sort
 * value (or send arbitrary input), so unsupported values intentionally fall
 * back to the stable newest ordering instead of becoming SQL identifiers.
 */
export function explorerSort(raw: unknown, kind: "traces" | "events"): { value: ExplorerSort; orderBy: string } {
  const requested = value(raw);
  if (kind === "events") {
    switch (requested) {
      case "cost_desc": return { value: "cost_desc", orderBy: "e.cost_usd DESC NULLS LAST, e.timestamp DESC, e.id DESC" };
      case "duration_desc": return { value: "duration_desc", orderBy: "e.duration_ms DESC NULLS LAST, e.timestamp DESC, e.id DESC" };
      case "newest": return { value: "newest", orderBy: "e.timestamp DESC NULLS LAST, e.id DESC" };
      // calls_desc is a trace-only ordering.  The traces screen requests the
      // same sort for both tabs, so preserve a useful event response.
      default: return { value: "newest", orderBy: "e.timestamp DESC NULLS LAST, e.id DESC" };
    }
  }
  switch (requested) {
    case "cost_desc": return { value: "cost_desc", orderBy: "tb.known_cost DESC NULLS LAST, tb.started_at DESC NULLS LAST, tb.trace_id DESC" };
    case "duration_desc": return { value: "duration_desc", orderBy: "(EXTRACT(EPOCH FROM (tb.ended_at - tb.started_at)) * 1000) DESC NULLS LAST, tb.started_at DESC NULLS LAST, tb.trace_id DESC" };
    case "calls_desc": return { value: "calls_desc", orderBy: "tb.call_count DESC, tb.started_at DESC NULLS LAST, tb.trace_id DESC" };
    case "newest": return { value: "newest", orderBy: "tb.started_at DESC NULLS LAST, tb.trace_id DESC" };
    default: return { value: "newest", orderBy: "tb.started_at DESC NULLS LAST, tb.trace_id DESC" };
  }
}

function number(valueToParse: unknown, fallback: number): number {
  const result = Number(valueToParse);
  return Number.isFinite(result) ? result : fallback;
}

function randomId(prefix: string): string {
  return `${prefix}${randomBytes(12).toString("hex")}`;
}

function user(req: Request): { id?: string; role?: string } {
  return ((req as any).user ?? {}) as { id?: string; role?: string };
}

function isManager(req: Request): boolean {
  return roleCanManageWorkspace(user(req).role);
}

function requireManager(req: Request, res: Response): boolean {
  if (isManager(req)) return true;
  res.status(403).json({ error: "Only owners and admins can manage accounting settings" });
  return false;
}

function dateParam(raw: unknown, fallback: Date): string {
  const parsed = value(raw);
  if (!parsed) return fallback.toISOString();
  const date = new Date(parsed);
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

function validateExplorerRange(req: Request, res: Response): boolean {
  const from = value(req.query["from"]);
  const to = value(req.query["to"]);
  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) {
    res.status(400).json({ error: "from and to must be valid dates" });
    return false;
  }
  if (fromDate && toDate && fromDate >= toDate) {
    res.status(400).json({ error: "from must be before to" });
    return false;
  }
  return true;
}

/** Context values become SQL JSONB keys; only documented dimensions may be
 * queried.  Reject arrays and unknown keys rather than silently broadening a
 * scope or allowing a client to probe arbitrary metadata. */
export function validContextKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const candidate = raw.trim();
  return SAFE_CONTEXT_KEYS.has(candidate) ? candidate : null;
}

function validateContextKey(req: Request, res: Response): boolean {
  const raw = req.query["contextKey"];
  if (raw === undefined) return true;
  if (typeof raw !== "string" || validContextKey(raw) === null) {
    res.status(400).json({ error: "contextKey is not an allowed metadata key" });
    return false;
  }
  return true;
}

function readExplorerScope(req: Request): ExplorerScope {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const groupByValue = value(req.query["groupBy"]);
  const groupBy = groupByValue === "feature" || groupByValue === "function" || groupByValue === "customer"
    || groupByValue === "model" || groupByValue === "provider" || groupByValue === "context"
    ? groupByValue
    : undefined;
  return {
    from: dateParam(req.query["from"], defaultFrom),
    to: dateParam(req.query["to"], now),
    environment: queryValues(req.query["environment"]),
    feature: queryValues(req.query["feature"]),
    function: queryValues(req.query["function"] ?? req.query["fn"]),
    file: queryValues(req.query["file"]),
    functionName: queryValues(req.query["functionName"]),
    customer: queryValues(req.query["customer"]),
    service: queryValues(req.query["service"] ?? req.query["route"]),
    release: queryValues(req.query["release"]),
    model: queryValues(req.query["model"]),
    provider: queryValues(req.query["provider"]),
    traceId: queryValues(req.query["traceId"] ?? req.query["trace_id"]),
    executionId: queryValues(req.query["executionId"] ?? req.query["execution_id"]),
    q: value(req.query["q"] ?? req.query["search"]),
    groupBy,
    groupValue: queryValues(req.query["groupValue"] ?? req.query["value"]),
    contextKey: value(req.query["contextKey"]),
    contextValue: queryValues(req.query["contextValue"]),
  };
}

/** Source-location filters are not available without source access. */
function dropSourceFilters(scope: Pick<ChargeScope, "function" | "file" | "functionName">): void {
  scope.function = undefined;
  scope.file = undefined;
  scope.functionName = undefined;
}

async function workspaceTimezone(pool: pg.Pool, projectId: string): Promise<string> {
  try {
    const result = await pool.query(
      `SELECT COALESCE(ws.timezone, 'UTC') AS timezone
       FROM projects p LEFT JOIN workspace_settings ws ON ws.org_id = p.org_id
       WHERE p.id = $1`,
      [projectId],
    );
    const timezone = String(result.rows[0]?.timezone ?? "UTC");
    try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); return timezone; }
    catch { return "UTC"; }
  } catch {
    return "UTC";
  }
}

async function sourceAccessAllowed(pool: pg.Pool, projectId: string, role: unknown): Promise<boolean> {
  if (!roleCanReadContent(role)) return false;
  try {
    const result = await pool.query(
      "SELECT COALESCE(source_access_enabled, FALSE) AS enabled FROM project_settings WHERE project_id = $1",
      [projectId],
    );
    return result.rows[0]?.enabled === true;
  } catch {
    // Unknown source policy is a privacy failure.  The caller must return
    // aggregate metadata only until the setting can be read.
    return false;
  }
}

function exposeEvent(row: Record<string, unknown>, restricted: boolean): Record<string, unknown> {
  if (!restricted) return row;
  const sanitized = { ...row };
  for (const field of [
    "request_body", "response_body", "system_prompt", "call_site_raw",
    "call_site_frames", "bl_file", "bl_function", "bl_line",
  ]) delete sanitized[field];
  delete sanitized.metadata;
  if (sanitized.context && typeof sanitized.context === "object" && !Array.isArray(sanitized.context)) {
    const safeContext: Record<string, unknown> = {};
    for (const [key, contextValue] of Object.entries(sanitized.context as Record<string, unknown>)) {
      if (SAFE_CONTEXT_KEYS.has(key)
        && (typeof contextValue === "string" || typeof contextValue === "number" || typeof contextValue === "boolean")) {
        safeContext[key] = contextValue;
      }
    }
    sanitized.context = safeContext;
  } else {
    delete sanitized.context;
  }
  if (Object.prototype.hasOwnProperty.call(sanitized, "content_status")) sanitized["content_status"] = "restricted";
  return sanitized;
}

interface AvailableFiltersResult {
  filters: Record<string, unknown>;
  complete: boolean;
  nextCursor: string | null;
  limit: number;
  offset: number;
}

/**
 * Aggregate filter options in PostgreSQL. This intentionally does not call
 * loadCanonicalCharges(): a project may have millions of charges and option
 * discovery must remain bounded in both result size and application memory.
 */
async function loadAvailableFilters(
  pool: pg.Pool | pg.PoolClient,
  projectId: string,
  scope: ChargeScope,
  restricted: boolean,
  options: { limit?: number; offset?: number; search?: string | null } = {},
): Promise<AvailableFiltersResult> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 100);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  const params: unknown[] = [projectId];
  const clauses = scopeClauses(scope, params, "c");
  const safeKeys = [...SAFE_CONTEXT_KEYS];
  params.push(safeKeys);
  const contextKeysParam = params.length;
  params.push(options.search ? `%${options.search}%` : null);
  const searchParam = params.length;
  params.push(limit);
  const limitParam = params.length;
  params.push(offset);
  const offsetParam = params.length;
  const functionDimension = restricted ? "" : `
           UNION ALL
           SELECT 'function'::text AS dimension,
                  CASE WHEN c.bl_file IS NULL AND c.bl_function IS NULL THEN '(unassigned)'
                       WHEN NULLIF(c.context->>'service', '') IS NULL THEN COALESCE(NULLIF(c.bl_file || ':' || c.bl_function, ':'), '(unassigned)')
                       ELSE (c.context->>'service') || ':' || COALESCE(NULLIF(c.bl_file || ':' || c.bl_function, ':'), '(unassigned)') END AS value,
                  COUNT(*)::int AS observations,
                  'charges'::text AS count_unit
           FROM base c GROUP BY 1, 2`;
  const result = await pool.query(
    `${chargesCte()},
       base AS (
         SELECT c.* FROM charges c WHERE ${clauses.join(" AND ")}
       ), trace_rollup AS (
         SELECT c.trace_id,
                COALESCE(MAX(t.state), 'unknown') AS lifecycle,
                COUNT(*)::int AS observations,
                COUNT(*) FILTER (WHERE c.cost_usd IS NULL)::int AS unpriced
         FROM base c
         LEFT JOIN traces t ON t.project_id = c.project_id AND t.id = c.trace_id
         WHERE c.trace_id IS NOT NULL
         GROUP BY c.trace_id
       ), dimension_values AS (
         SELECT 'provider'::text AS dimension, COALESCE(NULLIF(c.provider, ''), '(unknown)') AS value,
                COUNT(*)::int AS observations, 'charges'::text AS count_unit
         FROM base c GROUP BY 1, 2
         UNION ALL
         SELECT 'model'::text, COALESCE(NULLIF(c.model, ''), '(unknown)'), COUNT(*)::int, 'charges'::text
         FROM base c GROUP BY 1, 2
         UNION ALL
         SELECT 'environment'::text, COALESCE(NULLIF(c.context->>'environment', ''), '(unassigned)'), COUNT(*)::int, 'charges'::text
         FROM base c GROUP BY 1, 2
         UNION ALL
         SELECT 'feature'::text, COALESCE(NULLIF(c.context->>'feature', ''), '(unassigned)'), COUNT(*)::int, 'charges'::text
         FROM base c GROUP BY 1, 2
         UNION ALL
         SELECT 'customer'::text, COALESCE(NULLIF(c.context->>'customer', ''), '(unassigned)'), COUNT(*)::int, 'charges'::text
         FROM base c GROUP BY 1, 2${functionDimension}
         UNION ALL
         SELECT 'context:' || kv.key, COALESCE(NULLIF(kv.value, ''), '(unassigned)'), COUNT(*)::int, 'charges'::text
         FROM base c
         CROSS JOIN LATERAL jsonb_each_text(
           CASE WHEN jsonb_typeof(COALESCE(c.context, '{}'::jsonb)) = 'object'
                THEN COALESCE(c.context, '{}'::jsonb) ELSE '{}'::jsonb END
         ) AS kv(key, value)
         WHERE kv.key = ANY($${contextKeysParam}::text[])
         GROUP BY 1, 2
         UNION ALL
         SELECT 'lifecycle'::text, lifecycle, COUNT(*)::int, 'traces'::text
         FROM trace_rollup GROUP BY 1, 2
         UNION ALL
         SELECT 'accounting'::text,
                CASE WHEN observations = 0 THEN 'pending' WHEN unpriced > 0 THEN 'partial' ELSE 'complete' END,
                COUNT(*)::int, 'traces'::text
         FROM trace_rollup GROUP BY 1, 2
         UNION ALL
         SELECT 'coverage'::text, CASE WHEN c.cost_usd IS NULL THEN 'unpriced' ELSE 'priced' END,
                COUNT(*)::int, 'charges'::text
         FROM base c GROUP BY 1, 2
         UNION ALL
         SELECT 'status'::text, COALESCE(e.status_code::text, '(unknown)'), COUNT(*)::int, 'charges'::text
         FROM base c
         LEFT JOIN events e ON c.record_type = 'call' AND e.project_id = c.project_id AND e.id = c.record_id
         GROUP BY 1, 2
       ), searched AS (
         SELECT dimension, value, observations, count_unit,
                ROW_NUMBER() OVER (PARTITION BY dimension ORDER BY value) - 1 AS position,
                COUNT(*) OVER (PARTITION BY dimension)::int AS total_values
         FROM dimension_values
         WHERE $${searchParam}::text IS NULL OR value ILIKE $${searchParam}::text
       )
       SELECT dimension, value, observations, count_unit, position, total_values
       FROM searched
       WHERE position >= $${offsetParam} AND position < $${offsetParam} + $${limitParam}
       ORDER BY dimension, position`,
    params,
  );
  const providers: string[] = [];
  const models: string[] = [];
  const environments: string[] = [];
  const features: string[] = [];
  const customers: string[] = [];
  const functions: string[] = [];
  const lifecycles: string[] = [];
  const accounting: string[] = [];
  const coverage: string[] = [];
  const statuses: string[] = [];
  const contextValues = new Map<string, Array<{ value: string; count: number }>>();
  const filterCounts: Record<string, Record<string, number>> = {};
  const countUnits: Record<string, string> = {};
  let complete = true;
  for (const row of result.rows ?? []) {
    const dimension = String(row.dimension);
    const item = String(row.value);
    const count = Number(row.observations ?? 0);
    const unit = String(row.count_unit ?? "charges");
    if (Number(row.total_values ?? 0) > offset + limit) complete = false;
    const counts = filterCounts[dimension] ?? {};
    counts[item] = count;
    filterCounts[dimension] = counts;
    countUnits[dimension] = unit;
    if (dimension === "provider") providers.push(item);
    else if (dimension === "model") models.push(item);
    else if (dimension === "environment") environments.push(item);
    else if (dimension === "feature") features.push(item);
    else if (dimension === "customer") customers.push(item);
    else if (dimension === "function") functions.push(item);
    else if (dimension === "lifecycle") lifecycles.push(item);
    else if (dimension === "accounting") accounting.push(item);
    else if (dimension === "coverage") coverage.push(item);
    else if (dimension === "status") statuses.push(item);
    else if (dimension.startsWith("context:")) {
      const key = dimension.slice("context:".length);
      const values = contextValues.get(key) ?? [];
      values.push({ value: item, count });
      contextValues.set(key, values);
    }
  }
  const contexts: Record<string, { values: string[]; counts: Record<string, number> }> = {};
  for (const [key, rows] of contextValues) {
    contexts[key] = {
      values: rows.map((row) => row.value),
      counts: Object.fromEntries(rows.map((row) => [row.value, row.count])),
    };
  }
  const filters: Record<string, unknown> = {
    providers, models, environments, features, customers, lifecycles, accounting, coverage, statuses,
    functions: restricted ? [] : functions,
    contextKeys: Object.keys(contexts).sort(),
    contexts,
    counts: filterCounts,
    countUnits,
  };
  return {
    filters,
    complete,
    nextCursor: complete ? null : String(offset + limit),
    limit,
    offset,
  };
}

function aggregateGroupKey(scope: ChargeScope, row: Record<string, unknown>): string {
  switch (scope.groupBy) {
    case "function": return String(row.function_key ?? "(unassigned)");
    case "customer": return String(row.customer ?? "(unassigned)");
    case "model": return String(row.model ?? "(unknown)");
    case "provider": return String(row.provider ?? "(unknown)");
    case "context": {
      const key = scope.contextKey;
      if (key === "environment") return String(row.environment ?? "(unassigned)");
      if (key === "feature") return String(row.feature ?? "(unassigned)");
      if (key === "customer") return String(row.customer ?? "(unassigned)");
      if (key === "provider") return String(row.provider ?? "(unknown)");
      if (key === "model") return String(row.model ?? "(unknown)");
      return "(unassigned)";
    }
    case "feature":
    default: return String(row.feature ?? "(unassigned)");
  }
}

/** Merge detail rollups with already-reconciled daily rows without exposing
 * aggregate-only rows as traces or pretending their trace evidence exists. */
function mergeFinancialRollups(
  detailRows: Array<Record<string, unknown>>,
  aggregateRows: Array<Record<string, unknown>>,
  scope: ChargeScope,
): Array<Record<string, unknown>> {
  const merged = new Map<string, Record<string, unknown>>();
  const add = (input: Record<string, unknown>, aggregate: boolean): void => {
    const key = aggregate ? aggregateGroupKey(scope, input) : String(input.group_key);
    const row = merged.get(key) ?? {
      group_key: key,
      observations: 0,
      call_count: 0,
      priced_observations: 0,
      unpriced_observations: 0,
      known_cost: null,
      trace_count: 0,
      fully_priced_trace_count: 0,
      fully_priced_trace_cost_usd: 0,
      untraced_usage_count: 0,
      untraced_usage_cost: null,
    };
    const value = (field: string, fallback = 0): number => {
      const parsed = Number(input[field]);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    row.observations = Number(row.observations) + value("observations");
    row.call_count = Number(row.call_count) + value(aggregate ? "call_count" : "call_count");
    row.priced_observations = Number(row.priced_observations) + value("priced_observations");
    row.unpriced_observations = Number(row.unpriced_observations) + value(aggregate ? "unpriced_observations" : "unpriced_observations");
    const known = input[aggregate ? "known_cost_usd" : "known_cost"];
    if (known !== null && known !== undefined && Number.isFinite(Number(known))) {
      row.known_cost = Number(row.known_cost ?? 0) + Number(known);
    }
    row.trace_count = Number(row.trace_count) + value("trace_count");
    row.fully_priced_trace_count = Number(row.fully_priced_trace_count) + value("fully_priced_trace_count");
    const traceCost = aggregate ? input.fully_priced_trace_cost_usd : input.fully_priced_trace_cost;
    if (traceCost !== null && traceCost !== undefined && Number.isFinite(Number(traceCost))) {
      row.fully_priced_trace_cost_usd = Number(row.fully_priced_trace_cost_usd) + Number(traceCost);
    }
    row.untraced_usage_count = Number(row.untraced_usage_count) + value("untraced_usage_count");
    const untracedCost = aggregate ? null : input.untraced_usage_cost;
    if (untracedCost !== null && untracedCost !== undefined && Number.isFinite(Number(untracedCost))) {
      row.untraced_usage_cost = Number(row.untraced_usage_cost ?? 0) + Number(untracedCost);
    }
    merged.set(key, row);
  };
  for (const row of detailRows) add(row, false);
  for (const row of aggregateRows) add(row, true);
  for (const row of merged.values()) {
    row.mean_cost_per_charge = Number(row.priced_observations) > 0 && row.known_cost != null
      ? Number(row.known_cost) / Number(row.priced_observations) : null;
    row.mean_cost_per_trace = Number(row.fully_priced_trace_count) > 0
      ? Number(row.fully_priced_trace_cost_usd) / Number(row.fully_priced_trace_count) : null;
    row.unpriced_observations = Number(row.observations) - Number(row.priced_observations);
  }
  return [...merged.values()];
}

interface FinancialTotals {
  observations: number;
  calls: number;
  priced: number;
  cost: number;
  tokens: number;
  topFunctions: Array<{ function_name: string | null; file_name: string | null; cost: number; calls: number }>;
  byRelease: Array<{ release: string; observations: number; calls: number; priced: number; cost: number }>;
}

/** Bounded headline query used by Summary and retained-history views. */
async function loadFinancialTotals(pool: pg.Pool, projectId: string, scope: ChargeScope): Promise<FinancialTotals> {
  const detailParams: unknown[] = [projectId];
  const detailClauses = scopeClauses({ ...scope, groupBy: undefined, groupValue: undefined }, detailParams, "c");
  const [totals, functions, releases, aggregates] = await Promise.all([
    pool.query(
      `${chargesCte()}
       SELECT COUNT(*)::int AS observations,
              COUNT(*) FILTER (WHERE c.record_type = 'call')::int AS calls,
              COUNT(*) FILTER (WHERE c.cost_usd IS NOT NULL)::int AS priced,
              SUM(c.cost_usd) FILTER (WHERE c.cost_usd IS NOT NULL) AS known_cost,
              COALESCE(SUM(c.total_tokens),0)::bigint AS tokens
       FROM charges c WHERE ${detailClauses.join(" AND ")}`,
      detailParams,
    ),
    pool.query(
      `${chargesCte()}
       SELECT c.bl_function AS function_name, c.bl_file AS file_name,
              SUM(c.cost_usd) FILTER (WHERE c.cost_usd IS NOT NULL) AS cost,
              COUNT(*) FILTER (WHERE c.record_type = 'call')::int AS calls
       FROM charges c WHERE ${detailClauses.join(" AND ")}
       GROUP BY c.bl_function, c.bl_file
       ORDER BY cost DESC NULLS LAST, calls DESC LIMIT 5`,
      detailParams,
    ),
    pool.query(
      `${chargesCte()}
       SELECT COALESCE(NULLIF(c.release, ''), NULLIF(c.context->>'release', ''), '(unassigned)') AS release,
              COUNT(*)::int AS observations,
              COUNT(*) FILTER (WHERE c.record_type = 'call')::int AS calls,
              COUNT(*) FILTER (WHERE c.cost_usd IS NOT NULL)::int AS priced,
              SUM(c.cost_usd) FILTER (WHERE c.cost_usd IS NOT NULL) AS cost
       FROM charges c WHERE ${detailClauses.join(" AND ")}
       GROUP BY 1 ORDER BY cost DESC NULLS LAST, release ASC LIMIT 100`,
      detailParams,
    ),
    loadDailyAggregates(pool, projectId, { ...scope, groupBy: undefined, groupValue: undefined }, scope.timezone ?? "UTC"),
  ]);
  const total = {
    observations: Number(totals.rows[0]?.observations ?? 0),
    calls: Number(totals.rows[0]?.calls ?? 0),
    priced: Number(totals.rows[0]?.priced ?? 0),
    cost: Number(totals.rows[0]?.known_cost ?? 0),
    tokens: Number(totals.rows[0]?.tokens ?? 0),
  };
  const top = new Map<string, { function_name: string | null; file_name: string | null; cost: number; calls: number }>();
  for (const row of functions.rows as Array<Record<string, unknown>>) {
    const key = `${row.file_name ?? ""}\u0000${row.function_name ?? "(unassigned)"}`;
    top.set(key, { function_name: row.function_name == null ? null : String(row.function_name), file_name: row.file_name == null ? null : String(row.file_name), cost: Number(row.cost ?? 0), calls: Number(row.calls ?? 0) });
  }
  const byRelease = new Map<string, { release: string; observations: number; calls: number; priced: number; cost: number }>();
  for (const row of releases.rows as Array<Record<string, unknown>>) {
    const release = String(row.release ?? "(unassigned)");
    byRelease.set(release, {
      release,
      observations: Number(row.observations ?? 0),
      calls: Number(row.calls ?? 0),
      priced: Number(row.priced ?? 0),
      cost: Number(row.cost ?? 0),
    });
  }
  for (const row of aggregates) {
    total.observations += Number(row.observations ?? 0);
    total.calls += Number(row.call_count ?? 0);
    total.priced += Number(row.priced_observations ?? 0);
    total.cost += Number(row.known_cost_usd ?? 0);
    total.tokens += Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0);
    const functionName = row.function_key === "(unassigned)" ? null : String(row.function_key ?? "");
    const key = `${functionName ?? ""}`;
    const item = top.get(key) ?? { function_name: functionName, file_name: null, cost: 0, calls: 0 };
    item.cost += Number(row.known_cost_usd ?? 0);
    item.calls += Number(row.call_count ?? 0);
    top.set(key, item);
    const release = String(row.release ?? "(unassigned)");
    const releaseRow = byRelease.get(release) ?? { release, observations: 0, calls: 0, priced: 0, cost: 0 };
    releaseRow.observations += Number(row.observations ?? 0);
    releaseRow.calls += Number(row.call_count ?? 0);
    releaseRow.priced += Number(row.priced_observations ?? 0);
    releaseRow.cost += Number(row.known_cost_usd ?? 0);
    byRelease.set(release, releaseRow);
  }
  return {
    ...total,
    topFunctions: [...top.values()].sort((left, right) => right.cost - left.cost || right.calls - left.calls).slice(0, 5),
    byRelease: [...byRelease.values()].sort((left, right) => right.cost - left.cost || left.release.localeCompare(right.release)),
  };
}

function traceCte(): string {
  return `${chargesCte()},
    charge_rollup AS (
      SELECT project_id, trace_id,
             MAX(execution_id) AS execution_id,
             MAX(group_id) AS group_id,
             MAX(trace_name) AS trace_name,
             MAX(provider) AS provider,
             MAX(model) AS model,
             COUNT(*)::int AS observations,
             COUNT(*) FILTER (WHERE cost_usd IS NOT NULL)::int AS priced_observations,
             COUNT(*) FILTER (WHERE cost_usd IS NULL AND NOT no_charge)::int AS unpriced_observations,
             SUM(cost_usd) FILTER (WHERE cost_usd IS NOT NULL) AS known_cost,
             STRING_AGG(DISTINCT provider, ',') AS providers,
             STRING_AGG(DISTINCT model, ',') AS models,
             MAX(context->>'feature') AS feature,
             MAX(context->>'environment') AS environment,
             MAX(context->>'customer') AS customer,
             MAX(COALESCE(NULLIF(service, ''), context->>'service')) AS service,
             MAX(COALESCE(NULLIF(release, ''), context->>'release')) AS release,
             MAX(bl_file) AS bl_file,
             MAX(bl_function) AS bl_function,
             MAX(phase) AS phase,
             MIN(timestamp) AS charge_started_at,
             MAX(timestamp + COALESCE(duration_ms, 0) * INTERVAL '1 millisecond') AS charge_ended_at
      FROM charges
      WHERE trace_id IS NOT NULL
      GROUP BY project_id, trace_id
    ),
    call_rollup AS (
      SELECT e.project_id, e.trace_id,
             COUNT(*)::int AS call_count,
             MAX(e.trace_name) AS trace_name,
             MAX(e.context->>'feature') AS feature,
             MAX(e.context->>'environment') AS environment,
             MAX(e.context->>'customer') AS customer,
             MAX(e.context->>'service') AS service,
             MAX(e.release) AS release,
             MAX(e.bl_file) AS bl_file,
             MAX(e.bl_function) AS bl_function,
             MAX(e.execution_id) AS execution_id,
             MAX(e.phase) AS phase,
             MAX(e.context->>'agent') AS agent,
             MAX(e.context->>'userId') AS user_id,
             MAX(e.context->>'conversationId') AS conversation_id,
             SUM(e.input_tokens)::bigint AS total_input_tokens,
             SUM(e.output_tokens)::bigint AS total_output_tokens,
             COUNT(*) FILTER (WHERE COALESCE(e.lifecycle_state, '') IN ('failed', 'cancelled', 'canceled')
               OR COALESCE(e.status_code, 200) >= 400)::int AS failed_call_count,
             MIN(e.timestamp) AS observed_started_at,
             MAX(e.timestamp + COALESCE(e.duration_ms, 0) * INTERVAL '1 millisecond') AS observed_ended_at
      FROM events e
      WHERE COALESCE(e.event_type, 'call') = 'call' AND e.trace_id IS NOT NULL
      GROUP BY e.project_id, e.trace_id
    ),
    span_rollup AS (
      SELECT project_id, trace_id,
             COUNT(*) FILTER (WHERE kind = 'agent')::int AS agent_count,
             COUNT(*) FILTER (WHERE kind = 'step')::int AS step_count,
             COUNT(*) FILTER (WHERE kind = 'tool')::int AS tool_count,
             MIN(name) FILTER (WHERE kind = 'agent' AND parent_span_id IS NULL) AS root_agent,
             BOOL_OR(status = 'error') AS has_error,
             BOOL_OR(status = 'error' AND parent_span_id IS NULL) AS root_error
      FROM spans
      WHERE trace_id IS NOT NULL
      GROUP BY project_id, trace_id
    ),
    trace_keys AS (
      SELECT t.project_id, t.id AS trace_id FROM traces t
      UNION
      SELECT e.project_id, e.trace_id FROM events e
       WHERE e.trace_id IS NOT NULL
      UNION
      SELECT u.project_id, u.trace_id FROM usage_components u
       WHERE u.trace_id IS NOT NULL AND (u.aggregation = 'delta' OR u.active = TRUE)
    ),
    trace_base AS (
      SELECT k.project_id, k.trace_id,
             COALESCE(t.trace_name, cr.trace_name) AS trace_name,
             COALESCE(t.execution_id, cr.execution_id, rr.execution_id) AS execution_id,
             COALESCE(t.group_id, rr.group_id) AS group_id,
             COALESCE(t.state, 'unknown') AS execution_state,
             t.accounting_state AS stored_accounting_state,
             COALESCE(t.started_at, cr.observed_started_at, rr.charge_started_at) AS started_at,
             COALESCE(t.ended_at, cr.observed_ended_at, rr.charge_ended_at) AS ended_at,
             COALESCE(cr.call_count, 0)::int AS call_count,
             COALESCE(rr.observations, 0)::int AS observations,
             COALESCE(rr.priced_observations, 0)::int AS priced_observations,
             COALESCE(rr.unpriced_observations, 0)::int AS unpriced_observations,
             rr.known_cost,
             rr.providers, rr.models, rr.provider, rr.model,
             COALESCE(cr.feature, rr.feature, t.context->>'feature') AS feature,
             COALESCE(cr.environment, rr.environment, t.context->>'environment') AS environment,
             COALESCE(cr.service, rr.service, t.context->>'service') AS service,
             COALESCE(cr.release, rr.release, t.context->>'release') AS release,
             COALESCE(cr.bl_file, rr.bl_file) AS bl_file,
             COALESCE(cr.bl_function, rr.bl_function) AS bl_function,
             COALESCE(cr.phase, rr.phase) AS phase,
             COALESCE(cr.customer, rr.customer, t.context->>'customer') AS customer,
             COALESCE(sr.root_agent, cr.agent, t.context->>'agent') AS agent,
             COALESCE(cr.user_id, t.context->>'userId') AS user_id,
             COALESCE(cr.conversation_id, t.context->>'conversationId') AS conversation_id,
             cr.total_input_tokens, cr.total_output_tokens,
             COALESCE(sr.agent_count, 0) AS agent_count,
             COALESCE(sr.step_count, 0) AS step_count,
             COALESCE(sr.tool_count, 0) AS tool_count,
             COALESCE(sr.has_error, FALSE) AS span_error,
             COALESCE(sr.root_error, FALSE) AS root_span_error,
             COALESCE(cr.failed_call_count, 0)::int AS failed_call_count,
             COALESCE(CASE WHEN jsonb_typeof(t.context) = 'object' THEN t.context ELSE NULL END, '{}'::jsonb)
             || jsonb_strip_nulls(jsonb_build_object(
               'feature', COALESCE(cr.feature, rr.feature),
               'environment', COALESCE(cr.environment, rr.environment),
               'customer', COALESCE(cr.customer, rr.customer),
               'service', COALESCE(cr.service, rr.service),
               'release', COALESCE(cr.release, rr.release)
             )) AS context,
             COALESCE(t.started_at, cr.observed_started_at, rr.charge_started_at) AS timestamp
      FROM trace_keys k
      LEFT JOIN traces t ON t.project_id = k.project_id AND t.id = k.trace_id
      LEFT JOIN call_rollup cr ON cr.project_id = k.project_id AND cr.trace_id = k.trace_id
      LEFT JOIN charge_rollup rr ON rr.project_id = k.project_id AND rr.trace_id = k.trace_id
      LEFT JOIN span_rollup sr ON sr.project_id = k.project_id AND sr.trace_id = k.trace_id
    )`;
}

const SPAN_CONTENT_ATTRIBUTES = new Set(["input", "output", "args", "arguments", "result", "prompt", "completion", "messages", "content"]);

/** Span payloads are content: roles without content access only see structure. */
function exposeSpan(row: Record<string, unknown>, restricted: boolean): Record<string, unknown> {
  const started = row.started_at ? new Date(String(row.started_at)).getTime() : NaN;
  const ended = row.ended_at ? new Date(String(row.ended_at)).getTime() : NaN;
  let attributes = row.attributes && typeof row.attributes === "object" ? row.attributes as Record<string, unknown> : null;
  if (attributes && restricted) {
    attributes = Object.fromEntries(Object.entries(attributes).filter(([key]) => !SPAN_CONTENT_ATTRIBUTES.has((key.split(".").pop() ?? key).toLowerCase())));
  }
  return {
    id: row.id,
    parent_span_id: row.parent_span_id ?? null,
    kind: row.kind,
    name: row.name,
    status: row.status,
    error_type: row.error_type ?? null,
    started_at: row.started_at ?? null,
    ended_at: row.ended_at ?? null,
    duration_ms: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null,
    attributes,
    execution_id: row.execution_id ?? null,
  };
}

function serializeTrace(row: Record<string, unknown>): Record<string, unknown> {
  const observations = number(row.observations, 0);
  const priced = number(row.priced_observations, 0);
  const unpriced = number(row.unpriced_observations, 0);
  // No model calls, or only failed calls without a price: it cost nothing.
  const knownCost = priced > 0 ? number(row.known_cost, 0) : unpriced === 0 ? 0 : null;
  const started = row.started_at ? new Date(String(row.started_at)) : null;
  const ended = row.ended_at ? new Date(String(row.ended_at)) : null;
  const elapsed = started && ended && !Number.isNaN(started.getTime()) && !Number.isNaN(ended.getTime())
    ? Math.max(0, ended.getTime() - started.getTime())
    : null;
  return {
    trace_id: row.trace_id,
    trace_name: row.trace_name,
    execution_id: row.execution_id ?? null,
    group_id: row.group_id ?? null,
    started_at: row.started_at ?? null,
    ended_at: row.ended_at ?? null,
    elapsed_ms: elapsed,
    // Legacy aliases are retained while their semantics are corrected.
    total_duration_ms: elapsed,
    call_count: number(row.call_count, 0),
    observations,
    total_cost: knownCost,
    known_cost: knownCost,
    unpriced_count: unpriced,
    pricing_coverage: observations > 0 ? priced / observations : null,
    accounting_state: observations === 0 ? "no_calls" : unpriced > 0 ? "partial" : "complete",
    execution_state: row.execution_state ?? "unknown",
    providers: row.providers ?? null,
    models: row.models ?? null,
    feature: row.feature ?? null,
    environment: row.environment ?? null,
    service: row.service ?? null,
    release: row.release ?? null,
    customer: row.customer ?? null,
    agent: row.agent ?? null,
    user_id: row.user_id ?? null,
    conversation_id: row.conversation_id ?? null,
    total_input_tokens: row.total_input_tokens == null ? null : Number(row.total_input_tokens),
    total_output_tokens: row.total_output_tokens == null ? null : Number(row.total_output_tokens),
    agent_count: number(row.agent_count, 0),
    step_count: number(row.step_count, 0),
    tool_count: number(row.tool_count, 0),
    span_error: row.span_error === true,
    root_span_error: row.root_span_error === true,
    failed_calls: number(row.failed_call_count, 0),
  };
}

function validDimension(raw: unknown): ScopeDimension | null {
  const candidate = value(raw);
  return candidate === "feature" || candidate === "function" || candidate === "customer"
    || candidate === "model" || candidate === "provider" || candidate === "context"
    ? candidate
    : null;
}

function parseEffectivePriceBody(body: Record<string, unknown>): EffectivePriceInput {
  return normalizeEffectivePriceInput({
    provider: body["provider"] as string,
    accountScope: (body["accountScope"] ?? body["account_scope"]) as string,
    model: body["model"] as string | null | undefined,
    nativeUnit: (body["nativeUnit"] ?? body["native_unit"] ?? body["unit"]) as string,
    pricePerUnit: (body["pricePerUnit"] ?? body["price_per_unit"] ?? body["inputRate"] ?? body["outputRate"]) as number,
    currency: body["currency"] as string,
    effectiveFrom: body["effectiveFrom"] as string,
    effectiveTo: (body["effectiveTo"] ?? body["effective_to"]) as string | null | undefined,
    source: body["source"] as string,
    version: (body["version"] ?? 1) as number,
    pricingId: (body["pricingId"] ?? body["pricing_id"]) as string | null | undefined,
    metadata: body["metadata"] as Record<string, unknown> | undefined,
  });
}

class FindingThresholdInputError extends Error {
  readonly status = 400;
  readonly code = "invalid_finding_thresholds";
}

function parseFindingThresholds(body: Record<string, unknown>, current: FindingThresholds): FindingThresholds {
  const read = (camel: string, snake: string): unknown => body[camel] ?? body[snake];
  const next: FindingThresholds = { ...current };
  const integerFields: Array<[keyof FindingThresholds, string, string, number, number]> = [
    ["expensiveSample", "expensiveSample", "expensive_sample", 1, 1_000],
    ["unitSample", "unitSample", "unit_sample", 1, 1_000],
  ];
  for (const [field, camel, snake, minimum, maximum] of integerFields) {
    const raw = read(camel, snake);
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < minimum || raw > maximum) {
      throw new FindingThresholdInputError(`${camel} must be a safe integer from ${minimum} to ${maximum}`);
    }
    next[field] = raw;
  }
  const numberFields: Array<[keyof FindingThresholds, string, string, number, number]> = [
    ["expensiveMultiplier", "expensiveMultiplier", "expensive_multiplier", 1, 100],
    ["expensiveMinAbsolute", "expensiveMinAbsolute", "expensive_min_absolute", 0, 1_000_000],
    ["unitMinRelative", "unitMinRelative", "unit_min_relative", 0, 100],
    ["unitMinImpact", "unitMinImpact", "unit_min_impact", 0, 1_000_000],
    ["coverageMinDrop", "coverageMinDrop", "coverage_min_drop", 0, 1],
    ["allowanceMinRatio", "allowanceMinRatio", "allowance_min_ratio", 0, 1],
  ];
  for (const [field, camel, snake, minimum, maximum] of numberFields) {
    const raw = read(camel, snake);
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < minimum || raw > maximum) {
      throw new FindingThresholdInputError(`${camel} must be a finite number from ${minimum} to ${maximum}`);
    }
    next[field] = raw;
  }
  return next;
}

export function createAccountingRouter(pool: pg.Pool): Router {
  const router = createRouter();
  router.use("/api/v1/projects/:projectId", requireAuth, orgScope(pool));
  router.use("/api/v1/projects/:projectId", (req, res, next) => {
    if (validateContextKey(req, res)) next();
  });

  // ── Financial overview aliases (replace legacy zero-coalescing routes) ──
  router.get("/api/v1/projects/:projectId/overview", async (req, res) => {
    try {
      if (!validateExplorerRange(req, res)) return;
      const projectId = req.params["projectId"] as string;
      const input = readExplorerScope(req);
      const restricted = !await sourceAccessAllowed(pool, projectId, user(req).role);
      if (restricted) input.function = undefined;
      if (restricted && input.groupBy === "function") { input.groupBy = undefined; input.groupValue = undefined; }
      input.searchSource = !restricted;
      const scope: ChargeScope = { ...input };
      scope.timezone = await workspaceTimezone(pool, projectId);
      const detailScope: ChargeScope = { ...scope, groupBy: undefined, groupValue: undefined };
      const detailParams: unknown[] = [projectId];
      const detailClauses = scopeClauses(detailScope, detailParams, "c");
      const [totalsResult, modelResult, providerResult, aggregateRows] = await Promise.all([
        pool.query(
          `${chargesCte()}
           SELECT COUNT(*)::int AS observations,
                  COUNT(*) FILTER (WHERE c.record_type = 'call')::int AS calls,
                  COUNT(*) FILTER (WHERE c.cost_usd IS NOT NULL)::int AS priced,
                  COUNT(DISTINCT c.trace_id)::int AS traces,
                  SUM(c.cost_usd) FILTER (WHERE c.cost_usd IS NOT NULL) AS known_cost,
                  COALESCE(SUM(c.input_tokens),0)::bigint AS input_tokens,
                  COALESCE(SUM(c.output_tokens),0)::bigint AS output_tokens,
                  AVG(c.duration_ms) FILTER (WHERE c.record_type = 'call' AND c.duration_ms IS NOT NULL) AS avg_duration_ms
           FROM charges c WHERE ${detailClauses.join(" AND ")}`,
          detailParams,
        ),
        pool.query(
          `${chargesCte()}
           SELECT c.provider, COALESCE(c.model, 'unknown') AS model,
                  COUNT(*)::int AS observations,
                  COUNT(*) FILTER (WHERE c.record_type = 'call')::int AS calls,
                  COUNT(*) FILTER (WHERE c.cost_usd IS NOT NULL)::int AS priced,
                  SUM(c.cost_usd) FILTER (WHERE c.cost_usd IS NOT NULL) AS known_cost,
                  COALESCE(SUM(c.input_tokens),0)::bigint AS input_tokens,
                  COALESCE(SUM(c.output_tokens),0)::bigint AS output_tokens
           FROM charges c WHERE ${detailClauses.join(" AND ")}
           GROUP BY c.provider, COALESCE(c.model, 'unknown')`,
          detailParams,
        ),
        pool.query(
          `${chargesCte()}
           SELECT c.provider, COUNT(*)::int AS observations,
                  COUNT(*) FILTER (WHERE c.record_type = 'call')::int AS calls,
                  COUNT(*) FILTER (WHERE c.cost_usd IS NOT NULL)::int AS priced,
                  SUM(c.cost_usd) FILTER (WHERE c.cost_usd IS NOT NULL) AS known_cost,
                  COALESCE(SUM(c.input_tokens),0)::bigint AS input_tokens,
                  COALESCE(SUM(c.output_tokens),0)::bigint AS output_tokens
           FROM charges c WHERE ${detailClauses.join(" AND ")}
           GROUP BY c.provider`,
          detailParams,
        ),
        loadDailyAggregates(pool, projectId, detailScope, scope.timezone ?? "UTC"),
      ]);
      type OverviewBucket = { provider: string; model?: string; observations: number; calls: number; priced: number; cost: number; input: number; output: number };
      const total = {
        observations: Number(totalsResult.rows[0]?.observations ?? 0),
        calls: Number(totalsResult.rows[0]?.calls ?? 0),
        priced: Number(totalsResult.rows[0]?.priced ?? 0),
        cost: Number(totalsResult.rows[0]?.known_cost ?? 0),
        input: Number(totalsResult.rows[0]?.input_tokens ?? 0),
        output: Number(totalsResult.rows[0]?.output_tokens ?? 0),
      };
      const byModel = new Map<string, OverviewBucket>();
      const byProvider = new Map<string, OverviewBucket>();
      const addBucket = (map: Map<string, OverviewBucket>, key: string, row: Record<string, unknown>, aggregate: boolean): void => {
        const provider = String(row.provider ?? "unknown");
        const model = row.model == null ? undefined : String(row.model);
        const bucketKey = model === undefined ? provider : `${provider}\u0000${model}`;
        const bucket = map.get(bucketKey) ?? { provider, model, observations: 0, calls: 0, priced: 0, cost: 0, input: 0, output: 0 };
        bucket.observations += Number(row[aggregate ? "observations" : "observations"] ?? 0);
        bucket.calls += Number(row[aggregate ? "call_count" : "calls"] ?? 0);
        bucket.priced += Number(row.priced_observations ?? row.priced ?? 0);
        bucket.cost += Number(row[aggregate ? "known_cost_usd" : "known_cost"] ?? 0);
        bucket.input += Number(row.input_tokens ?? 0);
        bucket.output += Number(row.output_tokens ?? 0);
        map.set(bucketKey, bucket);
      };
      for (const row of modelResult.rows as Array<Record<string, unknown>>) addBucket(byModel, `${row.provider}\u0000${row.model}`, row, false);
      for (const row of providerResult.rows as Array<Record<string, unknown>>) addBucket(byProvider, String(row.provider), row, false);
      for (const row of aggregateRows) {
        total.observations += Number(row.observations ?? 0);
        total.calls += Number(row.call_count ?? 0);
        total.priced += Number(row.priced_observations ?? 0);
        total.cost += Number(row.known_cost_usd ?? 0);
        total.input += Number(row.input_tokens ?? 0);
        total.output += Number(row.output_tokens ?? 0);
        addBucket(byModel, `${row.provider}\u0000${row.model}`, row as unknown as Record<string, unknown>, true);
        addBucket(byProvider, String(row.provider), row as unknown as Record<string, unknown>, true);
      }
      const knownCost = total.priced > 0 ? total.cost : null;
      const observations = total.observations;
      const unpriced = observations - total.priced;
      const avgDuration = Number(totalsResult.rows[0]?.avg_duration_ms ?? 0);
      res.json({
        overview: {
          total_calls: total.calls,
          total_cost: knownCost,
          known_cost: knownCost,
          total_input_tokens: total.input,
          total_output_tokens: total.output,
          avg_duration_ms: avgDuration,
          avg_ttft: 0,
          avg_tps: 0,
          observations,
          trace_count: Number(totalsResult.rows[0]?.traces) || 0,
          priced_observations: total.priced,
          unpriced_count: unpriced,
          pricing_coverage: observations > 0 ? total.priced / observations : null,
          accounting_state: observations === 0 ? "pending" : unpriced > 0 ? "partial" : "complete",
        },
        byModel: [...byModel.values()].map((row) => ({
          model: row.model ?? "unknown", provider: row.provider, calls: row.calls,
          unpriced_calls: row.observations - row.priced, cost: row.priced > 0 ? row.cost : null,
          known_cost: row.priced > 0 ? row.cost : null,
          pricing_coverage: row.observations > 0 ? row.priced / row.observations : null,
          input_tokens: row.input,
          output_tokens: row.output,
          avg_duration_ms: 0,
        })),
        byProvider: [...byProvider.values()].map((row) => ({
          provider: row.provider, calls: row.calls, unpriced_calls: row.observations - row.priced,
          cost: row.priced > 0 ? row.cost : null, known_cost: row.priced > 0 ? row.cost : null,
          pricing_coverage: row.observations > 0 ? row.priced / row.observations : null,
        })),
        scope,
      });
    } catch (err) {
      console.error("[costkey] Accounting overview error:", err);
      res.status(500).json({ error: "Failed to fetch overview" });
    }
  });

  router.get("/api/v1/projects/:projectId/summary", async (req, res) => {
    try {
      const projectId = req.params["projectId"] as string;
      const restricted = !await sourceAccessAllowed(pool, projectId, user(req).role);
      const now = new Date();
      const timezone = await workspaceTimezone(pool, projectId);
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
      const localYear = Number(parts.find((part) => part.type === "year")?.value);
      const localMonth = Number(parts.find((part) => part.type === "month")?.value);
      const localDay = Number(parts.find((part) => part.type === "day")?.value);
      const currentStart = zonedMidnight(localYear, localMonth, 1, timezone);
      const previousStart = localMonth === 1
        ? zonedMidnight(localYear - 1, 12, 1, timezone)
        : zonedMidnight(localYear, localMonth - 1, 1, timezone);
      const current = await loadFinancialTotals(pool, projectId, { from: currentStart.toISOString(), to: now.toISOString(), timezone });
      const previous = await loadFinancialTotals(pool, projectId, { from: previousStart.toISOString(), to: currentStart.toISOString(), timezone });
      const summarise = (summary: FinancialTotals) => ({
        cost: summary.priced > 0 ? summary.cost : null,
        calls: summary.calls,
        tokens: summary.tokens,
        observations: summary.observations,
        unpriced: summary.observations - summary.priced,
      });
      const thisMonth = summarise(current);
      const lastMonth = summarise(previous);
      const daysElapsed = Math.max(1, localDay - 1);
      const knownCurrent = thisMonth.cost;
      const previousCost = lastMonth.cost;
      const previousReleases = new Map(previous.byRelease.map((row) => [row.release, row]));
      const byRelease = current.byRelease.map((row) => {
        const prior = previousReleases.get(row.release);
        const currentComplete = row.observations > 0 && row.priced === row.observations;
        const priorComplete = Boolean(prior && prior.observations > 0 && prior.priced === prior.observations);
        const comparable = Boolean(prior && currentComplete && priorComplete);
        const currentCost = currentComplete ? row.cost : null;
        const priorCost = comparable && prior ? prior.cost : null;
        return {
          release: row.release,
          cost: currentCost,
          known_cost: currentCost,
          calls: row.calls,
          observations: row.observations,
          priced_observations: row.priced,
          pricing_coverage: row.observations > 0 ? row.priced / row.observations : null,
          change_abs: comparable && priorCost != null && currentCost != null ? currentCost - priorCost : null,
          change_pct: comparable && priorCost != null && priorCost > 0 && currentCost != null ? ((currentCost - priorCost) / priorCost) * 100 : null,
          comparison_available: comparable,
          comparison_reason: comparable ? null : "Release comparison requires the same release in both periods with complete pricing",
        };
      });
      const comparableReleaseChanges = byRelease.filter((row) => row.comparison_available);
      const releaseComparison = {
        available: comparableReleaseChanges.length > 0,
        reason: comparableReleaseChanges.length > 0 ? null : "Release comparison requires the same release in both periods with complete pricing",
        comparableReleases: comparableReleaseChanges.map((row) => row.release),
      };
      res.json({
        thisMonth,
        lastMonth,
        costChange: knownCurrent != null && previousCost != null && previousCost > 0 ? ((knownCurrent - previousCost) / previousCost) * 100 : null,
        callsChange: lastMonth.calls > 0 ? ((thisMonth.calls - lastMonth.calls) / lastMonth.calls) * 100 : null,
        topFeatures: restricted ? [] : current.topFunctions.map((row) => ({ ...row, pct: knownCurrent && knownCurrent > 0 ? row.cost / knownCurrent : null })),
        dailyAvg: knownCurrent == null ? null : knownCurrent / daysElapsed,
        projectedMonthly: knownCurrent == null ? null : (knownCurrent / daysElapsed) * new Date(Date.UTC(localYear, localMonth, 0)).getUTCDate(),
        byRelease,
        costChangeFromPrevRelease: comparableReleaseChanges.length === 1 ? comparableReleaseChanges[0]?.change_pct ?? null : null,
        releaseComparison,
        pricing: { pricedObservations: thisMonth.calls - thisMonth.unpriced, observations: thisMonth.calls, coverage: thisMonth.calls > 0 ? (thisMonth.calls - thisMonth.unpriced) / thisMonth.calls : null },
      });
    } catch (err) {
      console.error("[costkey] Accounting summary error:", err);
      res.status(500).json({ error: "Failed to fetch summary" });
    }
  });

  // Local Calls view. Keep raw event metadata available to authorized
  // developers/admins while enforcing aggregate-only Viewer access here.
  router.get("/api/v1/projects/:projectId/events", async (req, res) => {
    try {
      if (!validateExplorerRange(req, res)) return;
      const projectId = req.params["projectId"] as string;
      const limit = Math.min(Math.max(number(req.query["limit"], 50), 1), 200);
      const offset = Math.max(number(req.query["offset"], 0), 0);
      const scope = readExplorerScope(req);
      const restricted = !await sourceAccessAllowed(pool, projectId, user(req).role);
      const eventScope: ChargeScope = {
        ...scope,
        function: restricted ? undefined : scope.function,
        file: restricted ? undefined : scope.file,
        functionName: restricted ? undefined : scope.functionName,
        groupBy: restricted && scope.groupBy === "function" ? undefined : scope.groupBy,
        groupValue: restricted && scope.groupBy === "function" ? undefined : scope.groupValue,
        searchSource: !restricted,
      };
      const sort = explorerSort(req.query["sort"], "events");
      const params: unknown[] = [projectId];
      const clauses = ["COALESCE(e.event_type, 'call') = 'call'", ...scopeClauses(eventScope, params, "e")];
      const statuses = queryValues(req.query["status"]);
      if (statuses) {
        const items = (Array.isArray(statuses) ? statuses : [statuses])
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item));
        if (items.length > 0) {
          params.push(items);
          clauses.push(`e.status_code = ANY($${params.length}::int[])`);
        }
      }
      const lifecycles = queryValues(req.query["lifecycle"]);
      if (lifecycles) {
        params.push(Array.isArray(lifecycles) ? lifecycles : [lifecycles]);
        clauses.push(`e.lifecycle_state = ANY($${params.length}::text[])`);
      }
      // A failed call, as the console shows it: a failed or cancelled
      // lifecycle, or an HTTP error from the provider.
      if (value(req.query["outcome"]) === "failed") {
        clauses.push("(COALESCE(e.lifecycle_state, '') IN ('failed', 'cancelled', 'canceled') OR COALESCE(e.status_code, 200) >= 400)");
      }
      const accountingStates = queryValues(req.query["accounting"]);
      if (accountingStates) {
        const items = Array.isArray(accountingStates) ? accountingStates : [accountingStates];
        const accountingClauses: string[] = [];
        if (items.includes("partial") || items.includes("pending")) accountingClauses.push("e.cost_usd IS NULL");
        if (items.includes("complete")) accountingClauses.push("e.cost_usd IS NOT NULL");
        if (accountingClauses.length > 0) clauses.push(`(${accountingClauses.join(" OR ")})`);
      }
      const coverageValues = queryValues(req.query["coverage"]);
      if (coverageValues) {
        const items = Array.isArray(coverageValues) ? coverageValues : [coverageValues];
        const coverageClauses: string[] = [];
        if (items.includes("partial")) coverageClauses.push("e.cost_usd IS NULL");
        if (items.includes("complete")) coverageClauses.push("e.cost_usd IS NOT NULL");
        if (coverageClauses.length > 0) clauses.push(`(${coverageClauses.join(" OR ")})`);
      }
      const result = await pool.query(
        `SELECT e.* FROM events e WHERE ${clauses.join(" AND ")}
         ORDER BY ${sort.orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      );
      const total = await pool.query(`SELECT COUNT(*)::int AS count FROM events e WHERE ${clauses.join(" AND ")}`, params);
      res.json({ events: result.rows.map((row) => exposeEvent(row as Record<string, unknown>, restricted)), total: number(total.rows[0]?.count, 0), limit, offset, sort: sort.value });
    } catch (err) {
      console.error("[costkey] Accounting events error:", err);
      res.status(500).json({ error: "Failed to fetch events" });
    }
  });

  router.get("/api/v1/projects/:projectId/events/:eventId", async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM events WHERE project_id = $1 AND id = $2 AND COALESCE(event_type, 'call') = 'call'",
        [req.params["projectId"], req.params["eventId"]],
      );
      if (result.rows.length === 0) { res.status(404).json({ error: "Event not found" }); return; }
      const sourceRestricted = !await sourceAccessAllowed(pool, String(req.params["projectId"]), user(req).role);
      const row = result.rows[0] as Record<string, unknown>;
      // A call with no code of its own (made on a framework's task) shows the
      // code that opened the span it ran in.
      let scope: Awaited<ReturnType<typeof scopeSite>> = null;
      const frames = Array.isArray(row["call_site_frames"]) ? row["call_site_frames"] as StackFrame[] : [];
      if (!sourceRestricted && !findBusinessLogicFrame(frames)) scope = await scopeSite(pool, String(req.params["projectId"]), row["span_id"] as string | null);
      // How its cost adds up: each component at its rate, from the price it was charged at.
      res.json({ event: {
        ...exposeEvent(row, sourceRestricted),
        cost_breakdown: callCostBreakdown(row),
        scope_site: scope ? { span_id: scope.spanId, kind: scope.kind, name: scope.name, frames: scope.frames } : null,
      } });
    } catch (err) {
      console.error("[costkey] Accounting event detail error:", err);
      res.status(500).json({ error: "Failed to fetch event" });
    }
  });

  router.get("/api/v1/projects/:projectId/trends", async (req, res) => {
    try {
      if (!validateExplorerRange(req, res)) return;
      const projectId = req.params["projectId"] as string;
      const bucket = value(req.query["bucket"]) === "hour" ? "hour" : "day";
      const range = value(req.query["range"]) ?? "mtd";
      const now = new Date();
      const rangeDays: Record<string, number> = { "7d": 7, "30d": 30, "3m": 90, "6m": 180, "1y": 365 };
      const from = value(req.query["from"]) ?? (range === "mtd"
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
        : new Date(now.getTime() - (rangeDays[range] ?? 30) * 86400000).toISOString());
      const to = value(req.query["to"]) ?? now.toISOString();
      const timezone = await workspaceTimezone(pool, projectId);
      const scope: ChargeScope = { ...readExplorerScope(req), from, to, timezone, groupBy: undefined, groupValue: undefined };
      const restricted = !await sourceAccessAllowed(pool, projectId, user(req).role);
      if (restricted) dropSourceFilters(scope);
      scope.searchSource = !restricted;
      const params: unknown[] = [projectId];
      const clauses = scopeClauses(scope, params, "c");
      params.push(timezone);
      const timezoneParam = params.length;
      const bucketRows = await pool.query(
        `${chargesCte()}
         SELECT date_trunc('${bucket}', c.timestamp AT TIME ZONE $${timezoneParam}::text) AS bucket,
                COALESCE(c.model, 'unknown') AS model,
                COUNT(*)::int AS observations,
                COUNT(*) FILTER (WHERE c.record_type = 'call')::int AS calls,
                COUNT(*) FILTER (WHERE c.cost_usd IS NOT NULL)::int AS priced,
                SUM(c.cost_usd) FILTER (WHERE c.cost_usd IS NOT NULL) AS known_cost,
                COALESCE(SUM(c.input_tokens),0)::bigint AS input_tokens,
                COALESCE(SUM(c.output_tokens),0)::bigint AS output_tokens,
                AVG(c.duration_ms) FILTER (WHERE c.record_type = 'call' AND c.duration_ms IS NOT NULL) AS avg_duration_ms
         FROM charges c WHERE ${clauses.join(" AND ")}
         GROUP BY 1, 2 ORDER BY 1 ASC, 2 ASC`,
        params,
      );
      const aggregateRows = await loadDailyAggregates(pool, projectId, scope, timezone);
      type TrendRow = { observations: number; calls: number; priced: number; cost: number; input: number; output: number; durationSum: number; durationCount: number };
      const rows = new Map<string, TrendRow>();
      const models = new Map<string, Map<string, TrendRow>>();
      // pg returns timestamps as Date objects; String(date) yields unt sortable
      // "Day Mon DD..." text. Normalize to ISO instants so bucket keys merge
      // and sort chronologically.
      const bucketKey = (value: unknown): string => {
        const date = value instanceof Date ? value : new Date(String(value));
        return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
      };
      const add = (raw: Record<string, unknown>, aggregate: boolean): void => {
        const model = String(raw.model ?? "unknown");
        const key = aggregate ? bucketKey(raw.day) : bucketKey(raw.bucket);
        const item = rows.get(key) ?? { observations: 0, calls: 0, priced: 0, cost: 0, input: 0, output: 0, durationSum: 0, durationCount: 0 };
        const observations = Number(raw.observations ?? 0);
        const priced = Number(raw[aggregate ? "priced_observations" : "priced"] ?? 0);
        item.observations += observations;
        item.calls += Number(raw[aggregate ? "call_count" : "calls"] ?? 0);
        item.priced += priced;
        item.cost += Number(raw[aggregate ? "known_cost_usd" : "known_cost"] ?? 0);
        item.input += Number(raw.input_tokens ?? 0);
        item.output += Number(raw.output_tokens ?? 0);
        if (!aggregate && raw.avg_duration_ms != null) { item.durationSum += Number(raw.avg_duration_ms) * observations; item.durationCount += observations; }
        rows.set(key, item);
        const modelRows = models.get(model) ?? new Map<string, TrendRow>();
        const modelItem = modelRows.get(key) ?? { observations: 0, calls: 0, priced: 0, cost: 0, input: 0, output: 0, durationSum: 0, durationCount: 0 };
        modelItem.observations += observations; modelItem.calls += Number(raw[aggregate ? "call_count" : "calls"] ?? 0);
        modelItem.priced += priced; modelItem.cost += Number(raw[aggregate ? "known_cost_usd" : "known_cost"] ?? 0);
        modelRows.set(key, modelItem); models.set(model, modelRows);
      };
      for (const row of bucketRows.rows as Array<Record<string, unknown>>) add(row, false);
      for (const row of aggregateRows) add(row as unknown as Record<string, unknown>, true);
      const trends = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, row]) => ({
        bucket: key,
        calls: row.calls,
        observations: row.observations,
        cost: row.priced > 0 ? row.cost : null,
        input_tokens: row.input,
        output_tokens: row.output,
        avg_duration_ms: row.durationCount > 0 ? row.durationSum / row.durationCount : 0,
        unpriced_count: row.observations - row.priced,
        coverage: row.observations > 0 ? row.priced / row.observations : null,
      }));
      const byModel: Record<string, Array<{ bucket: string; cost: number | null; unpriced_count: number }>> = {};
      for (const [model, modelRows] of models) byModel[model] = [...modelRows.entries()].map(([key, row]) => ({ bucket: key, cost: row.priced > 0 ? row.cost : null, unpriced_count: row.observations - row.priced }));
      res.json({ trends, bucket, range, byModel: req.query["groupBy"] === "model" ? byModel : undefined });
    } catch (err) {
      console.error("[costkey] Accounting trends error:", err);
      res.status(500).json({ error: "Failed to fetch trends" });
    }
  });

  router.get("/api/v1/projects/:projectId/call-sites", async (req, res) => {
    try {
      const projectId = req.params["projectId"] as string;
      const sourceRestricted = !await sourceAccessAllowed(pool, projectId, user(req).role);
      const limit = Math.min(Math.max(number(req.query["limit"], 50), 1), 200);
      const allowedSorts = new Set(["total_cost_usd", "total_calls", "total_input_tokens", "total_output_tokens", "avg_duration_ms"]);
      const sortValue = value(req.query["sort"]) ?? "total_cost_usd";
      const sort = allowedSorts.has(sortValue) ? sortValue : "total_cost_usd";
      const result = await pool.query(
        `SELECT cs.call_site_key, cs.file_name, cs.function_name, cs.line_number,
                cs.provider, cs.model, cs.total_calls::int, cs.total_cost_usd,
                cs.priced_calls::int, cs.unpriced_calls::int,
                cs.total_input_tokens::int, cs.total_output_tokens::int,
                cs.avg_duration_ms, cs.avg_ttft, cs.avg_tps, cs.first_seen, cs.last_seen
         FROM call_site_stats cs WHERE cs.project_id = $1
         ORDER BY cs.${sort} DESC NULLS LAST LIMIT $2`,
        [projectId, limit],
      );
      res.json({ callSites: result.rows.map((row) => ({
        ...row,
        call_site_key: sourceRestricted ? "(restricted)" : row.call_site_key,
        file_name: sourceRestricted ? null : row.file_name,
        function_name: sourceRestricted ? null : row.function_name,
        line_number: sourceRestricted ? null : row.line_number,
        total_cost_usd: row.priced_calls > 0 ? Number(row.total_cost_usd) : null,
        pricing_coverage: row.total_calls > 0 ? Number(row.priced_calls) / Number(row.total_calls) : null,
      })) });
    } catch (err) {
      console.error("[costkey] Accounting call-sites error:", err);
      res.status(500).json({ error: "Failed to fetch call sites" });
    }
  });

  // Filter choices are derived from the entire scoped cohort, never from a
  // paginated page. Context keys/values are allowlisted and body/source data
  // is intentionally absent so the endpoint is safe for Viewers.
  router.get("/api/v1/projects/:projectId/filter-options", async (req, res) => {
    try {
      if (!validateExplorerRange(req, res)) return;
      const projectId = req.params["projectId"] as string;
      const restricted = !await sourceAccessAllowed(pool, projectId, user(req).role);
      const scope = readExplorerScope(req);
      if (restricted) dropSourceFilters(scope);
      if (restricted && scope.groupBy === "function") { scope.groupBy = undefined; scope.groupValue = undefined; }
      scope.searchSource = !restricted;
      if (scope.contextKey && !SAFE_CONTEXT_KEYS.has(scope.contextKey)) {
        res.status(400).json({ error: "contextKey is not an allowed metadata key" });
        return;
      }
      const filterOnlyScope: ChargeScope = { ...scope, groupBy: undefined, groupValue: undefined };
      const rawLimit = number(req.query["limit"], 100);
      const rawOffset = number(req.query["offset"], 0);
      const options = await loadAvailableFilters(pool, projectId, filterOnlyScope, restricted, {
        limit: rawLimit,
        offset: rawOffset,
        search: value(req.query["search"] ?? req.query["filterQ"]),
      });
      res.json({ scope: filterOnlyScope, availableFilters: options.filters, complete: options.complete, nextCursor: options.nextCursor, limit: options.limit, offset: options.offset });
    } catch (err) {
      console.error("[costkey] Accounting filter options error:", err);
      res.status(500).json({ error: "Failed to fetch filter options" });
    }
  });

  // ── Trace explorer / inspection ───────────────────────────────────
  router.get("/api/v1/projects/:projectId/traces", async (req, res) => {
    try {
      if (!validateExplorerRange(req, res)) return;
      const projectId = req.params["projectId"] as string;
      const scope = readExplorerScope(req);
      scope.timezone = await workspaceTimezone(pool, projectId);
      const restricted = !await sourceAccessAllowed(pool, projectId, user(req).role);
      if (restricted) dropSourceFilters(scope);
      if (restricted && scope.groupBy === "function") { scope.groupBy = undefined; scope.groupValue = undefined; }
      scope.searchSource = !restricted;
      const sort = explorerSort(req.query["sort"], "traces");
      const limit = Math.min(Math.max(number(req.query["limit"], 50), 1), 100);
      const offset = Math.max(number(req.query["offset"], 0), 0);
      const params: unknown[] = [projectId];
      const clauses = scopeClauses(scope, params, "tb");
      // The console hides runs that made no model calls unless asked.
      if (value(req.query["withCalls"]) === "1") clauses.push("tb.observations > 0");
      const statuses = queryValues(req.query["status"] ?? req.query["lifecycle"]);
      if (statuses) {
        const statusItems = Array.isArray(statuses) ? statuses : [statuses];
        params.push(statusItems);
        clauses.push(`tb.execution_state = ANY($${params.length}::text[])`);
      }
      // A run that went wrong, whether or not it reported its own end: it
      // ended failed, a span in it errored, or a call failed and no retry of
      // that call succeeded. `status` alone only sees reported run endings.
      if (value(req.query["outcome"]) === "failed") {
        clauses.push(`(tb.execution_state IN ('failed', 'error') OR tb.span_error OR EXISTS (
          SELECT 1 FROM events fe
          WHERE fe.project_id = tb.project_id AND fe.trace_id = tb.trace_id
            AND COALESCE(fe.event_type, 'call') = 'call'
            AND (COALESCE(fe.lifecycle_state, '') IN ('failed', 'cancelled', 'canceled') OR COALESCE(fe.status_code, 200) >= 400)
            AND NOT EXISTS (
              SELECT 1 FROM events re
              WHERE re.project_id = fe.project_id AND re.trace_id = fe.trace_id AND re.parent_event_id = fe.id
                AND COALESCE(re.lifecycle_state, '') NOT IN ('failed', 'cancelled', 'canceled')
                AND COALESCE(re.status_code, 200) < 400
            )
        ))`);
      }
      const accountingStates = queryValues(req.query["accounting"]);
      if (accountingStates) {
        const stateItems = Array.isArray(accountingStates) ? accountingStates : [accountingStates];
        const stateClauses: string[] = [];
        for (const state of stateItems) {
          if (state === "partial") stateClauses.push("tb.unpriced_observations > 0");
          if (state === "complete") stateClauses.push("tb.unpriced_observations = 0 AND tb.observations > 0");
          if (state === "pending") stateClauses.push("tb.observations = 0");
        }
        if (stateClauses.length > 0) clauses.push(`(${stateClauses.join(" OR ")})`);
      }
      const coverageValues = queryValues(req.query["coverage"]);
      if (coverageValues) {
        const values = Array.isArray(coverageValues) ? coverageValues : [coverageValues];
        const coverageClauses: string[] = [];
        if (values.includes("partial")) coverageClauses.push("tb.unpriced_observations > 0");
        if (values.includes("complete")) coverageClauses.push("tb.unpriced_observations = 0");
        if (coverageClauses.length > 0) clauses.push(`(${coverageClauses.join(" OR ")})`);
      }
      const listSql = `${traceCte()}
        SELECT tb.* FROM trace_base tb WHERE ${clauses.join(" AND ")}
        ORDER BY ${sort.orderBy}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      const result = await pool.query(listSql, [...params, limit, offset]);
      const total = await pool.query(`${traceCte()}
        SELECT COUNT(*)::int AS count FROM trace_base tb WHERE ${clauses.join(" AND ")}`, params);
      // A failed attempt that a later attempt of the same work item completed is "retried".
      const retries = await loadRetries(pool, projectId, result.rows.map((row) => String(row.trace_id)));
      res.json({
        traces: result.rows.map((row) => ({ ...serializeTrace(row as Record<string, unknown>), retry: retries.get(String(row.trace_id)) ?? null })),
        total: number(total.rows[0]?.count, 0),
        limit,
        offset,
        sort: sort.value,
      });
    } catch (err) {
      console.error("[costkey] Accounting trace list error:", err);
      res.status(500).json({ error: "Failed to fetch traces" });
    }
  });

  router.get("/api/v1/projects/:projectId/traces/:traceId", async (req, res) => {
    try {
      const projectId = req.params["projectId"] as string;
      const traceId = req.params["traceId"] as string;
      const params: unknown[] = [projectId, traceId];
      const summaryResult = await pool.query(`${traceCte()}
        SELECT tb.* FROM trace_base tb
        WHERE tb.project_id = $1 AND tb.trace_id = $2`, params);
      if (summaryResult.rows.length === 0) {
        res.status(404).json({ error: "Trace not found" });
        return;
      }
      const restricted = !await sourceAccessAllowed(pool, projectId, user(req).role);
      const events = await pool.query(
        `SELECT id, timestamp, event_type, source, entity_type, entity_id, sequence,
                lifecycle_state, lifecycle_at, lifecycle_error_type,
                provider, model, request_model,
                attempt_id, parent_event_id, charge_id, component_id,
                execution_id, group_id, group_name, group_kind, phase, case_id,
                status_code, input_tokens, output_tokens, total_tokens,
                reasoning_tokens, cache_read_tokens, cache_creation_tokens,
                image_output_tokens, cost_usd, cost_basis, cost_source,
                pricing_id, pricing_date, cost_currency, duration_ms, streaming, ttft, tps,
                unit_kind, unit_value, unit, aggregation, revision,
                content_status, feature_source, feature_mapping_id,
                feature_mapping_action_id, feature_original,
                call_site_raw, call_site_frames, bl_function, bl_file, bl_line,
                context, metadata, system_prompt, request_body, response_body,
                span_id, native_units, release, url AS pricing_url
         FROM events
         WHERE project_id = $1 AND trace_id = $2
           AND COALESCE(event_type, 'call') = 'call'
         ORDER BY timestamp ASC, id ASC`,
        params,
      );
      const spans = await pool.query(
        `SELECT id, parent_span_id, kind, name, status, error_type,
                started_at, ended_at, attributes, execution_id
         FROM spans
         WHERE project_id = $1 AND trace_id = $2
         ORDER BY started_at ASC NULLS LAST, id ASC`,
        params,
      );
      const lifecycleEvents = await pool.query(
        `SELECT id, timestamp, entity_type, entity_id, lifecycle_state, lifecycle_at,
                lifecycle_error_type, sequence, context, metadata
         FROM events
         WHERE project_id = $1 AND trace_id = $2 AND event_type = 'lifecycle'
         ORDER BY lifecycle_at ASC NULLS LAST, sequence ASC NULLS LAST, id ASC`,
        params,
      );
      const components = await pool.query(
        `SELECT id, charge_id, component_id, caller_id, provider, model,
                context,
                phase, unit_kind, unit_value, unit, amount, currency, pricing_id,
                amount_kind, aggregation, revision, observed_at, metadata
         FROM usage_components
         WHERE project_id = $1 AND trace_id = $2
           AND (aggregation = 'delta' OR active = TRUE)
         ORDER BY observed_at ASC, id ASC`,
        params,
      );
      const summary = { ...serializeTrace(summaryResult.rows[0] as Record<string, unknown>), retry: (await loadRetries(pool, projectId, [traceId])).get(traceId) ?? null };
      const usageComponents = components.rows.map((row) => restricted
        ? {
          id: row.id,
          charge_id: row.charge_id,
          component_id: row.component_id,
          provider: row.provider,
          model: row.model,
          phase: row.phase,
          unit_kind: row.unit_kind,
          unit_value: row.unit_value,
          unit: row.unit,
          amount: row.amount,
          currency: row.currency,
          pricing_id: row.pricing_id,
          amount_kind: row.amount_kind,
          aggregation: row.aggregation,
          revision: row.revision,
          observed_at: row.observed_at,
        }
        : row);
      res.json({
        traceId,
        summary,
        events: events.rows.map((row) => {
          // What cache hits saved on this call, when its price can be checked.
          const { pricing_url: url, ...call } = row as Record<string, unknown>;
          return exposeEvent({ ...call, cache_saved_usd: callCacheSavings({ ...call, url }) }, restricted);
        }),
        lifecycleEvents: lifecycleEvents.rows.map((row) => exposeEvent(row as Record<string, unknown>, restricted)),
        usageComponents,
        spans: spans.rows.map((row) => exposeSpan(row as Record<string, unknown>, restricted)),
      });
    } catch (err) {
      console.error("[costkey] Accounting trace detail error:", err);
      res.status(500).json({ error: "Failed to fetch trace" });
    }
  });

  // ── Grouped execution receipts ────────────────────────────────────
  router.get("/api/v1/projects/:projectId/executions", async (req, res) => {
    try {
      if (!validateExplorerRange(req, res)) return;
      const projectId = req.params["projectId"] as string;
      const limit = Math.min(Math.max(number(req.query["limit"], 50), 1), 100);
      const offset = Math.max(number(req.query["offset"], 0), 0);
      const scope = readExplorerScope(req);
      const params: unknown[] = [projectId];
      const scopeClausesForExecution = ["eb.project_id = $1"];
      if (scope.from) { params.push(scope.from); scopeClausesForExecution.push(`eb.effective_started_at >= $${params.length}`); }
      if (scope.to) { params.push(scope.to); scopeClausesForExecution.push(`eb.effective_started_at < $${params.length}`); }
      const addScopeValues = (expression: string, item: ScopeValues | undefined): void => {
        if (!item) return;
        const values = Array.isArray(item) ? item : [item];
        if (values.length === 0) return;
        params.push(values);
        scopeClausesForExecution.push(`${expression} = ANY($${params.length}::text[])`);
      };
      addScopeValues("eb.effective_context->>'environment'", scope.environment);
      addScopeValues("eb.effective_context->>'feature'", scope.feature);
      addScopeValues("eb.effective_context->>'customer'", scope.customer);
      addScopeValues("eb.service", scope.service);
      addScopeValues("eb.release", scope.release);
      addScopeValues("eb.provider", scope.provider);
      addScopeValues("eb.model", scope.model);
      addScopeValues("eb.function_key", scope.function);
      const groupIds = queryValues(req.query["groupId"]);
      if (groupIds) {
        params.push(Array.isArray(groupIds) ? groupIds : [groupIds]);
        scopeClausesForExecution.push(`eb.group_id = ANY($${params.length}::text[])`);
      }
      const statuses = queryValues(req.query["status"] ?? req.query["lifecycle"]);
      if (statuses) {
        params.push(Array.isArray(statuses) ? statuses : [statuses]);
        scopeClausesForExecution.push(`eb.state = ANY($${params.length}::text[])`);
      }
      const accountingStates = queryValues(req.query["accounting"]);
      if (accountingStates) {
        const stateClauses: string[] = [];
        for (const state of Array.isArray(accountingStates) ? accountingStates : [accountingStates]) {
          if (state === "pending") stateClauses.push("COALESCE(eb.observations,0) = 0");
          if (state === "partial") stateClauses.push("COALESCE(eb.unpriced_observations,0) > 0");
          if (state === "complete") stateClauses.push("COALESCE(eb.observations,0) > 0 AND COALESCE(eb.unpriced_observations,0) = 0");
        }
        if (stateClauses.length > 0) scopeClausesForExecution.push(`(${stateClauses.join(" OR ")})`);
      }
      const coverageValues = queryValues(req.query["coverage"]);
      if (coverageValues) {
        const coverageClauses: string[] = [];
        for (const state of Array.isArray(coverageValues) ? coverageValues : [coverageValues]) {
          if (state === "partial") coverageClauses.push("COALESCE(eb.unpriced_observations,0) > 0");
          if (state === "complete") coverageClauses.push("COALESCE(eb.observations,0) > 0 AND COALESCE(eb.unpriced_observations,0) = 0");
        }
        if (coverageClauses.length > 0) scopeClausesForExecution.push(`(${coverageClauses.join(" OR ")})`);
      }
      if (scope.q) {
        params.push(`%${scope.q}%`);
        scopeClausesForExecution.push(`(eb.id ILIKE $${params.length}
          OR COALESCE(eb.name, '') ILIKE $${params.length}
          OR COALESCE(eb.provider, '') ILIKE $${params.length}
          OR COALESCE(eb.model, '') ILIKE $${params.length}
          OR COALESCE(eb.service, '') ILIKE $${params.length}
          OR COALESCE(eb.release, '') ILIKE $${params.length}
          OR COALESCE(eb.effective_context->>'feature', '') ILIKE $${params.length}
          OR COALESCE(eb.effective_context->>'environment', '') ILIKE $${params.length}
          OR COALESCE(eb.effective_context->>'customer', '') ILIKE $${params.length})`);
      }
      const cte = `${chargesCte()},
        charge_rollup AS (
          SELECT project_id, execution_id,
                 COUNT(*)::int AS observations,
                 COUNT(*) FILTER (WHERE cost_usd IS NOT NULL)::int AS priced_observations,
                 COUNT(*) FILTER (WHERE cost_usd IS NULL AND NOT no_charge)::int AS unpriced_observations,
                 SUM(cost_usd) FILTER (WHERE cost_usd IS NOT NULL) AS known_cost,
                 COUNT(*) FILTER (WHERE record_type = 'call')::int AS call_count,
                 MAX(provider) AS provider,
                 MAX(model) AS model,
                 MAX(context->>'environment') AS environment,
                 MAX(context->>'feature') AS feature,
                 MAX(context->>'customer') AS customer,
                 MAX(COALESCE(NULLIF(service, ''), context->>'service')) AS service,
                 MAX(COALESCE(NULLIF(release, ''), context->>'release')) AS release,
                 MAX(CASE WHEN bl_file IS NULL AND bl_function IS NULL THEN '(unassigned)'
                          WHEN NULLIF(context->>'service', '') IS NULL THEN COALESCE(NULLIF(bl_file || ':' || bl_function, ':'), '(unassigned)')
                          ELSE (context->>'service') || ':' || COALESCE(NULLIF(bl_file || ':' || bl_function, ':'), '(unassigned)') END) AS function_key,
                 MIN(timestamp) AS observed_started_at,
                 MAX(timestamp + COALESCE(duration_ms, 0) * INTERVAL '1 millisecond') AS observed_ended_at
          FROM charges WHERE execution_id IS NOT NULL
          GROUP BY project_id, execution_id
        ), phase_rollup AS (
          SELECT project_id, execution_id,
                 jsonb_object_agg(phase_key, phase_value) AS phases
          FROM (
            SELECT project_id, execution_id,
                   COALESCE(phase, 'unassigned') AS phase_key,
                   jsonb_build_object(
                     'knownCost', SUM(cost_usd) FILTER (WHERE cost_usd IS NOT NULL),
                     'unpricedCount', COUNT(*) FILTER (WHERE cost_usd IS NULL),
                     'observations', COUNT(*)
                   ) AS phase_value
            FROM charges WHERE execution_id IS NOT NULL
            GROUP BY project_id, execution_id, COALESCE(phase, 'unassigned')
          ) p GROUP BY project_id, execution_id
        ), execution_base AS (
          SELECT x.*, x.id AS execution_id, r.observations, r.priced_observations, r.unpriced_observations,
                 r.known_cost, r.call_count,
                 r.provider, r.model, r.environment, r.feature, r.customer, r.service, r.release, r.function_key,
                 COALESCE(CASE WHEN jsonb_typeof(x.context) = 'object' THEN x.context ELSE NULL END, '{}'::jsonb)
                   || jsonb_strip_nulls(jsonb_build_object(
                     'environment', r.environment, 'feature', r.feature, 'customer', r.customer,
                     'service', r.service, 'release', r.release
                   )) AS effective_context,
                 COALESCE(x.started_at, r.observed_started_at) AS effective_started_at,
                 COALESCE(x.ended_at, r.observed_ended_at) AS effective_ended_at,
                 p.phases
          FROM executions x
          LEFT JOIN charge_rollup r ON r.project_id = x.project_id AND r.execution_id = x.id
          LEFT JOIN phase_rollup p ON p.project_id = x.project_id AND p.execution_id = x.id
        )`;
      const query = `${cte}
        SELECT eb.*,
          EXTRACT(EPOCH FROM (eb.effective_ended_at - eb.effective_started_at)) * 1000 AS elapsed_ms,
          CASE WHEN COALESCE(eb.observations,0) = 0 THEN 'pending'
               WHEN COALESCE(eb.unpriced_observations,0) > 0 THEN 'partial'
               ELSE 'complete' END AS accounting_state_derived
        FROM execution_base eb WHERE ${scopeClausesForExecution.join(" AND ")}
        ORDER BY eb.effective_started_at DESC NULLS LAST, eb.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      const result = await pool.query(query, [...params, limit, offset]);
      const total = await pool.query(`${cte} SELECT COUNT(*)::int AS count FROM execution_base eb WHERE ${scopeClausesForExecution.join(" AND ")}`, params);
      const executions = result.rows.map((row: Record<string, unknown>) => ({
        id: row.id,
        project_id: row.project_id,
        group_id: row.group_id,
        name: row.name,
        kind: row.kind,
        state: row.state,
        execution_state: row.state,
        started_at: row.effective_started_at,
        ended_at: row.effective_ended_at,
        elapsed_ms: row.elapsed_ms == null ? null : number(row.elapsed_ms, 0),
        observations: number(row.observations, 0),
        call_count: number(row.call_count, 0),
        known_cost: number(row.priced_observations, 0) > 0 ? number(row.known_cost, 0) : null,
        unpriced_count: number(row.unpriced_observations, 0),
        pricing_coverage: number(row.observations, 0) > 0 ? number(row.priced_observations, 0) / number(row.observations, 0) : null,
        accounting_state: row.accounting_state_derived,
        expected_items: row.expected_items,
        completed_items: row.completed_items,
        failed_items: row.failed_items,
        configuration: row.configuration,
        dataset_revision: row.dataset_revision,
        service: row.service,
        release: row.release,
        phases: row.phases ?? {},
      }));
      res.json({ executions, total: number(total.rows[0]?.count, 0), limit, offset });
    } catch (err) {
      console.error("[costkey] Execution list error:", err);
      res.status(500).json({ error: "Failed to fetch executions" });
    }
  });

  router.get("/api/v1/projects/:projectId/executions/:executionId", async (req, res) => {
    try {
      const projectId = req.params["projectId"] as string;
      const executionId = req.params["executionId"] as string;
      const executionsResult = await pool.query(
        `SELECT * FROM executions WHERE project_id = $1 AND id = $2`,
        [projectId, executionId],
      );
      if (executionsResult.rows.length === 0) {
        // A legacy execution may only be represented by events. Keep the
        // receipt inspectable without claiming lifecycle completion.
        const legacy = await pool.query(
          `SELECT execution_id FROM events
           WHERE project_id = $1 AND execution_id = $2 LIMIT 1`,
          [projectId, executionId],
        );
        if (legacy.rows.length === 0) {
          res.status(404).json({ error: "Execution not found" });
          return;
        }
      }
      const traceRows = await pool.query(
        `SELECT trace_id, MAX(trace_name) AS trace_name,
                COUNT(*)::int AS call_count,
                MIN(timestamp) AS started_at,
                MAX(timestamp + COALESCE(duration_ms,0) * INTERVAL '1 millisecond') AS ended_at
         FROM events
         WHERE project_id = $1 AND execution_id = $2
           AND COALESCE(event_type, 'call') = 'call'
           AND trace_id IS NOT NULL
         GROUP BY trace_id ORDER BY started_at ASC`,
        [projectId, executionId],
      );
      const phaseRows = await pool.query(
        `${chargesCte()}
         SELECT COALESCE(phase, 'unassigned') AS phase,
                COUNT(*)::int AS observations,
                COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced_count,
                SUM(cost_usd) FILTER (WHERE cost_usd IS NOT NULL) AS known_cost
         FROM charges WHERE project_id = $1 AND execution_id = $2
         GROUP BY 1 ORDER BY 1`,
        [projectId, executionId],
      );
      const detail = executionsResult.rows[0] ?? {
        id: executionId, project_id: projectId, state: "unknown", accounting_state: "pending",
      };
      const detailObservations = phaseRows.rows.reduce((sum, row) => sum + number(row.observations, 0), 0);
      const detailUnpriced = phaseRows.rows.reduce((sum, row) => sum + number(row.unpriced_count, 0), 0);
      const detailKnown = detailObservations > detailUnpriced
        ? phaseRows.rows.reduce((sum, row) => sum + number(row.known_cost, 0), 0) : null;
      const effectiveStarted = detail.started_at ?? traceRows.rows[0]?.started_at ?? null;
      const effectiveEnded = detail.ended_at ?? traceRows.rows.reduce((latest: string | null, row) => {
        const candidate = row.ended_at == null ? null : String(row.ended_at);
        return candidate && (!latest || candidate > latest) ? candidate : latest;
      }, null);
      res.json({
        execution: {
          ...detail,
          started_at: effectiveStarted,
          ended_at: effectiveEnded,
          elapsed_ms: effectiveStarted && effectiveEnded
            ? Math.max(0, new Date(String(effectiveEnded)).getTime() - new Date(String(effectiveStarted)).getTime()) : null,
          observations: detailObservations,
          known_cost: detailKnown,
          unpriced_count: detailUnpriced,
          pricing_coverage: detailObservations > 0 ? (detailObservations - detailUnpriced) / detailObservations : null,
          accounting_state: detailObservations === 0 ? "pending" : detailUnpriced > 0 ? "partial" : "complete",
        },
        traces: traceRows.rows,
        phases: phaseRows.rows.map((row) => ({
          phase: row.phase,
          observations: number(row.observations, 0),
          known_cost: number(row.observations, 0) - number(row.unpriced_count, 0) > 0 ? number(row.known_cost, 0) : null,
          unpriced_count: number(row.unpriced_count, 0),
        })),
      });
    } catch (err) {
      console.error("[costkey] Execution detail error:", err);
      res.status(500).json({ error: "Failed to fetch execution" });
    }
  });

  router.get("/api/v1/projects/:projectId/groups", async (req, res) => {
    try {
      const projectId = req.params["projectId"] as string;
      const result = await pool.query(
        `${chargesCte()},
         group_rollup AS (
           SELECT project_id, group_id,
                  COUNT(*)::int AS observations,
                  COUNT(*) FILTER (WHERE cost_usd IS NOT NULL)::int AS priced_observations,
                  COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced_count,
                  SUM(cost_usd) FILTER (WHERE cost_usd IS NOT NULL) AS known_cost
           FROM charges WHERE group_id IS NOT NULL GROUP BY project_id, group_id
         ), execution_rollup AS (
           SELECT project_id, group_id, COUNT(*)::int AS execution_count
           FROM executions WHERE group_id IS NOT NULL GROUP BY project_id, group_id
         )
         SELECT g.id, g.project_id, g.name, g.kind, g.metadata, g.created_at, g.updated_at,
                COALESCE(x.execution_count, 0)::int AS execution_count,
                COALESCE(c.observations, 0)::int AS observations,
                COALESCE(c.priced_observations, 0)::int AS priced_observations,
                COALESCE(c.unpriced_count, 0)::int AS unpriced_count,
                c.known_cost
         FROM groups g
         LEFT JOIN execution_rollup x ON x.project_id = g.project_id AND x.group_id = g.id
         LEFT JOIN group_rollup c ON c.project_id = g.project_id AND c.group_id = g.id
         WHERE g.project_id = $1
         ORDER BY g.updated_at DESC NULLS LAST, g.id DESC`,
        [projectId],
      );
      res.json({ groups: result.rows.map((row) => ({
        ...row,
        known_cost: Number(row.priced_observations) > 0 ? Number(row.known_cost) : null,
        coverage: Number(row.observations) > 0 ? Number(row.priced_observations) / Number(row.observations) : null,
        accounting_state: Number(row.observations) === 0 ? "pending" : Number(row.unpriced_count) > 0 ? "partial" : "complete",
      })) });
    } catch (err) {
      console.error("[costkey] Group list error:", err);
      res.status(500).json({ error: "Failed to fetch groups" });
    }
  });

  router.get("/api/v1/projects/:projectId/groups/:groupId/executions", async (req, res) => {
    try {
      if (!validateExplorerRange(req, res)) return;
      const projectId = req.params["projectId"] as string;
      const groupId = req.params["groupId"] as string;
      const scope = readExplorerScope(req);
      const restricted = !await sourceAccessAllowed(pool, projectId, user(req).role);
      if (restricted) dropSourceFilters(scope);
      const limit = Math.min(Math.max(number(req.query["limit"], 50), 1), 100);
      const offset = Math.max(number(req.query["offset"], 0), 0);
      const params: unknown[] = [projectId, groupId];
      const where = ["x.project_id = $1", "x.group_id = $2"];
      if (scope.from) { params.push(scope.from); where.push(`COALESCE(x.started_at, r.observed_started_at) >= $${params.length}`); }
      if (scope.to) { params.push(scope.to); where.push(`COALESCE(x.started_at, r.observed_started_at) < $${params.length}`); }
      const addValues = (expression: string, item: ScopeValues | undefined): void => {
        if (!item) return;
        const values = Array.isArray(item) ? item : [item];
        if (values.length === 0) return;
        params.push(values);
        where.push(`${expression} = ANY($${params.length}::text[])`);
      };
      addValues("COALESCE(x.context->>'environment', r.environment)", scope.environment);
      addValues("COALESCE(x.context->>'feature', r.feature)", scope.feature);
      addValues("COALESCE(x.context->>'customer', r.customer)", scope.customer);
      addValues("COALESCE(x.context->>'service', r.service)", scope.service);
      addValues("COALESCE(x.context->>'release', r.release)", scope.release);
      addValues("r.provider", scope.provider);
      addValues("r.model", scope.model);
      addValues("r.function_key", scope.function);
      const statuses = queryValues(req.query["status"] ?? req.query["lifecycle"]);
      if (statuses) {
        params.push(Array.isArray(statuses) ? statuses : [statuses]);
        where.push(`x.state = ANY($${params.length}::text[])`);
      }
      const accountingStates = queryValues(req.query["accounting"]);
      if (accountingStates) {
        const accountingClauses: string[] = [];
        for (const state of Array.isArray(accountingStates) ? accountingStates : [accountingStates]) {
          if (state === "pending") accountingClauses.push("COALESCE(r.observations,0) = 0");
          if (state === "partial") accountingClauses.push("COALESCE(r.unpriced_count,0) > 0");
          if (state === "complete") accountingClauses.push("COALESCE(r.observations,0) > 0 AND COALESCE(r.unpriced_count,0) = 0");
        }
        if (accountingClauses.length > 0) where.push(`(${accountingClauses.join(" OR ")})`);
      }
      const coverageValues = queryValues(req.query["coverage"]);
      if (coverageValues) {
        const coverageClauses: string[] = [];
        for (const state of Array.isArray(coverageValues) ? coverageValues : [coverageValues]) {
          if (state === "partial") coverageClauses.push("COALESCE(r.unpriced_count,0) > 0");
          if (state === "complete") coverageClauses.push("COALESCE(r.observations,0) > 0 AND COALESCE(r.unpriced_count,0) = 0");
        }
        if (coverageClauses.length > 0) where.push(`(${coverageClauses.join(" OR ")})`);
      }
      if (scope.q) {
        params.push(`%${scope.q}%`);
        where.push(`(x.id ILIKE $${params.length} OR COALESCE(x.name, '') ILIKE $${params.length}
          OR COALESCE(r.provider, '') ILIKE $${params.length} OR COALESCE(r.model, '') ILIKE $${params.length}
          OR COALESCE(r.service, '') ILIKE $${params.length} OR COALESCE(r.release, '') ILIKE $${params.length}
          OR COALESCE(COALESCE(x.context->>'feature', r.feature), '') ILIKE $${params.length}
          OR COALESCE(COALESCE(x.context->>'environment', r.environment), '') ILIKE $${params.length})`);
      }
      const cte = `${chargesCte()}, rollup AS (
           SELECT project_id, execution_id,
                  COUNT(*)::int AS observations,
                  COUNT(*) FILTER (WHERE cost_usd IS NOT NULL)::int AS priced_observations,
                  COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced_count,
                  SUM(cost_usd) FILTER (WHERE cost_usd IS NOT NULL) AS known_cost,
                  COUNT(*) FILTER (WHERE record_type = 'call')::int AS call_count,
                  MAX(provider) AS provider, MAX(model) AS model,
                  MAX(context->>'environment') AS environment,
                  MAX(context->>'feature') AS feature,
                  MAX(context->>'customer') AS customer,
                  MAX(COALESCE(NULLIF(service, ''), context->>'service')) AS service,
                  MAX(COALESCE(NULLIF(release, ''), context->>'release')) AS release,
                  MAX(CASE WHEN bl_file IS NULL AND bl_function IS NULL THEN '(unassigned)'
                           WHEN NULLIF(context->>'service', '') IS NULL THEN COALESCE(NULLIF(bl_file || ':' || bl_function, ':'), '(unassigned)')
                           ELSE (context->>'service') || ':' || COALESCE(NULLIF(bl_file || ':' || bl_function, ':'), '(unassigned)') END) AS function_key,
                  MIN(timestamp) AS observed_started_at,
                  MAX(timestamp + COALESCE(duration_ms,0) * INTERVAL '1 millisecond') AS observed_ended_at
           FROM charges WHERE execution_id IS NOT NULL GROUP BY project_id, execution_id
         )
         SELECT x.*, r.observations, r.priced_observations, r.unpriced_count, r.known_cost,
                r.provider, r.model, r.environment, r.feature, r.customer, r.service, r.release, r.function_key,
                COALESCE(x.started_at, r.observed_started_at) AS effective_started_at,
                COALESCE(x.ended_at, r.observed_ended_at) AS effective_ended_at
         FROM executions x LEFT JOIN rollup r ON r.project_id = x.project_id AND r.execution_id = x.id`;
      const result = await pool.query(
        `${cte} WHERE ${where.join(" AND ")}
         ORDER BY effective_started_at DESC NULLS LAST, x.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      );
      const total = await pool.query(
        `SELECT COUNT(*)::int AS count FROM (${cte} WHERE ${where.join(" AND ")}) AS execution_rows`,
        params,
      );
      res.json({ executions: result.rows.map((row) => ({
        id: row.id,
        project_id: row.project_id,
        group_id: row.group_id,
        name: row.name,
        kind: row.kind,
        state: row.state,
        execution_state: row.state,
        started_at: row.effective_started_at,
        ended_at: row.effective_ended_at,
        elapsed_ms: row.effective_started_at && row.effective_ended_at
          ? Math.max(0, new Date(String(row.effective_ended_at)).getTime() - new Date(String(row.effective_started_at)).getTime())
          : null,
        observations: Number(row.observations ?? 0),
        call_count: Number(row.call_count ?? 0),
        known_cost: Number(row.priced_observations) > 0 ? Number(row.known_cost) : null,
        accounting_state: Number(row.observations ?? 0) === 0 ? "pending" : Number(row.unpriced_count ?? 0) > 0 ? "partial" : "complete",
        unpriced_count: Number(row.unpriced_count ?? 0),
        pricing_coverage: Number(row.observations ?? 0) > 0 ? Number(row.priced_observations ?? 0) / Number(row.observations ?? 0) : null,
        service: row.service,
        release: row.release,
      })), total: number(total.rows[0]?.count, 0), limit, offset });
    } catch (err) {
      console.error("[costkey] Group execution list error:", err);
      res.status(500).json({ error: "Failed to fetch group executions" });
    }
  });

  // ── Costs explorer ─────────────────────────────────────────────────
  router.get("/api/v1/projects/:projectId/costs", async (req, res) => {
    try {
      if (!validateExplorerRange(req, res)) return;
      const projectId = req.params["projectId"] as string;
      const scope = readExplorerScope(req);
      scope.timezone = await workspaceTimezone(pool, projectId);
      const restricted = !await sourceAccessAllowed(pool, projectId, user(req).role);
      if (restricted) dropSourceFilters(scope);
      if (restricted && scope.groupBy === "function") { scope.groupBy = undefined; scope.groupValue = undefined; }
      scope.searchSource = !restricted;
      const groupBy = scope.groupBy ?? "feature";
      if (restricted && groupBy === "function") {
        res.status(403).json({ error: "Function/source grouping is restricted for viewers" });
        return;
      }
      const currentFrom = new Date(scope.from);
      const currentTo = new Date(scope.to);
      if (Number.isNaN(currentFrom.getTime()) || Number.isNaN(currentTo.getTime()) || currentFrom >= currentTo) {
        res.status(400).json({ error: "from must be before to" });
        return;
      }
      if (scope.contextKey && !SAFE_CONTEXT_KEYS.has(scope.contextKey)) {
        res.status(400).json({ error: "contextKey is not an allowed metadata key" });
        return;
      }
      if (groupBy === "context" && !scope.contextKey) {
        const filterOnlyScope: ChargeScope = {
          ...scope,
          groupBy: undefined,
          groupValue: undefined,
          from: currentFrom.toISOString(),
          to: currentTo.toISOString(),
        };
        const options = await loadAvailableFilters(pool, projectId, filterOnlyScope, restricted, { limit: 100, offset: 0 });
        const filters = options.filters;
        const contextKeys = Array.isArray(filters.contextKeys) ? filters.contextKeys as string[] : [];
        res.json({
          scope: filterOnlyScope,
          groupBy,
          costCurrency: "USD",
          requiresContextKey: true,
          complete: options.complete,
          nextCursor: options.nextCursor,
          availableContextKeys: contextKeys,
          availableFilters: filters,
          availableDimensions: ["feature", ...(restricted ? [] : ["function"]), "customer", "model", "provider", ...contextKeys.map((key) => `context:${key}`)],
          totals: {
            known_cost: null,
            cost_currency: "USD",
            observations: null,
            priced_observations: null,
            unpriced_count: null,
            coverage: null,
            unit_basis: "trace",
          },
          contributors: [],
          total: 0,
        });
        return;
      }
      const previousFrom = new Date(currentFrom.getTime() - (currentTo.getTime() - currentFrom.getTime()));
      const currentScope: ChargeScope = { ...scope, groupBy, from: currentFrom.toISOString(), to: currentTo.toISOString() };
      const previousScope: ChargeScope = { ...scope, groupBy, from: previousFrom.toISOString(), to: currentFrom.toISOString() };
      const traceLens = groupBy === "feature" || groupBy === "function" || groupBy === "customer" || groupBy === "context";
      const load = async (period: ChargeScope): Promise<{ rows: Array<Record<string, unknown>> }> => {
        const params: unknown[] = [projectId];
        const clauses = scopeClauses(period, params, "c");
        const expression = dimensionExpression(period, "c");
        const detail = await pool.query(
          `${chargesCte()},
           scoped AS (
             SELECT c.*, ${expression} AS group_key
             FROM charges c WHERE ${clauses.join(" AND ")}
           ), trace_groups AS (
             SELECT group_key, trace_id,
                    BOOL_AND(cost_usd IS NOT NULL) AS fully_priced,
                    SUM(cost_usd) FILTER (WHERE cost_usd IS NOT NULL) AS trace_known_cost
             FROM scoped
             WHERE trace_id IS NOT NULL
             GROUP BY group_key, trace_id
           ), trace_summary AS (
             SELECT group_key,
                    COUNT(*)::int AS trace_count,
                    COUNT(*) FILTER (WHERE fully_priced)::int AS fully_priced_trace_count,
                    SUM(trace_known_cost) FILTER (WHERE fully_priced) AS fully_priced_trace_cost,
                    AVG(trace_known_cost) FILTER (WHERE fully_priced) AS mean_cost_per_trace
             FROM trace_groups
             GROUP BY group_key
           ), grouped AS (
             SELECT group_key,
                    COUNT(*)::int AS observations,
                    COUNT(*) FILTER (WHERE c.record_type = 'call')::int AS call_count,
                    COUNT(*) FILTER (WHERE c.cost_usd IS NOT NULL)::int AS priced_observations,
                    COUNT(*) FILTER (WHERE c.cost_usd IS NULL)::int AS unpriced_observations,
                    SUM(c.cost_usd) FILTER (WHERE c.cost_usd IS NOT NULL) AS known_cost,
                    AVG(c.cost_usd) FILTER (WHERE c.cost_usd IS NOT NULL) AS mean_cost_per_charge,
                    COUNT(*) FILTER (WHERE c.cost_usd IS NOT NULL AND c.cost_basis = 'reported')::int AS reported_observations,
                    COUNT(*) FILTER (WHERE c.cost_usd IS NOT NULL AND c.cost_basis = 'estimated')::int AS estimated_observations,
                    COUNT(*) FILTER (WHERE c.cost_usd IS NULL OR c.cost_basis NOT IN ('reported','estimated'))::int AS unknown_observations,
                    COUNT(*) FILTER (WHERE c.trace_id IS NULL AND c.record_type = 'usage')::int AS untraced_usage_count,
                    SUM(c.cost_usd) FILTER (WHERE c.trace_id IS NULL AND c.record_type = 'usage' AND c.cost_usd IS NOT NULL) AS untraced_usage_cost
             FROM scoped c
             GROUP BY group_key
           )
           SELECT g.*, COALESCE(ts.trace_count, 0)::int AS trace_count,
                  COALESCE(ts.fully_priced_trace_count, 0)::int AS fully_priced_trace_count,
                  ts.fully_priced_trace_cost,
                  ts.mean_cost_per_trace
           FROM grouped g LEFT JOIN trace_summary ts USING (group_key)
           ORDER BY g.known_cost DESC NULLS LAST, g.observations DESC`,
          params,
        );
        const aggregates = await loadDailyAggregates(pool, projectId, period, period.timezone ?? "UTC");
        return { rows: mergeFinancialRollups(detail.rows as Array<Record<string, unknown>>, aggregates as unknown as Array<Record<string, unknown>>, period) };
      };
      const [current, previous] = await Promise.all([load(currentScope), load(previousScope)]);
      const previousByKey = new Map<string, Record<string, unknown>>();
      for (const row of previous.rows) previousByKey.set(String(row.group_key), row as Record<string, unknown>);
      const contributors = current.rows.map((row) => {
        const financial = financialFields(row as Record<string, unknown>);
        const prior = previousByKey.get(String(row.group_key));
        const priorPriced = prior ? number(prior.priced_observations, 0) : 0;
        const priorKnown = priorPriced > 0 ? number(prior?.known_cost, 0) : null;
        const currentTraceCount = number(row.trace_count, 0);
        const currentFullyPricedTraces = number(row.fully_priced_trace_count, 0);
        const currentTraceMean = currentFullyPricedTraces > 0 ? number(row.mean_cost_per_trace, 0) : null;
        const currentChargeMean = financial.priced_observations > 0 ? number(row.mean_cost_per_charge, 0) : null;
        const priorFullyPricedTraces = number(prior?.fully_priced_trace_count, 0);
        const priorMean = traceLens
          ? (priorFullyPricedTraces > 0 ? number(prior?.mean_cost_per_trace, 0) : null)
          : (priorPriced > 0 ? number(prior?.mean_cost_per_charge, 0) : null);
        const currentMean = traceLens ? currentTraceMean : currentChargeMean;
        return {
          key: row.group_key,
          label: row.group_key,
          secondary: null,
          cost_currency: "USD",
          ...financial,
          charge_count: financial.observations,
          trace_count: currentTraceCount,
          fully_priced_trace_count: currentFullyPricedTraces,
          mean_cost_per_trace: currentTraceMean,
          mean_cost_per_charge: currentChargeMean,
          untraced_usage_count: number(row.untraced_usage_count, 0),
          untraced_usage_cost: row.untraced_usage_cost == null ? null : number(row.untraced_usage_cost, 0),
          unit_cost: currentMean,
          unit_basis: traceLens ? "trace" : "charge",
          unit_label: traceLens ? "per trace" : "per charge",
          group: row.group_key,
          mean_cost_per_operation: currentMean,
          previous_known_cost: priorKnown,
          change_abs: financial.known_cost !== null && priorKnown !== null ? financial.known_cost - priorKnown : null,
          change_pct: currentMean !== null && priorMean !== null && priorMean > 0 ? (currentMean / priorMean - 1) * 100 : null,
          change_known_cost: financial.known_cost !== null && priorKnown !== null ? financial.known_cost - priorKnown : null,
        };
      });
      const totalObservations = contributors.reduce((sum, row) => sum + row.observations, 0);
      const totalPriced = contributors.reduce((sum, row) => sum + row.priced_observations, 0);
      const totalUnpriced = contributors.reduce((sum, row) => sum + row.unpriced_count, 0);
      const totalKnown = totalPriced > 0
        ? contributors.reduce((sum, row) => sum + (row.known_cost ?? 0), 0)
        : null;
      const totalTraceCount = contributors.reduce((sum, row) => sum + Number(row.trace_count ?? 0), 0);
      const totalFullyPricedTraceCount = contributors.reduce((sum, row) => sum + Number(row.fully_priced_trace_count ?? 0), 0);
      const totalUntracedUsage = contributors.reduce((sum, row) => sum + Number(row.untraced_usage_count ?? 0), 0);
      const filterOnlyScope: ChargeScope = { ...currentScope, groupBy: undefined, groupValue: undefined };
      const filterOptions = await loadAvailableFilters(pool, projectId, filterOnlyScope, restricted, { limit: 100, offset: 0 });
      const filters = filterOptions.filters;
      const contextKeys = Array.isArray(filters.contextKeys) ? filters.contextKeys as string[] : [];
      const limit = Math.min(Math.max(number(req.query["limit"], 25), 1), 100);
      const offset = Math.max(number(req.query["offset"], 0), 0);
      res.json({
        scope: currentScope,
        groupBy,
        costCurrency: "USD",
        from: currentFrom.toISOString(),
        to: currentTo.toISOString(),
        totals: {
          known_cost: totalKnown,
          cost_currency: "USD",
          observations: totalObservations,
          priced_observations: totalPriced,
          unpriced_count: totalUnpriced,
          coverage: totalObservations > 0 ? totalPriced / totalObservations : null,
          charge_count: totalObservations,
          trace_count: totalTraceCount,
          fully_priced_trace_count: totalFullyPricedTraceCount,
          untraced_usage_count: totalUntracedUsage,
          unit_basis: traceLens ? "trace" : "charge",
        },
        contributors: contributors.slice(offset, offset + limit),
        availableDimensions: ["feature", ...(restricted ? [] : ["function"]), "customer", "model", "provider", ...contextKeys.map((key) => `context:${key}`)],
        availableFilters: filters,
        availableFiltersComplete: filterOptions.complete,
        availableFiltersNextCursor: filterOptions.nextCursor,
        total: contributors.length,
      });
    } catch (err) {
      console.error("[costkey] Costs explorer error:", err);
      res.status(500).json({ error: "Failed to fetch costs" });
    }
  });

  router.get("/api/v1/projects/:projectId/costs/contributors/:dimension/:contributor", async (req, res) => {
    try {
      if (!validateExplorerRange(req, res)) return;
      const dimension = validDimension(req.params["dimension"]);
      if (!dimension) {
        res.status(400).json({ error: "Unsupported cost dimension" });
        return;
      }
      if (dimension === "context" && !value(req.query["contextKey"])) {
        res.status(400).json({ error: "contextKey is required for context contributors" });
        return;
      }
      const projectId = req.params["projectId"] as string;
      const sourceRestricted = !await sourceAccessAllowed(pool, projectId, user(req).role);
      if (dimension === "function" && sourceRestricted) {
        res.status(403).json({ error: "Function/source grouping is restricted for this project" });
        return;
      }
      const contextKey = value(req.query["contextKey"]);
      if (dimension === "context" && (!contextKey || !SAFE_CONTEXT_KEYS.has(contextKey))) {
        res.status(400).json({ error: "contextKey is not an allowed metadata key" });
        return;
      }
      const contributor = req.params["contributor"] as string;
      const scope = readExplorerScope(req);
      const restricted = sourceRestricted;
      if (restricted) dropSourceFilters(scope);
      if (restricted && scope.groupBy === "function") { scope.groupBy = undefined; scope.groupValue = undefined; }
      scope.searchSource = !restricted;
      const filterScope: ChargeScope = { ...scope, groupBy: dimension, groupValue: contributor };
      const periodFrom = new Date(scope.from);
      const periodTo = new Date(scope.to);
      if (Number.isNaN(periodFrom.getTime()) || Number.isNaN(periodTo.getTime()) || periodFrom >= periodTo) {
        res.status(400).json({ error: "from must be before to" });
        return;
      }
      const previousFrom = new Date(periodFrom.getTime() - (periodTo.getTime() - periodFrom.getTime()));
      const previousScope: ChargeScope = { ...filterScope, from: previousFrom.toISOString(), to: periodFrom.toISOString() };
      const metric = async (periodScope: ChargeScope): Promise<Record<string, unknown>> => {
        const metricParams: unknown[] = [projectId];
        const metricClauses = scopeClauses(periodScope, metricParams, "c");
        const result = await pool.query(
          `${chargesCte()}, scoped AS (
             SELECT c.* FROM charges c WHERE ${metricClauses.join(" AND ")}
           ), trace_groups AS (
             SELECT trace_id, BOOL_AND(cost_usd IS NOT NULL) AS fully_priced,
                    SUM(cost_usd) FILTER (WHERE cost_usd IS NOT NULL) AS trace_known_cost
             FROM scoped WHERE trace_id IS NOT NULL GROUP BY trace_id
           ), trace_summary AS (
             SELECT COUNT(*)::int AS trace_count,
                    COUNT(*) FILTER (WHERE fully_priced)::int AS fully_priced_trace_count,
                    SUM(trace_known_cost) FILTER (WHERE fully_priced) AS fully_priced_trace_cost,
                    AVG(trace_known_cost) FILTER (WHERE fully_priced) AS mean_cost_per_trace
             FROM trace_groups
           )
           SELECT COUNT(*)::int AS observations,
                  COUNT(*) FILTER (WHERE c.cost_usd IS NOT NULL)::int AS priced_observations,
                  COUNT(*) FILTER (WHERE c.cost_usd IS NULL)::int AS unpriced_observations,
                  SUM(c.cost_usd) FILTER (WHERE c.cost_usd IS NOT NULL) AS known_cost,
                  COUNT(*) FILTER (WHERE c.record_type = 'call')::int AS call_count,
                  COUNT(*) FILTER (WHERE c.trace_id IS NULL AND c.record_type = 'usage')::int AS untraced_usage_count,
                  SUM(c.cost_usd) FILTER (WHERE c.trace_id IS NULL AND c.record_type = 'usage' AND c.cost_usd IS NOT NULL) AS untraced_usage_cost,
                  ts.trace_count, ts.fully_priced_trace_count, ts.fully_priced_trace_cost, ts.mean_cost_per_trace
           FROM scoped c CROSS JOIN trace_summary ts
           GROUP BY ts.trace_count, ts.fully_priced_trace_count, ts.fully_priced_trace_cost, ts.mean_cost_per_trace`,
          metricParams,
        );
        return (result.rows[0] as Record<string, unknown> | undefined) ?? {};
      };
      const [currentMetric, previousMetric] = await Promise.all([metric(filterScope), metric(previousScope)]);
      const params: unknown[] = [projectId];
      const clauses = scopeClauses(filterScope, params, "c");
      // scopeClauses appends the group value as the final parameter. The
      // contributor endpoint intentionally returns both history and evidence.
      const history = await pool.query(
        `${chargesCte()}
         SELECT date_trunc('day', c.timestamp) AS day,
                COUNT(*)::int AS observations,
                COUNT(*) FILTER (WHERE c.cost_usd IS NOT NULL)::int AS priced_observations,
                COUNT(*) FILTER (WHERE c.cost_usd IS NULL)::int AS unpriced_observations,
                SUM(c.cost_usd) FILTER (WHERE c.cost_usd IS NOT NULL) AS known_cost
         FROM charges c WHERE ${clauses.join(" AND ")}
         GROUP BY 1 ORDER BY 1 ASC`,
        params,
      );
      const traces = await pool.query(
        `${chargesCte()}
         SELECT c.trace_id, MAX(c.trace_name) AS trace_name,
                COUNT(*) FILTER (WHERE c.record_type = 'call')::int AS call_count,
                COUNT(*) FILTER (WHERE c.cost_usd IS NOT NULL)::int AS priced_observations,
                COUNT(*) FILTER (WHERE c.cost_usd IS NULL)::int AS unpriced_count,
                SUM(c.cost_usd) FILTER (WHERE c.cost_usd IS NOT NULL) AS known_cost,
                MIN(c.timestamp) AS started_at
         FROM charges c WHERE ${clauses.join(" AND ")} AND c.trace_id IS NOT NULL
         GROUP BY c.trace_id ORDER BY known_cost DESC NULLS LAST, started_at DESC LIMIT 50`,
        params,
      );
      const distributionParams: unknown[] = [projectId];
      const distributionClauses = scopeClauses(filterScope, distributionParams, "c");
      const functionExpression = `CASE WHEN c.bl_file IS NULL AND c.bl_function IS NULL THEN '(unassigned)'
        WHEN NULLIF(c.context->>'service', '') IS NULL THEN COALESCE(NULLIF(c.bl_file || ':' || c.bl_function, ':'), '(unassigned)')
        ELSE (c.context->>'service') || ':' || COALESCE(NULLIF(c.bl_file || ':' || c.bl_function, ':'), '(unassigned)') END`;
      const distributionDimensions = [
        `SELECT 'provider'::text AS dimension, COALESCE(NULLIF(c.provider, ''), '(unknown)') AS group_key, c.cost_usd FROM scoped c`,
        `SELECT 'model'::text, COALESCE(NULLIF(c.model, ''), '(unknown)'), c.cost_usd FROM scoped c`,
        `SELECT 'service'::text, COALESCE(NULLIF(c.service, ''), NULLIF(c.context->>'service', ''), '(unassigned)'), c.cost_usd FROM scoped c`,
        `SELECT 'release'::text, COALESCE(NULLIF(c.release, ''), NULLIF(c.context->>'release', ''), '(unassigned)'), c.cost_usd FROM scoped c`,
        `SELECT 'feature'::text, COALESCE(NULLIF(c.context->>'feature', ''), '(unassigned)'), c.cost_usd FROM scoped c`,
        ...(restricted ? [] : [`SELECT 'function'::text, ${functionExpression}, c.cost_usd FROM scoped c`]),
      ];
      const distribution = await pool.query(
        `${chargesCte()}, scoped AS (
           SELECT c.* FROM charges c WHERE ${distributionClauses.join(" AND ")}
         ), dimensions AS (
           ${distributionDimensions.join(" UNION ALL ")}
         )
         SELECT d.dimension, d.group_key,
                COUNT(*)::int AS observations,
                COUNT(*) FILTER (WHERE d.cost_usd IS NOT NULL)::int AS priced_observations,
                COUNT(*) FILTER (WHERE d.cost_usd IS NULL)::int AS unpriced_count,
                SUM(d.cost_usd) FILTER (WHERE d.cost_usd IS NOT NULL) AS known_cost
         FROM dimensions d
         GROUP BY d.dimension, d.group_key
         ORDER BY d.dimension, d.group_key
         LIMIT 500`,
        distributionParams,
      );
      const byDistribution = (dimensionName: string): Array<Record<string, unknown>> => (distribution.rows ?? [])
        .filter((row) => String(row.dimension) === dimensionName)
        .map((row) => ({
          key: String(row.group_key),
          label: String(row.group_key),
          observations: number(row.observations, 0),
          priced_observations: number(row.priced_observations, 0),
          unpriced_count: number(row.unpriced_count, 0),
          known_cost: number(row.priced_observations, 0) > 0 ? number(row.known_cost, 0) : null,
          coverage: number(row.observations, 0) > 0 ? number(row.priced_observations, 0) / number(row.observations, 0) : null,
        }));
      const policyActions: Record<string, unknown[]> = { policies: [], decisions: [], firings: [], legacyRules: [], legacyFirings: [] };
      try {
        const policies = await pool.query(
          `SELECT id, name, scope, mode, status, unit, allowance, currency,
                  window_kind, policy_version, updated_at
           FROM spending_policies
           WHERE project_id = $1 AND status <> 'archived'
           ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 100`,
          [projectId],
        );
        policyActions.policies = policies.rows.map((row) => ({
          id: row.id, name: row.name, scope: row.scope, mode: row.mode, status: row.status,
          unit: row.unit, allowance: row.allowance, currency: row.currency,
          window_kind: row.window_kind, policy_version: row.policy_version, updated_at: row.updated_at,
        }));
      } catch { /* policy storage is additive and may not exist during rollout */ }
      try {
        const decisions = await pool.query(
          `SELECT policy_id, policy_version, decision, refusal, created_at
           FROM policy_decisions
           WHERE project_id = $1 AND created_at >= $2 AND created_at < $3
           ORDER BY created_at DESC LIMIT 100`,
          [projectId, periodFrom.toISOString(), periodTo.toISOString()],
        );
        policyActions.decisions = decisions.rows.map((row) => ({
          policy_id: row.policy_id, policy_version: row.policy_version, decision: row.decision,
          refusal: row.refusal, created_at: row.created_at,
        }));
      } catch { /* policy storage is additive and may not exist during rollout */ }
      try {
        const firings = await pool.query(
          `SELECT f.rule_id, f.scope, f.threshold, f.window_key, f.spent_usd, f.limit_usd, f.fired_at
           FROM budget_alert_firings f
           WHERE f.project_id = $1 AND f.fired_at >= $2 AND f.fired_at < $3
           ORDER BY f.fired_at DESC LIMIT 100`,
          [projectId, periodFrom.toISOString(), periodTo.toISOString()],
        );
        policyActions.legacyFirings = firings.rows;
      } catch { /* legacy policy storage is optional */ }
      try {
        const rules = await pool.query(
          `SELECT id, name, scope_model, scope_function, daily_usd, monthly_usd,
                  calls_per_minute, tokens_per_minute, on_exceed, enabled, updated_at
           FROM budget_rules WHERE project_id = $1 ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 100`,
          [projectId],
        );
        policyActions.legacyRules = rules.rows;
      } catch { /* legacy policy storage is optional */ }
      type ContributorMetric = {
        known_cost: number | null;
        observations: number;
        priced_observations: number;
        unpriced_count: number;
        coverage: number | null;
        call_count: number;
        trace_count: number;
        fully_priced_trace_count: number;
        fully_priced_trace_cost: number | null;
        mean_cost_per_trace: number | null;
        untraced_usage_count: number;
        untraced_usage_cost: number | null;
      };
      const metricResponse = (row: Record<string, unknown>): ContributorMetric => {
        const observations = number(row.observations, 0);
        const priced = number(row.priced_observations, 0);
        const traceCount = number(row.trace_count, 0);
        const fullyPricedTraceCount = number(row.fully_priced_trace_count, 0);
        const knownCost = priced > 0 ? number(row.known_cost, 0) : null;
        return {
          known_cost: knownCost,
          observations,
          priced_observations: priced,
          unpriced_count: number(row.unpriced_observations, 0),
          coverage: observations > 0 ? priced / observations : null,
          call_count: number(row.call_count, 0),
          trace_count: traceCount,
          fully_priced_trace_count: fullyPricedTraceCount,
          fully_priced_trace_cost: fullyPricedTraceCount > 0 ? number(row.fully_priced_trace_cost, 0) : null,
          mean_cost_per_trace: fullyPricedTraceCount > 0 ? number(row.mean_cost_per_trace, 0) : null,
          untraced_usage_count: number(row.untraced_usage_count, 0),
          untraced_usage_cost: row.untraced_usage_cost == null ? null : number(row.untraced_usage_cost, 0),
        };
      };
      const currentSummary = metricResponse(currentMetric);
      const previousSummary = metricResponse(previousMetric);
      const traceLens = dimension === "feature" || dimension === "function" || dimension === "customer" || dimension === "context";
      const unitCost = traceLens ? currentSummary.mean_cost_per_trace : (currentSummary.known_cost != null && currentSummary.priced_observations > 0 ? currentSummary.known_cost / currentSummary.priced_observations : null);
      const previousUnitCost = traceLens ? previousSummary.mean_cost_per_trace : (previousSummary.known_cost != null && previousSummary.priced_observations > 0 ? previousSummary.known_cost / previousSummary.priced_observations : null);
      const detail = {
        ...currentSummary,
        unit_cost: unitCost,
        unit_basis: traceLens ? "trace" : "charge",
        period: { from: periodFrom.toISOString(), to: periodTo.toISOString() },
        baseline: {
          ...previousSummary,
          period: { from: previousFrom.toISOString(), to: periodFrom.toISOString() },
          unit_cost: previousUnitCost,
          unit_basis: traceLens ? "trace" : "charge",
          change_abs: unitCost != null && previousUnitCost != null ? unitCost - previousUnitCost : null,
          change_pct: unitCost != null && previousUnitCost != null && previousUnitCost > 0 ? (unitCost / previousUnitCost - 1) * 100 : null,
        },
      };
      res.json({
        dimension,
        value: contributor,
        history: history.rows.map((row) => ({
          day: row.day,
          observations: number(row.observations, 0),
          known_cost: number(row.priced_observations, 0) > 0 ? number(row.known_cost, 0) : null,
          unpriced_count: number(row.unpriced_observations, 0),
          coverage: number(row.observations, 0) > 0 ? number(row.priced_observations, 0) / number(row.observations, 0) : null,
        })),
        traces: traces.rows,
        summary: detail,
        baseline: detail.baseline,
        distributions: {
          providers: byDistribution("provider"),
          models: byDistribution("model"),
          services: byDistribution("service"),
          releases: byDistribution("release"),
          functions: restricted ? [] : byDistribution("function"),
          features: byDistribution("feature"),
        },
        related: {
          functions: restricted ? [] : byDistribution("function"),
          features: byDistribution("feature"),
        },
        policyActions,
      });
    } catch (err) {
      console.error("[costkey] Contributor detail error:", err);
      res.status(500).json({ error: "Failed to fetch contributor" });
    }
  });

  // ── Findings ───────────────────────────────────────────────────────
  router.get("/api/v1/projects/:projectId/finding-thresholds", async (req, res) => {
    try {
      const projectId = req.params["projectId"] as string;
      const thresholds = await loadFindingThresholds(pool, projectId);
      res.json({ projectId, thresholds, defaults: DEFAULT_FINDING_THRESHOLDS });
    } catch (err) {
      console.error("[costkey] Finding thresholds read error:", err);
      res.status(500).json({ error: "Failed to fetch finding thresholds" });
    }
  });

  router.patch("/api/v1/projects/:projectId/finding-thresholds", async (req, res) => {
    try {
      if (!requireManager(req, res)) return;
      const projectId = req.params["projectId"] as string;
      const current = await loadFindingThresholds(pool, projectId);
      const thresholds = parseFindingThresholds((req.body ?? {}) as Record<string, unknown>, current);
      await pool.query(
        `INSERT INTO finding_thresholds (
           project_id, expensive_sample, expensive_multiplier, expensive_min_absolute,
           unit_sample, unit_min_relative, unit_min_impact, coverage_min_drop,
           allowance_min_ratio, updated_by, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (project_id) DO UPDATE SET
           expensive_sample = EXCLUDED.expensive_sample,
           expensive_multiplier = EXCLUDED.expensive_multiplier,
           expensive_min_absolute = EXCLUDED.expensive_min_absolute,
           unit_sample = EXCLUDED.unit_sample,
           unit_min_relative = EXCLUDED.unit_min_relative,
           unit_min_impact = EXCLUDED.unit_min_impact,
           coverage_min_drop = EXCLUDED.coverage_min_drop,
           allowance_min_ratio = EXCLUDED.allowance_min_ratio,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        [projectId, thresholds.expensiveSample, thresholds.expensiveMultiplier,
          thresholds.expensiveMinAbsolute, thresholds.unitSample, thresholds.unitMinRelative,
          thresholds.unitMinImpact, thresholds.coverageMinDrop, thresholds.allowanceMinRatio,
          user(req).id ?? null],
      );
      scheduleFindingsRefresh(pool, projectId);
      res.json({ projectId, thresholds, defaults: DEFAULT_FINDING_THRESHOLDS });
    } catch (err) {
      if (err instanceof FindingThresholdInputError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      console.error("[costkey] Finding thresholds update error:", err);
      res.status(500).json({ error: "Failed to update finding thresholds" });
    }
  });

  router.get("/api/v1/projects/:projectId/findings", async (req, res) => {
    try {
      const projectId = req.params["projectId"] as string;
      const includeAcknowledged = req.query["acknowledged"] !== "false";
      const findings = await listFindings(pool, projectId, includeAcknowledged);
      res.json({ findings });
    } catch (err) {
      console.error("[costkey] Findings list error:", err);
      res.status(500).json({ error: "Failed to fetch findings" });
    }
  });

  // Refresh is an explicit/admin or background-worker action. Listing must be
  // read-only and bounded so opening the console cannot trigger an expensive
  // full-project scan or create findings as a side effect.
  router.post("/api/v1/projects/:projectId/findings/refresh", async (req, res) => {
    try {
      if (!roleCanManageWorkspace(user(req).role)) {
        res.status(403).json({ error: "Only owners and admins can refresh findings" });
        return;
      }
      await refreshFindings(pool, req.params["projectId"] as string);
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] Findings refresh error:", err);
      res.status(500).json({ error: "Failed to refresh findings" });
    }
  });

  router.get("/api/v1/projects/:projectId/findings/:findingId", async (req, res) => {
    try {
      const finding = await getFinding(pool, req.params["projectId"] as string, req.params["findingId"] as string);
      if (!finding) {
        res.status(404).json({ error: "Finding not found" });
        return;
      }
      res.json({ finding });
    } catch (err) {
      console.error("[costkey] Finding detail error:", err);
      res.status(500).json({ error: "Failed to fetch finding" });
    }
  });

  router.post("/api/v1/projects/:projectId/findings/:findingId/acknowledge", async (req, res) => {
    try {
      const ok = await acknowledgeFinding(
        pool,
        req.params["projectId"] as string,
        req.params["findingId"] as string,
        user(req).id ?? null,
      );
      if (!ok) {
        res.status(404).json({ error: "Finding not found" });
        return;
      }
      res.json({ ok: true, state: "acknowledged" });
    } catch (err) {
      console.error("[costkey] Finding acknowledge error:", err);
      res.status(500).json({ error: "Failed to acknowledge finding" });
    }
  });

  // ── Forecasts ──────────────────────────────────────────────────────
  async function forecastScope(req: Request): Promise<ForecastScope> {
    const scope = readExplorerScope(req);
    const restricted = !await sourceAccessAllowed(pool, String(req.params["projectId"]), user(req).role);
    if (restricted) dropSourceFilters(scope);
    if (restricted && scope.groupBy === "function") { scope.groupBy = undefined; scope.groupValue = undefined; }
    scope.searchSource = !restricted;
    const groupBy = scope.groupBy;
    const forecast: ForecastScope = {
      from: scope.from,
      to: scope.to,
      environment: scope.environment,
      feature: scope.feature,
      function: scope.function,
      customer: scope.customer,
      service: scope.service,
      release: scope.release,
      model: scope.model,
      provider: scope.provider,
      groupBy,
      groupValue: scope.groupValue,
      contextKey: scope.contextKey,
      contextValue: scope.contextValue,
      searchSource: scope.searchSource,
      currency: (value(req.query["currency"]) ?? "USD").toUpperCase(),
    };
    const numericQuery = (key: string): number | undefined => req.query[key] == null ? undefined : number(req.query[key], -1);
    const operations = numericQuery("operations");
    const volume = numericQuery("volume");
    const users = numericQuery("users");
    const conversations = numericQuery("conversations");
    const operationsPerUser = numericQuery("operationsPerUser");
    const operationsPerConversation = numericQuery("operationsPerConversation");
    const assumedCost = numericQuery("assumedCostPerOperation");
    const assumedUnitCost = numericQuery("assumedCostPerUnit");
    const targetDays = numericQuery("targetPeriodDays");
    if (operations !== undefined) forecast.operations = operations;
    if (volume !== undefined) forecast.volume = volume;
    if (users !== undefined) forecast.users = users;
    if (conversations !== undefined) forecast.conversations = conversations;
    if (operationsPerUser !== undefined) forecast.operationsPerUser = operationsPerUser;
    if (operationsPerConversation !== undefined) forecast.operationsPerConversation = operationsPerConversation;
    if (assumedCost !== undefined) forecast.assumedCostPerOperation = assumedCost;
    if (assumedUnitCost !== undefined) forecast.assumedCostPerUnit = assumedUnitCost;
    if (targetDays !== undefined) forecast.targetPeriodDays = targetDays;
    const volumeUnit = value(req.query["volumeUnit"]);
    const timezone = value(req.query["timezone"] ?? req.query["workspaceTimezone"]);
    const accountScope = value(req.query["accountScope"]);
    const cloudProject = value(req.query["cloudProject"]);
    const asOf = value(req.query["asOf"]);
    if (volumeUnit) forecast.volumeUnit = volumeUnit;
    if (timezone) forecast.timezone = timezone;
    if (accountScope) forecast.accountScope = accountScope;
    if (cloudProject) forecast.cloudProject = cloudProject;
    if (asOf) forecast.asOf = asOf;
    if (req.query["fullyPricedOnly"] !== undefined) forecast.fullyPricedOnly = req.query["fullyPricedOnly"] === "true";
    return forecast;
  }

  router.get("/api/v1/projects/:projectId/forecast", async (req, res) => {
    try {
      if ((value(req.query["currency"]) ?? "USD").toUpperCase() !== "USD") {
        res.status(400).json({ error: "INR forecast requires a dated FX conversion basis; USD is currently the available forecast currency", code: "reporting_currency_unavailable" });
        return;
      }
      const rawFrom = value(req.query["from"]);
      const rawTo = value(req.query["to"]);
      if ((rawFrom && Number.isNaN(new Date(rawFrom).getTime())) || (rawTo && Number.isNaN(new Date(rawTo).getTime()))) {
        res.status(400).json({ error: "from and to must be valid dates", code: "invalid_forecast_scope" });
        return;
      }
      if (rawFrom && rawTo && new Date(rawFrom) >= new Date(rawTo)) {
        res.status(400).json({ error: "Forecast range must satisfy from < to", code: "invalid_forecast_scope" });
        return;
      }
      const forecast = await calculateForecast(pool, req.params["projectId"] as string, await forecastScope(req));
      res.json({ forecast });
    } catch (err) {
      if (err instanceof ForecastInputError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      console.error("[costkey] Forecast error:", err);
      res.status(500).json({ error: "Failed to calculate forecast" });
    }
  });

  router.post("/api/v1/projects/:projectId/forecast", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if ((value(body["currency"]) ?? "USD").toUpperCase() !== "USD") {
        res.status(400).json({ error: "INR forecast requires a dated FX conversion basis; USD is currently the available forecast currency", code: "reporting_currency_unavailable" });
        return;
      }
      const scope: ForecastScope = {
        from: value(body["from"]),
        to: value(body["to"]),
        environment: value(body["environment"]),
        feature: value(body["feature"]),
        function: value(body["function"]),
        customer: value(body["customer"]),
        service: value(body["service"] ?? body["route"]),
        release: value(body["release"]),
        model: value(body["model"]),
        provider: value(body["provider"]),
        groupBy: validDimension(body["groupBy"]),
        groupValue: value(body["groupValue"] ?? body["value"]),
        contextKey: value(body["contextKey"]),
        contextValue: value(body["contextValue"]),
        currency: (value(body["currency"]) ?? "USD").toUpperCase(),
      };
      if (scope.contextKey && !SAFE_CONTEXT_KEYS.has(scope.contextKey)) {
        res.status(400).json({ error: "contextKey is not an allowed metadata key", code: "invalid_context_key" });
        return;
      }
      const restricted = !await sourceAccessAllowed(pool, req.params["projectId"] as string, user(req).role);
      if (restricted) dropSourceFilters(scope);
      if (restricted && scope.groupBy === "function") { scope.groupBy = undefined; scope.groupValue = undefined; }
      scope.searchSource = !restricted;
      if (body["operations"] != null) scope.operations = number(body["operations"], -1);
      if (body["volume"] != null) scope.volume = number(body["volume"], -1);
      if (body["users"] != null) scope.users = number(body["users"], -1);
      if (body["conversations"] != null) scope.conversations = number(body["conversations"], -1);
      if (body["operationsPerUser"] != null) scope.operationsPerUser = number(body["operationsPerUser"], -1);
      if (body["operationsPerConversation"] != null) scope.operationsPerConversation = number(body["operationsPerConversation"], -1);
      if (body["assumedCostPerOperation"] != null) scope.assumedCostPerOperation = number(body["assumedCostPerOperation"], -1);
      if (body["assumedCostPerUnit"] != null) scope.assumedCostPerUnit = number(body["assumedCostPerUnit"], -1);
      if (body["targetPeriodDays"] != null) scope.targetPeriodDays = number(body["targetPeriodDays"], -1);
      if (body["volumeUnit"] != null) scope.volumeUnit = value(body["volumeUnit"]);
      if (body["timezone"] != null) scope.timezone = value(body["timezone"]);
      if (body["accountScope"] != null) scope.accountScope = value(body["accountScope"]);
      if (body["cloudProject"] != null) scope.cloudProject = value(body["cloudProject"]);
      if (body["asOf"] != null) scope.asOf = value(body["asOf"]);
      if (body["fullyPricedOnly"] != null) scope.fullyPricedOnly = body["fullyPricedOnly"] === true;
      if (scope.from && Number.isNaN(new Date(scope.from).getTime()) || scope.to && Number.isNaN(new Date(scope.to).getTime())) {
        res.status(400).json({ error: "from and to must be valid dates" });
        return;
      }
      if (scope.from && scope.to && new Date(scope.from) >= new Date(scope.to)) {
        res.status(400).json({ error: "Forecast range must satisfy from < to", code: "invalid_forecast_scope" });
        return;
      }
      const forecast = await calculateForecast(pool, req.params["projectId"] as string, scope);
      res.json({ forecast });
    } catch (err) {
      if (err instanceof ForecastInputError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      console.error("[costkey] Forecast calculation error:", err);
      res.status(500).json({ error: "Failed to calculate forecast" });
    }
  });

  router.get("/api/v1/projects/:projectId/forecast/scenarios", async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, name, scope, assumptions, result, shared, calculated_at, created_by, created_at, updated_at
         FROM forecast_scenarios
         WHERE project_id = $1 AND (shared = TRUE OR created_by = $2 OR $3 IN ('owner', 'admin'))
         ORDER BY updated_at DESC LIMIT 100`,
        [req.params["projectId"], user(req).id ?? null, user(req).role?.toLowerCase() ?? "viewer"],
      );
      res.json({ scenarios: result.rows });
    } catch (err) {
      console.error("[costkey] Forecast scenarios error:", err);
      res.status(500).json({ error: "Failed to fetch forecast scenarios" });
    }
  });

  router.post("/api/v1/projects/:projectId/forecast/scenarios", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = value(body["name"]);
      if (!name) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      const shared = body["shared"] === true;
      if (shared && !roleCanPublishSharedView(user(req).role)) {
        res.status(403).json({ error: "Viewers cannot publish shared forecast scenarios" });
        return;
      }
      const scope = (body["scope"] && typeof body["scope"] === "object" ? body["scope"] : {}) as ForecastScope;
      const assumptions = (body["assumptions"] && typeof body["assumptions"] === "object" ? body["assumptions"] : {}) as Record<string, unknown>;
      const forecast = await calculateForecast(pool, req.params["projectId"] as string, { ...scope, ...assumptions });
      const id = randomId("fc_");
      await pool.query(
        `INSERT INTO forecast_scenarios (id, project_id, name, scope, assumptions, result, shared, calculated_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, req.params["projectId"], name, JSON.stringify(scope), JSON.stringify(assumptions), JSON.stringify(forecast), shared, forecast.calculatedAt, user(req).id ?? null],
      );
      res.status(201).json({ id, scenario: forecast });
    } catch (err) {
      if (err instanceof ForecastInputError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      console.error("[costkey] Forecast scenario create error:", err);
      res.status(500).json({ error: "Failed to save forecast scenario" });
    }
  });

  router.get("/api/v1/projects/:projectId/forecast/scenarios/:scenarioId", async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, name, scope, assumptions, result, shared, calculated_at, created_by, created_at, updated_at
         FROM forecast_scenarios
         WHERE project_id = $1 AND id = $2
           AND (shared = TRUE OR created_by = $3 OR $4 IN ('owner', 'admin'))`,
        [req.params["projectId"], req.params["scenarioId"], user(req).id ?? null, user(req).role?.toLowerCase() ?? "viewer"],
      );
      if (result.rows.length === 0) { res.status(404).json({ error: "Forecast scenario not found" }); return; }
      res.json({ scenario: result.rows[0] });
    } catch (err) {
      console.error("[costkey] Forecast scenario read error:", err);
      res.status(500).json({ error: "Failed to fetch forecast scenario" });
    }
  });

  router.patch("/api/v1/projects/:projectId/forecast/scenarios/:scenarioId", async (req, res) => {
    try {
      const projectId = req.params["projectId"] as string;
      const scenarioId = req.params["scenarioId"] as string;
      const existing = await pool.query(
        `SELECT id, name, scope, assumptions, shared, created_by FROM forecast_scenarios
         WHERE project_id = $1 AND id = $2 AND (created_by = $3 OR $4 IN ('owner', 'admin'))`,
        [projectId, scenarioId, user(req).id ?? null, user(req).role?.toLowerCase() ?? "viewer"],
      );
      if (existing.rows.length === 0) { res.status(404).json({ error: "Forecast scenario not found" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const shared = body.shared === undefined ? Boolean(existing.rows[0].shared) : body.shared === true;
      if (shared && !roleCanPublishSharedView(user(req).role)) { res.status(403).json({ error: "Viewers cannot publish shared forecast scenarios" }); return; }
      const name = body.name === undefined ? String(existing.rows[0].name) : value(body.name);
      if (!name) { res.status(400).json({ error: "name is required" }); return; }
      await pool.query(
        `UPDATE forecast_scenarios SET name = $1, shared = $2, updated_at = NOW() WHERE project_id = $3 AND id = $4`,
        [name, shared, projectId, scenarioId],
      );
      res.json({ ok: true, id: scenarioId, name, shared });
    } catch (err) {
      console.error("[costkey] Forecast scenario update error:", err);
      res.status(500).json({ error: "Failed to update forecast scenario" });
    }
  });

  router.delete("/api/v1/projects/:projectId/forecast/scenarios/:scenarioId", async (req, res) => {
    try {
      const projectId = req.params["projectId"] as string;
      const result = await pool.query(
        `DELETE FROM forecast_scenarios
         WHERE project_id = $1 AND id = $2
           AND (created_by = $3 OR $4 IN ('owner', 'admin'))
         RETURNING id`,
        [projectId, req.params["scenarioId"], user(req).id ?? null, user(req).role?.toLowerCase() ?? "viewer"],
      );
      if (result.rows.length === 0) { res.status(404).json({ error: "Forecast scenario not found" }); return; }
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] Forecast scenario delete error:", err);
      res.status(500).json({ error: "Failed to delete forecast scenario" });
    }
  });

  // ── Manual credits ─────────────────────────────────────────────────
  router.get("/api/v1/projects/:projectId/credits", async (req, res) => {
    try {
      const credits = await listCredits(pool, req.params["projectId"] as string);
      res.json({ credits });
    } catch (err) {
      console.error("[costkey] Credits list error:", err);
      res.status(500).json({ error: "Failed to fetch credits" });
    }
  });

  router.post("/api/v1/projects/:projectId/credits", async (req, res) => {
    try {
      if (!requireManager(req, res)) return;
      const parsed = parseCreditInput((req.body ?? {}) as Record<string, unknown>);
      if ("error" in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const id = randomId("credit_");
      const projectId = req.params["projectId"] as string;
      await createCredit(pool, projectId, parsed, id, user(req).id ?? null);
      const credit = (await listCredits(pool, projectId)).find((item) => item.id === id) ?? { id, ...parsed };
      res.status(201).json({ credit });
    } catch (err) {
      console.error("[costkey] Credit create error:", err);
      res.status(500).json({ error: "Failed to create credit" });
    }
  });

  router.patch("/api/v1/projects/:projectId/credits/:creditId", async (req, res) => {
    try {
      if (!requireManager(req, res)) return;
      const parsed = parseCreditInput((req.body ?? {}) as Record<string, unknown>);
      if ("error" in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const projectId = req.params["projectId"] as string;
      const creditId = req.params["creditId"] as string;
      const ok = await updateCredit(pool, projectId, creditId, parsed);
      if (!ok) {
        res.status(404).json({ error: "Credit not found" });
        return;
      }
      const credit = (await listCredits(pool, projectId)).find((item) => item.id === creditId);
      res.json({ credit, ok: true });
    } catch (err) {
      console.error("[costkey] Credit update error:", err);
      res.status(500).json({ error: "Failed to update credit" });
    }
  });

  router.delete("/api/v1/projects/:projectId/credits/:creditId", async (req, res) => {
    try {
      if (!requireManager(req, res)) return;
      const ok = await deleteCredit(pool, req.params["projectId"] as string, req.params["creditId"] as string);
      if (!ok) {
        res.status(404).json({ error: "Credit not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] Credit delete error:", err);
      res.status(500).json({ error: "Failed to delete credit" });
    }
  });

  // ── Dated effective prices ─────────────────────────────────────────
  router.get("/api/v1/projects/:projectId/effective-prices", async (req, res) => {
    try {
      const prices = await listEffectivePrices(pool, req.params["projectId"] as string);
      res.json({ prices, overrides: prices });
    } catch (err) {
      console.error("[costkey] Effective prices list error:", err);
      res.status(500).json({ error: "Failed to fetch effective prices" });
    }
  });

  router.post("/api/v1/projects/:projectId/effective-prices", async (req, res) => {
    try {
      if (!requireManager(req, res)) return;
      const input = parseEffectivePriceBody((req.body ?? {}) as Record<string, unknown>);
      const id = randomId("price_");
      const actor = { id: user(req).id ?? null, role: user(req).role ?? "viewer" };
      assertCanManageEffectivePrices(actor.role);
      await createEffectivePrice(pool, req.params["projectId"] as string, input, id, actor);
      invalidateProjectPrices(req.params["projectId"] as string);
      const prices = await listEffectivePrices(pool, req.params["projectId"] as string);
      const repricing = await repriceHistoricalForEffectivePrice(pool, req.params["projectId"] as string, id);
      res.status(201).json({ price: prices.find((price) => price.id === id) ?? { id, ...input }, repricing });
    } catch (err) {
      if (err instanceof EffectivePriceInputError || err instanceof EffectivePriceConflictError || err instanceof EffectivePricePermissionError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      console.error("[costkey] Effective price create error:", err);
      res.status(500).json({ error: "Failed to create effective price" });
    }
  });

  router.patch("/api/v1/projects/:projectId/effective-prices/:priceId", async (req, res) => {
    try {
      if (!requireManager(req, res)) return;
      const input = parseEffectivePriceBody((req.body ?? {}) as Record<string, unknown>);
      const actor = { id: user(req).id ?? null, role: user(req).role ?? "viewer" };
      const replacementId = randomId("price_");
      const id = await updateEffectivePrice(pool, req.params["projectId"] as string, req.params["priceId"] as string, input, actor, replacementId);
      invalidateProjectPrices(req.params["projectId"] as string);
      if (!id) { res.status(404).json({ error: "Effective price not found" }); return; }
      const prices = await listEffectivePrices(pool, req.params["projectId"] as string);
      const repricing = await repriceHistoricalForEffectivePrice(pool, req.params["projectId"] as string, id);
      res.json({ price: prices.find((price) => price.id === id) ?? { id, ...input }, repricing });
    } catch (err) {
      if (err instanceof EffectivePriceInputError || err instanceof EffectivePriceConflictError || err instanceof EffectivePricePermissionError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      console.error("[costkey] Effective price update error:", err);
      res.status(500).json({ error: "Failed to update effective price" });
    }
  });

  router.delete("/api/v1/projects/:projectId/effective-prices/:priceId", async (req, res) => {
    try {
      if (!requireManager(req, res)) return;
      const actor = { id: user(req).id ?? null, role: user(req).role ?? "viewer" };
      const ok = await deleteEffectivePrice(pool, req.params["projectId"] as string, req.params["priceId"] as string, actor);
      invalidateProjectPrices(req.params["projectId"] as string);
      if (!ok) { res.status(404).json({ error: "Effective price not found" }); return; }
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof EffectivePriceInputError || err instanceof EffectivePricePermissionError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      console.error("[costkey] Effective price delete error:", err);
      res.status(500).json({ error: "Failed to revoke effective price" });
    }
  });

  return router;
}

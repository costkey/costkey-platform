import type pg from "pg";
import { OUTPUT_TOKENS_SQL, PROMPT_TOKENS_SQL } from "./token-sql.js";

/** Shared filters for every financial view. Keep dimensions/lens filters here
 * so overview, Costs, Findings and Forecast cannot silently count different
 * records. All dates are half-open [from, to). */
export type ScopeValues = string | string[];

export interface ChargeScope {
  from?: string | null;
  to?: string | null;
  environment?: ScopeValues | null;
  feature?: ScopeValues | null;
  function?: ScopeValues | null;
  /** A source file: the exact recorded path, or a path it ends with ("src/agents/summarize.ts"). */
  file?: ScopeValues | null;
  /** A bare function name ("summarize", or a method "Summarizer.run"). */
  functionName?: ScopeValues | null;
  customer?: ScopeValues | null;
  service?: ScopeValues | null;
  release?: ScopeValues | null;
  model?: ScopeValues | null;
  provider?: ScopeValues | null;
  traceId?: ScopeValues | null;
  executionId?: ScopeValues | null;
  q?: string | null;
  groupBy?: "feature" | "function" | "customer" | "model" | "provider" | "context" | null;
  groupValue?: ScopeValues | null;
  contextKey?: string | null;
  contextValue?: ScopeValues | null;
  timezone?: string | null;
  /** Internal role-aware opt-in for source-location q matching. */
  searchSource?: boolean;
  /** Read only these parts of the window from calls and usage; rollupPlan decides them. */
  ranges?: Array<{ from: string; to: string }> | null;
}

export interface CanonicalCharge {
  project_id: string;
  record_id: string;
  charge_key: string;
  timestamp: string;
  provider: string;
  model: string | null;
  request_model: string | null;
  pricing_id: string | null;
  cost_usd: number | null;
  cost_basis: string;
  cost_source: string | null;
  cost_currency: string;
  duration_ms: number | null;
  trace_id: string | null;
  trace_name: string | null;
  context: Record<string, unknown> | null;
  release: string | null;
  service: string | null;
  feature_source: string | null;
  feature_mapping_id: string | null;
  feature_mapping_action_id: string | null;
  feature_original: string | null;
  execution_id: string | null;
  group_id: string | null;
  group_name: string | null;
  group_kind: string | null;
  phase: string | null;
  case_id: string | null;
  record_type: "call" | "usage";
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  unit_value: number | null;
  unit: string | null;
  unit_kind: string | null;
  revision: number | null;
  bl_file: string | null;
  bl_function: string | null;
  bl_line: number | null;
}

export interface DailyAggregateRow {
  project_id: string;
  day: string;
  timezone: string;
  environment: string;
  feature: string;
  function_key: string;
  customer: string;
  service: string;
  release: string;
  provider: string;
  model: string;
  known_cost_usd: number | null;
  observations: number;
  call_count: number;
  priced_observations: number;
  unpriced_observations: number;
  trace_count: number;
  fully_priced_trace_count: number;
  fully_priced_trace_cost_usd: number | null;
  reported_observations: number;
  estimated_observations: number;
  unknown_observations: number;
  input_tokens: number;
  output_tokens: number;
  no_charge_observations: number;
  duration_sum_ms: number;
  duration_count: number;
  untraced_usage_count: number;
  untraced_usage_cost_usd: number | null;
}

/**
 * One reconciled relation for automatic calls and explicit usage components.
 * Explicit components linked to an automatic charge are excluded. Delta
 * revisions remain separate records; only the active cumulative snapshot is
 * included. Unknown USD amounts stay NULL.
 */
/** Placeholders for the project and, optionally, the window a charges query reads. */
export interface ChargeBounds { project: string; from?: string; to?: string; ranges?: Array<{ from: string; to: string }>; marginDays?: number }

/** Where scopeClauses put a query's window, so chargesCte can read only that slice. */
const queryBounds = new WeakMap<unknown[], Omit<ChargeBounds, "project">>();

/**
 * The canonical charges. Given the params a scopeClauses call filled ($1 is the
 * project), it reads only that project's records in that window, instead of
 * every record of every project and then filtering: a full scan and sort that
 * grows with the database. Without params it reads everything, as before.
 */
export function chargesCte(scoped?: unknown[] | ChargeBounds, options: { marginDays?: number } = {}): string {
  // Params filled by scopeClauses carry their window; explicit bounds name it.
  const given: ChargeBounds | undefined = Array.isArray(scoped)
    ? { project: "$1", ...(queryBounds.get(scoped) ?? {}) }
    : scoped;
  // A run's cost needs its calls just outside the window too: widen by a margin.
  const margin = options.marginDays ?? given?.marginDays;
  const widen = (bound: string | undefined, sign: "-" | "+") => bound && margin
    ? `(${bound}::timestamptz ${sign} INTERVAL '${Math.max(0, Math.floor(margin))} days')` : bound;
  const within = (column: string): string => {
    if (given?.ranges) {
      if (given.ranges.length === 0) return " AND FALSE";
      return ` AND (${given.ranges.map((range) => `(${column} >= ${widen(range.from, "-")} AND ${column} < ${widen(range.to, "+")})`).join(" OR ")})`;
    }
    const from = widen(given?.from, "-");
    const to = widen(given?.to, "+");
    return `${from ? ` AND ${column} >= ${from}` : ""}${to ? ` AND ${column} < ${to}` : ""}`;
  };
  const eventBounds = given ? ` AND e.project_id = ${given.project}${within("e.timestamp")}` : "";
  const usageBounds = given ? ` AND u.project_id = ${given.project}${within("COALESCE(u.accounting_at, u.observed_at)")}` : "";
  return `
    WITH auto_raw AS (
      SELECT e.project_id, e.id AS record_id,
             COALESCE(e.charge_id, e.id) AS charge_key,
             e.timestamp, e.provider, e.model, e.request_model, e.pricing_id,
             e.cost_usd, e.cost_basis, e.cost_source, e.cost_currency,
             e.duration_ms, e.trace_id, e.trace_name, e.context,
             e.release AS release, e.context->>'service' AS service,
             e.feature_source, e.feature_mapping_id, e.feature_mapping_action_id, e.feature_original,
             e.execution_id, e.group_id, e.group_name, e.group_kind,
             e.phase, e.case_id, e.bl_file, e.bl_function, e.bl_line,
             'call'::text AS record_type,
             e.input_tokens, e.output_tokens, e.total_tokens,
             -- Tokens as the console counts them everywhere: the whole prompt (cache
             -- reads and writes included) and output with reasoning.
             ${PROMPT_TOKENS_SQL("e")} AS prompt_tokens, ${OUTPUT_TOKENS_SQL("e")} AS completion_tokens,
             NULL::double precision AS unit_value, NULL::text AS unit,
             NULL::text AS unit_kind, NULL::integer AS revision,
             -- A failed call without a price cost nothing: it is not unpriced.
             (e.cost_usd IS NULL AND (COALESCE(e.lifecycle_state, '') IN ('failed', 'cancelled')
               OR COALESCE(e.status_code, 200) >= 400)) AS no_charge
      FROM events e
      WHERE COALESCE(e.event_type, 'call') = 'call'${eventBounds}
    ), auto_charges AS (
      SELECT DISTINCT ON (project_id, charge_key) *
      FROM auto_raw
      ORDER BY project_id, charge_key,
               CASE WHEN cost_usd IS NOT NULL THEN 0 ELSE 1 END,
               CASE WHEN cost_basis = 'reported' THEN 0 ELSE 1 END,
               timestamp DESC, record_id DESC
    ), explicit_raw AS (
      SELECT u.project_id, u.id AS record_id,
             CASE WHEN a.charge_key IS NOT NULL THEN u.charge_id
               WHEN u.aggregation = 'delta'
                 THEN COALESCE(u.charge_id, u.id) || ':delta:' || u.id
               ELSE COALESCE(u.charge_id, u.id) || ':cumulative'
             END AS charge_key,
             COALESCE(u.accounting_at, u.observed_at) AS timestamp,
             u.provider, u.model,
             NULL::text AS request_model, u.pricing_id,
             CASE WHEN UPPER(u.currency) = 'USD' THEN u.amount ELSE NULL END AS cost_usd,
             CASE WHEN u.amount IS NULL THEN 'unknown' ELSE u.amount_kind END AS cost_basis,
             CASE WHEN u.amount IS NULL THEN NULL ELSE 'explicit' END AS cost_source,
             u.currency AS cost_currency, NULL::double precision AS duration_ms,
             u.trace_id, anchor.trace_name,
             COALESCE(anchor.context, '{}'::jsonb) || COALESCE(u.context, '{}'::jsonb) AS context,
             COALESCE(anchor.release,
               (COALESCE(anchor.context, '{}'::jsonb) || COALESCE(u.context, '{}'::jsonb))->>'release') AS release,
             (COALESCE(anchor.context, '{}'::jsonb) || COALESCE(u.context, '{}'::jsonb))->>'service' AS service,
             CASE WHEN NULLIF(BTRIM(COALESCE(u.context, '{}'::jsonb)->>'feature'), '') IS NOT NULL THEN 'explicit'
                  ELSE COALESCE(anchor.feature_source, 'unknown') END AS feature_source,
             anchor.feature_mapping_id, anchor.feature_mapping_action_id, anchor.feature_original,
             COALESCE(u.execution_id, anchor.execution_id) AS execution_id,
             COALESCE(u.group_id, anchor.group_id) AS group_id,
             anchor.group_name, anchor.group_kind, u.phase, anchor.case_id,
             anchor.bl_file, anchor.bl_function, anchor.bl_line,
             'usage'::text AS record_type, NULL::integer AS input_tokens,
             NULL::integer AS output_tokens, NULL::integer AS total_tokens,
             NULL::integer AS prompt_tokens, NULL::integer AS completion_tokens,
             u.unit_value, u.unit, u.unit_kind, u.revision,
             FALSE AS no_charge
      FROM usage_components u
      LEFT JOIN LATERAL (
        SELECT e.trace_name, e.context, e.release AS release, e.feature_source, e.feature_mapping_id,
               e.feature_mapping_action_id, e.feature_original,
               e.execution_id, e.group_id,
               e.group_name, e.group_kind, e.case_id,
               e.bl_file, e.bl_function, e.bl_line
        FROM events e
        WHERE e.project_id = u.project_id
          AND COALESCE(e.event_type, 'call') = 'call'
          AND (
            (u.charge_id IS NOT NULL AND COALESCE(e.charge_id, e.id) = u.charge_id)
            OR (u.trace_id IS NOT NULL AND e.trace_id = u.trace_id)
            OR (u.execution_id IS NOT NULL AND e.execution_id = u.execution_id)
          )
        ORDER BY CASE WHEN u.charge_id IS NOT NULL AND COALESCE(e.charge_id, e.id) = u.charge_id THEN 0 ELSE 1 END,
                 e.timestamp ASC, e.id ASC
        LIMIT 1
      ) anchor ON TRUE
      LEFT JOIN auto_charges a
        ON a.project_id = u.project_id AND a.charge_key = u.charge_id
      WHERE (u.aggregation = 'delta' OR u.active = TRUE)${usageBounds}
    ), all_charges AS (
      SELECT a.*, 0::int AS source_order FROM auto_charges a
      UNION ALL
      SELECT e.*, 1::int AS source_order FROM explicit_raw e
    ), charges AS (
      SELECT DISTINCT ON (project_id, charge_key) *
      FROM all_charges
      ORDER BY project_id, charge_key,
               CASE WHEN cost_usd IS NOT NULL THEN 0 ELSE 1 END,
               source_order, timestamp DESC, record_id DESC
    )`;
}

function add(params: unknown[], expression: string, item: unknown, clauses: string[]): void {
  params.push(item);
  clauses.push(`${expression} = $${params.length}`);
}

function values(item: ScopeValues | null | undefined): string[] {
  if (Array.isArray(item)) return item.filter((value) => value.length > 0);
  return typeof item === "string" && item.length > 0 ? [item] : [];
}

/** Escape LIKE wildcards so a path matches literally. */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** A path as typed by a person or an agent: no leading "./" or "/". */
export function relativeFile(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

/**
 * Source-file filter: the recorded path equals the value, or ends with it at
 * a path boundary, so a repo-relative path matches an absolute stack path.
 */
function addFileValues(params: unknown[], expression: string, item: ScopeValues | null | undefined, clauses: string[]): void {
  const items = values(item).map(relativeFile).filter(Boolean);
  if (items.length === 0) return;
  params.push(items);
  const exact = params.length;
  params.push(items.map((file) => `%/${likeLiteral(file)}`));
  const suffix = params.length;
  clauses.push(`(${expression} = ANY($${exact}::text[]) OR ${expression} LIKE ANY($${suffix}::text[]))`);
}

/** A bare function name, or the method of that name on any class. */
function addFunctionNameValues(params: unknown[], expression: string, item: ScopeValues | null | undefined, clauses: string[]): void {
  const items = values(item).map((name) => name.trim()).filter(Boolean);
  if (items.length === 0) return;
  params.push(items);
  const exact = params.length;
  params.push(items.map((name) => `%.${likeLiteral(name)}`));
  const method = params.length;
  clauses.push(`(${expression} = ANY($${exact}::text[]) OR ${expression} LIKE ANY($${method}::text[]))`);
}

function addValues(params: unknown[], expression: string, item: ScopeValues | null | undefined, clauses: string[]): void {
  const items = values(item);
  if (items.length === 0) return;
  if (items.length === 1) {
    add(params, expression, items[0], clauses);
    return;
  }
  params.push(items);
  clauses.push(`${expression} = ANY($${params.length}::text[])`);
}

/** Add the same scope predicates to a `charges c` or `events e` relation. */
export function scopeClauses(scope: ChargeScope, params: unknown[], alias = "c"): string[] {
  const clauses: string[] = [`${alias}.project_id = $1`];
  const bounds: Omit<ChargeBounds, "project"> = {};
  if (scope.ranges) {
    // Parts of a window beside rollup days. A charge's records can sit either
    // side of a midnight and the rollup keeps it on its winning record's day,
    // so read a day either way to de-duplicate it the same way here.
    bounds.ranges = scope.ranges.map((range) => {
      params.push(range.from);
      const from = `$${params.length}`;
      params.push(range.to);
      return { from, to: `$${params.length}` };
    });
    bounds.marginDays = 1;
    clauses.push(bounds.ranges.length > 0
      ? `(${bounds.ranges.map((range) => `(${alias}.timestamp >= ${range.from} AND ${alias}.timestamp < ${range.to})`).join(" OR ")})`
      : "FALSE");
  } else {
    if (scope.from) {
      params.push(scope.from);
      bounds.from = `$${params.length}`;
      clauses.push(`${alias}.timestamp >= $${params.length}`);
    }
    if (scope.to) {
      params.push(scope.to);
      bounds.to = `$${params.length}`;
      clauses.push(`${alias}.timestamp < $${params.length}`);
    }
  }
  queryBounds.set(params, bounds);
  addValues(params, `${alias}.context->>'environment'`, scope.environment, clauses);
  addValues(params, `${alias}.context->>'feature'`, scope.feature, clauses);
  const functionValues = values(scope.function);
  if (functionValues.length > 0) {
    params.push(functionValues);
    const plainParam = params.length;
    params.push(functionValues);
    const serviceParam = params.length;
    clauses.push(`((COALESCE(${alias}.bl_file, '') || ':' || COALESCE(${alias}.bl_function, '')) = ANY($${plainParam}::text[])
      OR ((COALESCE(${alias}.context->>'service', '') || ':' || COALESCE(${alias}.bl_file, '') || ':' || COALESCE(${alias}.bl_function, '')) = ANY($${serviceParam}::text[])))`);
  }
  addFileValues(params, `${alias}.bl_file`, scope.file, clauses);
  addFunctionNameValues(params, `${alias}.bl_function`, scope.functionName, clauses);
  addValues(params, `${alias}.context->>'customer'`, scope.customer, clauses);
  addValues(params, `${alias}.context->>'service'`, scope.service, clauses);
  addValues(params, `${alias}.context->>'release'`, scope.release, clauses);
  if (scope.model) {
    const items = values(scope.model);
    params.push(items);
    clauses.push(alias === "tb"
      ? `string_to_array(COALESCE(${alias}.models, ''), ',') && $${params.length}::text[]`
      : `${alias}.model = ANY($${params.length}::text[])`);
  }
  if (scope.provider) {
    const items = values(scope.provider);
    params.push(items);
    clauses.push(alias === "tb"
      ? `string_to_array(COALESCE(${alias}.providers, ''), ',') && $${params.length}::text[]`
      : `${alias}.provider = ANY($${params.length}::text[])`);
  }
  addValues(params, `${alias}.trace_id`, scope.traceId, clauses);
  addValues(params, `${alias}.execution_id`, scope.executionId, clauses);
  if (scope.q) {
    params.push(`%${scope.q}%`);
    const identity = alias === "tb"
      ? `${alias}.trace_id ILIKE $${params.length}`
      : alias === "e"
        ? `${alias}.id ILIKE $${params.length}
           OR ${alias}.charge_id ILIKE $${params.length}
           OR ${alias}.trace_id ILIKE $${params.length}`
        : `${alias}.record_id ILIKE $${params.length}
           OR ${alias}.charge_key ILIKE $${params.length}
           OR ${alias}.trace_id ILIKE $${params.length}`;
    const sourceIdentity = scope.searchSource
      ? `OR COALESCE(${alias}.bl_file, '') ILIKE $${params.length}
         OR COALESCE(${alias}.bl_function, '') ILIKE $${params.length}`
      : "";
    clauses.push(`(${identity}
      OR COALESCE(${alias}.trace_name, '') ILIKE $${params.length}
      OR COALESCE(${alias}.model, '') ILIKE $${params.length}
      OR COALESCE(${alias}.provider, '') ILIKE $${params.length}
      OR COALESCE(${alias}.context->>'feature', '') ILIKE $${params.length}
      OR COALESCE(${alias}.context->>'customer', '') ILIKE $${params.length}
      OR COALESCE(${alias}.context->>'environment', '') ILIKE $${params.length}
      OR COALESCE(${alias}.phase, '') ILIKE $${params.length}
      ${sourceIdentity})`);
  }
  if (scope.groupBy && scope.groupValue) {
    addValues(params, dimensionExpression(scope, alias), scope.groupValue, clauses);
  } else if (scope.groupBy === "context" && scope.contextKey && scope.contextValue) {
    const key = scope.contextKey.replace(/'/g, "''");
    addValues(params, `${alias}.context->>'${key}'`, scope.contextValue, clauses);
  }
  return clauses;
}

export function dimensionExpression(scope: Pick<ChargeScope, "groupBy" | "contextKey">, alias = "c"): string {
  switch (scope.groupBy) {
    case "function": return `CASE WHEN ${alias}.bl_file IS NULL AND ${alias}.bl_function IS NULL THEN '(unassigned)'
      WHEN NULLIF(${alias}.context->>'service', '') IS NULL THEN COALESCE(NULLIF(${alias}.bl_file || ':' || ${alias}.bl_function, ':'), '(unassigned)')
      ELSE (${alias}.context->>'service') || ':' || COALESCE(NULLIF(${alias}.bl_file || ':' || ${alias}.bl_function, ':'), '(unassigned)') END`;
    case "customer": return `COALESCE(NULLIF(${alias}.context->>'customer', ''), '(unassigned)')`;
    case "model": return `COALESCE(NULLIF(${alias}.model, ''), '(unknown)')`;
    case "provider": return `COALESCE(NULLIF(${alias}.provider, ''), '(unknown)')`;
    case "context": {
      const key = (scope.contextKey ?? "").replace(/'/g, "''");
      return `COALESCE(NULLIF(${alias}.context->>'${key}', ''), '(unassigned)')`;
    }
    case "feature":
    default: return `COALESCE(NULLIF(${alias}.context->>'feature', ''), '(unassigned)')`;
  }
}

export function numeric(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

export function financialFields(row: Record<string, unknown>): {
  observations: number;
  call_count: number;
  priced_observations: number;
  unpriced_count: number;
  known_cost: number | null;
  coverage: number | null;
  accounting_state: "complete" | "partial" | "pending";
} {
  const observations = numeric(row.observations);
  const priced = numeric(row.priced_observations);
  const unpriced = numeric(row.unpriced_observations);
  return {
    observations,
    call_count: numeric(row.call_count),
    priced_observations: priced,
    unpriced_count: unpriced,
    known_cost: priced > 0 ? numeric(row.known_cost) : null,
    coverage: observations > 0 ? priced / observations : null,
    accounting_state: observations === 0 ? "pending" : unpriced > 0 ? "partial" : "complete",
  };
}

export async function loadCanonicalCharges(
  pool: pg.Pool | pg.PoolClient,
  projectId: string,
  scope: ChargeScope = {},
  options: { limit?: number; order?: "asc" | "desc" } = {},
): Promise<CanonicalCharge[]> {
  const params: unknown[] = [projectId];
  const clauses = scopeClauses(scope, params, "c");
  const order = options.order === "desc" ? "DESC" : "ASC";
  const limit = options.limit === undefined
    ? ""
    : ` LIMIT $${params.length + 1}`;
  if (options.limit !== undefined) params.push(Math.min(Math.max(Math.trunc(options.limit), 1), 100_001));
  const result = await pool.query(
    `${chargesCte(params)}
     SELECT c.* FROM charges c WHERE ${clauses.join(" AND ")}
     ORDER BY c.timestamp ${order}, c.record_id ${order}${limit}`,
    params,
  );
  return result.rows as CanonicalCharge[];
}

function aggregateDimensionExpression(scope: ChargeScope, alias = "a"): string | null {
  switch (scope.groupBy) {
    case "feature": return `${alias}.feature`;
    case "function": return `${alias}.function_key`;
    case "customer": return `${alias}.customer`;
    case "model": return `${alias}.model`;
    case "provider": return `${alias}.provider`;
    case "context": {
      const key = scope.contextKey;
      if (key === "environment") return `${alias}.environment`;
      if (key === "feature") return `${alias}.feature`;
      if (key === "customer") return `${alias}.customer`;
      if (key === "provider") return `${alias}.provider`;
      if (key === "model") return `${alias}.model`;
      return null;
    }
    default: return `COALESCE(${alias}.feature, '(unassigned)')`;
  }
}

function aggregateValues(params: unknown[], expression: string, item: ScopeValues | null | undefined, clauses: string[]): void {
  const items = values(item);
  if (items.length === 0) return;
  params.push(items);
  clauses.push(`${expression} = ANY($${params.length}::text[])`);
}

/** Bump when the rollup's meaning changes: days of older versions are rebuilt and read from detail until then. */
export const DAILY_ROLLUP_VERSION = 1;

/** Context keys the console may list and group by. */
export const SAFE_CONTEXT_KEYS = new Set([
  "environment", "service", "release", "operation", "feature", "function", "functionName",
  "group", "groupName", "groupType", "executionId", "execution_id", "phase", "caseId", "case_id",
  "datasetRevision", "dataset_revision", "customer", "customerId", "customer_id", "traceId", "trace_id",
  "traceName", "trace_name", "runtime", "task",
  "agent", "tool", "userId", "conversationId", "voiceSessionId",
]);

/** Which of a window's days the rollup answers, and what is left to read from calls and usage. */
export interface RollupPlan {
  rollupDays: string[];
  /** The window around those days; empty when they cover all of it. Null when no day qualifies. */
  ranges: Array<{ from: string; to: string }> | null;
  /** False when the rollup answers the whole window, so no charges need building. */
  readsDetail: boolean;
}

const READ_FROM_DETAIL: RollupPlan = { rollupDays: [], ranges: null, readsDetail: true };

/** Can daily rows answer this scope exactly as calls would? */
function rollupAnswers(scope: ChargeScope, needsTraces: boolean): boolean {
  if (!scope.from || !scope.to || scope.q || scope.groupBy === "context") return false;
  // Matched differently from calls (a function with or without its service, a
  // release in the column or the context) or not kept in a daily row at all.
  const unmatched = [scope.traceId, scope.executionId, scope.function, scope.file, scope.functionName, scope.release, scope.groupValue, scope.contextValue];
  if (unmatched.some((item) => values(item).length > 0)) return false;
  const filters = [scope.environment, scope.feature, scope.customer, scope.service, scope.model, scope.provider].flatMap((item) => values(item));
  // Placeholders of a daily row: calls hold no such value, so a filter on one matches none.
  if (filters.some((value) => value === "(unassigned)" || value === "(unknown)")) return false;
  // Trace totals are kept per dimension, not per combination of filters.
  return !needsTraces || filters.length === 0;
}

/**
 * Split a window into days the rollup answers and the ranges calls must answer:
 * today, any partial day at its edges, and days whose calls changed since they
 * were reconciled. A day qualifies only if the scheduler rebuilt it, after it
 * ended, in the workspace's current time zone (daily_rollup_days), so a day
 * with no rollup rows reads as an empty day only when it really was one.
 */
export async function rollupPlan(
  pool: pg.Pool | pg.PoolClient,
  projectId: string,
  scope: ChargeScope,
  timezone: string,
  options: { traces?: boolean } = {},
): Promise<RollupPlan> {
  if (!rollupAnswers(scope, options.traces === true)) return READ_FROM_DETAIL;
  const from = new Date(scope.from!);
  const to = new Date(scope.to!);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return READ_FROM_DETAIL;
  let days: Array<{ day: string; day_start: Date; day_end: Date }>;
  try {
    days = (await pool.query(
      `SELECT d.day::text AS day,
              (d.day::timestamp AT TIME ZONE $2::text) AS day_start,
              ((d.day + 1)::timestamp AT TIME ZONE $2::text) AS day_end
       FROM daily_rollup_days d
       WHERE d.project_id = $1 AND d.timezone = $2::text AND d.version = $3::int
         AND d.day >= ($4::timestamptz AT TIME ZONE $2::text)::date
         AND d.day <= ($5::timestamptz AT TIME ZONE $2::text)::date
         AND (d.day::timestamp AT TIME ZONE $2::text) >= $4::timestamptz
         AND ((d.day + 1)::timestamp AT TIME ZONE $2::text) <= $5::timestamptz
         AND NOT EXISTS (
           SELECT 1 FROM accounting_changed_periods p
           WHERE p.project_id = d.project_id
             AND p.period_start >= (d.day::timestamp AT TIME ZONE $2::text)
             AND p.period_start < ((d.day + 1)::timestamp AT TIME ZONE $2::text)
         )
       ORDER BY d.day`,
      [projectId, timezone, DAILY_ROLLUP_VERSION, from.toISOString(), to.toISOString()],
    )).rows;
  } catch (error) {
    // Before startup has applied the additive schema, detail remains valid.
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "42703") return READ_FROM_DETAIL;
    throw error;
  }
  if (days.length === 0) return READ_FROM_DETAIL;
  const ranges: Array<{ from: string; to: string }> = [];
  let cursor = from;
  for (const day of days) {
    const start = new Date(day.day_start);
    if (start > cursor) ranges.push({ from: cursor.toISOString(), to: start.toISOString() });
    cursor = new Date(day.day_end);
  }
  if (cursor < to) ranges.push({ from: cursor.toISOString(), to: to.toISOString() });
  return { rollupDays: days.map((day) => day.day), ranges, readsDetail: ranges.length > 0 };
}

/** The scope a plan leaves to calls and usage. */
export function detailOfPlan(scope: ChargeScope, plan: RollupPlan): ChargeScope {
  return plan.ranges ? { ...scope, ranges: plan.ranges } : scope;
}

export interface LensTotalRow {
  group_key: string;
  observations: number;
  trace_count: number;
  fully_priced_trace_count: number;
  fully_priced_trace_cost_usd: number | null;
}

/**
 * Per-dimension totals of rollup days. A trace that spans models counts once
 * here, as it does over calls; a trace that crosses a local midnight counts
 * once on each of its days.
 */
export async function loadLensTotals(
  pool: pg.Pool | pg.PoolClient,
  projectId: string,
  days: string[],
  lens: string,
): Promise<LensTotalRow[]> {
  if (days.length === 0) return [];
  const result = await pool.query(
    `SELECT group_key, SUM(observations)::bigint AS observations, SUM(trace_count)::bigint AS trace_count,
            SUM(fully_priced_trace_count)::bigint AS fully_priced_trace_count,
            SUM(fully_priced_trace_cost_usd) AS fully_priced_trace_cost_usd
     FROM daily_lens_aggregates
     WHERE project_id = $1 AND lens = $2 AND day = ANY($3::date[])
     GROUP BY group_key`,
    [projectId, lens, days],
  );
  return result.rows.map((row) => ({
    group_key: String(row.group_key),
    observations: Number(row.observations),
    trace_count: Number(row.trace_count),
    fully_priced_trace_count: Number(row.fully_priced_trace_count),
    fully_priced_trace_cost_usd: row.fully_priced_trace_cost_usd == null ? null : Number(row.fully_priced_trace_cost_usd),
  }));
}

/** The values each filter dimension takes on rollup days, and the context keys seen. */
export async function loadRollupFilterValues(
  pool: pg.Pool | pg.PoolClient,
  projectId: string,
  days: string[],
): Promise<Array<{ lens: string; value: string; observations: number }>> {
  if (days.length === 0) return [];
  const result = await pool.query(
    `SELECT lens, group_key AS value, SUM(observations)::bigint AS observations
     FROM daily_lens_aggregates
     WHERE project_id = $1 AND day = ANY($2::date[]) AND lens <> 'window'
     GROUP BY lens, group_key
     ORDER BY lens, group_key`,
    [projectId, days],
  );
  return result.rows.map((row) => ({ lens: String(row.lens), value: String(row.value), observations: Number(row.observations) }));
}

/**
 * Read durable daily rows for the days rollupPlan chose and for workspace-local
 * days whose detail is gone. It is intentionally a separate seam: aggregates
 * cannot fabricate traces/content, but they can preserve financial totals
 * after retention removes detail. Trace counts of chosen days are left out:
 * a row per model counts a trace once per model, so they come from
 * loadLensTotals instead.
 */
export async function loadDailyAggregates(
  pool: pg.Pool | pg.PoolClient,
  projectId: string,
  scope: ChargeScope = {},
  timezone = scope.timezone ?? "UTC",
  rollupDays: string[] = [],
  /** Sum across every other dimension: a month of daily rows is thousands, and a view needs dozens. */
  collapseBy: Array<"day" | "provider" | "model" | "feature" | "function_key" | "customer"> = [],
): Promise<DailyAggregateRow[]> {
  // IDs/names/source q cannot be reconstructed from a daily row. Returning no
  // aggregate rows keeps q semantics truthful; detail rows still answer it.
  if (scope.q || values(scope.traceId).length > 0 || values(scope.executionId).length > 0) return [];
  const detailParams: unknown[] = [projectId, timezone];
  const timezoneParam = 2;
  // A retained day is all-or-nothing: if any call or usage of the project is
  // still stored for the day, detail answers it and the snapshot is not mixed
  // in. Asked per day through the (project, time) index, not by building
  // every charge of the window.
  const dayStart = `(d.day::timestamp AT TIME ZONE $${timezoneParam}::text)`;
  const dayEnd = `((d.day + 1)::timestamp AT TIME ZONE $${timezoneParam}::text)`;
  const aggregateClauses: string[] = [
    `a.project_id = $1`,
    `a.timezone = $${timezoneParam}::text`,
  ];
  const add = (expression: string, item: ScopeValues | null | undefined): void => aggregateValues(detailParams, expression, item, aggregateClauses);
  add(`a.environment`, scope.environment);
  add(`a.feature`, scope.feature);
  add(`a.function_key`, scope.function);
  // A daily row keeps its function as "file:function" (after any service).
  const files = values(scope.file).map(relativeFile).filter(Boolean);
  if (files.length > 0) {
    detailParams.push(files.flatMap((file) => [`${likeLiteral(file)}:%`, `%/${likeLiteral(file)}:%`, `%:${likeLiteral(file)}:%`]));
    aggregateClauses.push(`a.function_key LIKE ANY($${detailParams.length}::text[])`);
  }
  const functionNames = values(scope.functionName).map((name) => name.trim()).filter(Boolean);
  if (functionNames.length > 0) {
    detailParams.push(functionNames.flatMap((name) => [`%:${likeLiteral(name)}`, `%.${likeLiteral(name)}`]));
    aggregateClauses.push(`a.function_key LIKE ANY($${detailParams.length}::text[])`);
  }
  add(`a.customer`, scope.customer);
  add(`a.service`, scope.service);
  add(`a.release`, scope.release);
  add(`a.model`, scope.model);
  add(`a.provider`, scope.provider);
  if (scope.groupBy && scope.groupValue) {
    const expression = aggregateDimensionExpression(scope, "a");
    if (!expression) return [];
    add(expression, scope.groupValue);
  } else if (scope.groupBy === "context" && scope.contextKey && scope.contextValue) {
    const expression = aggregateDimensionExpression({ ...scope, groupValue: undefined }, "a");
    if (!expression) return [];
    add(expression, scope.contextValue);
  }
  if (scope.from) {
    detailParams.push(scope.from);
    const n = detailParams.length;
    aggregateClauses.push(`a.day >= CASE
      WHEN ($${n}::timestamptz AT TIME ZONE $${timezoneParam}::text) = date_trunc('day', $${n}::timestamptz AT TIME ZONE $${timezoneParam}::text)
      THEN ($${n}::timestamptz AT TIME ZONE $${timezoneParam}::text)::date
      ELSE (($${n}::timestamptz AT TIME ZONE $${timezoneParam}::text)::date + 1)
    END`);
  }
  if (scope.to) {
    detailParams.push(scope.to);
    const n = detailParams.length;
    aggregateClauses.push(`a.day < ($${n}::timestamptz AT TIME ZONE $${timezoneParam}::text)::date`);
  }
  detailParams.push(rollupDays);
  const chosenDays = `$${detailParams.length}::date[]`;
  const tracesOutside = (column: string, zero: string): string => `CASE WHEN a.day = ANY(${chosenDays}) THEN ${zero} ELSE a.${column} END`;
  const selectRows = collapseBy.length === 0
    ? `SELECT a.project_id, a.day::text AS day, a.timezone,
              a.environment, a.feature, a.function_key, a.customer, a.provider, a.model,
              a.service, a.release,
              a.known_cost_usd, a.observations, a.call_count, a.priced_observations, a.unpriced_observations,
              ${tracesOutside("trace_count", "0")} AS trace_count,
              ${tracesOutside("fully_priced_trace_count", "0")} AS fully_priced_trace_count,
              ${tracesOutside("fully_priced_trace_cost_usd", "NULL")} AS fully_priced_trace_cost_usd,
              a.reported_observations, a.estimated_observations, a.unknown_observations,
              a.input_tokens, a.output_tokens, a.no_charge_observations,
              a.duration_sum_ms, a.duration_count, a.untraced_usage_count, a.untraced_usage_cost_usd`
    : `SELECT ${collapseBy.map((column) => (column === "day" ? "a.day::text AS day" : `a.${column}`)).join(", ")},
              SUM(a.known_cost_usd) AS known_cost_usd, SUM(a.observations)::bigint AS observations,
              SUM(a.call_count)::bigint AS call_count, SUM(a.priced_observations)::bigint AS priced_observations,
              SUM(a.unpriced_observations)::bigint AS unpriced_observations,
              SUM(${tracesOutside("trace_count", "0")})::bigint AS trace_count,
              SUM(${tracesOutside("fully_priced_trace_count", "0")})::bigint AS fully_priced_trace_count,
              SUM(${tracesOutside("fully_priced_trace_cost_usd", "NULL")}) AS fully_priced_trace_cost_usd,
              SUM(a.reported_observations)::bigint AS reported_observations,
              SUM(a.estimated_observations)::bigint AS estimated_observations,
              SUM(a.unknown_observations)::bigint AS unknown_observations,
              SUM(a.input_tokens)::bigint AS input_tokens, SUM(a.output_tokens)::bigint AS output_tokens,
              SUM(a.no_charge_observations)::bigint AS no_charge_observations,
              SUM(a.duration_sum_ms) AS duration_sum_ms, SUM(a.duration_count)::bigint AS duration_count,
              SUM(a.untraced_usage_count)::bigint AS untraced_usage_count,
              SUM(a.untraced_usage_cost_usd) AS untraced_usage_cost_usd`;
  const groupRows = collapseBy.length === 0
    ? "ORDER BY a.day ASC, a.feature ASC, a.function_key ASC, a.provider ASC, a.model ASC"
    : `GROUP BY ${collapseBy.map((column) => `a.${column}`).join(", ")} ORDER BY ${collapseBy.map((column) => `a.${column}`).join(", ")}`;
  try {
    const result = await pool.query(
      `WITH matched AS (
         SELECT a.* FROM daily_cost_aggregates a
         WHERE ${aggregateClauses.join(" AND ")}
       ), expired_days AS (
         SELECT d.day FROM (SELECT DISTINCT day FROM matched WHERE NOT (day = ANY(${chosenDays}))) d
         WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.project_id = $1 AND e.timestamp >= ${dayStart} AND e.timestamp < ${dayEnd}
                             AND COALESCE(e.event_type, 'call') = 'call')
           AND NOT EXISTS (SELECT 1 FROM usage_components u WHERE u.project_id = $1
                             AND COALESCE(u.accounting_at, u.observed_at) >= ${dayStart} AND COALESCE(u.accounting_at, u.observed_at) < ${dayEnd})
       )
       ${selectRows}
       FROM matched a
       WHERE a.day IN (SELECT day FROM expired_days) OR a.day = ANY(${chosenDays})
       ${groupRows}`,
      detailParams,
    );
    return result.rows as DailyAggregateRow[];
  } catch (error) {
    const code = (error as { code?: string }).code;
    // Old installations may not have run the aggregate migration yet; the
    // detail path remains valid while startup applies the additive schema.
    if (code === "42P01" || code === "42703") return [];
    throw error;
  }
}

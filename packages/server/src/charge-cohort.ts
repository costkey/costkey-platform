import type pg from "pg";

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
}

/**
 * One reconciled relation for automatic calls and explicit usage components.
 * Explicit components linked to an automatic charge are excluded. Delta
 * revisions remain separate records; only the active cumulative snapshot is
 * included. Unknown USD amounts stay NULL.
 */
export function chargesCte(): string {
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
             NULL::double precision AS unit_value, NULL::text AS unit,
             NULL::text AS unit_kind, NULL::integer AS revision,
             -- A failed call without a price cost nothing: it is not unpriced.
             (e.cost_usd IS NULL AND (COALESCE(e.lifecycle_state, '') IN ('failed', 'cancelled')
               OR COALESCE(e.status_code, 200) >= 400)) AS no_charge
      FROM events e
      WHERE COALESCE(e.event_type, 'call') = 'call'
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
      WHERE (u.aggregation = 'delta' OR u.active = TRUE)
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
  if (scope.from) {
    params.push(scope.from);
    clauses.push(`${alias}.timestamp >= $${params.length}`);
  }
  if (scope.to) {
    params.push(scope.to);
    clauses.push(`${alias}.timestamp < $${params.length}`);
  }
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
    `${chargesCte()}
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

/**
 * Read durable daily rows only for workspace-local days that have no matching
 * detailed canonical charge. It is intentionally a separate seam: aggregates
 * cannot fabricate traces/content, but they can preserve financial totals
 * after retention removes detail.
 */
export async function loadDailyAggregates(
  pool: pg.Pool | pg.PoolClient,
  projectId: string,
  scope: ChargeScope = {},
  timezone = scope.timezone ?? "UTC",
): Promise<DailyAggregateRow[]> {
  // IDs/names/source q cannot be reconstructed from a daily row. Returning no
  // aggregate rows keeps q semantics truthful; detail rows still answer it.
  if (scope.q || values(scope.traceId).length > 0 || values(scope.executionId).length > 0) return [];
  const detailParams: unknown[] = [projectId];
  // A retained day is all-or-nothing: if any detailed charge remains for the
  // day, do not mix a full daily snapshot with that day's partial detail.
  const detailDayScope: ChargeScope = { ...scope, groupBy: undefined, groupValue: undefined };
  const detailClauses = scopeClauses(detailDayScope, detailParams, "c");
  detailParams.push(timezone);
  const timezoneParam = detailParams.length;
  const aggregateClauses: string[] = [
    `a.project_id = $1`,
    `a.timezone = $${timezoneParam}::text`,
    `NOT EXISTS (SELECT 1 FROM detail_days d WHERE d.day = a.day)`,
  ];
  const add = (expression: string, item: ScopeValues | null | undefined): void => aggregateValues(detailParams, expression, item, aggregateClauses);
  add(`a.environment`, scope.environment);
  add(`a.feature`, scope.feature);
  add(`a.function_key`, scope.function);
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
  try {
    const result = await pool.query(
      `${chargesCte()},
       detail_days AS (
         SELECT DISTINCT (c.timestamp AT TIME ZONE $${timezoneParam}::text)::date AS day
         FROM charges c WHERE ${detailClauses.join(" AND ")}
       )
       SELECT a.project_id, a.day::text AS day, a.timezone,
              a.environment, a.feature, a.function_key, a.customer, a.provider, a.model,
              a.service, a.release,
              a.known_cost_usd, a.observations, a.call_count, a.priced_observations, a.unpriced_observations,
              a.trace_count, a.fully_priced_trace_count, a.fully_priced_trace_cost_usd,
              a.reported_observations, a.estimated_observations, a.unknown_observations,
              a.input_tokens, a.output_tokens
       FROM daily_cost_aggregates a
       WHERE ${aggregateClauses.join(" AND ")}
       ORDER BY a.day ASC, a.feature ASC, a.function_key ASC, a.provider ASC, a.model ASC`,
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

/**
 * Read-only views behind the console's budget screens: where each budget is
 * heading by the end of its period, the names a budget can cover, and daily
 * spend for the Overview chart. Nothing here reserves, admits or mutates.
 */
import type { Request, Response, Router } from "express";
import type pg from "pg";
import { isIdentityWindow, normalizeSpendingPolicy, policyScopeClauses, policyWindowBounds } from "./admission.js";
import { chargesCte, loadDailyAggregates, scopeClauses, type ChargeScope } from "./charge-cohort.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back the spending pace looks. */
const PACE_LOOKBACK_MS = 7 * DAY_MS;
/** Share of the limit at which a budget counts as at risk even on a good pace. */
const AT_RISK_SHARE = 0.8;
const SCOPE_NAME_DAYS = 90;
const SCOPE_NAME_LIMIT = 200;
const MAX_SERIES_DAYS = 400;

export type BudgetHealth = "on_track" | "at_risk" | "over" | "paused" | "no_data";

export interface BudgetForecast {
  /** Start and end of the current period; null for per-run, per-batch and per-call budgets. */
  periodStart: string | null;
  periodEnd: string | null;
  /** Usage expected by the period end at the last seven days' pace. */
  projected: number | null;
  health: BudgetHealth;
}

/**
 * On track, at risk or over. Over means the limit is already reached; at risk
 * means the pace reaches it before the period ends, or 80% is already used.
 */
export function budgetHealth(input: { status: string; allowance: number; used: number | null; projected: number | null; overLimit?: number | null }): BudgetHealth {
  if (input.status === "paused" || input.status === "archived") return "paused";
  if (input.used == null || !Number.isFinite(input.used)) return "no_data";
  const allowance = Number.isFinite(input.allowance) ? Math.max(0, input.allowance) : 0;
  if ((input.overLimit ?? 0) > 0) return "over";
  if (allowance === 0) return input.used > 0 ? "over" : "on_track";
  if (input.used >= allowance) return "over";
  if (input.projected != null && input.projected >= allowance) return "at_risk";
  if (input.used >= allowance * AT_RISK_SHARE) return "at_risk";
  return "on_track";
}

/** Used so far plus the remaining time at a steady rate. */
export function projectToPeriodEnd(input: { used: number; ratePerMs: number; now: number; periodEnd: number }): number {
  const remaining = Math.max(0, input.periodEnd - input.now);
  return input.used + Math.max(0, input.ratePerMs) * remaining;
}

/** The spending rate per millisecond over the last seven days in a policy's scope. */
async function scopedPace(pool: pg.Pool, row: Record<string, unknown>, now: Date): Promise<number | null> {
  const policy = normalizeSpendingPolicy(row);
  const params: unknown[] = [policy.projectId];
  const clauses = ["e.project_id = $1", "COALESCE(e.event_type, 'call') = 'call'", ...policyScopeClauses(policy.scope, params, "e")];
  params.push(new Date(now.getTime() - PACE_LOOKBACK_MS).toISOString());
  clauses.push(`e.timestamp >= $${params.length}`);
  params.push(now.toISOString());
  clauses.push(`e.timestamp < $${params.length}`);
  const quantity = policy.unit === "calls"
    ? "COUNT(*)::double precision"
    : policy.unit === "tokens"
      ? "COALESCE(SUM(COALESCE(e.total_tokens, e.input_tokens + e.output_tokens)), 0)::double precision"
      : "COALESCE(SUM(e.cost_usd), 0)::double precision";
  const result = await pool.query(
    `SELECT ${quantity} AS quantity, MIN(e.timestamp) AS first_seen
     FROM events e WHERE ${clauses.join(" AND ")}`,
    params,
  );
  const first = result.rows[0]?.first_seen ? new Date(result.rows[0].first_seen).getTime() : null;
  if (first == null) return 0;
  let quantityValue = Number(result.rows[0]?.quantity) || 0;
  if (policy.unit === "money" && policy.currency === "INR") {
    const rate = policy.usdToPolicyCurrency ?? null;
    if (rate == null || !(rate > 0)) return null;
    quantityValue *= rate;
  }
  // A scope seen only for an hour is not spending a week's worth in an hour.
  const span = Math.max(DAY_MS, now.getTime() - first);
  return quantityValue / span;
}

/** Where a budget is heading by the end of its current period, and its health. */
export async function policyForecast(pool: pg.Pool, row: Record<string, unknown>, serialized: Record<string, unknown>, now = new Date()): Promise<BudgetForecast> {
  const policy = normalizeSpendingPolicy(row);
  const usage = (serialized["usage"] ?? {}) as Record<string, unknown>;
  const used = usage["observed"] == null ? null : Number(usage["observed"]);
  const overLimit = usage["overLimit"] == null ? null : Number(usage["overLimit"]);
  const status = String(serialized["status"] ?? policy.status ?? "active");
  const base = { periodStart: null, periodEnd: null, projected: null } as const;
  if (isIdentityWindow(policy.window) || policy.window === "calendar_minute") {
    return { ...base, health: budgetHealth({ status, allowance: policy.allowance, used, projected: null, overLimit }) };
  }
  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  try {
    const bounds = policyWindowBounds(policy, now);
    periodStart = bounds.from;
    periodEnd = bounds.to;
  } catch {
    return { ...base, health: budgetHealth({ status, allowance: policy.allowance, used, projected: null }) };
  }
  let projected: number | null = null;
  if (used != null && periodEnd && status === "active") {
    try {
      const pace = await scopedPace(pool, row, now);
      if (pace != null) projected = projectToPeriodEnd({ used, ratePerMs: pace, now: now.getTime(), periodEnd: periodEnd.getTime() });
    } catch (error) {
      if ((error as { code?: string })?.code !== "42P01") throw error;
    }
  }
  return {
    periodStart: periodStart?.toISOString() ?? null,
    periodEnd: periodEnd?.toISOString() ?? null,
    projected,
    health: budgetHealth({ status, allowance: policy.allowance, used, projected }),
  };
}

export type ScopeNameKind = "agent" | "workflow" | "feature" | "model" | "customer";
export const SCOPE_NAME_KINDS: ScopeNameKind[] = ["agent", "workflow", "feature", "model", "customer"];

/**
 * Distinct names a budget can cover, most expensive first, read with the same
 * expressions admission matches on: an agent is context.agent, a workflow is
 * the run's trace name (agent runs excluded), a customer is context.customer.
 */
export async function loadScopeNames(pool: pg.Pool, projectId: string, now = new Date()): Promise<Record<ScopeNameKind, string[]>> {
  const since = new Date(now.getTime() - SCOPE_NAME_DAYS * DAY_MS).toISOString();
  const result = await pool.query(
    `SELECT d.kind, d.name
     FROM events e
     CROSS JOIN LATERAL (VALUES
       ('agent', NULLIF(BTRIM(e.context->>'agent'), '')),
       ('workflow', CASE WHEN NULLIF(BTRIM(e.context->>'agent'), '') IS NULL
         THEN NULLIF(BTRIM(COALESCE(e.trace_name, e.context->>'traceName', e.context->>'trace_name')), '') END),
       ('feature', NULLIF(BTRIM(e.context->>'feature'), '')),
       ('model', NULLIF(BTRIM(e.model), '')),
       ('customer', NULLIF(BTRIM(COALESCE(e.context->>'customer', e.context->>'customerId')), ''))
     ) AS d(kind, name)
     WHERE e.project_id = $1 AND e.timestamp >= $2 AND e.timestamp <= $3
       AND COALESCE(e.event_type, 'call') = 'call' AND d.name IS NOT NULL
     GROUP BY d.kind, d.name
     ORDER BY d.kind, SUM(e.cost_usd) DESC NULLS LAST, COUNT(*) DESC, d.name ASC`,
    [projectId, since, now.toISOString()],
  );
  const names: Record<ScopeNameKind, string[]> = { agent: [], workflow: [], feature: [], model: [], customer: [] };
  for (const row of result.rows as Array<{ kind: ScopeNameKind; name: string }>) {
    const list = names[row.kind];
    if (list && list.length < SCOPE_NAME_LIMIT) list.push(row.name);
  }
  return names;
}

function localDay(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Every local calendar day from `from` up to (not including) `to`. */
export function seriesDays(from: Date, to: Date, timezone: string): string[] {
  const first = localDay(from, timezone);
  const last = localDay(new Date(to.getTime() - 1), timezone);
  const days: string[] = [];
  const cursor = new Date(`${first}T00:00:00Z`);
  const end = new Date(`${last}T00:00:00Z`).getTime();
  while (cursor.getTime() <= end && days.length <= MAX_SERIES_DAYS) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export interface SpendPoint {
  /** "2026-10-04" for a day, "2026-10" for a month, in the workspace time zone. */
  key: string;
  cost: number;
  calls: number;
  unpriced: number;
}

/** Known spend per local day (or month), zero-filled, from the same records as every total. */
export async function loadSpendSeries(pool: pg.Pool, projectId: string, input: { from: Date; to: Date; timezone: string; bucket: "day" | "month"; environment?: string | null }): Promise<SpendPoint[]> {
  const scope: ChargeScope = { from: input.from.toISOString(), to: input.to.toISOString(), timezone: input.timezone, environment: input.environment || undefined };
  const params: unknown[] = [projectId];
  const clauses = scopeClauses(scope, params, "c");
  params.push(input.timezone);
  const timezoneParam = params.length;
  const detail = await pool.query(
    `${chargesCte()}
     SELECT to_char(c.timestamp AT TIME ZONE $${timezoneParam}::text, 'YYYY-MM-DD') AS day,
            COALESCE(SUM(c.cost_usd), 0)::double precision AS cost,
            COUNT(*) FILTER (WHERE c.record_type = 'call')::int AS calls,
            COUNT(*) FILTER (WHERE c.cost_usd IS NULL AND NOT c.no_charge)::int AS unpriced
     FROM charges c WHERE ${clauses.join(" AND ")}
     GROUP BY 1`,
    params,
  );
  const byDay = new Map<string, { cost: number; calls: number; unpriced: number }>();
  const add = (day: string, cost: number, calls: number, unpriced: number) => {
    const item = byDay.get(day) ?? { cost: 0, calls: 0, unpriced: 0 };
    item.cost += cost; item.calls += calls; item.unpriced += unpriced;
    byDay.set(day, item);
  };
  for (const row of detail.rows as Array<Record<string, unknown>>) add(String(row.day), Number(row.cost) || 0, Number(row.calls) || 0, Number(row.unpriced) || 0);
  // Days whose detail retention removed still count from their daily rollup.
  for (const row of await loadDailyAggregates(pool, projectId, scope, input.timezone)) {
    add(String(row.day).slice(0, 10), Number(row.known_cost_usd) || 0, Number(row.call_count) || 0, Number(row.unpriced_observations) || 0);
  }
  const days = seriesDays(input.from, input.to, input.timezone);
  if (input.bucket === "day") return days.map((day) => ({ key: day, ...(byDay.get(day) ?? { cost: 0, calls: 0, unpriced: 0 }) }));
  const months = new Map<string, SpendPoint>();
  for (const day of days) {
    const key = day.slice(0, 7);
    const item = months.get(key) ?? { key, cost: 0, calls: 0, unpriced: 0 };
    const value = byDay.get(day);
    if (value) { item.cost += value.cost; item.calls += value.calls; item.unpriced += value.unpriced; }
    months.set(key, item);
  }
  return [...months.values()];
}

function queryText(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** Mounted inside the budgets router, which already requires a session for /budget paths. */
export function registerBudgetViewRoutes(router: Router, pool: pg.Pool, deps: {
  ensureProjectInOrg: (projectId: string, orgId: string) => Promise<boolean>;
  timezoneFor: (projectId: string) => Promise<string>;
}): void {
  router.get("/api/v1/projects/:id/budget/scope-names", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const id = req.params["id"] as string;
      if (!(await deps.ensureProjectInOrg(id, user.orgId))) { res.status(404).json({ error: "Project not found" }); return; }
      res.json({ days: SCOPE_NAME_DAYS, names: await loadScopeNames(pool, id) });
    } catch (err) {
      console.error("[costkey] GET budget scope names error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/v1/projects/:id/budget/spend-series", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const id = req.params["id"] as string;
      if (!(await deps.ensureProjectInOrg(id, user.orgId))) { res.status(404).json({ error: "Project not found" }); return; }
      const now = new Date();
      const from = new Date(queryText(req.query["from"]) ?? new Date(now.getTime() - 30 * DAY_MS).toISOString());
      const to = new Date(queryText(req.query["to"]) ?? now.toISOString());
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
        res.status(400).json({ error: "from and to must be valid dates with from before to" });
        return;
      }
      if (to.getTime() - from.getTime() > MAX_SERIES_DAYS * DAY_MS) {
        res.status(400).json({ error: `The range can be at most ${MAX_SERIES_DAYS} days` });
        return;
      }
      const bucket = queryText(req.query["bucket"]) === "month" ? "month" : "day";
      const timezone = await deps.timezoneFor(id);
      const environment = queryText(req.query["environment"]);
      const points = await loadSpendSeries(pool, id, { from, to, timezone, bucket, environment: environment === "all" ? null : environment });
      res.json({ timezone, bucket, from: from.toISOString(), to: to.toISOString(), currency: "USD", points });
    } catch (err) {
      console.error("[costkey] GET spend series error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });
}

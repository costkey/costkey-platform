import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { ensureAccountingChangeSchema, initDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { ensurePolicySchema } from "../policy-storage.js";
import { reconcileDailyAccounting, reconcileDailyCostAggregates } from "../accounting.js";
import { createAccountingRouter } from "../accounting-api.js";
import { createBudgetsRouter } from "../budgets.js";
import { rollupPlan } from "../charge-cohort.js";
import { invalidateSummaries } from "../response-cache.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];
const IST_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;

/** A time in India, `daysAgo` local days before today. */
function ist(daysAgo: number, hours = 0, minutes = 0): Date {
  const local = new Date(Date.now() + IST_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysAgo, hours, minutes) - IST_MS);
}

function localDay(daysAgo: number): string {
  return new Date(ist(daysAgo).getTime() + IST_MS).toISOString().slice(0, 10);
}

/** Rounded numbers and sorted lists, so only a real difference fails a comparison. */
function normal(value: unknown): unknown {
  if (typeof value === "number") return Math.round(value * 1e6) / 1e6;
  if (Array.isArray(value)) {
    const items = value.map(normal);
    return items.every((item) => typeof item === "string")
      ? [...items].sort()
      : [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "scope")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normal(item)]));
  }
  return value;
}

/** The parts of a /costs response the rollup answers. */
function costsView(body: Record<string, any>): unknown {
  const filters = body.availableFilters ?? {};
  const counts = filters.counts ?? {};
  return {
    totals: body.totals,
    contributors: body.contributors,
    total: body.total,
    availableDimensions: body.availableDimensions,
    providers: filters.providers, models: filters.models, environments: filters.environments,
    features: filters.features, customers: filters.customers, functions: filters.functions,
    contextKeys: filters.contextKeys,
    counts: { provider: counts.provider, model: counts.model, environment: counts.environment, feature: counts.feature, customer: counts.customer, function: counts.function },
  };
}

interface Fixture {
  pool: pg.Pool;
  projectId: string;
  orgId: string;
  suffix: string;
  builds: () => number;
  resetBuilds: () => void;
  get: (path: string) => Promise<Record<string, any>>;
  call: (input: Record<string, unknown>) => Promise<unknown>;
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_rollup_read_${suffix}`;
  const projectId = `project_rollup_read_${suffix}`;
  let builds = 0;
  const counted = new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop !== "query") return Reflect.get(target, prop, receiver);
      return (...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0].includes("auto_raw")) builds += 1;
        return (target.query as (...a: unknown[]) => unknown)(...args);
      };
    },
  });
  const app = express();
  app.use((req, _res, next) => { (req as any).user = { id: `owner-${suffix}`, orgId, role: "owner" }; next(); });
  app.use(createAccountingRouter(counted));
  app.use(createBudgetsRouter(counted));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/projects/${projectId}`;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await ensurePolicySchema(pool);
    await ensureAccountingChangeSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Rollup read',$2)", [orgId, `rollup-read-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Rollup read',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    await pool.query("INSERT INTO workspace_settings(org_id,timezone,reporting_currency) VALUES ($1,'Asia/Kolkata','USD')", [orgId]);
    await pool.query("INSERT INTO project_settings(project_id,aggregate_retention_days) VALUES ($1,30) ON CONFLICT (project_id) DO UPDATE SET aggregate_retention_days = 30", [projectId]);
    const call = (input: Record<string, unknown>) => pool.query(
      `INSERT INTO events(id, project_id, timestamp, provider, model, cost_usd, cost_basis, cost_source, trace_id, context,
                          status_code, duration_ms, charge_id, bl_file, bl_function, input_tokens, output_tokens, event_type)
       VALUES ($1,$2,$3,$4,$5,$6,'reported','provider',$7,$8,$9,$10,$11,$12,$13,$14,$15,'call')`,
      [
        `${input.id}-${suffix}`, projectId, input.at, input.provider ?? "openai", "model" in input ? input.model : "gpt-4o", input.cost ?? null,
        input.trace ? `${input.trace}-${suffix}` : null, JSON.stringify(input.context ?? {}), input.status ?? 200, input.duration ?? null,
        input.charge ? `${input.charge}-${suffix}` : null, input.file ?? null, input.fn ?? null, input.input ?? 10, input.output ?? 5,
      ],
    );
    await fn({
      pool, projectId, orgId, suffix, call,
      builds: () => builds,
      resetBuilds: () => { builds = 0; },
      get: async (path) => {
        invalidateSummaries(projectId);
        const response = await fetch(`${baseUrl}${path}`);
        assert.equal(response.status, 200, `${path}: ${response.status}`);
        return await response.json() as Record<string, any>;
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.query("DELETE FROM usage_components WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM events WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM accounting_changed_periods WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
}

/** A month's worth of awkward records, compressed into four local days. */
async function seed({ call, pool, projectId, suffix }: Fixture): Promise<void> {
  for (const daysAgo of [3, 2, 1]) {
    const name = `d${daysAgo}`;
    const trace = `multi-${name}`;
    // One trace across two models, providers and features of a kind.
    await call({ id: `${name}-a`, at: ist(daysAgo, 9), cost: 1 + daysAgo, trace, duration: 100, file: "src/search.ts", fn: "search", context: { feature: "search", customer: "acme", environment: "prod", service: "web" } });
    await call({ id: `${name}-b`, at: ist(daysAgo, 13), provider: "anthropic", model: "claude-sonnet", cost: 2, trace, duration: 300, file: "src/search.ts", fn: "rerank", context: { feature: "search", customer: "acme", environment: "prod" } });
    // A trace with one call that has no price: not fully priced for its feature.
    await call({ id: `${name}-c`, at: ist(daysAgo, 14), cost: 0.25, trace: `part-${name}`, context: { feature: "answer", environment: "staging" } });
    await call({ id: `${name}-d`, at: ist(daysAgo, 15), model: "unlisted", cost: null, trace: `part-${name}`, context: { feature: "answer", environment: "staging" } });
    // A failed call costs nothing: settled, never unpriced.
    await call({ id: `${name}-e`, at: ist(daysAgo, 16), cost: null, status: 500, trace: `failed-${name}`, duration: 50, context: { feature: "answer", environment: "prod" } });
    // Blank context values, no trace, no model.
    await call({ id: `${name}-f`, at: ist(daysAgo, 17), model: null, cost: 0.5, context: { feature: "", customer: "", environment: "" } });
    // A retry: one charge, the priced record wins.
    await call({ id: `${name}-g1`, at: ist(daysAgo, 18), cost: null, charge: `retry-${name}`, context: { feature: "search" } });
    await call({ id: `${name}-g2`, at: ist(daysAgo, 18, 1), cost: 3, charge: `retry-${name}`, context: { feature: "search" } });
  }
  // Only ever on the oldest day, so the rollup must remember the key.
  await call({ id: "agent-only", at: ist(3, 20), cost: 0.1, context: { feature: "search", agent: "planner" } });
  // A charge with records either side of a midnight: it belongs to the winner's day.
  await call({ id: "cross-1", at: ist(2, 23, 59), cost: null, charge: "cross", context: { feature: "search" } });
  await call({ id: "cross-2", at: ist(1, 0, 1), cost: 4, charge: "cross", context: { feature: "search" } });
  // Priced before midnight and repeated after it: counted once, on the earlier day.
  await call({ id: "edge-1", at: ist(1, 23, 59), cost: 6, charge: "edge", context: { feature: "search" } });
  await call({ id: "edge-2", at: ist(0, 0, 0), cost: null, charge: "edge", context: { feature: "search" } });
  // Explicit usage: traced, untraced, and a superseded cumulative snapshot.
  const usage = (id: string, at: Date, values: { amount: number; trace?: string; aggregation?: string; active?: boolean; charge?: string }) => pool.query(
    `INSERT INTO usage_components(id, project_id, charge_id, trace_id, provider, model, amount, currency, amount_kind, aggregation, active, observed_at, context)
     VALUES ($1,$2,$3,$4,'browserbase','session',$5,'USD','reported',$6,$7,$8,$9)`,
    [`${id}-${suffix}`, projectId, values.charge ? `${values.charge}-${suffix}` : null, values.trace ? `${values.trace}-${suffix}` : null, values.amount,
      values.aggregation ?? "delta", values.active ?? true, at, JSON.stringify({ feature: "browse", environment: "prod" })],
  );
  await usage("usage-traced", ist(2, 11), { amount: 1.5, trace: "multi-d2" });
  await usage("usage-untraced", ist(2, 12), { amount: 2.5 });
  await usage("usage-old-snapshot", ist(1, 10), { amount: 9, aggregation: "cumulative", active: false, charge: "snap" });
  await usage("usage-snapshot", ist(1, 11), { amount: 3, aggregation: "cumulative", active: true, charge: "snap" });
  // Today, read from calls whatever the rollup holds.
  const justNow = new Date(Date.now() - 1000);
  await call({ id: "today-a", at: justNow, cost: 8, trace: "today", duration: 200, context: { feature: "search", environment: "prod" } });
  await call({ id: "today-b", at: justNow, model: "claude-sonnet", provider: "anthropic", cost: null, trace: "today", context: { feature: "fresh-feature", environment: "canary" } });
}

function windows(): Record<string, string> {
  const q = (from: Date, to: Date) => `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
  const later = new Date(Date.now() + 60_000);
  return {
    "whole days and today": q(ist(3), later),
    "whole days only": q(ist(3), ist(0)),
    "partial days at both ends": q(ist(3, 12), ist(1, 12)),
    "a single day": q(ist(3), ist(2)),
  };
}

async function snapshot(get: Fixture["get"], ranges: Record<string, string>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [name, range] of Object.entries(ranges)) {
    out[`${name}: overview`] = normal(await get(`/overview?${range}`));
    out[`${name}: spend`] = normal((await get(`/budget/spend-series?${range}&bucket=day`)).points);
    out[`${name}: spend in prod`] = normal((await get(`/budget/spend-series?${range}&bucket=day&environment=prod`)).points);
    out[`${name}: overview in prod`] = normal(await get(`/overview?${range}&environment=prod`));
    for (const groupBy of ["feature", "function", "customer", "model", "provider"]) {
      out[`${name}: costs by ${groupBy}`] = normal(costsView(await get(`/costs?groupBy=${groupBy}&${range}`)));
    }
  }
  return out;
}

test("every summary answers the same from the rollup as from its calls", { skip: !connectionString }, async () => {
  await withFixture(async (fixture) => {
    const { pool, projectId, get } = fixture;
    await seed(fixture);
    const ranges = windows();
    const fromCalls = await snapshot(get, ranges);
    await reconcileDailyAccounting(pool);

    const covered = await pool.query("SELECT day::text AS day, timezone, version FROM daily_rollup_days WHERE project_id = $1 ORDER BY day", [projectId]);
    const coveredDays = covered.rows.map((row) => String(row.day));
    for (const daysAgo of [3, 2, 1]) assert.ok(coveredDays.includes(localDay(daysAgo)), `${localDay(daysAgo)} is covered`);
    assert.ok(!coveredDays.includes(localDay(0)), "today is not");
    assert.ok(covered.rows.every((row) => row.timezone === "Asia/Kolkata"));

    const fromRollup = await snapshot(get, ranges);
    for (const key of Object.keys(fromCalls)) assert.deepEqual(fromRollup[key], fromCalls[key], key);

    const totals = (fromRollup["whole days only: overview"] as { overview: Record<string, number> }).overview;
    assert.equal(totals.unpriced_count, 3, "the unlisted model is unpriced on each day");
    assert.ok(totals.total_calls > totals.unpriced_count, "failed calls are not among the unpriced");
    const rows = await pool.query("SELECT SUM(no_charge_observations)::int AS failed, SUM(unpriced_observations)::int AS unpriced FROM daily_cost_aggregates WHERE project_id = $1", [projectId]);
    assert.equal(rows.rows[0].failed, 3);
    assert.equal(rows.rows[0].unpriced, 3);
  });
});

test("a window of completed days builds no charges, and today reads only itself", { skip: !connectionString }, async () => {
  await withFixture(async (fixture) => {
    const { pool, get, builds, resetBuilds } = fixture;
    await seed(fixture);
    await reconcileDailyAccounting(pool);
    const { "whole days only": closed, "whole days and today": open } = windows();

    resetBuilds();
    await get(`/overview?${closed}`);
    await get(`/budget/spend-series?${closed}&bucket=day`);
    assert.equal(builds(), 0, "no call is read for days the rollup answers");
    await get(`/costs?groupBy=feature&${closed}`);
    assert.equal(builds(), 0, "nor for its comparison window, or the filters beside it");

    resetBuilds();
    const today = await get(`/overview?${open}`);
    assert.equal(builds(), 1);
    assert.equal(today.byModel.some((row: { model: string }) => row.model === "claude-sonnet"), true);

    const costs = await get(`/costs?groupBy=feature&${closed}`);
    const known = costs.contributors.map((row: { known_cost: number | null }) => row.known_cost ?? -1);
    assert.deepEqual(known, [...known].sort((a: number, b: number) => b - a), "contributors stay in cost order for paging");
    assert.ok(costs.availableFilters.contextKeys.includes("agent"), "context keys of rollup days stay available");
  });
});

test("a late call shows at once, then the day returns to the rollup", { skip: !connectionString }, async () => {
  await withFixture(async (fixture) => {
    const { pool, projectId, get, call, builds, resetBuilds } = fixture;
    await seed(fixture);
    await reconcileDailyAccounting(pool);
    const { "whole days only": closed } = windows();
    const cost = async () => Number((await get(`/overview?${closed}`)).overview.known_cost);
    const before = await cost();

    await call({ id: "late", at: ist(2, 14), cost: 7, context: { feature: "search" } });
    resetBuilds();
    assert.equal(await cost(), before + 7, "a changed day is read from its calls");
    assert.equal(builds(), 1);

    await reconcileDailyAccounting(pool);
    resetBuilds();
    assert.equal(await cost(), before + 7, "the rebuilt rollup holds it");
    assert.equal(builds(), 0);
    const pending = await pool.query("SELECT 1 FROM accounting_changed_periods WHERE project_id = $1 AND period_start < $2", [projectId, ist(0)]);
    assert.equal(pending.rows.length, 0);
  });
});

test("a repriced call changes the number straight away", { skip: !connectionString }, async () => {
  await withFixture(async (fixture) => {
    const { pool, projectId, get, suffix } = fixture;
    await seed(fixture);
    await reconcileDailyAccounting(pool);
    const { "a single day": day } = windows();
    const before = Number((await get(`/overview?${day}`)).overview.known_cost);
    await pool.query("UPDATE events SET cost_usd = cost_usd + 10 WHERE project_id = $1 AND id = $2", [projectId, `d3-a-${suffix}`]);
    assert.equal(Number((await get(`/overview?${day}`)).overview.known_cost), before + 10);
    await reconcileDailyAccounting(pool);
    assert.equal(Number((await get(`/overview?${day}`)).overview.known_cost), before + 10);
  });
});

test("changing the workspace time zone never mixes days of two zones", { skip: !connectionString }, async () => {
  await withFixture(async (fixture) => {
    const { pool, projectId, orgId, get, builds, resetBuilds } = fixture;
    await seed(fixture);
    await reconcileDailyAccounting(pool);
    await pool.query("UPDATE workspace_settings SET timezone = 'UTC' WHERE org_id = $1", [orgId]);
    const start = new Date(Date.now() - 2 * DAY_MS);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + DAY_MS);
    const range = `from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;

    resetBuilds();
    const fromCalls = normal(await get(`/overview?${range}`));
    assert.equal(builds(), 1, "days rolled up for another zone are not used");

    await reconcileDailyAccounting(pool);
    const zones = await pool.query(
      "SELECT DISTINCT timezone FROM daily_rollup_days WHERE project_id = $1 AND day >= $2::date",
      [projectId, start.toISOString().slice(0, 10)],
    );
    assert.deepEqual(zones.rows.map((row) => row.timezone), ["UTC"], "days with data are rebuilt in the new zone");
    resetBuilds();
    assert.deepEqual(normal(await get(`/overview?${range}`)), fromCalls);
    assert.equal(builds(), 0);
  });
});

test("a purged day keeps its numbers, and refreshing today does not cover it", { skip: !connectionString }, async () => {
  await withFixture(async (fixture) => {
    const { pool, projectId, get } = fixture;
    await seed(fixture);
    await reconcileDailyAccounting(pool);
    const { "whole days only": closed } = windows();
    const before = normal(await get(`/overview?${closed}`));

    // Retention's purge: the oldest day's detail goes, and it is never rebuilt.
    await pool.query("UPDATE daily_cost_aggregate_checkpoints SET purged_before = $2 WHERE project_id = $1", [projectId, ist(3, 23, 59)]);
    await pool.query("DELETE FROM events WHERE project_id = $1 AND timestamp < $2", [projectId, ist(2)]);
    await reconcileDailyAccounting(pool);
    assert.deepEqual(normal(await get(`/overview?${closed}`)), before);

    await reconcileDailyCostAggregates(pool, projectId, localDay(0), { advanceCheckpoint: false });
    const today = await pool.query("SELECT 1 FROM daily_rollup_days WHERE project_id = $1 AND day = $2", [projectId, localDay(0)]);
    assert.equal(today.rows.length, 0, "a day that has not ended is never answered by the rollup");
  });
});

test("a charge recorded either side of a midnight stays on its winning record's day", { skip: !connectionString }, async () => {
  await withFixture(async ({ pool, get, call }) => {
    await call({ id: "attempt", at: ist(2, 23, 59), cost: null, charge: "retried", context: { feature: "search" } });
    await call({ id: "success", at: ist(1, 0, 1), cost: 4, charge: "retried", context: { feature: "search" } });
    const range = (from: number, to: number) => `from=${encodeURIComponent(ist(from).toISOString())}&to=${encodeURIComponent(ist(to).toISOString())}`;
    await reconcileDailyAccounting(pool);
    const before = (await get(`/overview?${range(2, 1)}`)).overview;
    const after = (await get(`/overview?${range(1, 0)}`)).overview;
    assert.equal(before.observations, 0, "not on the day of the record that lost");
    assert.equal(after.observations, 1);
    assert.equal(after.known_cost, 4);
    assert.equal(after.unpriced_count, 0);
  });
});

test("a trace crossing a midnight counts once on each of its days", { skip: !connectionString }, async () => {
  await withFixture(async ({ pool, get, call }) => {
    await call({ id: "before", at: ist(2, 23, 50), cost: 1, trace: "overnight", context: { feature: "search" } });
    await call({ id: "after", at: ist(1, 0, 10), cost: 1, trace: "overnight", context: { feature: "search" } });
    const range = `from=${encodeURIComponent(ist(2).toISOString())}&to=${encodeURIComponent(ist(0).toISOString())}`;
    assert.equal((await get(`/overview?${range}`)).overview.trace_count, 1);
    await reconcileDailyAccounting(pool);
    const rolled = await get(`/overview?${range}`);
    assert.equal(rolled.overview.trace_count, 2);
    assert.equal(rolled.overview.known_cost, 2, "its cost still counts once");
  });
});

test("scopes a daily row cannot answer exactly stay on calls", async () => {
  const pool = { query: async () => { throw new Error("the plan should not ask the database"); } } as unknown as pg.Pool;
  const window = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z" };
  const onCalls = { rollupDays: [], ranges: null, readsDetail: true };
  for (const scope of [
    { q: "search" },
    { traceId: "trace" },
    { executionId: "execution" },
    { function: "src/a.ts:run" },
    { file: "src/a.ts" },
    { functionName: "run" },
    { release: "v1" },
    { groupBy: "context" as const, contextKey: "agent" },
    { groupBy: "feature" as const, groupValue: "search" },
    { feature: "(unassigned)" },
    { model: "(unknown)" },
  ]) {
    assert.deepEqual(await rollupPlan(pool, "project", { ...window, ...scope }, "UTC"), onCalls, JSON.stringify(scope));
  }
  assert.deepEqual(await rollupPlan(pool, "project", { ...window, environment: "prod" }, "UTC", { traces: true }), onCalls, "traces are not kept per filter");
  assert.deepEqual(await rollupPlan(pool, "project", { from: window.from }, "UTC"), onCalls, "an open window has no whole days to find");
});

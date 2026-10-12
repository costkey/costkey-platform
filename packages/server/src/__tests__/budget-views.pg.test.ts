import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { initDatabase, shutdownDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { ensurePolicySchema } from "../policy-storage.js";
import { createBudgetsRouter } from "../budgets.js";
import { budgetHealth, projectToPeriodEnd, seriesDays } from "../budget-views.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("budget health: over at the limit, at risk on pace or past 80%, otherwise on track", () => {
  const base = { status: "active", allowance: 100 };
  assert.equal(budgetHealth({ ...base, used: 100, projected: 100 }), "over");
  assert.equal(budgetHealth({ ...base, used: 40, projected: 120 }), "at_risk");
  assert.equal(budgetHealth({ ...base, used: 85, projected: 90 }), "at_risk");
  assert.equal(budgetHealth({ ...base, used: 40, projected: 70 }), "on_track");
  assert.equal(budgetHealth({ ...base, used: 40, projected: null }), "on_track");
  assert.equal(budgetHealth({ ...base, used: null, projected: null }), "no_data");
  assert.equal(budgetHealth({ ...base, status: "paused", used: 500, projected: 900 }), "paused");
  assert.equal(budgetHealth({ ...base, used: 2, projected: null, overLimit: 1 }), "over");
  assert.equal(projectToPeriodEnd({ used: 10, ratePerMs: 1, now: 0, periodEnd: 5 }), 15);
  assert.equal(projectToPeriodEnd({ used: 10, ratePerMs: 1, now: 9, periodEnd: 5 }), 10);
});

test("series days follow the workspace calendar, not UTC", () => {
  // 1 Mar 00:00 IST to 4 Mar 00:00 IST.
  assert.deepEqual(seriesDays(new Date("2026-02-28T18:30:00Z"), new Date("2026-03-03T18:30:00Z"), "Asia/Kolkata"), ["2026-03-01", "2026-03-02", "2026-03-03"]);
  assert.deepEqual(seriesDays(new Date("2026-02-28T18:30:00Z"), new Date("2026-03-03T18:30:00Z"), "UTC"), ["2026-02-28", "2026-03-01", "2026-03-02", "2026-03-03"]);
});

test("budget list statuses, scope names and the daily spend series", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_budget_views_${suffix}`;
  const otherOrgId = `org_budget_views_other_${suffix}`;
  const projectId = `project_budget_views_${suffix}`;
  let server: ReturnType<typeof createServer> | null = null;
  const recent = new Date(Date.now() - 60_000);
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await ensurePolicySchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,$2,$3), ($4,$5,$6)", [orgId, "Budget views", `budget-views-${suffix}`, otherOrgId, "Other", `budget-views-other-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,$2,$3,$4)", [projectId, "Budget views", orgId, `key-${suffix}`]);
    await pool.query("INSERT INTO workspace_settings(org_id, timezone) VALUES ($1, 'Asia/Kolkata')", [orgId]);
    const insert = (id: string, at: Date, model: string, cost: number | null, traceName: string | null, context: Record<string, unknown>) => pool.query(
      `INSERT INTO events(id, project_id, timestamp, provider, model, cost_usd, cost_basis, cost_source, trace_id, trace_name, context, event_type)
       VALUES ($1,$2,$3,'openai',$4,$5,'reported','provider',$6,$7,$8,'call')`,
      [`${id}-${suffix}`, projectId, at, model, cost, `trace-${id}`, traceName, JSON.stringify(context)],
    );
    await insert("search-1", recent, "gpt-4o", 2, "nightly-import", { feature: "search", customer: "acme" });
    await insert("search-2", recent, "gpt-4o", 0.5, "nightly-import", { feature: "search", customer: "acme" });
    await insert("answer-1", recent, "gpt-4o-mini", 5, "chat", { feature: "answer", customerId: "globex" });
    await insert("agent-1", recent, "claude-sonnet", 1, "support-agent", { agent: "support-agent" });
    // Old enough to leave the scope names, and placed for the time zone series.
    await insert("old-1", new Date("2026-03-01T10:00:00Z"), "old-model", 1, "old-flow", { feature: "old-feature" });
    await insert("old-2", new Date("2026-03-01T20:00:00Z"), "old-model", 2, "old-flow", { feature: "old-feature" });
    await insert("old-3", new Date("2026-03-01T21:00:00Z"), "old-model", null, "old-flow", { feature: "old-feature" });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: `owner-${suffix}`, orgId: req.headers["x-org"] ?? orgId, role: "owner" };
      next();
    });
    app.use(createBudgetsRouter(pool));
    server = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/projects/${projectId}/budget`;
    const getJson = async (path: string, headers: Record<string, string> = {}) => {
      const response = await fetch(`${base}${path}`, { headers });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const create = async (body: Record<string, unknown>) => {
      const response = await fetch(`${base}/policies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unit: "money", currency: "USD", window: "calendar_month", timezone: "UTC", mode: "monitor", ...body }) });
      assert.equal(response.status, 201);
      return (await response.json() as Record<string, any>).id as string;
    };

    // Statuses on the list.
    const onTrack = await create({ name: "on track", allowance: 1000, scope: { feature: "search" } });
    const atRisk = await create({ name: "at risk", allowance: 3, scope: { feature: "search" } });
    const over = await create({ name: "over", allowance: 4, scope: { feature: "answer" }, mode: "enforce" });
    const paused = await create({ name: "paused", allowance: 1, scope: { agent: "support-agent" }, status: "paused" });
    const perRun = await create({ name: "per run", allowance: 1, window: "per_trace", scope: { workflow: "nightly-import" } });
    const list = await getJson("/policies");
    assert.equal(list.status, 200);
    const byId = new Map((list.body.policies as Array<Record<string, any>>).map((policy) => [policy.id, policy]));
    assert.equal(byId.get(onTrack)?.forecast.health, "on_track");
    assert.equal(byId.get(onTrack)?.usage.observed, 2.5);
    assert.ok(byId.get(onTrack)?.forecast.periodStart && byId.get(onTrack)?.forecast.periodEnd);
    assert.ok(byId.get(onTrack)?.forecast.projected >= 2.5);
    assert.equal(byId.get(atRisk)?.forecast.health, "at_risk");
    assert.equal(byId.get(over)?.forecast.health, "over");
    assert.equal(byId.get(over)?.usage.observed, 5);
    assert.equal(byId.get(paused)?.forecast.health, "paused");
    assert.equal(byId.get(perRun)?.forecast.health, "no_data");
    assert.equal(byId.get(perRun)?.forecast.periodEnd, null);
    const single = await getJson(`/policies/${over}`);
    assert.equal(single.body.policy.forecast.health, "over");

    // Names a budget can cover, last 90 days only.
    const names = await getJson("/scope-names");
    assert.equal(names.status, 200);
    assert.deepEqual(names.body.names.agent, ["support-agent"]);
    assert.deepEqual(names.body.names.workflow, ["chat", "nightly-import"]);
    assert.deepEqual(names.body.names.feature, ["answer", "search"]);
    assert.deepEqual(names.body.names.customer, ["globex", "acme"]);
    assert.deepEqual(names.body.names.model, ["gpt-4o-mini", "gpt-4o", "claude-sonnet"]);
    assert.equal((await getJson("/scope-names", { "x-org": otherOrgId })).status, 404);

    // Daily spend in the workspace time zone (IST): 1 Mar has 1, 2 Mar has 2 plus an unpriced call.
    const from = "2026-02-28T18:30:00.000Z";
    const to = "2026-03-03T18:30:00.000Z";
    const days = await getJson(`/spend-series?from=${from}&to=${to}`);
    assert.equal(days.status, 200);
    assert.equal(days.body.timezone, "Asia/Kolkata");
    assert.deepEqual(days.body.points.map((point: Record<string, unknown>) => [point.key, point.cost, point.unpriced]), [["2026-03-01", 1, 0], ["2026-03-02", 2, 1], ["2026-03-03", 0, 0]]);
    const months = await getJson(`/spend-series?from=${from}&to=${to}&bucket=month`);
    assert.deepEqual(months.body.points.map((point: Record<string, unknown>) => [point.key, point.cost, point.calls]), [["2026-03", 3, 3]]);
    assert.equal((await getJson(`/spend-series?from=${to}&to=${from}`)).status, 400);
    assert.equal((await getJson(`/spend-series?from=2024-01-01T00:00:00Z&to=${to}`)).status, 400);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    await pool.query("DELETE FROM events WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM spending_policies WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = ANY($1::text[])", [[orgId, otherOrgId]]).catch(() => undefined);
    await pool.end();
    await shutdownDatabase();
  }
});

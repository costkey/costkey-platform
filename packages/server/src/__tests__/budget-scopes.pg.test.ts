import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { initDatabase, shutdownDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { ensurePolicySchema } from "../policy-storage.js";
import { createPostgresObservedUsageSource, normalizeSpendingPolicy, perCallUsageSummary, policyWindowKey } from "../admission.js";
import { createBudgetsRouter } from "../budgets.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("group, user and per-call budgets read the canonical charges", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_budget_scopes_${suffix}`;
  const projectId = `project_budget_scopes_${suffix}`;
  let server: ReturnType<typeof createServer> | null = null;
  const at = new Date(Date.now() - 60_000);
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await ensurePolicySchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,$2,$3)", [orgId, "Budget scopes", `budget-scopes-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,$2,$3,$4)", [projectId, "Budget scopes", orgId, `key-${suffix}`]);
    await pool.query(
      `INSERT INTO events(id, project_id, timestamp, provider, model, cost_usd, cost_basis, cost_source, trace_id, trace_name, context, event_type)
       VALUES
         ($1,$4,$5,'openai','model-a',0.5,'reported','provider','t1','nightly-import',$6,'call'),
         ($2,$4,$5,'openai','model-a',2,'reported','provider','t2','chat',$7,'call'),
         ($3,$4,$5,'openai','model-b',5,'reported','provider','t3','nightly-export',$8,'call')`,
      [
        `ev-a-${suffix}`, `ev-b-${suffix}`, `ev-c-${suffix}`, projectId, at,
        JSON.stringify({ feature: "search", userId: "u-1" }),
        JSON.stringify({ feature: "answer", user_id: "u-2" }),
        JSON.stringify({ feature: "other" }),
      ],
    );

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: `owner-${suffix}`, orgId, role: "owner" };
      next();
    });
    app.use(createBudgetsRouter(pool));
    server = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/projects/${projectId}/budget/policies`;
    const create = async (body: Record<string, unknown>) => {
      const response = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unit: "money", currency: "USD", window: "calendar_day", timezone: "UTC", mode: "monitor", ...body }) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };

    const group = await create({ name: "group", allowance: 10, scope: { feature: ["search", "answer", "rerank"] } });
    assert.equal(group.status, 201);
    assert.deepEqual(group.body.policy.scope, { feature: ["search", "answer", "rerank"] });
    assert.equal(group.body.policy.usage.observed, 2.5);

    const single = await create({ name: "single", allowance: 10, scope: { feature: "search" } });
    assert.equal(single.status, 201);
    const stored = await pool.query("SELECT scope FROM spending_policies WHERE id = $1", [single.body.id]);
    assert.deepEqual(stored.rows[0].scope, { feature: "search" });
    assert.equal(single.body.policy.usage.observed, 0.5);

    const user = await create({ name: "user", allowance: 10, scope: { user: "u-2" } });
    assert.equal(user.status, 201);
    assert.equal(user.body.policy.usage.observed, 2);

    const workflow = await create({ name: "workflow", allowance: 10, scope: { workflow: ["nightly-import", "nightly-export"] } });
    assert.equal(workflow.status, 201);
    assert.equal(workflow.body.policy.usage.observed, 5.5);

    const perCall = await create({ name: "per call", allowance: 1, window: "per_call", scope: { model: "model-a" } });
    assert.equal(perCall.status, 201);
    assert.equal(perCall.body.policy.window, "per_call");
    assert.equal(perCall.body.policy.usage.observed, 2);
    assert.equal(perCall.body.policy.usage.overLimit, 1);
    const windows = await pool.query("SELECT COUNT(*)::int AS count FROM policy_window_usage WHERE policy_id = $1", [perCall.body.id]);
    assert.equal(windows.rows[0].count, 0);

    const invalid = await create({ name: "calls per call", unit: "calls", allowance: 1, window: "per_call" });
    assert.equal(invalid.status, 400);

    // The observed source pools group members and resolves either user key.
    const rows = await pool.query("SELECT * FROM spending_policies WHERE id = ANY($1::text[])", [[group.body.id, user.body.id]]);
    const source = createPostgresObservedUsageSource(pool);
    for (const row of rows.rows) {
      const policy = normalizeSpendingPolicy(row);
      const windowKey = policyWindowKey(policy, new Date());
      const observations = await source(policy, windowKey, { projectId, admissionId: `obs-${policy.id}`, provider: "openai", now: new Date() });
      const total = observations.reduce((sum, observation) => sum + (observation.quantity ?? 0), 0);
      assert.equal(total, policy.id === group.body.id ? 2.5 : 2);
    }

    const tokenCap = normalizeSpendingPolicy({ id: "tokens", project_id: projectId, unit: "tokens", allowance: 1, window_kind: "per_call", scope: { feature: ["search", "answer"] } });
    const tokenSummary = await perCallUsageSummary(pool, tokenCap, new Date(at.getTime() - 1000), new Date());
    assert.equal(tokenSummary.overLimit, 0);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    await pool.query("DELETE FROM events WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM spending_policies WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
    await shutdownDatabase();
  }
});

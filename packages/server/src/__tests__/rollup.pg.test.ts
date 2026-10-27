import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { ensureAccountingChangeSchema, initDatabase, shutdownDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { reconcileDailyAccounting, reconcileDailyCostAggregates } from "../accounting.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("the daily rollup follows late changes and the checkpoint stays on completed days", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_rollup_${suffix}`;
  const projectId = `project_rollup_${suffix}`;
  const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const addEvent = (id: string, cost: number) => pool.query(
    `INSERT INTO events(id,project_id,timestamp,provider,model,trace_id,context,cost_usd,cost_basis,cost_source,event_type)
     VALUES ($1,$2,$3,'openai','gpt-4o','trace-rollup',$4,$5,'reported','provider','call')`,
    [id, projectId, `${day}T10:07:00Z`, JSON.stringify({ feature: "search" }), cost],
  );
  const rollupCost = async () => Number((await pool.query(
    "SELECT SUM(known_cost_usd) AS cost FROM daily_cost_aggregates WHERE project_id = $1 AND day = $2", [projectId, day],
  )).rows[0]?.cost ?? 0);
  const checkpoint = async () => (await pool.query(
    "SELECT through_day::text AS through_day FROM daily_cost_aggregate_checkpoints WHERE project_id = $1", [projectId],
  )).rows[0]?.through_day as string | undefined;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await ensureAccountingChangeSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Rollup','rollup-' || $1)", [orgId]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Rollup',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    await pool.query("INSERT INTO workspace_settings(org_id,timezone,reporting_currency) VALUES ($1,'UTC','USD')", [orgId]);
    // Only the last few days matter here; keep the first run short.
    await pool.query("INSERT INTO project_settings(project_id,aggregate_retention_days) VALUES ($1,30) ON CONFLICT (project_id) DO UPDATE SET aggregate_retention_days = 30", [projectId]);

    await addEvent(`event_a_${suffix}`, 1);
    const marked = await pool.query(
      "SELECT period_start FROM accounting_changed_periods WHERE project_id = $1", [projectId],
    );
    assert.deepEqual(marked.rows.map((row) => (row.period_start as Date).toISOString()), [`${day}T10:00:00.000Z`]);

    await reconcileDailyAccounting(pool);
    assert.equal(await rollupCost(), 1);
    assert.equal(await checkpoint(), yesterday);
    assert.equal(Number((await pool.query(
      "SELECT COUNT(*) AS n FROM accounting_changed_periods WHERE project_id = $1", [projectId],
    )).rows[0].n), 0, "reconciled periods are cleared");

    // A call for that day arriving after it was rolled up, and a repricing.
    await addEvent(`event_b_${suffix}`, 2);
    await pool.query("UPDATE events SET cost_usd = 4 WHERE project_id = $1 AND id = $2", [projectId, `event_a_${suffix}`]);
    await reconcileDailyAccounting(pool);
    assert.equal(await rollupCost(), 6);

    // Refreshing today's partial day never moves the checkpoint past it.
    await reconcileDailyCostAggregates(pool, projectId, today, { advanceCheckpoint: false });
    assert.equal(await checkpoint(), yesterday);
  } finally {
    await pool.query("DELETE FROM accounting_changed_periods WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM daily_cost_aggregates WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM events WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
    await shutdownDatabase();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { ensureAccountingChangeSchema, initDatabase, shutdownDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { reconcileDailyAccounting } from "../accounting.js";
import { runRetention } from "../retention.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("retention purges only rolled-up detail and the rollup keeps purged days", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_retention_${suffix}`;
  const projectId = `project_retention_${suffix}`;
  const oldDay = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  const oldEvent = `event_old_${suffix}`;
  const oldEventStored = async () => Number((await pool.query(
    "SELECT COUNT(*) AS n FROM events WHERE project_id = $1 AND id = $2", [projectId, oldEvent],
  )).rows[0].n) === 1;
  const oldDayCost = async () => Number((await pool.query(
    "SELECT SUM(known_cost_usd) AS cost FROM daily_cost_aggregates WHERE project_id = $1 AND day = $2", [projectId, oldDay],
  )).rows[0]?.cost ?? 0);
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await ensureAccountingChangeSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Retention','retention-' || $1)", [orgId]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Retention',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    await pool.query("INSERT INTO workspace_settings(org_id,timezone,reporting_currency) VALUES ($1,'UTC','USD')", [orgId]);
    await pool.query(
      `INSERT INTO project_settings(project_id, body_retention_days, metadata_retention_days, aggregate_retention_days)
       VALUES ($1, 1, 5, 30)
       ON CONFLICT (project_id) DO UPDATE SET body_retention_days = 1, metadata_retention_days = 5, aggregate_retention_days = 30`,
      [projectId],
    );
    await pool.query(
      `INSERT INTO events(id,project_id,timestamp,provider,model,trace_id,context,request_body,cost_usd,cost_basis,cost_source,event_type,created_at)
       VALUES ($1,$2,$3,'openai','gpt-4o','trace-retention',$4,'{"prompt":"hi"}',2,'reported','provider','call',$3)`,
      [oldEvent, projectId, `${oldDay}T09:00:00Z`, JSON.stringify({ feature: "search", note: "free text" })],
    );
    await reconcileDailyAccounting(pool);
    assert.equal(await oldDayCost(), 2);

    // The scrub marks the old day changed, so its detail waits for the rollup.
    const first = await runRetention(pool);
    assert.ok(first.redactedBodies >= 1);
    assert.equal(await oldEventStored(), true, "a period with a change the rollup has not taken in keeps its detail");

    await reconcileDailyAccounting(pool);
    const second = await runRetention(pool);
    assert.equal(second.redactedBodies, 0, "a scrubbed row is not rewritten again");
    assert.equal(await oldEventStored(), false);
    const checkpoint = await pool.query(
      "SELECT purged_before FROM daily_cost_aggregate_checkpoints WHERE project_id = $1", [projectId],
    );
    assert.ok(checkpoint.rows[0]?.purged_before, "the purge horizon is recorded");

    // The purge marked the old day changed; the scheduler must not rebuild it empty.
    await reconcileDailyAccounting(pool);
    assert.equal(await oldDayCost(), 2);
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

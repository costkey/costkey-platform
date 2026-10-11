import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase, shutdownDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { reconcileDailyCostAggregates } from "../accounting.js";
import { loadDailyAggregates } from "../charge-cohort.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("daily accounting preserves workspace-local boundaries after detail expiry", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_aggregate_${suffix}`;
  const projectId = `project_aggregate_${suffix}`;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Aggregate','aggregate-' || $1)", [orgId]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Aggregate',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    await pool.query("INSERT INTO workspace_settings(org_id,timezone,reporting_currency) VALUES ($1,'America/Los_Angeles','USD')", [orgId]);
    await pool.query(
      `INSERT INTO events(id,project_id,timestamp,provider,model,trace_id,context,cost_usd,cost_basis,cost_source,event_type)
       VALUES ($1,$2,'2026-09-01T07:00:00Z','openai','gpt-4o','trace-aggregate',$3,1,'reported','provider','call')`,
      [`event_${suffix}`, projectId, JSON.stringify({ feature: "search" })],
    );
    assert.equal(await reconcileDailyCostAggregates(pool, projectId, "2026-09-01"), 1);
    await pool.query("DELETE FROM events WHERE project_id = $1", [projectId]);

    const exact = await loadDailyAggregates(pool, projectId, {
      from: "2026-09-01T07:00:00.000Z",
      to: "2026-09-02T07:00:00.000Z",
      feature: "search",
    }, "America/Los_Angeles");
    assert.equal(exact.length, 1);
    assert.equal(exact[0].day, "2026-09-01");
    assert.equal(exact[0].known_cost_usd, 1);

    const partial = await loadDailyAggregates(pool, projectId, {
      from: "2026-09-01T08:00:00.000Z",
      to: "2026-09-02T07:00:00.000Z",
      feature: "search",
    }, "America/Los_Angeles");
    assert.equal(partial.length, 0, "a partial local day must not use a full-day snapshot");
  } finally {
    await pool.query("DELETE FROM daily_cost_aggregates WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
    await shutdownDatabase();
  }
});

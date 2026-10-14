import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { loadModelDetail } from "../model-detail-api.js";
import { ensurePlatformSchema } from "../platform-storage.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("a model whose only call failed cost nothing; it isn't unpriced", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_fail_${suffix}`;
  const projectId = `project_fail_${suffix}`;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Failed',$2)", [orgId, `fail-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Failed',$2,$3)", [projectId, orgId, `key_fail_${suffix}`]);
    const at = new Date(Date.now() - 60_000).toISOString();
    // One failed call with no price, and one call that went through without a price.
    await pool.query("INSERT INTO events (id, project_id, timestamp, provider, model, status_code, duration_ms) VALUES ($1, $2, $3, 'anthropic', 'claude-haiku-5-5', 500, 578)", [`ev_fail_${suffix}`, projectId, at]);
    await pool.query("INSERT INTO events (id, project_id, timestamp, provider, model, status_code, duration_ms) VALUES ($1, $2, $3, 'acme', 'acme-llm', 200, 400)", [`ev_unpriced_${suffix}`, projectId, at]);
    const window = { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), environment: null, timezone: "UTC" };

    const failed = await loadModelDetail(pool, projectId, { provider: "anthropic", model: "claude-haiku-5-5", ...window });
    assert.equal(failed.summary.calls, 1);
    assert.equal(failed.summary.failedCalls, 1);
    assert.equal(failed.summary.unpricedCalls, 0);
    assert.equal(failed.summary.cost, 0, "no charge, not unpriced");

    const unpriced = await loadModelDetail(pool, projectId, { provider: "acme", model: "acme-llm", ...window });
    assert.equal(unpriced.summary.unpricedCalls, 1);
    assert.equal(unpriced.summary.cost, null, "a call that went through without a price stays unpriced");
  } finally {
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

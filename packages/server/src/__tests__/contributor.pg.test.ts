import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { initDatabase, shutdownDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { ensurePolicySchema } from "../policy-storage.js";
import { createAccountingRouter } from "../accounting-api.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("contributor detail returns baseline, distributions, and policy context", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_contributor_${suffix}`;
  const projectId = `project_contributor_${suffix}`;
  let server: ReturnType<typeof createServer> | null = null;
  // /summary always compares this calendar month with last month, so anchor
  // the fixtures to now: the current event sits halfway into this month and
  // the baseline event the same distance before the month started.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const half = Math.floor((now.getTime() - monthStart.getTime()) / 2);
  const currentAt = new Date(monthStart.getTime() + half);
  const previousAt = new Date(monthStart.getTime() - half - 1);
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await ensurePolicySchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,$2,$3)", [orgId, "Contributor", `contributor-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,$2,$3,$4)", [projectId, "Contributor", orgId, `key-${suffix}`]);
    await pool.query(
      `INSERT INTO events(
         id, project_id, timestamp, provider, model, cost_usd, cost_basis, cost_source, release,
         trace_id, trace_name, context, bl_file, bl_function, event_type
       ) VALUES
         ($1,$2,$3,'openai','gpt-4o',1,'reported','provider','v2','trace-current','Search',$4,'src/search.ts','search','call'),
         ($5,$2,$3,'anthropic','claude',2,'estimated','pricing','v2','trace-current','Search',$4,'src/search.ts','search','call'),
         ($6,$2,$7,'openai','gpt-4o',0.5,'reported','provider','v2','trace-previous','Search',$4,'src/search.ts','search','call')`,
      [
        "event-current-one", projectId, currentAt,
        JSON.stringify({ feature: "search", service: "web" }),
        "event-current-two", "event-previous", previousAt,
      ],
    );
    await pool.query(
      `INSERT INTO spending_policies(id,project_id,name,scope,mode,status,unit,allowance,currency,window_kind)
       VALUES ($1,$2,'Search policy','{"feature":"search"}','monitor','active','money',10,'USD','calendar_day')`,
      [`policy-${suffix}`, projectId],
    );

    const app = express();
    app.use((req, _res, next) => {
      (req as any).user = { id: `owner-${suffix}`, orgId, role: "owner" };
      next();
    });
    app.use(createAccountingRouter(pool));
    server = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const port = (server.address() as { port: number }).port;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/projects/${projectId}/costs/contributors/feature/search?from=${monthStart.toISOString()}&to=${now.toISOString()}`,
    );
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, any>;
    assert.equal(body.summary.known_cost, 3);
    assert.equal(body.summary.baseline.known_cost, 0.5);
    assert.equal(body.distributions.providers.length, 2);
    assert.equal(body.distributions.services[0].key, "web");
    assert.equal(body.related.features[0].key, "search");
    assert.equal(body.policyActions.policies.length, 1);

    const summaryResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${projectId}/summary`);
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json() as Record<string, any>;
    assert.equal(summary.byRelease[0].release, "v2");
    assert.equal(summary.releaseComparison.available, true);
    assert.equal(summary.byRelease[0].change_abs, 2.5);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
    await shutdownDatabase();
  }
});

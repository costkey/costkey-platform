import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { initDatabase, shutdownDatabase } from "../db.js";
import { createIngestRouter } from "../ingest.js";
import { loadCanonicalCharges } from "../charge-cohort.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

async function request(baseUrl: string, projectKey: string, eventId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${projectKey}` },
    body: JSON.stringify({
      sdkVersion: "tenant-accounting-test",
      events: [{
        id: eventId,
        timestamp: "2026-09-13T00:00:00.000Z",
        provider: "openai",
        model: "gpt-4o",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        traceId: "same-trace",
        traceName: "same-trace-name",
        chargeId: "same-charge",
        context: { feature: "tenant-isolation" },
      }],
    }),
  });
}

test("event envelope ids are project-scoped in real PostgreSQL", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_tenant_${suffix}`;
  const projectA = `project_tenant_a_${suffix}`;
  const projectB = `project_tenant_b_${suffix}`;
  const keyA = `key_tenant_a_${suffix}`;
  const keyB = `key_tenant_b_${suffix}`;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  try {
    await initDatabase();
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,$2,$3)", [orgId, "Tenant isolation", `tenant-${suffix}`]);
    await pool.query(
      `INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'A',$3,$4),($2,'B',$3,$5)`,
      [projectA, projectB, orgId, keyA, keyB],
    );
    app.use(createIngestRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      assert.equal((await request(baseUrl, keyA, "same-envelope-id")).status, 202);
      assert.equal((await request(baseUrl, keyB, "same-envelope-id")).status, 202);
      assert.equal((await request(baseUrl, keyA, "same-envelope-id")).status, 202, "same-project retry remains idempotent");

      const rows = await pool.query(
        `SELECT project_id, id FROM events WHERE id = $1 ORDER BY project_id`,
        ["same-envelope-id"],
      );
      assert.deepEqual(rows.rows.map((row) => row.project_id), [projectA, projectB]);
      assert.equal(rows.rowCount, 2);
      assert.equal((await loadCanonicalCharges(pool, projectA, {})).length, 1);
      assert.equal((await loadCanonicalCharges(pool, projectB, {})).length, 1);

      const traces = await pool.query(
        "SELECT project_id, id FROM traces WHERE id = $1 ORDER BY project_id",
        ["same-trace"],
      );
      assert.deepEqual(traces.rows.map((row) => row.project_id), [projectA, projectB]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await pool.query("DELETE FROM events WHERE project_id = ANY($1::text[])", [[projectA, projectB]]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = ANY($1::text[])", [[projectA, projectB]]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
    await shutdownDatabase();
  }
});

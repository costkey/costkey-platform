import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { createIngestRouter } from "../ingest.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { sweepEmptyRuns } from "../empty-runs.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("runs with no model call, span or score are removed after the grace period", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_empty_${suffix}`;
  const projectId = `project_empty_${suffix}`;
  const key = `key_empty_${suffix}`;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,$2,$3)", [orgId, "Empty", `empty-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Empty',$2,$3)", [projectId, orgId, key]);
    app.use(createIngestRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const now = new Date().toISOString();
      const lifecycle = (trace: string, state: string) => ({
        id: `ev_${trace}_${state}`, eventType: "lifecycle", lifecycle: state, entityType: "trace", entityId: trace,
        traceId: trace, timestamp: now, context: { traceName: "generated-media-synthesize-next" },
      });
      const run = (trace: string) => [lifecycle(trace, "started"), lifecycle(trace, "completed")];
      const events = [
        ...run("tr_empty"),
        ...run("tr_call"),
        {
          id: "ev_call", timestamp: now, durationMs: 900, provider: "openai", model: "gpt-4o", statusCode: 200,
          costUsd: 0.01, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, traceId: "tr_call",
        },
        ...run("tr_span"),
        { id: "ev_span", eventType: "span", traceId: "tr_span", spanId: "sp_tool", name: "lookup", kind: "tool", timestamp: now, durationMs: 5 },
        ...run("tr_recent"),
        // A work item's failed attempt, then a retry that had nothing left to do.
        ...[lifecycle("tr_try1", "started"), { ...lifecycle("tr_try1", "failed"), lifecycleErrorType: "RetryableWorkError" }, {
          id: "ev_try1_call", timestamp: now, durationMs: 900, provider: "openai", model: "gpt-4o", statusCode: 200,
          costUsd: 0.01, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, traceId: "tr_try1",
        }].map((event) => ({ ...event, context: { ...(event as { context?: object }).context, work_id: "w1" } })),
        ...run("tr_try2").map((event) => ({ ...event, context: { ...event.context, work_id: "w1" } })),
      ];
      const response = await fetch(`${baseUrl}/api/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ sdkVersion: "0.7.2", events }),
      });
      const body = await response.json() as { accepted?: number; rejected?: unknown[] };
      assert.equal(response.status, 202, JSON.stringify(body));
      assert.deepEqual(body.rejected ?? [], [], JSON.stringify(body.rejected));
      // Everything but tr_recent finished ten minutes ago.
      await pool.query(
        "UPDATE events SET timestamp = timestamp - interval '10 minutes' WHERE project_id = $1 AND trace_id <> 'tr_recent'",
        [projectId],
      );

      assert.ok(await sweepEmptyRuns(pool, { graceSeconds: 120 }) >= 1);
      const left = await pool.query<{ trace_id: string }>(
        "SELECT DISTINCT trace_id FROM events WHERE project_id = $1 ORDER BY trace_id",
        [projectId],
      );
      assert.deepEqual(left.rows.map((row) => row.trace_id), ["tr_call", "tr_recent", "tr_span", "tr_try1", "tr_try2"]);
      const traces = await pool.query("SELECT 1 FROM traces WHERE project_id = $1 AND id = 'tr_empty'", [projectId]);
      assert.equal(traces.rowCount, 0);

      process.env["COSTKEY_KEEP_EMPTY_RUNS"] = "true";
      await pool.query("UPDATE events SET timestamp = timestamp - interval '10 minutes' WHERE project_id = $1", [projectId]);
      assert.equal(await sweepEmptyRuns(pool, { graceSeconds: 120 }), 0, "the setting keeps empty runs");
    } finally {
      delete process.env["COSTKEY_KEEP_EMPTY_RUNS"];
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

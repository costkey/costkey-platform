import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase, shutdownDatabase } from "../db.js";
import { createIngestRouter } from "../ingest.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { telemetryFor } from "./helpers/skeleton.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

async function post(baseUrl: string, key: string, body: unknown): Promise<number> {
  const response = await fetch(`${baseUrl}/api/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  await response.text();
  return response.status;
}

test("frame source context survives ingest, and is dropped with source access off", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_src_${suffix}`;
  const projectId = `project_src_${suffix}`;
  const key = `key_src_${suffix}`;
  const closedProjectId = `project_srcoff_${suffix}`;
  const closedKey = `key_srcoff_${suffix}`;
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,$2,$3)", [orgId, "Source", `src-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Src',$2,$3), ($4,'SrcOff',$2,$5)", [projectId, orgId, key, closedProjectId, closedKey]);
    await pool.query(
      `INSERT INTO project_settings(project_id, capture_mode, body_capture_enabled, source_access_enabled)
       VALUES ($1, 'metadata', false, true), ($2, 'metadata', false, false)
       ON CONFLICT (project_id) DO UPDATE SET capture_mode = EXCLUDED.capture_mode,
         body_capture_enabled = EXCLUDED.body_capture_enabled, source_access_enabled = EXCLUDED.source_access_enabled`,
      [projectId, closedProjectId],
    );
    app.use(createIngestRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      const frames = [
        { functionName: "costKeyFetchWrapper", fileName: "/app/node_modules/costkey/dist/fetch-patch.js", lineNumber: 1, columnNumber: 1 },
        { functionName: "OpenAI.makeRequest", fileName: "/app/node_modules/openai/core.js", lineNumber: 2, columnNumber: 1 },
        {
          functionName: "summarize", fileName: "/app/src/summarize.ts", lineNumber: 12, columnNumber: 3,
          contextLine: "  const res = await openai.chat.completions.create(req);",
          preContext: ["export async function summarize(req) {", "  const t0 = Date.now();", ""],
          postContext: ["  return res;", "}", ""],
        },
        { functionName: "handler", fileName: "/app/src/routes.ts", lineNumber: 40, columnNumber: 9 },
      ];
      const event = (id: string) => ({
        id, timestamp: startedAt, eventType: "call",
        callSite: { raw: null, frames },
        telemetry: telemetryFor({
          url: "https://api.openai.com/v1/chat/completions", requestBody: { model: "gpt-4o" }, status: 200,
          responseBody: { id: "x", model: "gpt-4o", usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }, startedAt,
        }),
      });
      assert.equal(await post(baseUrl, key, { sdkVersion: "0.7.5", events: [event(`src_${suffix}`)] }), 202);
      assert.equal(await post(baseUrl, closedKey, { sdkVersion: "0.7.5", events: [event(`srcoff_${suffix}`)] }), 202);

      const open = (await pool.query("SELECT call_site_frames, bl_function FROM events WHERE project_id = $1 AND id = $2", [projectId, `src_${suffix}`])).rows[0];
      assert.ok(open, "event stored");
      assert.deepEqual(open.call_site_frames.map((f: { functionName: string }) => f.functionName), ["summarize", "handler"]);
      assert.equal(open.call_site_frames[0].contextLine, "  const res = await openai.chat.completions.create(req);");
      assert.deepEqual(open.call_site_frames[0].preContext, ["export async function summarize(req) {", "  const t0 = Date.now();", ""]);
      assert.deepEqual(open.call_site_frames[0].postContext, ["  return res;", "}", ""]);
      assert.equal(open.call_site_frames[1].contextLine, undefined);
      assert.equal(open.bl_function, "summarize");

      const closed = (await pool.query("SELECT call_site_frames, call_site_raw FROM events WHERE project_id = $1 AND id = $2", [closedProjectId, `srcoff_${suffix}`])).rows[0];
      assert.ok(closed, "event stored");
      assert.equal(closed.call_site_frames, null, "source access off stores no frames at all");
      assert.equal(closed.call_site_raw, null);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    for (const id of [projectId, closedProjectId]) {
      for (const table of ["events", "usage_components", "call_site_stats", "frame_stats", "frame_stats_callsites", "call_graphs", "traces", "executions", "groups", "project_settings"]) {
        await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [id]).catch(() => undefined);
      }
      await pool.query("DELETE FROM projects WHERE id = $1", [id]).catch(() => undefined);
    }
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
    await shutdownDatabase();
  }
});

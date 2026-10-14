import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { createIngestRouter } from "../ingest.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { configureRequestParsing } from "../request-parsing.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

// A model call the OpenAI Agents SDK makes on its own task: library frames and the entry point.
const frameworkStack = [
  { fileName: "/app/.venv/lib/python3.12/site-packages/openai/_base_client.py", lineNumber: 1500, functionName: "request" },
  { fileName: "/app/.venv/lib/python3.12/site-packages/agents/run.py", lineNumber: 400, functionName: "_run_single_turn" },
  { fileName: "/app/apps/api/src/platform_api/__main__.py", lineNumber: 8, functionName: "<module>", contextLine: "    uvicorn.run(" },
];
// Where Dash's code opened the agent.
const openedStack = [
  { fileName: "/app/.venv/lib/python3.12/site-packages/costkey/client.py", lineNumber: 700, functionName: "__enter__" },
  { fileName: "/app/apps/api/src/platform_api/modules/chat/run_loop.py", lineNumber: 212, functionName: "answer", contextLine: "        with costkey.agent(\"dash\"):" },
  { fileName: "/app/apps/api/src/platform_api/__main__.py", lineNumber: 8, functionName: "<module>" },
];

async function setup(sourceAccess: boolean) {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const projectId = `project_scope_${suffix}`;
  const orgId = `org_scope_${suffix}`;
  const key = `key_scope_${suffix}`;
  await initDatabase();
  await ensurePlatformSchema(pool);
  await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Scope',$2)", [orgId, `scope-${suffix}`]);
  await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Scope',$2,$3)", [projectId, orgId, key]);
  await pool.query("INSERT INTO project_settings (project_id, capture_mode, body_capture_enabled, source_access_enabled) VALUES ($1,'text',TRUE,$2)", [projectId, sourceAccess]);
  const app = express();
  configureRequestParsing(app);
  app.use(createIngestRouter(pool));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  const send = async (events: unknown[]) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/events`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ sdkVersion: "python-0.7.7", events }),
    });
    assert.equal(response.status, 202, await response.text());
  };
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  };
  return { pool, projectId, send, close };
}

const now = () => new Date().toISOString();
const span = (id: string, status: string, parent?: string, callSite?: unknown) => ({
  id, eventType: "span", kind: parent ? "step" : "agent", name: parent ? "turn 1" : "dash", status, traceId: "tr_dash",
  ...(parent ? { parentSpanId: parent } : {}), startedAt: now(), timestamp: now(), ...(callSite ? { callSite } : {}),
});
const call = (id: string, spanId: string) => ({
  id, timestamp: now(), durationMs: 900, provider: "openai", model: "gpt-4o", statusCode: 200,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, spanId, traceId: "tr_dash",
  context: { traceId: "tr_dash", spanId }, callSite: { raw: "", frames: frameworkStack },
});

test("a call made on a framework's task is named after the code that opened its agent", { skip: !connectionString }, async () => {
  const { pool, projectId, send, close } = await setup(true);
  try {
    // The agent opens in Dash's code; the SDK's own turn span opens in library code.
    await send([span("sp_dash", "running", undefined, { raw: "", frames: openedStack }), span("sp_turn", "running", "sp_dash", { raw: "", frames: frameworkStack })]);
    await send([call("ev_1", "sp_turn")]);
    const row = await pool.query("SELECT bl_function, bl_file, bl_line FROM events WHERE project_id = $1 AND id = 'ev_1'", [projectId]);
    assert.deepEqual(row.rows[0], { bl_function: "answer", bl_file: "/app/apps/api/src/platform_api/modules/chat/run_loop.py", bl_line: 212 });
  } finally {
    await close();
  }
});

test("a call stored before its span's opening stack arrives is named when it does", { skip: !connectionString }, async () => {
  const { pool, projectId, send, close } = await setup(true);
  try {
    await send([span("sp_turn", "running", "sp_dash"), call("ev_2", "sp_turn")]);
    assert.equal((await pool.query("SELECT bl_function FROM events WHERE project_id = $1 AND id = 'ev_2'", [projectId])).rows[0].bl_function, null);
    await send([span("sp_dash", "ok", undefined, { raw: "", frames: openedStack })]);
    assert.equal((await pool.query("SELECT bl_function FROM events WHERE project_id = $1 AND id = 'ev_2'", [projectId])).rows[0].bl_function, "answer");
  } finally {
    await close();
  }
});

test("with source access off, no code is kept or used", { skip: !connectionString }, async () => {
  const { pool, projectId, send, close } = await setup(false);
  try {
    await send([span("sp_dash", "running", undefined, { raw: "", frames: openedStack }), call("ev_3", "sp_dash")]);
    const spanRow = await pool.query("SELECT call_site_frames FROM spans WHERE project_id = $1 AND id = 'sp_dash'", [projectId]);
    assert.equal(spanRow.rows[0].call_site_frames, null);
    assert.equal((await pool.query("SELECT bl_function FROM events WHERE project_id = $1 AND id = 'ev_3'", [projectId])).rows[0].bl_function, null);
  } finally {
    await close();
  }
});

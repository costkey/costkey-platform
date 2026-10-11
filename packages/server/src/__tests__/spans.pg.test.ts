import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase, shutdownDatabase } from "../db.js";
import { createIngestRouter } from "../ingest.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

async function post(baseUrl: string, key: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

test("agent spans, per-event rejection, group reuse and call start times", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_spans_${suffix}`;
  const projectId = `project_spans_${suffix}`;
  const key = `key_spans_${suffix}`;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  try {
    await initDatabase();
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,$2,$3)", [orgId, "Spans", `spans-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Spans',$2,$3)", [projectId, orgId, key]);
    // Metadata-only: span content must be stripped, structure kept.
    await pool.query(
      `INSERT INTO project_settings(project_id, capture_mode, body_capture_enabled)
       VALUES ($1, 'metadata', false)
       ON CONFLICT (project_id) DO UPDATE SET capture_mode = 'metadata', body_capture_enabled = false`,
      [projectId],
    ).catch(() => undefined);
    app.use(createIngestRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const now = Date.now();
      const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

      // Span start, a call inside it, an unknown event type and a bad span in one batch.
      const first = await post(baseUrl, key, {
        sdkVersion: "0.6.0",
        release: "v6",
        events: [
          { id: `agent_${suffix}`, eventType: "span", kind: "agent", name: "dash", traceId: `tr_${suffix}`, startedAt: iso(-5_000), status: "running", timestamp: iso(-5_000), attributes: { "agent.model": "gpt-6", input: "secret prompt" } },
          { id: `tool_${suffix}`, eventType: "span", kind: "tool", name: "search_funds", traceId: `tr_${suffix}`, parentSpanId: `agent_${suffix}`, startedAt: iso(-4_000), endedAt: iso(-3_000), status: "ok", timestamp: iso(-4_000) },
          { id: `call_${suffix}`, timestamp: iso(-2_000), durationMs: 1_000, provider: "openai", model: "gpt-4o", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, traceId: `tr_${suffix}`, spanId: `agent_${suffix}`, context: { feature: "chat", agent: "dash" } },
          { id: `future_${suffix}`, eventType: "agent_thought", timestamp: iso(0) },
          { id: `noname_${suffix}`, eventType: "span", kind: "step", traceId: `tr_${suffix}`, timestamp: iso(0) },
        ],
      });
      assert.equal(first.status, 202);
      assert.equal(first.json["accepted"], 3);
      const rejected = first.json["rejected"] as Array<{ index: number; code: string }>;
      assert.deepEqual(rejected.map((item) => [item.index, item.code]), [[3, "unsupported_event_type"], [4, "invalid_accounting_event"]]);

      // The span's end arrives later; the running start must not win.
      const end = await post(baseUrl, key, {
        sdkVersion: "0.6.0",
        events: [{ id: `agent_${suffix}`, eventType: "span", kind: "agent", name: "dash", traceId: `tr_${suffix}`, endedAt: iso(-1_000), status: "ok", timestamp: iso(-1_000) }],
      });
      assert.equal(end.status, 202);
      const late = await post(baseUrl, key, {
        sdkVersion: "0.6.0",
        events: [{ id: `agent_${suffix}`, eventType: "span", kind: "agent", name: "dash", traceId: `tr_${suffix}`, status: "running", timestamp: iso(-5_000) }],
      });
      assert.equal(late.status, 202);

      const spans = await pool.query(
        "SELECT id, kind, name, status, parent_span_id, started_at, ended_at, attributes FROM spans WHERE project_id = $1 ORDER BY started_at",
        [projectId],
      );
      assert.equal(spans.rowCount, 2);
      const agent = spans.rows[0] as { kind: string; status: string; ended_at: Date; attributes: Record<string, unknown> | null };
      assert.equal(agent.kind, "agent");
      assert.equal(agent.status, "ok", "a late running delivery never reopens a finished span");
      assert.ok(agent.ended_at);
      assert.equal(agent.attributes?.["agent.model"], "gpt-6");
      assert.equal(agent.attributes?.["input"], undefined, "metadata-only projects never store span content");
      assert.equal((spans.rows[1] as { parent_span_id: string }).parent_span_id, `agent_${suffix}`);

      const call = await pool.query("SELECT span_id, sdk_version, timestamp, context FROM events WHERE project_id = $1 AND id = $2", [projectId, `call_${suffix}`]);
      assert.equal(call.rows[0].span_id, `agent_${suffix}`);
      assert.equal(call.rows[0].sdk_version, "0.6.0");
      assert.equal(new Date(call.rows[0].timestamp).toISOString(), iso(-2_000), "0.6 SDKs send the start time");
      assert.equal(call.rows[0].context.release, "v6", "the batch release reaches context for release filters");
      assert.equal((await pool.query("SELECT 1 FROM events WHERE project_id = $1 AND event_type = 'span'", [projectId])).rowCount, 0, "spans are not billable rows");

      const trace = await pool.query("SELECT started_at, ended_at FROM traces WHERE project_id = $1 AND id = $2", [projectId, `tr_${suffix}`]);
      assert.equal(new Date(trace.rows[0].started_at).toISOString(), iso(-5_000), "trace starts with its first span");

      // Older SDKs stamped the end of the call: shift to the start.
      const legacy = await post(baseUrl, key, {
        sdkVersion: "0.5.2",
        events: [{ id: `legacy_${suffix}`, timestamp: iso(-1_000), durationMs: 4_000, provider: "openai", model: "gpt-4o", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }],
      });
      assert.equal(legacy.status, 202);
      const legacyRow = await pool.query("SELECT timestamp FROM events WHERE project_id = $1 AND id = $2", [projectId, `legacy_${suffix}`]);
      assert.equal(new Date(legacyRow.rows[0].timestamp).toISOString(), iso(-5_000));

      // A second id for an existing group name reuses the group instead of failing.
      const groupA = await post(baseUrl, key, {
        sdkVersion: "0.6.0",
        events: [{ id: `g1_${suffix}`, timestamp: iso(-500), durationMs: 10, provider: "openai", model: "gpt-4o", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, executionId: `ex1_${suffix}`, groupId: `grp_a_${suffix}`, groupName: "nightly", groupKind: "eval" }],
      });
      const groupB = await post(baseUrl, key, {
        sdkVersion: "0.6.0",
        events: [{ id: `g2_${suffix}`, timestamp: iso(-400), durationMs: 10, provider: "openai", model: "gpt-4o", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, executionId: `ex2_${suffix}`, groupId: `grp_b_${suffix}`, groupName: "nightly", groupKind: "eval" }],
      });
      assert.equal(groupA.status, 202);
      assert.equal(groupB.status, 202);
      const groups = await pool.query("SELECT id FROM groups WHERE project_id = $1", [projectId]);
      assert.equal(groups.rowCount, 1);
      const groupedEvents = await pool.query("SELECT DISTINCT group_id FROM events WHERE project_id = $1 AND group_id IS NOT NULL", [projectId]);
      assert.deepEqual(groupedEvents.rows.map((row) => row.group_id), [`grp_a_${suffix}`]);

      // A batch where every event is invalid keeps the single-error contract.
      const allBad = await post(baseUrl, key, { sdkVersion: "0.6.0", events: [{ id: `bad_${suffix}`, eventType: "lifecycle", timestamp: iso(0) }] });
      assert.equal(allBad.status, 400);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    for (const table of ["events", "spans", "traces", "executions", "groups", "project_settings"]) {
      await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]).catch(() => undefined);
    }
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
    await shutdownDatabase();
  }
});

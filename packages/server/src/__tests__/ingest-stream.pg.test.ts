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

const sse = (event: string, data: Record<string, unknown>) => ({ event, data: { type: event, ...data } });

test("a streamed call is stored as the assembled response", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_stream_${suffix}`;
  const projectId = `project_stream_${suffix}`;
  const key = `key_stream_${suffix}`;
  const app = express();
  configureRequestParsing(app);
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Stream',$2)", [orgId, `stream-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Stream',$2,$3)", [projectId, orgId, key]);
    await pool.query("INSERT INTO project_settings (project_id, capture_mode, body_capture_enabled) VALUES ($1, 'text', TRUE)", [projectId]);
    app.use(createIngestRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    try {
      const base = { id: "resp_dash", object: "response", model: "gpt-5-mini", status: "in_progress", output: [] };
      const toolItem = { id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: "portfolio", arguments: "{}" };
      // The secret is split across two deltas: only the assembled text shows it whole.
      const events = [
        sse("response.created", { response: base }),
        sse("response.output_item.done", { output_index: 0, item: toolItem }),
        sse("response.output_text.delta", { output_index: 1, delta: "You're up 4%. Your key is sk-abcdefghij" }),
        sse("response.output_text.delta", { output_index: 1, delta: "klmnopqrstuvwxyz0123." }),
      ];
      const batch = { sdkVersion: "0.7.5", events: [{
        id: `ev_stream_${suffix}`, timestamp: new Date().toISOString(), durationMs: 900, provider: "openai", model: "gpt-5-mini",
        statusCode: 200, streaming: true, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        requestBody: { model: "gpt-5-mini", stream: true, input: [{ role: "user", content: "How rich am i" }] },
        responseBody: { __costkey_stream__: events },
      }] };
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(batch),
      });
      assert.equal(response.status, 202, await response.text());
      const stored = await pool.query<{ response_body: Record<string, unknown> | null; metadata: Record<string, unknown> | null; output_tokens: number }>(
        "SELECT response_body, metadata, output_tokens FROM events WHERE project_id = $1",
        [projectId],
      );
      const row = stored.rows[0];
      const body = row?.response_body;
      assert.ok(body, "the response body is stored");
      assert.equal(body["__costkey_stream__"], undefined, "the stream is not stored as events");
      assert.equal(body["id"], "resp_dash");
      const output = body["output"] as Array<Record<string, unknown>>;
      assert.deepEqual(output[0], toolItem);
      const text = ((output[1]!["content"] as Array<Record<string, unknown>>)[0]!)["text"];
      assert.equal(text, "You're up 4%. Your key is [REDACTED].", "a secret split across deltas is redacted whole");
      assert.deepEqual((row!.metadata?.["toolCalls"] as unknown[] | undefined)?.[0], toolItem, "tool calls are read from the assembled body");
      assert.equal(row!.output_tokens, 5, "usage is unchanged");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

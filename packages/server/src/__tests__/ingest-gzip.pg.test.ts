import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { createIngestRouter } from "../ingest.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { configureRequestParsing } from "../request-parsing.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("a gzipped batch is unpacked and a large prompt is stored whole", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_gzip_${suffix}`;
  const projectId = `project_gzip_${suffix}`;
  const key = `key_gzip_${suffix}`;
  const app = express();
  configureRequestParsing(app);
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Gzip',$2)", [orgId, `gzip-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Gzip',$2,$3)", [projectId, orgId, key]);
    await pool.query("INSERT INTO project_settings (project_id, capture_mode, body_capture_enabled) VALUES ($1, 'text', TRUE)", [projectId]);
    app.use(createIngestRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    try {
      const instructions = "You are Dash, the user's money friend. ".repeat(8_000); // ~300 KB
      const requestBody = { model: "gpt-4o", instructions, input: [{ role: "user", content: "How rich am i" }], tools: [{ type: "function", name: "portfolio", parameters: { type: "object" } }] };
      const batch = { sdkVersion: "0.7.4", events: [{
        id: `ev_gzip_${suffix}`, timestamp: new Date().toISOString(), durationMs: 900, provider: "openai", model: "gpt-4o", statusCode: 200,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, requestBody, responseBody: { output_text: "Quite." },
      }] };
      const packed = gzipSync(JSON.stringify(batch));
      assert.ok(packed.length < 20_000, "300 KB of prompt goes over the wire in a few KB");
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${key}` },
        body: packed,
      });
      assert.equal(response.status, 202, await response.text());
      const stored = await pool.query<{ request_body: Record<string, unknown> | null }>("SELECT request_body FROM events WHERE project_id = $1", [projectId]);
      const body = stored.rows[0]?.request_body;
      assert.ok(body, "the request body is stored");
      assert.equal(body["instructions"], instructions, "the prompt is stored whole");
      assert.equal(body["__costkey_truncated__"], undefined);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

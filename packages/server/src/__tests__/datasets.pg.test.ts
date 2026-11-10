import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { createDatasetsRouter } from "../datasets.js";
import { createPrivacyRouter } from "../privacy.js";
import { purgeExpiredFrames } from "../frames.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("labelled datasets: add calls, relabel, export, permissions and content deletion", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_ds_${suffix}`;
  const projectId = `project_ds_${suffix}`;
  const userId = `user_ds_${suffix}`;
  const eventId = `evt_ds_${suffix}`;
  const sha = "d".repeat(56) + suffix.slice(0, 8).padEnd(8, "0");
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Datasets',$2)", [orgId, `ds-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Datasets',$2,$3)", [projectId, orgId, `key_ds_${suffix}`]);
    await pool.query("INSERT INTO project_settings (project_id, capture_mode, body_capture_enabled, screen_capture_enabled) VALUES ($1, 'text', TRUE, TRUE)", [projectId]);
    await pool.query("INSERT INTO users(id,email,name,password_hash,org_id,role) VALUES ($1,$2,'Owner','x',$3,'owner')", [userId, `ds-${suffix}@example.test`, orgId]);
    await pool.query("INSERT INTO project_memberships (project_id, user_id) VALUES ($1, $2)", [projectId, userId]);
    const request = { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "Buy the desk" }] };
    const response = { content: [{ type: "tool_use", input: { action: "left_click", coordinate: [10, 20] } }] };
    await pool.query(
      `INSERT INTO events (id, timestamp, project_id, provider, model, url, method, status_code, duration_ms, streaming,
                           trace_id, request_body, response_body, frames, event_type)
       VALUES ($1, NOW(), $2, 'anthropic', 'claude-sonnet-4-5', 'https://api.anthropic.com/v1/messages', 'POST', 200, 100, FALSE,
               $3, $4, $5, $6, 'call')`,
      [eventId, projectId, `tr_${suffix}`, JSON.stringify(request), JSON.stringify(response),
        JSON.stringify([{ sha256: "e".repeat(64), mediaType: "image/png", bytes: 5 }, { sha256: sha, mediaType: "image/png", bytes: 6 }])],
    );
    await pool.query("INSERT INTO frames (project_id, sha256, media_type, bytes, data, created_at) VALUES ($1, $2, 'image/png', 1, '\\x00', NOW() - INTERVAL '60 days')", [projectId, sha]);

    let role = "owner";
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: userId, orgId, role }; next(); });
    app.use(createDatasetsRouter(pool));
    app.use(createPrivacyRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/projects/${projectId}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      const text = await response.text();
      let json: Record<string, any> = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { text }; }
      return { status: response.status, json, text };
    };
    try {
      const created = await call("POST", "/datasets", { name: "checkout clicks", description: "Steps from the checkout agent" });
      assert.equal(created.status, 201, created.text);
      const datasetId = created.json.dataset.id as string;
      assert.equal((await call("POST", "/datasets", { name: "checkout clicks" })).status, 409);
      assert.equal((await call("POST", "/datasets", { name: "" })).status, 400);

      // Adding a call copies its input, output and newest screenshot.
      const added = await call("POST", `/datasets/${datasetId}/items`, { eventId, label: "Bad", note: "Clicked the banner" });
      assert.equal(added.status, 201, added.text);
      assert.equal(added.json.item.frameSha256, sha);
      assert.equal(added.json.item.hasInput, true);
      const stored = await pool.query("SELECT input, output FROM dataset_items WHERE id = $1", [added.json.item.id]);
      assert.deepEqual(stored.rows[0].input, request);
      assert.deepEqual(stored.rows[0].output, response);
      // Adding it again relabels it.
      const relabelled = await call("POST", `/datasets/${datasetId}/items`, { eventId, label: "Good", expected: { action: "left_click", x: 400, y: 300 } });
      assert.equal(relabelled.status, 200);
      assert.equal(relabelled.json.item.label, "Good");
      assert.equal((await call("POST", `/datasets/${datasetId}/items`, { eventId: "missing", label: "Good" })).status, 404);
      assert.equal((await call("POST", `/datasets/${datasetId}/items`, { eventId, label: "x".repeat(61) })).status, 400);

      const list = await call("GET", "/datasets");
      assert.equal(list.json.datasets.length, 1);
      assert.equal(list.json.datasets[0].itemCount, 1);
      assert.deepEqual(list.json.datasets[0].labels, { Good: 1 });
      assert.equal(list.json.datasets[0].revision, 3);
      const detail = await call("GET", `/datasets/${datasetId}`);
      assert.equal(detail.json.items[0].label, "Good");
      assert.deepEqual(detail.json.items[0].expected, { action: "left_click", x: 400, y: 300 });
      assert.equal(detail.json.items[0].input, undefined, "the detail list leaves content out");
      const memberships = await call("GET", `/dataset-items?eventId=${eventId}`);
      assert.deepEqual(memberships.json.items.map((item: { datasetName: string; label: string }) => [item.datasetName, item.label]), [["checkout clicks", "Good"]]);

      const patched = await call("PATCH", `/datasets/${datasetId}/items/${added.json.item.id}`, { note: "Should have clicked Continue" });
      assert.equal(patched.json.item.note, "Should have clicked Continue");
      assert.equal(patched.json.item.label, "Good");

      const exported = await call("GET", `/datasets/${datasetId}/export`);
      const lines = exported.text.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(lines.length, 1);
      assert.deepEqual(lines[0].input, request);
      assert.equal(lines[0].label, "Good");

      // A screenshot in a dataset survives frame retention.
      assert.equal(await purgeExpiredFrames(pool, new Date(), orgId), 0);
      assert.equal(Number((await pool.query("SELECT COUNT(*) FROM frames WHERE project_id = $1", [projectId])).rows[0].count), 1);

      // Viewers can't open datasets: they hold captured content.
      role = "viewer";
      assert.equal((await call("GET", "/datasets")).status, 403);
      role = "owner";

      // Deleting captured content clears the copied input and output.
      const wiped = await call("POST", "/privacy/delete-content", { confirmProjectId: projectId });
      assert.equal(wiped.status, 200, wiped.text);
      const cleared = await pool.query("SELECT input, output, label FROM dataset_items WHERE id = $1", [added.json.item.id]);
      assert.deepEqual([cleared.rows[0].input, cleared.rows[0].output, cleared.rows[0].label], [null, null, "Good"]);

      assert.equal((await call("DELETE", `/datasets/${datasetId}/items/${added.json.item.id}`)).status, 204);
      assert.equal((await call("DELETE", `/datasets/${datasetId}`)).status, 204);
      assert.equal((await call("GET", `/datasets/${datasetId}`)).status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await pool.query("DELETE FROM events WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

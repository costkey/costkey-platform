import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { createIngestRuntimeConfigRouter } from "../privacy.js";
import { invalidateSummaries } from "../response-cache.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("SDK runtime config is served from cache until the project changes", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_config_${suffix}`;
  const projectId = `project_config_${suffix}`;
  const key = `key_config_${suffix}`;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Config',$2)", [orgId, `config-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Config',$2,$3)", [projectId, orgId, key]);
    await pool.query("INSERT INTO project_settings (project_id, capture_mode, body_capture_enabled) VALUES ($1, 'metadata', FALSE)", [projectId]);

    let queries = 0;
    const counted = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === "query") return (...args: unknown[]) => { queries += 1; return (target.query as (...a: unknown[]) => unknown)(...args); };
        return Reflect.get(target, prop, receiver);
      },
    });
    const app = express();
    app.use(createIngestRuntimeConfigRouter(counted));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/projects/${projectId}/config`;
    const get = async (authKey = key) => {
      const response = await fetch(url, { headers: { authorization: `Bearer ${authKey}` } });
      return { status: response.status, body: await response.json() as { capture?: { mode: string; bodyCaptureEnabled: boolean } } };
    };
    try {
      const wrong = await get("not-the-key");
      assert.equal(wrong.status, 401);
      const first = await get();
      assert.equal(first.status, 200, "a rejected key is not cached against the project");
      assert.equal(first.body.capture?.mode, "metadata");
      const afterFirst = queries;

      const together = await Promise.all([get(), get(), get()]);
      assert.ok(together.every((answer) => answer.status === 200));
      assert.equal(queries, afterFirst, "repeat requests are answered without the database");

      await pool.query("UPDATE project_settings SET capture_mode = 'text', body_capture_enabled = TRUE WHERE project_id = $1", [projectId]);
      assert.equal((await get()).body.capture?.mode, "metadata", "a cached answer stands until it expires or the project changes");
      invalidateSummaries(projectId);
      const changed = await get();
      assert.equal(changed.body.capture?.mode, "text");
      assert.equal(changed.body.capture?.bodyCaptureEnabled, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

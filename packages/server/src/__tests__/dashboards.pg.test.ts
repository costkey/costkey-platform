import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { cleanWidgets, createDashboardsRouter } from "../dashboards.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("dashboard widgets are checked one by one", () => {
  assert.deepEqual(cleanWidgets([{ id: "a", title: " Spend ", kind: "total", metric: "cost", period: "7d" }]), [
    { id: "a", title: "Spend", kind: "total", metric: "cost", period: "7d", width: "half" },
  ]);
  assert.equal(cleanWidgets([{ id: "b", kind: "breakdown", metric: "calls", groupBy: "model", period: "30d", width: "full" }])[0]!.groupBy, "model");
  assert.throws(() => cleanWidgets([{ kind: "pie", metric: "cost", period: "7d" }]), /kind must be one of/);
  assert.throws(() => cleanWidgets([{ kind: "breakdown", metric: "cost", period: "7d" }]), /groupBy must be one of/);
  assert.throws(() => cleanWidgets([{ kind: "breakdown", metric: "tokens", groupBy: "model", period: "7d" }]), /cost or calls/);
  assert.throws(() => cleanWidgets([{ id: "x", kind: "total", metric: "cost", period: "7d" }, { id: "x", kind: "total", metric: "calls", period: "7d" }]), /unique/);
  assert.throws(() => cleanWidgets(Array.from({ length: 25 }, () => ({ kind: "total", metric: "cost", period: "7d" }))), /at most 24/);
});

test("dashboards: create with a starter layout, edit, permissions and delete", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_dash_${suffix}`;
  const otherOrgId = `org_dash_other_${suffix}`;
  const projectId = `project_dash_${suffix}`;
  const userId = `user_dash_${suffix}`;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Dash',$2), ($3,'Other',$4)", [orgId, `dash-${suffix}`, otherOrgId, `dash-other-${suffix}`]);
    await pool.query("INSERT INTO users(id,email,name,password_hash,org_id,role) VALUES ($1,$2,'Owner','x',$3,'owner')", [userId, `dash-${suffix}@example.test`, orgId]);
    await pool.query("INSERT INTO users(id,email,name,password_hash,org_id,role) VALUES ($1,$2,'Owner','x',$3,'owner')", [`${userId}_o`, `dash-o-${suffix}@example.test`, otherOrgId]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Dash',$2,$3)", [projectId, orgId, `key_dash_${suffix}`]);
    await pool.query("INSERT INTO project_memberships (project_id, user_id) VALUES ($1, $2)", [projectId, userId]);

    let user: Record<string, unknown> = { id: userId, orgId, role: "developer" };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { user: unknown }).user = user; next(); });
    app.use(createDashboardsRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/projects/${projectId}/dashboards`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      const text = await response.text();
      return { status: response.status, json: text ? JSON.parse(text) as Record<string, any> : {} };
    };
    try {
      const created = await call("POST", "", { name: "Weekly review" });
      assert.equal(created.status, 201);
      const id = created.json.dashboard.id as string;
      assert.equal(created.json.dashboard.widgets.length, 5, "a new dashboard starts with a starter layout");

      const widgets = [{ id: "agent-cost", title: "Agent spend", kind: "breakdown", metric: "cost", groupBy: "feature", period: "7d", width: "full" }];
      const updated = await call("PUT", `/${id}`, { name: "Agents", widgets });
      assert.equal(updated.status, 200);
      assert.equal(updated.json.dashboard.name, "Agents");
      assert.deepEqual(updated.json.dashboard.widgets, widgets);
      assert.equal((await call("PUT", `/${id}`, { widgets: [{ kind: "nope" }] })).status, 400);
      assert.equal((await call("GET", "")).json.dashboards.length, 1);

      // Viewers can look but not change; other orgs can't see it.
      user = { id: userId, orgId, role: "viewer" };
      assert.equal((await call("GET", `/${id}`)).status, 200);
      assert.equal((await call("PUT", `/${id}`, { name: "x" })).status, 403);
      assert.equal((await call("POST", "", { name: "x" })).status, 403);
      user = { id: `${userId}_o`, orgId: otherOrgId, role: "owner" };
      assert.equal((await call("GET", `/${id}`)).status, 404);
      user = { id: userId, orgId, role: "developer" };

      assert.equal((await call("DELETE", `/${id}`)).status, 204);
      assert.equal((await call("GET", `/${id}`)).status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [[userId, `${userId}_o`]]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = ANY($1)", [[orgId, otherOrgId]]).catch(() => undefined);
    await pool.end();
  }
});

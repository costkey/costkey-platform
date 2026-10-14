import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import express from "express";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { createUsersRouter, loadUserDetail, loadUsers, type UserDetail, type UsersList } from "../users-api.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

const close = (actual: number | null | undefined, expected: number, label: string) =>
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

test("users: spend, usage, agents and workflows per end user", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_users_${suffix}`;
  const projectId = `project_users_${suffix}`;
  const app = express();
  app.use((req, _res, next) => { (req as any).user = { id: `owner-${suffix}`, orgId, role: "owner" }; next(); });
  app.use(createUsersRouter(pool));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Users',$2)", [orgId, `users-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Users',$2,$3)", [projectId, orgId, `key_${suffix}`]);

    // A three-day window in the past, UTC.
    const day = (date: number, hour: number) => new Date(Date.UTC(2026, 9, date, hour, 0, 0)).toISOString();
    const window = { from: day(8, 0), to: day(11, 0), environment: null };
    const alice = "3f2a9c1e-7b4d-4c2a-9e1f-5d6a8b0ce81b";
    const bob = "team/bob";
    const call = (id: string, trace: string, traceName: string, when: string, opts: { provider?: string; model?: string; cost: number | null; tokens?: [number | null, number | null]; units?: Record<string, number>; status?: number; span?: string; context: Record<string, unknown> }) => pool.query(
      `INSERT INTO events (id, project_id, timestamp, provider, model, cost_usd, duration_ms, status_code, trace_id, trace_name, span_id,
                           input_tokens, output_tokens, native_units, context)
       VALUES ($1,$2,$3,$4,$5,$6,500,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, projectId, when, opts.provider ?? "openai", opts.model ?? "gpt-6-sol", opts.cost, opts.status ?? 200, trace, traceName, opts.span ?? null,
        ...(opts.tokens ?? [null, null]), opts.units ? JSON.stringify(opts.units) : null, JSON.stringify(opts.context)],
    );
    // Alice: an agent run (day 8) and a text-to-speech workflow billed in characters (day 10).
    await pool.query(
      `INSERT INTO spans (id, project_id, trace_id, parent_span_id, kind, name, status, started_at, ended_at)
       VALUES ('a1',$1,'t1',NULL,'agent','dash','ok',$2,$3)`,
      [projectId, day(8, 10), new Date(Date.parse(day(8, 10)) + 4_000).toISOString()],
    );
    await call("c1", "t1", "dash", day(8, 10), { cost: 0.02, tokens: [1_000, 200], span: "a1", context: { customer: alice } });
    await call("c2", "t1", "dash", day(8, 10), { cost: 0.01, tokens: [500, 100], span: "a1", context: { customer: alice } });
    await call("tts", "t2", "synthesize", day(10, 9), { provider: "elevenlabs", model: "eleven_multilingual_v2", cost: 0.163, units: { characters: 907 }, context: { customer: alice } });
    // Bob, sent as userId: a workflow run and a failed run (day 9).
    await call("w1", "t3", "POST /api/search", day(9, 12), { cost: 0.004, tokens: [300, 50], context: { userId: bob } });
    await call("w2", "t5", "POST /api/search", day(9, 13), { cost: 0.001, tokens: [100, 0], status: 500, context: { userId: bob } });
    // A run with no user.
    await call("anon", "t4", "POST /api/search", day(9, 14), { cost: 0.005, tokens: [100, 10], context: {} });
    // Outside the window.
    await call("old", "t6", "dash", day(1, 10), { cost: 1, tokens: [1, 1], context: { customer: alice } });

    const list = await loadUsers(pool, projectId, window);
    assert.deepEqual(list.users.map((user) => user.userId), [alice, bob], "sorted by spend");
    const [a, b] = list.users;
    assert.equal(a.runs, 2);
    assert.equal(a.calls, 3);
    close(a.cost, 0.193, "alice spend");
    assert.deepEqual(a.units, { characters: 907 });
    assert.equal(a.usage.inputTokens, 1_500);
    assert.equal(a.usage.outputTokens, 300);
    assert.deepEqual(a.agents, ["synthesize", "dash"], "agents and workflows by spend");
    assert.equal(a.lastRun, day(10, 9));
    assert.equal(b.runs, 2);
    assert.deepEqual(b.agents, ["POST /api/search"]);
    assert.deepEqual(b.units, {});
    assert.equal(list.totals.runs, 5);
    assert.equal(list.totals.runsWithoutUser, 1);
    close(list.totals.cost, 0.203, "total spend");

    const filtered = await loadUsers(pool, projectId, window, "BOB");
    assert.deepEqual(filtered.users.map((user) => user.userId), [bob], "q matches part of the id, any case");
    assert.equal(filtered.totals.runsWithoutUser, 1, "totals cover the whole window");
    const none = await loadUsers(pool, projectId, window, "nobody");
    assert.deepEqual(none.users, []);
    assert.equal(none.totals.runs, 5, "totals come back with no matching user");

    const detail = await loadUserDetail(pool, projectId, alice, window, "UTC");
    assert.equal(detail.summary.runs, 2);
    assert.equal(detail.summary.calls, 3);
    assert.equal(detail.summary.failedRuns, 0);
    close(detail.summary.cost, 0.193, "detail spend");
    assert.deepEqual(detail.summary.units, { characters: 907 });
    assert.equal(detail.summary.firstRun, day(8, 10));
    assert.equal(detail.summary.lastRun, day(10, 9));
    assert.deepEqual(detail.series.map((point) => [point.bucket, point.runs]), [["2026-10-08T00:00", 1], ["2026-10-09T00:00", 0], ["2026-10-10T00:00", 1]], "every day, zero-filled");
    close(detail.series[0].cost, 0.03, "day 8 spend");
    assert.equal(detail.series[1].cost, 0);
    assert.deepEqual(detail.owners.map((owner) => [owner.kind, owner.name, owner.runs]), [["workflow", "synthesize", 1], ["agent", "dash", 1]]);
    const tts = detail.models.find((model) => model.model === "eleven_multilingual_v2");
    assert.equal(detail.models[0].model, "eleven_multilingual_v2", "models by spend");
    assert.equal(tts?.provider, "elevenlabs");
    assert.deepEqual(tts?.units, { characters: 907 });
    assert.equal(tts?.usage.inputTokens, null, "no tokens for a characters model");
    const gpt = detail.models.find((model) => model.model === "gpt-6-sol");
    assert.equal(gpt?.calls, 2);
    assert.equal(gpt?.usage.inputTokens, 1_500);
    assert.deepEqual(detail.runs.map((run) => [run.traceId, run.kind, run.name]), [["t2", "workflow", "synthesize"], ["t1", "agent", "dash"]]);
    assert.equal(detail.runs[1].durationMs, 4_000);
    assert.equal(detail.runs[1].retry.retried, false);

    const bobDetail = await loadUserDetail(pool, projectId, bob, window, "UTC");
    assert.equal(bobDetail.summary.failedRuns, 1);
    assert.equal(bobDetail.runs.filter((run) => run.failed).length, 1);

    const nobody = await loadUserDetail(pool, projectId, "nobody", window, "UTC");
    assert.equal(nobody.summary.runs, 0);
    assert.equal(nobody.series.length, 3);
    assert.deepEqual(nobody.runs, []);

    // Over HTTP, with an id that has a slash in it.
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const range = `from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`;
    const listResponse = await fetch(`${baseUrl}/api/v1/projects/${projectId}/users?${range}&q=bob`);
    assert.equal(listResponse.status, 200);
    assert.deepEqual((await listResponse.json() as UsersList).users.map((user) => user.userId), [bob]);
    const detailResponse = await fetch(`${baseUrl}/api/v1/projects/${projectId}/users/detail?user=${encodeURIComponent(bob)}&${range}`);
    assert.equal(detailResponse.status, 200);
    const body = await detailResponse.json() as UserDetail;
    assert.equal(body.userId, bob);
    assert.equal(body.summary.runs, 2);
    const missing = await fetch(`${baseUrl}/api/v1/projects/${projectId}/users/detail?${range}`);
    assert.equal(missing.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const table of ["spans", "events"]) await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

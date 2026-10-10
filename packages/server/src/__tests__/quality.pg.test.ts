import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase, shutdownDatabase } from "../db.js";
import { createIngestRouter } from "../ingest.js";
import { createQualityRouter, readQualityScope, readThreshold } from "../quality-api.js";
import { InvalidAccountingEventError, normalizeAccountingEvent } from "../accounting.js";
import { ensurePlatformSchema } from "../platform-storage.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("score events normalize, validate and keep the score origin", () => {
  const score = normalizeAccountingEvent({
    id: "sc_1", eventType: "score", timestamp: "2026-10-01T00:00:00.000Z", traceId: "tr_1",
    name: "faithfulness", value: 0.8, label: "pass", comment: "x".repeat(2_000), source: "judge",
  });
  assert.equal(score.eventType, "score");
  assert.equal(score.score?.name, "faithfulness");
  assert.equal(score.score?.source, "judge");
  assert.equal(score.score?.comment?.length, 1_000);
  assert.equal(normalizeAccountingEvent({ id: "sc_2", eventType: "score", spanId: "sp_1", name: "n", value: 1 }).spanId, "sp_1");
  const bad = [
    { id: "a", eventType: "score", name: "n", value: 1 },
    { id: "b", eventType: "score", traceId: "t", value: 1 },
    { id: "c", eventType: "score", traceId: "t", name: "n", value: "1" },
    { id: "d", eventType: "score", traceId: "t", name: "n", value: Number.NaN },
    { id: "e", eventType: "score", traceId: "t", name: "n".repeat(121), value: 1 },
    { id: "f", eventType: "score", traceId: "t", name: "n", value: 1, label: "l".repeat(61) },
  ];
  for (const event of bad) assert.throws(() => normalizeAccountingEvent(event), InvalidAccountingEventError);
});

test("quality scope and threshold params", () => {
  const scope = readQualityScope({ from: "2026-10-01", to: "2026-10-05", environment: "prod" });
  assert.deepEqual(scope.environments, ["prod"]);
  assert.equal(readQualityScope({ environment: "all" }).environments, null);
  assert.throws(() => readQualityScope({ from: "nope" }));
  assert.throws(() => readQualityScope({ from: "2026-10-05", to: "2026-10-01" }));
  assert.equal(readThreshold(undefined), null);
  assert.equal(readThreshold("0.7"), 0.7);
  assert.throws(() => readThreshold("high"));
});

async function post(baseUrl: string, key: string, events: unknown[]): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ sdkVersion: "0.6.0", events }),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

test("scores ingest beside spans and calls, and the quality API reads them", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_quality_${suffix}`;
  const projectId = `project_quality_${suffix}`;
  const key = `key_quality_${suffix}`;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    (req as any).user = { id: `owner-${suffix}`, orgId, role: "owner" };
    next();
  });
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,$2,$3)", [orgId, "Quality", `quality-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Quality',$2,$3)", [projectId, orgId, key]);
    await pool.query(
      `INSERT INTO project_settings(project_id, capture_mode, body_capture_enabled)
       VALUES ($1, 'metadata', false)
       ON CONFLICT (project_id) DO UPDATE SET capture_mode = 'metadata', body_capture_enabled = false`,
      [projectId],
    );
    app.use(createIngestRouter(pool));
    app.use(createQualityRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const now = Date.now();
      const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
      const call = (id: string, trace: string, span: string, extra: Record<string, unknown> = {}) => ({
        id, timestamp: iso(-60_000), durationMs: 1_000, provider: "openai", model: "gpt-4o", statusCode: 200,
        costUsd: 1, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        traceId: trace, spanId: span, context: { agent: "dash", environment: "prod" }, ...extra,
      });

      const batch = await post(baseUrl, key, [
        // Run A passes, run B fails; run B's first call failed and was retried.
        { id: `agentA_${suffix}`, eventType: "span", kind: "agent", name: "dash", traceId: `trA_${suffix}`, startedAt: iso(-90_000), endedAt: iso(-30_000), status: "ok", timestamp: iso(-90_000), context: { environment: "prod" } },
        { id: `agentB_${suffix}`, eventType: "span", kind: "agent", name: "dash", traceId: `trB_${suffix}`, startedAt: iso(-90_000), endedAt: iso(-30_000), status: "error", timestamp: iso(-90_000), context: { environment: "prod" } },
        { id: `toolB_${suffix}`, eventType: "span", kind: "tool", name: "search", traceId: `trB_${suffix}`, parentSpanId: `agentB_${suffix}`, startedAt: iso(-80_000), status: "ok", timestamp: iso(-80_000) },
        call(`callA_${suffix}`, `trA_${suffix}`, `agentA_${suffix}`, { streaming: true, streamTiming: { ttft: 200, tps: 10, streamDuration: 800, chunkCount: 4 } }),
        call(`callB1_${suffix}`, `trB_${suffix}`, `toolB_${suffix}`, { statusCode: 429, costUsd: 0.5 }),
        call(`callB2_${suffix}`, `trB_${suffix}`, `toolB_${suffix}`, { parentEventId: `callB1_${suffix}`, costUsd: 2 }),
        { id: `scA_${suffix}`, eventType: "score", timestamp: iso(-20_000), traceId: `trA_${suffix}`, name: "faithfulness", value: 0.9, label: "pass", comment: "grounded", source: "judge" },
        // Span-only score: takes the span's trace.
        { id: `scB_${suffix}`, eventType: "score", timestamp: iso(-20_000), spanId: `toolB_${suffix}`, name: "faithfulness", value: 0.2, source: "code" },
        { id: `scBad_${suffix}`, eventType: "score", timestamp: iso(-20_000), name: "faithfulness", value: 1 },
        { id: `scNaN_${suffix}`, eventType: "score", timestamp: iso(-20_000), traceId: `trA_${suffix}`, name: "faithfulness", value: "high" },
      ]);
      assert.equal(batch.status, 202);
      assert.equal(batch.json["accepted"], 8);
      const rejected = batch.json["rejected"] as Array<{ index: number; code: string }>;
      assert.deepEqual(rejected.map((item) => [item.index, item.code]), [[8, "invalid_accounting_event"], [9, "invalid_accounting_event"]]);

      const stored = await pool.query(
        "SELECT id, trace_id, span_id, name, value, label, comment, source FROM scores WHERE project_id = $1 ORDER BY id",
        [projectId],
      );
      assert.equal(stored.rowCount, 2);
      const [scoreA, scoreB] = stored.rows as Array<Record<string, unknown>>;
      assert.equal(scoreA.comment, null, "metadata-only projects drop score comments");
      assert.equal(scoreA.source, "judge");
      assert.equal(scoreB.trace_id, `trB_${suffix}`);
      assert.equal(scoreB.source, "code");
      const events = await pool.query("SELECT COUNT(*)::int AS n FROM events WHERE project_id = $1 AND id LIKE 'sc%'", [projectId]);
      assert.equal(events.rows[0].n, 0, "scores never become billable events");

      // Re-grading upserts by id.
      const regrade = await post(baseUrl, key, [
        { id: `scA_${suffix}`, eventType: "score", timestamp: iso(-10_000), traceId: `trA_${suffix}`, name: "faithfulness", value: 0.95, label: "pass", source: "human" },
      ]);
      assert.equal(regrade.status, 202);
      const regraded = await pool.query("SELECT value, source FROM scores WHERE project_id = $1 AND id = $2", [projectId, `scA_${suffix}`]);
      assert.equal(regraded.rows[0].value, 0.95);
      assert.equal(regraded.rows[0].source, "human");

      const range = `from=${encodeURIComponent(iso(-3_600_000))}&to=${encodeURIComponent(iso(60_000))}`;
      const scoresResponse = await fetch(`${baseUrl}/api/v1/projects/${projectId}/quality/scores?${range}`);
      assert.equal(scoresResponse.status, 200);
      const scoresBody = await scoresResponse.json() as { scores: Array<Record<string, any>> };
      assert.equal(scoresBody.scores.length, 1);
      const faithfulness = scoresBody.scores[0];
      assert.equal(faithfulness.name, "faithfulness");
      assert.equal(faithfulness.count, 2);
      assert.ok(Math.abs(faithfulness.avg - 0.575) < 1e-9);
      assert.equal(faithfulness.threshold, 0.5);
      assert.equal(faithfulness.passRate, 0.5);
      assert.equal(faithfulness.latest.value, 0.95);
      assert.equal(faithfulness.trend.length, 1);
      assert.deepEqual(faithfulness.byRun.map((row: Record<string, unknown>) => [row.name, row.count]), [["dash", 2]]);
      assert.equal(faithfulness.scoredRuns, 2);
      assert.equal(faithfulness.passingRuns, 1);
      // The server prices calls itself; compare against what it stored.
      const priced = await pool.query("SELECT id, cost_usd FROM events WHERE project_id = $1", [projectId]);
      const costOf = new Map((priced.rows as Array<{ id: string; cost_usd: number }>).map((row) => [row.id, Number(row.cost_usd)]));
      const runCost = costOf.get(`callA_${suffix}`)! + costOf.get(`callB1_${suffix}`)! + costOf.get(`callB2_${suffix}`)!;
      assert.ok(runCost > 0);
      assert.ok(Math.abs(faithfulness.scoredCost - runCost) < 1e-12);
      assert.ok(Math.abs(faithfulness.costPerPassingRun - runCost) < 1e-12);

      const strict = await fetch(`${baseUrl}/api/v1/projects/${projectId}/quality/scores?${range}&threshold=0.99`);
      const strictBody = await strict.json() as { scores: Array<Record<string, any>> };
      assert.equal(strictBody.scores[0].passingRuns, 1, "label pass wins over the threshold");

      const staging = await fetch(`${baseUrl}/api/v1/projects/${projectId}/quality/scores?${range}&environment=staging`);
      assert.deepEqual((await staging.json() as { scores: unknown[] }).scores, []);
      const badRange = await fetch(`${baseUrl}/api/v1/projects/${projectId}/quality/scores?from=nope`);
      assert.equal(badRange.status, 400);

      const reliabilityResponse = await fetch(`${baseUrl}/api/v1/projects/${projectId}/quality/reliability?${range}`);
      assert.equal(reliabilityResponse.status, 200);
      const reliability = await reliabilityResponse.json() as Record<string, any>;
      assert.equal(reliability.totals.calls, 3);
      assert.equal(reliability.totals.errors, 1);
      assert.equal(reliability.totals.retries, 1);
      assert.ok(Math.abs(reliability.totals.wastedCost - costOf.get(`callB1_${suffix}`)!) < 1e-12, "the failed attempt that was retried");
      const model = reliability.byModel[0];
      assert.equal(model.model, "gpt-4o");
      assert.equal(model.p50DurationMs, 1_000);
      assert.equal(model.p95TtftMs, 200);
      assert.ok(Math.abs(model.errorRate - 1 / 3) < 1e-9);
      const agent = reliability.byAgent[0];
      assert.equal(agent.agent, "dash");
      assert.equal(agent.runs, 2);
      assert.equal(agent.failedRuns, 1);

      const otherOrg = await fetch(`${baseUrl}/api/v1/projects/project_missing_${suffix}/quality/reliability`);
      assert.equal(otherOrg.status, 404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    for (const table of ["scores", "spans", "events", "traces", "executions", "groups", "project_settings"]) {
      await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]).catch(() => undefined);
    }
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
    await shutdownDatabase();
  }
});

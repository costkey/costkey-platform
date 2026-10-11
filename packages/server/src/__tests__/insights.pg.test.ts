import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { boardBucket, GROUP_COLUMNS, loadOverviewBoard, previousWindow, RUNS_CTE } from "../insights-api.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("runs group into agents and workflows; a batch or eval is one workflow", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_insights_${suffix}`;
  const projectId = `project_insights_${suffix}`;
  try {
    await initDatabase();
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Insights',$2)", [orgId, `insights-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Insights',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const call = (id: string, trace: string, traceName: string, cost: number | null, extra: Record<string, unknown> = {}) => pool.query(
      `INSERT INTO events (id, project_id, timestamp, provider, model, cost_usd, duration_ms, status_code, trace_id, trace_name, span_id, parent_event_id, group_kind, group_name, context)
       VALUES ($1,$2,$3,'openai','gpt-6-sol',$4,500,$5,$6,$7,$8,$9,$10,$11,'{}'::jsonb)`,
      [id, projectId, at(Number(extra["minutesAgo"] ?? 10)), cost, extra["status"] ?? 200, trace, traceName, extra["spanId"] ?? null, extra["parent"] ?? null, extra["groupKind"] ?? null, extra["groupName"] ?? null],
    );
    const span = (id: string, trace: string, kind: string, name: string, parent: string | null, status = "ok") => pool.query(
      `INSERT INTO spans (id, project_id, trace_id, parent_span_id, kind, name, status, started_at, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, projectId, trace, parent, kind, name, status, at(11), at(9)],
    );
    // Two agent runs with a tool and a step; one fails in a tool.
    await span("a1", "t1", "agent", "dash", null);
    await span("s1", "t1", "step", "step", "a1");
    await span("tool1", "t1", "tool", "search", "s1");
    await call("c1", "t1", "dash", 0.02, { spanId: "a1" });
    await call("c2", "t1", "dash", 0.01, { spanId: "tool1" });
    await span("a2", "t2", "agent", "dash", null);
    await span("tool2", "t2", "tool", "search", "a2", "error");
    await call("c3", "t2", "dash", 0.03, { spanId: "a2" });
    // A named workflow, a batch of three items, and an evaluation.
    await call("w1", "t3", "POST /api/search", 0.004);
    await call("w2", "t4", "POST /api/search", 0.006, { status: 429 });
    await call("w3", "t4", "POST /api/search", 0.006, { parent: "w2" });
    for (const item of [5, 6, 7]) await call(`b${item}`, `t${item}`, `import item ${item}`, 0.001, { groupKind: "batch", groupName: "nightly-import" });
    await call("e1", "t8", "eval case 1", 0.002, { groupKind: "evaluation", groupName: "search-quality" });

    const params = [projectId, at(60), new Date(Date.now() + 60_000).toISOString(), null];
    const agents = await pool.query(`WITH ${RUNS_CTE} SELECT root_name AS name, ${GROUP_COLUMNS} FROM run_rows WHERE root_kind = 'agent' GROUP BY root_name`, params);
    assert.equal(agents.rows.length, 1);
    assert.equal(agents.rows[0].name, "dash");
    assert.equal(agents.rows[0].runs, 2);
    assert.ok(Math.abs(Number(agents.rows[0].cost) - 0.06) < 1e-9, "a run's cost is the whole run, tools included");
    assert.equal(agents.rows[0].failed_runs, 1);
    // 2 runs, 1 failed: the one success carries the whole $0.06.
    assert.ok(Math.abs(Number(agents.rows[0].cost_per_success) - 0.06) < 1e-9, "a success costs all spend over successful runs");
    assert.equal(Number(agents.rows[0].avg_tools), 1);

    const workflows = await pool.query(
      `WITH ${RUNS_CTE}
       SELECT COALESCE(CASE WHEN root_kind = 'workflow' THEN root_name END, NULLIF(group_name, ''), NULLIF(trace_name, ''), root_name, 'Unnamed') AS name, ${GROUP_COLUMNS}
       FROM run_rows WHERE root_kind IS DISTINCT FROM 'agent'
       GROUP BY 1 ORDER BY 1`,
      params,
    );
    assert.deepEqual(workflows.rows.map((row) => [row.name, row.runs, row.failed_runs]), [["POST /api/search", 2, 1], ["nightly-import", 3, 0], ["search-quality", 1, 0]]);
  } finally {
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

test("the board compares with the window of equal length before it", () => {
  assert.deepEqual(previousWindow("2026-10-08T00:00:00.000Z", "2026-10-11T00:00:00.000Z"), { from: "2026-10-05T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z" });
  assert.equal(boardBucket("2026-10-10T00:00:00.000Z", "2026-10-11T00:01:00.000Z"), "hour");
  assert.equal(boardBucket("2026-10-01T00:00:00.000Z", "2026-10-11T00:00:00.000Z"), "day");
});

test("the overview board reads runs, scores, model tokens, agents, tools and latency", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_board_${suffix}`;
  const projectId = `project_board_${suffix}`;
  try {
    await initDatabase();
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Board',$2)", [orgId, `board-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Board',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    const hour = 3_600_000;
    const to = new Date(Date.UTC(2026, 9, 11, 0, 0, 0));
    const from = new Date(to.getTime() - 24 * hour);
    const at = (hoursAfterFrom: number, extraMs = 0) => new Date(from.getTime() + hoursAfterFrom * hour + extraMs).toISOString();
    const call = (id: string, trace: string, when: string, span: string | null, tokens: [number, number, number | null, number | null], cost: number | null, environment = "prod") => pool.query(
      `INSERT INTO events (id, project_id, timestamp, provider, model, cost_usd, duration_ms, status_code, trace_id, trace_name,
                           span_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, context)
       VALUES ($1,$2,$3,'anthropic','claude-sonnet-5',$4,500,200,$5,$5,$6,$7,$8,$9,$10,$11)`,
      [id, projectId, when, cost, trace, span, ...tokens, JSON.stringify({ environment })],
    );
    const span = (id: string, trace: string, kind: string, name: string, parent: string | null, start: string, end: string) => pool.query(
      `INSERT INTO spans (id, project_id, trace_id, parent_span_id, kind, name, status, started_at, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,'ok',$7,$8)`,
      [id, projectId, trace, parent, kind, name, start, end],
    );
    const score = (id: string, trace: string | null, spanId: string | null, name: string, value: number, when: string) => pool.query(
      "INSERT INTO scores (project_id, id, trace_id, span_id, name, value, source, timestamp) VALUES ($1,$2,$3,$4,$5,$6,'judge',$7)",
      [projectId, id, trace, spanId, name, value, when],
    );
    // Two agent runs, 2s and 4s long, with one tool each.
    await span("a1", "t1", "agent", "support", null, at(2), at(2, 2_000));
    await span("tool1", "t1", "tool", "search_docs", "a1", at(2, 500), at(2, 1_500));
    await call("c1", "t1", at(2, 100), "a1", [1_000, 200, 400, 100], 0.01);
    await span("a2", "t2", "agent", "support", null, at(5), at(5, 4_000));
    await span("tool2", "t2", "tool", "search_docs", "a2", at(5, 500), at(5, 3_500));
    await call("c2", "t2", at(5, 100), "a2", [3_000, 600, null, null], 0.03);
    // One workflow run with no spans, and one in another environment.
    await call("w1", "t3", at(6), null, [500, 50, null, null], null);
    await call("w2", "t4", at(7), null, [500, 50, null, null], 0.5, "staging");
    // One run in the previous window.
    await call("old", "t0", new Date(from.getTime() - 2 * hour).toISOString(), null, [10, 10, null, null], 0.001);
    // Scores on 0..1, one sent with only a span id, and a 1..5 rating left out of the average.
    await score("s1", "t1", null, "faithfulness", 0.9, at(2, 3_000));
    await score("s2", null, "a2", "faithfulness", 0.5, at(5, 5_000));
    await score("s3", "t1", null, "rating", 4, at(2, 3_000));

    const board = await loadOverviewBoard(pool, projectId, { from: from.toISOString(), to: to.toISOString(), environment: "prod" }, "UTC");
    assert.equal(board.window.bucket, "hour");
    assert.equal(board.buckets.length, 24);
    assert.equal(board.buckets[0], "2026-10-10T00:00");
    assert.deepEqual(board.runs.current, { runs: 3, agentRuns: 2 });
    assert.deepEqual(board.runs.previous, { runs: 1, agentRuns: 0 });
    assert.ok(Math.abs((board.scores.current.avg ?? 0) - 0.7) < 1e-9, "only 0..1 checks go into the average");
    assert.equal(board.scores.current.count, 2);
    assert.equal(board.scores.current.allCount, 3);
    assert.equal(board.scores.previous.avg, null);
    const faithfulness = board.scores.checks.find((check) => check.name === "faithfulness");
    assert.deepEqual(faithfulness?.series.map((point) => [point.bucket, point.avg]), [["2026-10-10T02:00", 0.9], ["2026-10-10T05:00", 0.5]]);
    assert.equal(board.scores.checks.find((check) => check.name === "rating")?.unitScale, false);

    assert.equal(board.models.length, 1);
    assert.deepEqual(
      { calls: board.models[0].calls, input: board.models[0].input, output: board.models[0].output, cacheRead: board.models[0].cacheRead, cacheWrite: board.models[0].cacheWrite, unpriced: board.models[0].unpriced },
      { calls: 3, input: 4_500, output: 850, cacheRead: 400, cacheWrite: 100, unpriced: 1 },
    );
    assert.deepEqual(board.agents.map((agent) => [agent.name, agent.runs, agent.input, agent.output]), [["support", 2, 4_000, 800]]);
    assert.ok(Math.abs((board.agents[0].cost ?? 0) - 0.04) < 1e-9);
    assert.deepEqual(board.volume.agents, [{ name: "support", runs: 2, calls: 2 }]);
    assert.deepEqual(board.volume.workflows, [{ name: "t3", runs: 1, calls: 1 }]);
    assert.deepEqual(board.volume.tools, [{ name: "search_docs", runs: 2, calls: 2 }]);
    assert.equal(board.latency.agents.count, 2);
    assert.equal(board.latency.agents.p50Ms, 3_000);
    assert.deepEqual(board.latency.agents.series.map((point) => [point.bucket, point.p50Ms]), [["2026-10-10T02:00", 2_000], ["2026-10-10T05:00", 4_000]]);
    assert.equal(board.latency.tools.p95Ms, 2_900, "p95 of a 1s and a 3s tool call");
    assert.equal(board.latency.workflows.count, 1);
  } finally {
    for (const table of ["scores", "spans", "events"]) {
      await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]).catch(() => undefined);
    }
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

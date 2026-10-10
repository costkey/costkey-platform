import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { GROUP_COLUMNS, RUNS_CTE } from "../insights-api.js";

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

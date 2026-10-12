import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { GROUP_COLUMNS, RUNS_CTE, retryInfo } from "../insights-api.js";
import { loadRetries, resolveRetries } from "../retries.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("a failed attempt that a later attempt completed is retried, not failed", () => {
  const attempts = [
    { traceId: "a1", workId: "w1", startedAt: 1_000, state: "failed", errorType: "RetryableWorkError" },
    { traceId: "a2", workId: "w1", startedAt: 3_000, state: "completed", errorType: null },
    { traceId: "b1", workId: "w2", startedAt: 1_000, state: "failed", errorType: "RetryableWorkError" },
    { traceId: "c1", workId: "w3", startedAt: 1_000, state: "failed", errorType: "ValueError" },
  ];
  const retries = resolveRetries(["a1", "a2", "b1", "c1"], attempts);
  assert.deepEqual(retries.get("a1"), { workId: "w1", attempt: 1, attempts: 2, retried: true, succeededBy: "a2", succeededOnAttempt: 2, willRetry: false, errorType: "RetryableWorkError" });
  assert.equal(retries.get("a2")?.attempt, 2);
  assert.equal(retries.get("a2")?.retried, false);
  assert.equal(retries.get("b1")?.willRetry, true, "a retryable error with no later success yet will retry");
  assert.equal(retries.get("c1")?.willRetry, false);
});

test("runs, failure counts and the runs list group attempts of one work item", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_retry_${suffix}`;
  const projectId = `project_retry_${suffix}`;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Retry',$2)", [orgId, `retry-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Retry',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    const at = (seconds: number) => new Date(Date.now() - 600_000 + seconds * 1000).toISOString();
    const run = async (trace: string, workId: string, startSeconds: number, state: string, errorType: string | null) => {
      await pool.query(
        `INSERT INTO events (id, project_id, timestamp, provider, model, cost_usd, duration_ms, status_code, trace_id, trace_name, context)
         VALUES ($1,$2,$3,'openai','gpt-6-luna',0.01,500,200,$4,'credit-card-process-activity',$5)`,
        [`call_${trace}`, projectId, at(startSeconds), trace, JSON.stringify({ work_id: workId })],
      );
      await pool.query(
        `INSERT INTO traces (id, project_id, trace_name, state, error_type, started_at, ended_at, context)
         VALUES ($1,$2,'credit-card-process-activity',$3,$4,$5,$6,$7)`,
        [trace, projectId, state, errorType, at(startSeconds), at(startSeconds + 1), JSON.stringify({ work_id: workId })],
      );
    };
    // Work item 1 failed with a retryable error, then succeeded 2 s later.
    await run("t1", "w1", 0, "failed", "RetryableWorkError");
    await run("t2", "w1", 2, "completed", null);
    // Work item 2 failed for good.
    await run("t3", "w2", 10, "failed", "ValueError");

    const params = [projectId, at(-60), new Date(Date.now() + 60_000).toISOString(), null];
    const rows = await pool.query(`WITH ${RUNS_CTE} SELECT trace_id, failed, retried, retried_by, retried_on_attempt, attempt, work_id, error_type FROM run_rows ORDER BY trace_id`, params);
    const byTrace = new Map(rows.rows.map((row) => [row.trace_id, row]));
    assert.equal(byTrace.get("t1").retried, true);
    assert.equal(byTrace.get("t1").failed, false, "a retried attempt isn't a failure");
    assert.deepEqual(retryInfo(byTrace.get("t1")), { workId: "w1", attempt: 1, retried: true, succeededBy: "t2", succeededOnAttempt: 2, willRetry: false, errorType: "RetryableWorkError" });
    assert.equal(byTrace.get("t2").attempt, 2);
    assert.equal(byTrace.get("t3").failed, true);

    const groups = await pool.query(`WITH ${RUNS_CTE} SELECT ${GROUP_COLUMNS} FROM run_rows`, params);
    assert.equal(groups.rows[0].runs, 3);
    assert.equal(groups.rows[0].failed_runs, 1, "only the work item whose last attempt failed counts");
    assert.equal(groups.rows[0].retried_runs, 1);

    const retries = await loadRetries(pool, projectId, ["t1", "t3"]);
    assert.equal(retries.get("t1")?.succeededBy, "t2");
    assert.equal(retries.get("t3")?.retried, false);
  } finally {
    for (const table of ["events", "traces"]) await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

test("the runs list: zero-call runs cost nothing, failed calls aren't unpriced, retries are marked", { skip: !connectionString }, async () => {
  const { default: express } = await import("express");
  const { createAccountingRouter } = await import("../accounting-api.js");
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_runs_${suffix}`;
  const projectId = `project_runs_${suffix}`;
  const app = express();
  app.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: `owner-${suffix}`, orgId, role: "owner" }; next(); });
  app.use(createAccountingRouter(pool));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Runs',$2)", [orgId, `runs-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Runs',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    const at = (seconds: number) => new Date(Date.now() - 600_000 + seconds * 1000).toISOString();
    // A job that found nothing to do: a run with no model calls.
    await pool.query(
      `INSERT INTO traces (id, project_id, trace_name, state, started_at, ended_at) VALUES ('idle',$1,'credit-card-process-activity','completed',$2,$3)`,
      [projectId, at(0), at(0.01)],
    );
    // A run whose only unpriced call timed out.
    await pool.query(
      `INSERT INTO events (id, project_id, timestamp, provider, model, cost_usd, duration_ms, status_code, trace_id, trace_name, lifecycle_state, lifecycle_error_type, context)
       VALUES ('ok',$1,$2,'elevenlabs','eleven_multilingual_v2',0.159,4000,200,'tts','tts',NULL,NULL,'{}'::jsonb),
              ('timeout',$1,$3,'elevenlabs','eleven_multilingual_v2',NULL,10100,NULL,'tts','tts','failed','ReadTimeout','{}'::jsonb)`,
      [projectId, at(5), at(10)],
    );
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${projectId}/traces?from=${encodeURIComponent(at(-60))}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`);
    assert.equal(response.status, 200);
    const body = await response.json() as { traces: Array<Record<string, any>> };
    const idle = body.traces.find((trace) => trace.trace_id === "idle")!;
    assert.equal(idle.known_cost, 0, "a run with no model calls costs nothing");
    assert.equal(idle.accounting_state, "no_calls");
    assert.equal(idle.unpriced_count, 0);
    const tts = body.traces.find((trace) => trace.trace_id === "tts")!;
    assert.equal(tts.unpriced_count, 0, "a failed call without a price is no charge");
    assert.equal(tts.accounting_state, "complete");
    assert.ok(Math.abs(tts.known_cost - 0.159) < 1e-9);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const table of ["events", "traces"]) await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

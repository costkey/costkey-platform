import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { createDatasetsRouter } from "../datasets.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("eval runs against a dataset: list with pass rate and cost, and case by case", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_ev_${suffix}`;
  const projectId = `project_ev_${suffix}`;
  const executionId = `ex_${suffix}`;
  const click = (x: number, y: number) => JSON.stringify({ content: [{ type: "tool_use", input: { action: "left_click", coordinate: [x, y] } }] });
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Evals',$2)", [orgId, `ev-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Evals',$2,$3)", [projectId, orgId, `key_ev_${suffix}`]);
    await pool.query("INSERT INTO users(id,email,name,password_hash,org_id,role) VALUES ($1,$2,'Owner','x',$3,'owner')", [`user_ev_${suffix}`, `ev-${suffix}@example.test`, orgId]);
    const insertCall = (id: string, cost: number, fields: { execution?: string; caseId?: string; trace: string; body: string }) => pool.query(
      `INSERT INTO events (id, timestamp, project_id, provider, model, url, method, status_code, duration_ms, streaming,
                           trace_id, response_body, cost_usd, execution_id, case_id, event_type)
       VALUES ($1, NOW(), $2, 'anthropic', 'claude-haiku-4-5', 'https://api.anthropic.com/v1/messages', 'POST', 200, 100, FALSE,
               $3, $4, $5, $6, $7, 'call')`,
      [id, projectId, fields.trace, fields.body, cost, fields.execution ?? null, fields.caseId ?? null],
    );
    await insertCall(`src_a_${suffix}`, 0.02, { trace: "tr_src", body: click(100, 100) });
    await insertCall(`src_b_${suffix}`, 0.03, { trace: "tr_src", body: click(300, 300) });
    await pool.query("INSERT INTO datasets (id, project_id, name, revision) VALUES ($1, $2, 'clicks', 3)", [`ds_${suffix}`, projectId]);
    await pool.query(
      `INSERT INTO dataset_items (id, dataset_id, project_id, source_event_id, trace_id, label, output, created_at)
       VALUES ($1, $3, $4, $5, 'tr_src', 'Good', $7::jsonb, NOW() - INTERVAL '1 minute'),
              ($2, $3, $4, $6, 'tr_src', 'Bad', $8::jsonb, NOW())`,
      [`dsi_a_${suffix}`, `dsi_b_${suffix}`, `ds_${suffix}`, projectId, `src_a_${suffix}`, `src_b_${suffix}`, click(100, 100), click(300, 300)],
    );
    await pool.query(
      `INSERT INTO executions (id, project_id, name, kind, state, dataset_revision, configuration, started_at)
       VALUES ($1, $2, 'eval: clicks', 'evaluation', 'completed', $3, '{"model":"claude-haiku-4-5"}', NOW())`,
      [executionId, projectId, `ds_${suffix}@3`],
    );
    await insertCall(`cand_a_${suffix}`, 0.005, { execution: executionId, caseId: `dsi_a_${suffix}`, trace: "tr_cand_a", body: click(105, 98) });
    await insertCall(`cand_b_${suffix}`, 0.006, { execution: executionId, caseId: `dsi_b_${suffix}`, trace: "tr_cand_b", body: click(301, 300) });
    await pool.query(
      `INSERT INTO scores (project_id, id, trace_id, name, value, label, comment, source, timestamp)
       VALUES ($1, $2, 'tr_cand_a', 'eval: clicks', 1, 'pass', 'Matched the good action', 'code', NOW()),
              ($1, $3, 'tr_cand_b', 'eval: clicks', 0, 'fail', 'Repeated the bad action', 'code', NOW())`,
      [projectId, `eval_${executionId}_dsi_a_${suffix}`, `eval_${executionId}_dsi_b_${suffix}`],
    );

    const app = express();
    app.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: "u", orgId, role: "owner" }; next(); });
    app.use(createDatasetsRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/projects/${projectId}/datasets/ds_${suffix}`;
    try {
      const runs = await (await fetch(`${base}/evals`)).json() as { runs: Array<Record<string, unknown>> };
      assert.equal(runs.runs.length, 1);
      const [run] = runs.runs;
      assert.equal(run!.executionId, executionId);
      assert.deepEqual([run!.cases, run!.passed, run!.failed], [2, 1, 1]);
      assert.ok(Math.abs(Number(run!.cost) - 0.011) < 1e-9);
      assert.ok(Math.abs(Number(run!.originalCost) - 0.05) < 1e-9);
      assert.deepEqual(run!.configuration, { model: "claude-haiku-4-5" });

      // The dataset list carries the latest run's result for the Datasets page.
      const list = await (await fetch(base.replace(/\/ds_[^/]+$/, ""))).json() as { datasets: Array<Record<string, any>> };
      const listed = list.datasets.find((dataset) => dataset.id === `ds_${suffix}`)!;
      assert.equal(listed.evalRuns, 1);
      assert.deepEqual([listed.lastEval.executionId, listed.lastEval.passed, listed.lastEval.failed], [executionId, 1, 1]);
      assert.deepEqual(listed.lastEval.configuration, { model: "claude-haiku-4-5" });
      assert.ok(Array.isArray(listed.covers));

      const detail = await (await fetch(`${base}/evals/${executionId}`)).json() as { cases: Array<Record<string, any>> };
      assert.deepEqual(detail.cases.map((item) => [item.label, item.pass, item.reason]), [
        ["Good", true, "Matched the good action"],
        ["Bad", false, "Repeated the bad action"],
      ]);
      assert.equal(detail.cases[0]!.traceId, "tr_cand_a");
      assert.deepEqual(detail.cases[0]!.candidateOutput.content[0].input.coordinate, [105, 98]);
      assert.equal(detail.cases[1]!.originalCost, 0.03);
      assert.equal((await fetch(`${base}/evals/ex_missing`)).status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await pool.query("DELETE FROM scores WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM executions WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM events WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM users WHERE id = $1", [`user_ev_${suffix}`]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

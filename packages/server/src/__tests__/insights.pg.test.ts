import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import express from "express";
import { boardBucket, createInsightsRouter, GROUP_COLUMNS, loadOverviewBoard, previousWindow, RUNS_CTE } from "../insights-api.js";
import { getPriceCatalog, PriceCatalog, setPriceCatalog } from "../price-catalog/catalog.js";
import { costFromRates } from "../price-catalog/compute.js";
import { computeCost } from "../pricing.js";
import { callCacheSavings, sumCacheSavings, type TokenUsage } from "../token-usage.js";

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

test("agents and models report cache reads, hit rate, reasoning and checked cache savings", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_cache_${suffix}`;
  const projectId = `project_cache_${suffix}`;
  const previousCatalog = getPriceCatalog();
  const gpt = { id: `price_gpt_${suffix}`, source: "litellm" as const, provider: "openai", model: "gpt-4o", sourceKey: "gpt-4o", mode: "chat", effectiveFrom: "2020-01-01T00:00:00.000Z", effectiveTo: null, rates: { input: 2.5e-6, output: 1e-5, cacheRead: 1.25e-6 } };
  setPriceCatalog(new PriceCatalog([gpt]));
  const app = express();
  app.use((req, _res, next) => { (req as any).user = { id: `owner-${suffix}`, orgId, role: "owner" }; next(); });
  app.use(createInsightsRouter(pool));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Cache',$2)", [orgId, `cache-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Cache',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const span = (id: string, trace: string) => pool.query(
      `INSERT INTO spans (id, project_id, trace_id, parent_span_id, kind, name, status, started_at, ended_at)
       VALUES ($1,$2,$3,NULL,'agent','dash','ok',$4,$5)`,
      [id, projectId, trace, at(12), at(8)],
    );
    const call = (id: string, trace: string, provider: string, model: string, tokens: { input: number; output: number; cacheRead?: number | null; cacheWrite?: number | null; reasoning?: number | null }, price: { cost: number | null; basis: string; source: string | null; pricingId?: string | null }) => pool.query(
      `INSERT INTO events (id, project_id, timestamp, provider, model, cost_usd, cost_basis, cost_source, pricing_id, duration_ms, status_code,
                           trace_id, trace_name, span_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,500,200,$10,'dash',$11,$12,$13,$14,$15,$16,'{}'::jsonb)`,
      [id, projectId, at(10), provider, model, price.cost, price.basis, price.source, price.pricingId ?? null, trace, `a_${trace}`,
        tokens.input, tokens.output, tokens.cacheRead ?? null, tokens.cacheWrite ?? null, tokens.reasoning ?? null],
    );
    const claude = "claude-sonnet-4-5-20250929";
    await span("a_t1", "t1");
    // Anthropic: cache reads and writes sit beside the input count.
    await call("c1", "t1", "anthropic", claude, { input: 1_000, output: 200, cacheRead: 3_000, cacheWrite: 500 },
      { cost: computeCost(claude, 1_000, 200, 3_000, 500, "anthropic"), basis: "estimated", source: "pricing_table" });
    // OpenAI: cached tokens are part of the input count; reasoning is part of output.
    await call("c2", "t1", "openai", "gpt-4o", { input: 2_000, output: 300, cacheRead: 1_000, reasoning: 100 },
      { cost: costFromRates(gpt.rates, { inputTokens: 2_000, outputTokens: 300, cacheReadTokens: 1_000 }, "openai", "gpt-4o"), basis: "estimated", source: "catalog:litellm", pricingId: gpt.id });
    await span("a_t2", "t2");
    // Gemini reports thinking beside output, and no cache field at all.
    await call("c3", "t2", "google", "gemini-2.5-flash", { input: 500, output: 100, reasoning: 50 }, { cost: 0.001, basis: "estimated", source: "pricing_table" });

    const range = `from=${encodeURIComponent(at(60))}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`;
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const detail = async () => {
      const response = await fetch(`${baseUrl}/api/v1/projects/${projectId}/agents/dash?${range}`);
      assert.equal(response.status, 200);
      return await response.json() as { agent: { usage: TokenUsage }; runs: Array<{ traceId: string; usage: TokenUsage }>; models: Array<{ model: string; usage: TokenUsage }> };
    };
    const close = (actual: number | null | undefined, expected: number, label: string) => assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

    let body = await detail();
    const usage = body.agent.usage;
    assert.equal(usage.inputTokens, 7_000, "input counts the whole prompt, Anthropic cache included");
    assert.equal(usage.cacheReadTokens, 4_000);
    assert.equal(usage.cacheWriteTokens, 500);
    close(usage.cacheHitRate, 4_000 / 7_000, "agent hit rate");
    assert.equal(usage.outputTokens, 650, "Gemini thinking adds to output; OpenAI reasoning is already in it");
    assert.equal(usage.reasoningTokens, 150);
    // Saved: 3,000 reads at $3 - $0.30 per 1M, and 1,000 at $2.50 - $1.25 per 1M.
    close(usage.cacheSavings, 3_000 * 2.7e-6 + 1_000 * 1.25e-6, "agent savings");

    const t1 = body.runs.find((run) => run.traceId === "t1")!.usage;
    const t2 = body.runs.find((run) => run.traceId === "t2")!.usage;
    assert.deepEqual([t1.inputTokens, t1.cacheReadTokens, t1.outputTokens, t1.reasoningTokens], [6_500, 4_000, 500, 100]);
    assert.equal(t2.cacheHitRate, null, "a run with no cache fields has no hit rate, not 0%");
    assert.equal(t2.cacheReadTokens, null);

    const byModel = new Map(body.models.map((model) => [model.model, model.usage]));
    close(byModel.get(claude)?.cacheHitRate, 3_000 / 4_500, "claude hit rate");
    close(byModel.get(claude)?.cacheSavings, 3_000 * 2.7e-6, "claude savings");
    close(byModel.get("gpt-4o")?.cacheHitRate, 0.5, "gpt-4o hit rate");
    close(byModel.get("gpt-4o")?.cacheSavings, 1_000 * 1.25e-6, "gpt-4o savings");
    assert.equal(byModel.get("gemini-2.5-flash")?.cacheHitRate, null);
    assert.equal(byModel.get("gemini-2.5-flash")?.cacheSavings, null);
    assert.equal(byModel.get("gemini-2.5-flash")?.reasoningTokens, 50);

    // A provider-reported price has no list-price counterfactual: that model's
    // savings, and the agent's total, are no longer shown.
    await span("a_t3", "t3");
    await call("c4", "t3", "anthropic", claude, { input: 100, output: 10, cacheRead: 900 }, { cost: 0.0005, basis: "reported", source: "provider" });
    body = await detail();
    assert.equal(body.agent.usage.cacheSavings, null);
    assert.equal(new Map(body.models.map((model) => [model.model, model.usage])).get(claude)?.cacheSavings, null);
    close(new Map(body.models.map((model) => [model.model, model.usage])).get("gpt-4o")?.cacheSavings, 1_000 * 1.25e-6, "gpt-4o savings unaffected");

    // The By model tab carries the same breakdown.
    const modelsResponse = await fetch(`${baseUrl}/api/v1/projects/${projectId}/insights/models?kind=agent&${range}`);
    const models = await modelsResponse.json() as { models: Array<{ model: string; usage: TokenUsage }> };
    const gptRow = models.models.find((model) => model.model === "gpt-4o")!;
    assert.deepEqual([gptRow.usage.inputTokens, gptRow.usage.cacheReadTokens, gptRow.usage.reasoningTokens], [2_000, 1_000, 100]);
    close(gptRow.usage.cacheSavings, 1_000 * 1.25e-6, "tab model savings");

    // Workflows and agents lists carry the totals too.
    const agentsResponse = await fetch(`${baseUrl}/api/v1/projects/${projectId}/agents?${range}`);
    const agents = await agentsResponse.json() as { agents: Array<{ name: string; usage: TokenUsage }> };
    assert.equal(agents.agents[0]?.usage.cacheReadTokens, 4_900);
  } finally {
    setPriceCatalog(previousCatalog);
    await new Promise((resolve) => server.close(resolve));
    for (const table of ["spans", "events"]) await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

test("a call's cache savings are only counted when its stored cost checks out", () => {
  const previousCatalog = getPriceCatalog();
  const rates = { input: 3e-6, output: 1.5e-5, cacheRead: 3e-7, cacheWrite: 3.75e-6, longContext: [{ threshold: 200_000, input: 6e-6, output: 2.25e-5, cacheRead: 6e-7 }] };
  setPriceCatalog(new PriceCatalog([{ id: "p1", source: "litellm", provider: "anthropic", model: "claude-x", sourceKey: "claude-x", mode: "chat", effectiveFrom: "2020-01-01T00:00:00.000Z", effectiveTo: null, rates }]));
  try {
    const base = { provider: "anthropic", model: "claude-x", cost_basis: "estimated", cost_source: "catalog:litellm", pricing_id: "p1", input_tokens: 1_000, output_tokens: 100, cache_read_tokens: 10_000 };
    const charged = costFromRates(rates, { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 10_000 }, "anthropic", "claude-x")!;
    assert.ok(Math.abs(callCacheSavings({ ...base, cost_usd: charged })! - 10_000 * 2.7e-6) < 1e-12);
    // Over the long-context threshold the tier's rates apply to both sides.
    const big = { ...base, input_tokens: 150_000, cache_read_tokens: 100_000 };
    const bigCharged = costFromRates(rates, { inputTokens: 150_000, outputTokens: 100, cacheReadTokens: 100_000 }, "anthropic", "claude-x")!;
    assert.ok(Math.abs(callCacheSavings({ ...big, cost_usd: bigCharged })! - 100_000 * 5.4e-6) < 1e-12);
    assert.equal(callCacheSavings({ ...base, cost_usd: charged * 1.1 }), null, "a cost the rates don't reproduce");
    assert.equal(callCacheSavings({ ...base, pricing_id: "gone", cost_usd: charged }), null, "a price version we no longer have");
    assert.equal(callCacheSavings({ ...base, cost_source: "project_price", cost_usd: charged }), null);
    assert.equal(callCacheSavings({ ...base, cost_basis: "reported", cost_usd: charged }), null);
    assert.equal(callCacheSavings({ ...base, cache_read_tokens: 0, cost_usd: charged }), 0, "no cache hits saved nothing");
    // The built-in table: OpenAI cached tokens are part of the input count.
    const openai = { provider: "openai", model: "gpt-4o", cost_basis: "estimated", cost_source: "pricing_table", input_tokens: 4_000, output_tokens: 100, cache_read_tokens: 2_000 };
    assert.ok(Math.abs(callCacheSavings({ ...openai, cost_usd: computeCost("gpt-4o", 4_000, 100, 2_000, null, "openai") })! - 2_000 * 1.25e-6) < 1e-12);
    const totals = sumCacheSavings([{ ...openai, cost_usd: computeCost("gpt-4o", 4_000, 100, 2_000, null, "openai") }, { ...base, cost_usd: charged }]);
    assert.ok(Math.abs(totals.total! - (2_000 * 1.25e-6 + 10_000 * 2.7e-6)) < 1e-12);
    assert.equal(sumCacheSavings([]).total, null, "no cache hits, nothing to show");
  } finally {
    setPriceCatalog(previousCatalog);
  }
});

test("a failed call without a price is no charge, not an unpriced call", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_failed_${suffix}`;
  const projectId = `project_failed_${suffix}`;
  try {
    await initDatabase();
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Failed',$2)", [orgId, `failed-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Failed',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    const call = (id: string, cost: number | null, lifecycle: string | null, errorType: string | null) => pool.query(
      `INSERT INTO events (id, project_id, timestamp, provider, model, cost_usd, duration_ms, status_code, trace_id, trace_name, lifecycle_state, lifecycle_error_type, context)
       VALUES ($1,$2,$3,'elevenlabs','eleven_multilingual_v2',$4,10100,NULL,'t1','tts',$5,$6,'{}'::jsonb)`,
      [id, projectId, at, cost, lifecycle, errorType],
    );
    await call("ok", 0.159, "completed", null);
    await call("timeout", null, "failed", "ReadTimeout");
    const params = [projectId, new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() + 60_000).toISOString(), null];
    const runs = await pool.query(`WITH ${RUNS_CTE} SELECT unpriced, cost FROM run_rows`, params);
    assert.equal(runs.rows[0].unpriced, 0);
    assert.ok(Math.abs(Number(runs.rows[0].cost) - 0.159) < 1e-9);
    const groups = await pool.query(`WITH ${RUNS_CTE} SELECT ${GROUP_COLUMNS} FROM run_rows`, params);
    assert.equal(groups.rows[0].partly_priced_runs, 0, "the run is fully priced");
  } finally {
    await pool.query("DELETE FROM events WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

test("the board lists every model whatever it bills, and its costs add up to the spend total", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_units_${suffix}`;
  const projectId = `project_units_${suffix}`;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Units',$2)", [orgId, `units-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Units',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const call = (id: string, trace: string, traceName: string, provider: string, model: string, cost: number, tokens: [number | null, number | null], units: Record<string, number> | null) => pool.query(
      `INSERT INTO events (id, project_id, timestamp, provider, model, cost_usd, duration_ms, status_code, trace_id, trace_name, input_tokens, output_tokens, native_units, context)
       VALUES ($1,$2,$3,$4,$5,$6,500,200,$7,$8,$9,$10,$11,'{}'::jsonb)`,
      [id, projectId, at(10), provider, model, cost, trace, traceName, ...tokens, units ? JSON.stringify(units) : null],
    );
    await call("llm", "t1", "summarize", "openai", "gpt-6-luna", 0.1665, [4_000, 300], null);
    // A text-to-speech workflow that bills only characters.
    await call("tts1", "t2", "generated-media-synthesize-next", "elevenlabs", "eleven_multilingual_v2", 0.159, [null, null], { characters: 1_791 });
    await call("tts2", "t3", "generated-media-synthesize-next", "elevenlabs", "eleven_multilingual_v2", 0.163, [null, null], { characters: 907 });

    const board = await loadOverviewBoard(pool, projectId, { from: at(60), to: new Date(Date.now() + 60_000).toISOString(), environment: null }, "UTC");
    const byModel = new Map(board.models.map((row) => [row.model, row]));
    assert.ok(byModel.has("gpt-6-luna"));
    const tts = byModel.get("eleven_multilingual_v2");
    assert.ok(tts, "a characters-billed model is listed");
    assert.equal(tts.provider, "elevenlabs");
    assert.equal(tts.input, null, "no token counts for a characters model");
    assert.deepEqual(tts.units, { characters: 2_698 });
    const total = board.models.reduce((sum, row) => sum + (row.cost ?? 0), 0);
    const charges = await pool.query("SELECT SUM(cost_usd) AS cost FROM events WHERE project_id = $1", [projectId]);
    assert.ok(Math.abs(total - Number(charges.rows[0].cost)) < 1e-9, "model costs add up to the spend total");
    assert.deepEqual(board.units.current, { characters: 2_698 });
    const workflow = board.workflows.find((row) => row.name === "generated-media-synthesize-next");
    assert.equal(workflow?.runs, 2, "a characters-only workflow still appears in usage");
    assert.deepEqual(workflow?.units, { characters: 2_698 });
  } finally {
    await pool.query("DELETE FROM events WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

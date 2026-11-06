/**
 * The Overview board on a large synthetic project, through the real endpoint.
 *
 *   BOARD_BENCH_DATABASE_URL=postgres://localhost/costkey_board_bench \
 *     npx tsx packages/server/scripts/board-benchmark.ts seed
 *   BOARD_BENCH_DATABASE_URL=... npx tsx packages/server/scripts/board-benchmark.ts run
 *
 * `seed` builds BOARD_BENCH_CALLS calls (default 1.2M) over 60 days, half in the
 * console's 30-day window and half in the window before it, with spans, runs,
 * retries, scores, billed units and usage components. It writes to the database
 * it is given: point it only at a throwaway one.
 */
import express from "express";
import pg from "pg";

const url = process.env["BOARD_BENCH_DATABASE_URL"];
if (!url) throw new Error("Set BOARD_BENCH_DATABASE_URL to a throwaway database");
process.env["DATABASE_URL"] = url;
process.env["NODE_ENV"] ??= "test"; // The router needs no sign-in secret here: requests carry a stub user.

const PROJECT = "project_board_bench";
const ORG = "org_board_bench";
const CALLS = Number(process.env["BOARD_BENCH_CALLS"] ?? 1_200_000);
const DAYS = 60;

const pool = new pg.Pool({ connectionString: url, max: 10 });
pool.on("connect", (client) => { client.query("SET work_mem = '16MB'").catch(() => undefined); });

async function seed(): Promise<void> {
  const { initDatabase } = await import("../src/db.js");
  const { ensurePlatformSchema } = await import("../src/platform-storage.js");
  await initDatabase();
  await ensurePlatformSchema(pool);
  await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Board bench','board-bench') ON CONFLICT DO NOTHING", [ORG]);
  await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Board bench',$2,'key_board_bench') ON CONFLICT DO NOTHING", [PROJECT, ORG]);
  for (const table of ["scores", "spans", "traces", "usage_components", "events"]) {
    await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [PROJECT]);
  }
  const runs = Math.floor(CALLS / 3);
  const started = Date.now();
  const step = async (label: string, sql: string) => {
    const at = Date.now();
    const result = await pool.query(sql);
    console.log(`  ${label}: ${result.rowCount} rows in ${((Date.now() - at) / 1000).toFixed(1)}s`);
  };
  // One row per run: its time, shape and work item. Everything else derives from it.
  await pool.query("DROP TABLE IF EXISTS board_bench_runs");
  await step("runs", `
    CREATE UNLOGGED TABLE board_bench_runs AS
    SELECT n,
           'run_' || n AS trace_id,
           NOW() - (random() * ${DAYS}) * INTERVAL '1 day' AS started_at,
           (random() * 6000)::int + 200 AS duration_ms,
           CASE WHEN n % 5 < 2 THEN 'agent' WHEN n % 5 < 4 THEN 'workflow' ELSE 'none' END AS shape,
           'name_' || (n % 25) AS name,
           CASE WHEN n % 20 = 0 THEN 'work_' || (n / 60) END AS work_id,
           random() < 0.04 AS failed
    FROM generate_series(1, ${runs}) n`);
  await pool.query("CREATE INDEX ON board_bench_runs (n)");
  await step("events", `
    INSERT INTO events (id, project_id, timestamp, provider, model, request_model, url, method, status_code, input_tokens, output_tokens,
                        reasoning_tokens, cache_read_tokens, cache_creation_tokens, total_tokens, cost_usd, duration_ms, trace_id, trace_name, span_id,
                        lifecycle_state, native_units, context, release, event_type, cost_basis, cost_source, charge_id, call_site_raw, request_body)
    SELECT 'call_' || r.n || '_' || c,
           '${PROJECT}', r.started_at + c * INTERVAL '150 milliseconds',
           (ARRAY['openai','anthropic','google','mistral','elevenlabs'])[1 + r.n % 5],
           'model-' || (r.n % 18), 'model-' || (r.n % 18),
           'https://api.example.com/v1/chat/completions', 'POST',
           CASE WHEN r.failed AND c = 2 THEN 500 ELSE 200 END,
           500 + r.n % 3000, 50 + r.n % 700, r.n % 90, CASE WHEN r.n % 3 = 0 THEN 200 END, CASE WHEN r.n % 7 = 0 THEN 30 END, 550 + r.n % 3700,
           CASE WHEN r.n % 50 = 0 OR (r.failed AND c = 2) THEN NULL ELSE 0.0001 * (1 + r.n % 400) END,
           100 + r.n % 2000, r.trace_id, r.name,
           CASE WHEN r.shape <> 'none' THEN r.trace_id || '_root' END,
           CASE WHEN r.failed AND c = 2 THEN 'failed' END,
           CASE WHEN r.n % 40 = 0 THEN jsonb_build_object('characters', 100 + r.n % 900) END,
           jsonb_build_object('environment', (ARRAY['production','staging'])[1 + r.n % 2], 'feature', 'feature-' || (r.n % 40),
                              'customer', 'customer-' || (r.n % 300), 'service', 'svc-' || (r.n % 6), 'release', 'rel-' || (r.n % 12),
                              'userId', 'user-' || (r.n % 900), 'request_note', repeat('x', 120))
             || CASE WHEN r.work_id IS NOT NULL THEN jsonb_build_object('work_id', r.work_id) ELSE '{}'::jsonb END,
           'rel-' || (r.n % 12), 'call', 'estimated', 'catalog', NULL,
           'at app/agents/' || (r.n % 40) || '.ts:' || (r.n % 200),
           jsonb_build_object('messages', jsonb_build_array(jsonb_build_object('role', 'user', 'content', repeat('hello ', 60))))
    FROM board_bench_runs r CROSS JOIN generate_series(1, 3) c`);
  await step("root spans", `
    INSERT INTO spans (id, project_id, trace_id, parent_span_id, kind, name, status, started_at, ended_at, context, attributes)
    SELECT r.trace_id || '_root', '${PROJECT}', r.trace_id, NULL, r.shape, r.name,
           CASE WHEN r.failed THEN 'error' ELSE 'ok' END, r.started_at, r.started_at + r.duration_ms * INTERVAL '1 millisecond',
           jsonb_build_object('environment', (ARRAY['production','staging'])[1 + r.n % 2]), '{"a":1}'::jsonb
    FROM board_bench_runs r WHERE r.shape <> 'none'`);
  await step("step and tool spans", `
    INSERT INTO spans (id, project_id, trace_id, parent_span_id, kind, name, status, started_at, ended_at, context, attributes)
    SELECT r.trace_id || '_' || s, '${PROJECT}', r.trace_id, r.trace_id || '_root',
           CASE WHEN s = 1 THEN 'step' ELSE 'tool' END,
           CASE WHEN s = 1 THEN 'plan' ELSE 'tool_' || ((r.n + s) % 15) END, 'ok',
           r.started_at + s * INTERVAL '10 milliseconds', r.started_at + s * INTERVAL '10 milliseconds' + (r.n % 900) * INTERVAL '1 millisecond',
           '{}'::jsonb, '{"a":1}'::jsonb
    FROM board_bench_runs r CROSS JOIN generate_series(1, 3) s WHERE r.shape <> 'none'`);
  await step("traces", `
    INSERT INTO traces (id, project_id, trace_name, state, error_type, started_at, ended_at, context)
    SELECT r.trace_id, '${PROJECT}', r.name, CASE WHEN r.failed THEN 'failed' ELSE 'completed' END, CASE WHEN r.failed THEN 'RetryableError' END,
           r.started_at, r.started_at + r.duration_ms * INTERVAL '1 millisecond',
           CASE WHEN r.work_id IS NOT NULL THEN jsonb_build_object('work_id', r.work_id) ELSE '{}'::jsonb END
    FROM board_bench_runs r WHERE r.shape <> 'none'`);
  await step("scores", `
    INSERT INTO scores (project_id, id, trace_id, name, value, source, timestamp)
    SELECT '${PROJECT}', 'score_' || r.n || '_' || s, r.trace_id, (ARRAY['faithfulness','relevance','tone','rating'])[s],
           CASE WHEN s = 4 THEN 1 + (r.n % 5) ELSE random() END, 'judge', r.started_at + INTERVAL '30 seconds'
    FROM board_bench_runs r CROSS JOIN generate_series(1, 4) s WHERE r.n % 6 = 0`);
  await step("usage components", `
    INSERT INTO usage_components (id, project_id, charge_id, component_id, context, trace_id, component, provider, model, unit_kind, unit_value, unit, amount, currency, amount_kind, aggregation, revision, payload_hash, active, accounting_at, observed_at)
    SELECT 'usage_' || r.n, '${PROJECT}', 'charge_' || r.n, 'component', '{}'::jsonb, r.trace_id, 'search', 'tavily', 'search', 'requests', 1, 'requests', 0.01, 'USD', 'reported', 'delta', 1, md5(r.n::text), TRUE, r.started_at, r.started_at
    FROM board_bench_runs r WHERE r.n % 10000 = 0`);
  await pool.query("DROP TABLE board_bench_runs");
  await pool.query("ANALYZE events; ANALYZE spans; ANALYZE traces; ANALYZE scores; ANALYZE usage_components");
  console.log(`Seeded in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

async function run(): Promise<void> {
  const { boardWindowAt, ensureBoardSnapshotSchema, refreshDueBoards } = await import("../src/board-snapshots.js");
  const { withMigrationLock } = await import("../src/db.js");
  const { boardSource, createInsightsRouter, loadOverviewBoard } = await import("../src/insights-api.js");
  await withMigrationLock(pool, (client) => ensureBoardSnapshotSchema(client));
  const app = express();
  app.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: "bench", orgId: ORG, role: "owner" }; next(); });
  app.use(createInsightsRouter(pool, { boardSnapshots: true }));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/projects/${PROJECT}/insights/board`;
  // Past this process's in-memory cache, as on an instance that just started.
  const request = async (window: { from: string; to: string }) => {
    const at = performance.now();
    const response = await fetch(`${base}?from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`, { headers: { "x-costkey-cache-refresh": "1" } });
    const body = await response.json() as { runs: { current: { runs: number } } };
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
    return { ms: performance.now() - at, runs: body.runs.current.runs, source: response.headers.get("x-costkey-board") ?? "computed" };
  };
  const clear = () => pool.query("DELETE FROM board_snapshots WHERE project_id = $1", [PROJECT]);
  const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  const rolling = (ms: number) => { const now = Date.now(); return { from: new Date(now - ms).toISOString(), to: new Date(now).toISOString() }; };
  const HOUR = 3_600_000;

  console.log("On demand, nothing stored:");
  for (const key of ["30d", "90d"]) {
    await clear();
    const { ms, runs, source } = await request(boardWindowAt(key, "UTC", new Date()));
    console.log(`  ${key}: ${seconds(ms)} (${source}, ${runs} runs)`);
  }
  console.log("Presets that stay on demand:");
  for (const [label, hours] of [["15m", 0.25], ["1h", 1], ["3h", 3], ["12h", 12]] as const) {
    const { ms, source } = await request(rolling(hours * HOUR));
    console.log(`  ${label}: ${seconds(ms)} (${source})`);
  }

  await clear();
  const jobAt = performance.now();
  const job = await refreshDueBoards(pool, boardSource, { seed: true, budgetMs: 60 * 60_000 });
  console.log(`The job: ${job.refreshed} boards in ${seconds(performance.now() - jobAt)}, ${job.failed} failed`);
  const stored = await pool.query("SELECT window_key, window_from, window_to, timezone, duration_ms, board, octet_length(board::text) AS bytes FROM board_snapshots WHERE project_id = $1 ORDER BY duration_ms DESC", [PROJECT]);
  for (const row of stored.rows) console.log(`  ${row.window_key}: ${seconds(Number(row.duration_ms))}, ${Math.round(row.bytes / 1024)} KB`);

  console.log("Read from the table, cold instance:");
  for (const key of ["30d", "90d", "mtd", "7d", "24h"]) {
    const samples: number[] = [];
    let source = "";
    for (let i = 0; i < 20; i++) {
      const answer = await request(boardWindowAt(key, "UTC", new Date()));
      samples.push(answer.ms);
      source = answer.source;
    }
    samples.sort((a, b) => a - b);
    console.log(`  ${key}: median ${samples[10]!.toFixed(1)} ms, worst ${samples[19]!.toFixed(1)} ms (${source})`);
  }

  console.log("Stored against on demand, same window and data:");
  const settled = (value: unknown) => JSON.stringify(JSON.parse(JSON.stringify(value), (_key, item) => typeof item === "number" ? Number(item.toPrecision(12)) : item));
  for (const row of stored.rows.filter((item) => ["30d", "90d"].includes(item.window_key))) {
    const onDemand = await loadOverviewBoard(pool, PROJECT, { from: row.window_from.toISOString(), to: row.window_to.toISOString(), environment: null, release: null }, row.timezone);
    console.log(`  ${row.window_key}: ${settled(row.board) === settled(onDemand) ? "identical" : "DIFFERENT"}`);
  }
  server.close();
}

try {
  const mode = process.argv[2];
  if (mode === "seed") await seed();
  else if (mode === "run") await run();
  else throw new Error("Usage: board-benchmark.ts seed|run");
} finally {
  await pool.end();
  const { getPool } = await import("../src/db.js");
  await getPool().end().catch(() => undefined);
}

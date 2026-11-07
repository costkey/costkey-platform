import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import pg from "pg";
import { initDatabase, withMigrationLock } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { BOARD_WINDOW_KEYS, boardWindowAt, ensureBoardSnapshotSchema, markBoardsStale, readBoardSnapshot, refreshDueBoards, standardBoardWindow, storeBoardSnapshot, type BoardSource } from "../board-snapshots.js";
import { boardSource, createInsightsRouter, loadOverviewBoard } from "../insights-api.js";
import { invalidateSummaries } from "../response-cache.js";
import { loadCanonicalCharges } from "../charge-cohort.js";
import { periodDates } from "../../../dashboard/src/components/consoleFormatters.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Floats summed in another order differ past the 12th digit; the numbers are otherwise exact. */
function settled(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_key, item) => typeof item === "number" ? Number(item.toPrecision(12)) : item);
}

test("a request is a preset only if it is what the console sends for that preset", (t) => {
  const zones = ["UTC", "Asia/Kolkata", "America/New_York", "Pacific/Auckland"];
  // Ordinary days, first of a month, and days clocks change in those zones.
  const moments = ["2026-11-07T10:15:00Z", "2026-12-01T00:30:00Z", "2026-03-08T15:00:00Z", "2026-11-01T05:30:00Z", "2026-04-05T02:00:00Z", "2026-09-27T13:00:00Z"];
  for (const moment of moments) {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(moment) });
    for (const zone of zones) {
      for (const key of BOARD_WINDOW_KEYS) {
        const asked = periodDates(key as Parameters<typeof periodDates>[0], zone);
        assert.equal(boardWindowAt(key, zone, new Date()).from, asked.from, `${key} in ${zone} at ${moment}`);
        const found = standardBoardWindow({ ...asked, environment: null }, zone);
        assert.ok(found, `${key} in ${zone} at ${moment} is a preset`);
        assert.equal(boardWindowAt(found, zone, new Date()).from, asked.from, "it reads a row for the same window");
      }
      // Under a day: small enough to compute, and a stored answer would be mostly old.
      for (const key of ["15m", "1h", "3h", "12h"] as const) {
        assert.equal(standardBoardWindow({ ...periodDates(key, zone), environment: null }, zone), null, key);
      }
    }
    t.mock.timers.reset();
  }
  const now = new Date();
  const thirty = boardWindowAt("30d", "UTC", now);
  assert.equal(standardBoardWindow({ ...thirty, environment: "production" }, "UTC", now), null, "an environment filter");
  assert.equal(standardBoardWindow({ ...thirty, environment: null, release: "v2" }, "UTC", now), null, "a release filter");
  assert.equal(standardBoardWindow({ from: thirty.from, to: new Date(now.getTime() - HOUR).toISOString(), environment: null }, "UTC", now), null, "a range that ended earlier");
  assert.equal(standardBoardWindow({ from: new Date(Date.parse(thirty.from) + 1).toISOString(), to: thirty.to, environment: null }, "UTC", now), null, "a custom start");
  assert.equal(standardBoardWindow({ ...thirty, environment: null }, "Asia/Kolkata", now), null, "midnight in another timezone");
});

test("schema setup under the migration lock survives instances booting together", { skip: !connectionString }, async () => {
  const schema = `board_race_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString });
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 10 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.projects (id TEXT PRIMARY KEY)`);
    await Promise.all(Array.from({ length: 8 }, () => withMigrationLock(pool, (client) => ensureBoardSnapshotSchema(client))));
    const found = await pool.query("SELECT to_regclass('board_snapshots') AS name");
    assert.equal(found.rows[0].name, "board_snapshots");
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin.end();
  }
});

test("a stored board matches the on-demand answer, and is served only for the window it covers", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_snap_${suffix}`;
  const projectId = `project_snap_${suffix}`;
  const app = express();
  app.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: `owner-${suffix}`, orgId, role: "owner" }; next(); });
  app.use(createInsightsRouter(pool, { boardSnapshots: true }));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/projects/${projectId}/insights/board`;
  // Past the in-memory cache, as a cold instance would be.
  const get = async (query: Record<string, string | null | undefined>) => {
    const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1])));
    const response = await fetch(`${base}?${params}`, { headers: { "x-costkey-cache-refresh": "1" } });
    assert.equal(response.status, 200);
    return { body: await response.json() as Awaited<ReturnType<typeof loadOverviewBoard>>, source: response.headers.get("x-costkey-board") };
  };
  const rowsOf = async () => (await pool.query("SELECT * FROM board_snapshots WHERE project_id = $1 ORDER BY window_key", [projectId])).rows;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await withMigrationLock(pool, (client) => ensureBoardSnapshotSchema(client));
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Snapshots',$2)", [orgId, `snap-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Snapshots',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    const timezone = await boardSource.timezoneOf(pool, projectId);
    const ago = (ms: number, extra = 0) => new Date(Date.now() - ms + extra).toISOString();
    const call = (id: string, trace: string, when: string, opts: { cost?: number | null; status?: number; state?: string; span?: string | null; context?: Record<string, unknown>; units?: Record<string, number>; model?: string; tokens?: [number, number] } = {}) => pool.query(
      `INSERT INTO events (id, project_id, timestamp, provider, model, cost_usd, duration_ms, status_code, lifecycle_state, trace_id, trace_name, span_id, input_tokens, output_tokens, native_units, context)
       VALUES ($1,$2,$3,'anthropic',$4,$5,500,$6,$7,$8,$8,$9,$10,$11,$12,$13)`,
      [id, projectId, when, opts.model ?? "claude-sonnet-5", opts.cost === undefined ? 0.01 : opts.cost, opts.status ?? 200, opts.state ?? null, trace, opts.span ?? null, opts.tokens?.[0] ?? 100, opts.tokens?.[1] ?? 20, opts.units ? JSON.stringify(opts.units) : null, JSON.stringify(opts.context ?? { environment: "production" })],
    );
    const span = (id: string, trace: string, kind: string, name: string, parent: string | null, start: string, end: string, status = "ok") => pool.query(
      `INSERT INTO spans (id, project_id, trace_id, parent_span_id, kind, name, status, started_at, ended_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, projectId, trace, parent, kind, name, status, start, end],
    );
    const score = (id: string, trace: string, name: string, value: number, when: string) => pool.query(
      "INSERT INTO scores (project_id, id, trace_id, name, value, source, timestamp) VALUES ($1,$2,$3,$4,$5,'judge',$6)",
      [projectId, id, trace, name, value, when],
    );
    // An agent with a tool, in the last day and in the last 30 days.
    for (const [trace, when] of [["a1", 3 * HOUR], ["a2", 20 * HOUR], ["a3", 5 * DAY], ["a4", 20 * DAY], ["a5", 70 * DAY]] as const) {
      await span(`${trace}_root`, trace, "agent", "support", null, ago(when), ago(when, 4_000));
      await span(`${trace}_tool`, trace, "tool", "search_docs", `${trace}_root`, ago(when, 500), ago(when, 1_500));
      await call(`${trace}_c1`, trace, ago(when, 100), { span: `${trace}_root`, tokens: [1_000, 200] });
      await score(`${trace}_s`, trace, "faithfulness", 0.8, ago(when, 5_000));
      await score(`${trace}_r`, trace, "rating", 4, ago(when, 5_000));
    }
    // A failed call without a price is not unpriced; a call that went through without one is.
    await call("failed_unpriced", "a1", ago(3 * HOUR, 200), { cost: null, status: 500, state: "failed", span: "a1_root" });
    await call("ok_unpriced", "w1", ago(5 * HOUR), { cost: null, model: "brand-new-model" });
    // A failed attempt a later one completed, a workflow, billed units and another environment.
    await call("retry_1", "r1", ago(6 * HOUR), { status: 500, context: { environment: "production", work_id: "job-1" } });
    await call("retry_2", "r2", ago(5.5 * HOUR), { context: { environment: "production", work_id: "job-1" } });
    await call("voice", "v1", ago(2 * DAY), { model: "eleven_v2", cost: 0.2, units: { characters: 900 } });
    await call("stage", "s1", ago(4 * HOUR), { cost: 5, context: { environment: "staging", release: "v9" } });
    // A usage component on a run, as its own charge.
    await pool.query(
      `INSERT INTO usage_components (id, project_id, charge_id, component_id, context, trace_id, component, provider, model, unit_kind, unit_value, unit, amount, currency, amount_kind, aggregation, revision, payload_hash, active, accounting_at, observed_at)
       VALUES ('usage1',$1,'charge1','search','{}'::jsonb,'a2','search','tavily','search','requests',1,'requests',0.25,'USD','reported','delta',1,'h1',TRUE,$2,$2)`,
      [projectId, ago(20 * HOUR)],
    );
    // What each preset compares with: the window before it.
    await call("older_30", "o1", ago(40 * DAY));
    await call("older_90", "o2", ago(120 * DAY));

    const before = await refreshDueBoards(pool, boardSource, { seed: true });
    assert.ok(before.ran);
    assert.equal(before.failed, 0);
    const rows = await rowsOf();
    assert.deepEqual(rows.map((row) => row.window_key).sort(), [...BOARD_WINDOW_KEYS].sort(), "every preset of an active project");

    // Same window, same data: the stored answer is the on-demand answer.
    for (const row of rows) {
      assert.ok(row.board, `${row.window_key} was computed`);
      const onDemand = await loadOverviewBoard(pool, projectId, { from: row.window_from.toISOString(), to: row.window_to.toISOString(), environment: null, release: null }, timezone);
      assert.deepEqual(settled(row.board), settled(onDemand), `${row.window_key} matches`);
    }

    // The endpoint serves it, and a request's own window (a moment later) has the same numbers.
    for (const key of BOARD_WINDOW_KEYS) {
      const asked = boardWindowAt(key, timezone, new Date());
      const { body, source } = await get(asked);
      assert.equal(source, "snapshot", key);
      const onDemand = await loadOverviewBoard(pool, projectId, { ...asked, environment: null, release: null }, timezone);
      const numbers = ({ window: _window, previous: _previous, buckets: _buckets, ...rest }: Awaited<ReturnType<typeof loadOverviewBoard>>) => settled(rest);
      assert.deepEqual(numbers(body), numbers(onDemand), `${key} over the request's window`);
    }

    // Failed calls stay out of unpriced everywhere the board counts it.
    const { body: thirty } = await get(boardWindowAt("30d", timezone, new Date()));
    assert.equal(thirty.agents.find((agent) => agent.name === "support")?.unpriced, 0);
    assert.equal(thirty.models.find((model) => model.model === "claude-sonnet-5")?.unpriced, 0);
    assert.equal(thirty.models.find((model) => model.model === "brand-new-model")?.unpriced, 1);
    assert.equal(thirty.workflows.find((flow) => flow.name === "w1")?.unpriced, 1);
    assert.equal(thirty.runs.current.runs, 9, "the 30-day runs are all there");
    assert.equal(thirty.runs.previous.runs, 1);
    const { body: ninety } = await get(boardWindowAt("90d", timezone, new Date()));
    assert.equal(ninety.runs.current.runs, 11);
    assert.equal(ninety.runs.previous.runs, 1);

    // Filters and custom ranges are computed, and leave no row behind.
    const stored = (await rowsOf()).length;
    const asked30 = boardWindowAt("30d", timezone, new Date());
    const filtered = await get({ ...asked30, environment: "staging" });
    assert.equal(filtered.source, null, "an environment filter is on demand");
    assert.deepEqual(settled(filtered.body), settled(await loadOverviewBoard(pool, projectId, { ...asked30, environment: "staging", release: null }, timezone)));
    assert.equal(filtered.body.runs.current.runs, 1);
    const released = await get({ ...asked30, release: "v9" });
    assert.equal(released.source, null, "a release filter is on demand");
    assert.equal(released.body.runs.current.runs, 1);
    const custom = { from: ago(10 * DAY), to: ago(1 * DAY) };
    const range = await get(custom);
    assert.equal(range.source, null, "a custom range is on demand");
    assert.deepEqual(settled(range.body), settled(await loadOverviewBoard(pool, projectId, { ...custom, environment: null, release: null }, timezone)));
    assert.equal((await rowsOf()).length, stored);

    // New calls wait for the job, which picks them up; a change to the project can't wait.
    await call("new_call", "n1", ago(60_000), { cost: 1 });
    assert.equal((await get(boardWindowAt("30d", timezone, new Date()))).body.runs.current.runs, 9);
    invalidateSummaries(projectId);
    for (let tries = 0; tries < 50; tries++) {
      const marked = (await rowsOf()).every((row) => row.stale_at);
      if (marked) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok((await rowsOf()).every((row) => row.stale_at && Date.parse(row.next_refresh_at) <= Date.now()), "a change marks every stored board");
    const changed = await get(boardWindowAt("30d", timezone, new Date()));
    assert.equal(changed.source, "computed", "a board from before the change isn't served");
    assert.equal(changed.body.runs.current.runs, 10);
    const again = await get(boardWindowAt("30d", timezone, new Date()));
    assert.equal(again.source, "snapshot", "what the request computed is kept for the next one");
    assert.equal(again.body.runs.current.runs, 10);

    // A price list sync or a workspace setting refreshes boards soon, and they keep being served.
    await pool.query("UPDATE board_snapshots SET next_refresh_at = NOW() + INTERVAL '1 hour' WHERE project_id = $1", [projectId]);
    await markBoardsStale(pool);
    assert.equal((await get(boardWindowAt("30d", timezone, new Date()))).source, "snapshot");
    assert.ok((await rowsOf()).every((row) => Date.parse(row.next_refresh_at) <= Date.now() + 60_000));

    // The job works through what changed; a computation that began before a change doesn't count.
    const after = await refreshDueBoards(pool, boardSource);
    assert.equal(after.failed, 0);
    const key = "7d";
    const window = boardWindowAt(key, timezone, new Date());
    const { rows: [{ now: beforeChange }] } = await pool.query("SELECT NOW() AS now");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await markBoardsStale(pool, projectId);
    await storeBoardSnapshot(pool, { projectId, key, timezone, window, board: { old: true }, computedAt: beforeChange, durationMs: 10, viewed: false });
    assert.equal((await readBoardSnapshot(pool, projectId, key, window, timezone)).board, null);
    assert.ok(Date.parse((await rowsOf()).find((row) => row.window_key === key).next_refresh_at) <= Date.now(), "and it is redone at once");
    await refreshDueBoards(pool, boardSource);

    // Only for the window it covers, in the timezone and format it was built in, while recent.
    const read = async () => (await readBoardSnapshot(pool, projectId, key, boardWindowAt(key, timezone, new Date()), timezone)).board;
    assert.ok(await read());
    const edit = (set: string) => pool.query(`UPDATE board_snapshots SET ${set} WHERE project_id = $1 AND window_key = $2`, [projectId, key]);
    const original = (await rowsOf()).find((row) => row.window_key === key);
    await edit("window_from = window_from - INTERVAL '1 day'");
    assert.equal(await read(), null, "yesterday's anchor");
    await pool.query("UPDATE board_snapshots SET window_from = $3 WHERE project_id = $1 AND window_key = $2", [projectId, key, original.window_from]);
    await edit("format = 0");
    assert.equal(await read(), null, "an older format");
    await edit(`format = ${original.format}, computed_at = NOW() - INTERVAL '4 hours'`);
    assert.equal(await read(), null, "old enough that the job has stopped keeping up");
    await pool.query("UPDATE board_snapshots SET computed_at = $3 WHERE project_id = $1 AND window_key = $2", [projectId, key, original.computed_at]);
    assert.ok(await read());
    assert.equal((await readBoardSnapshot(pool, projectId, key, window, "Asia/Kolkata")).board, null, "another timezone");

    // Rolling windows aren't tied to an anchor; a view pulls an idle row's refresh in.
    await pool.query("UPDATE board_snapshots SET viewed_at = NULL, next_refresh_at = NOW() + INTERVAL '1 hour' WHERE project_id = $1 AND window_key = '90d'", [projectId]);
    assert.equal((await get(boardWindowAt("90d", timezone, new Date()))).source, "snapshot");
    let viewed: { viewed_at: Date; next_refresh_at: Date } | undefined;
    for (let tries = 0; tries < 50 && !viewed?.viewed_at; tries++) {
      viewed = (await rowsOf()).find((row) => row.window_key === "90d");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(viewed?.viewed_at, "the view is recorded");
    assert.ok(Date.parse(String(viewed.next_refresh_at)) < Date.now() + 10 * 60_000, "and it refreshes soon");

    // A deleted project's boards go with it, and a failed refresh keeps the last good one.
    const failing: BoardSource = { ...boardSource, load: async () => { throw new Error("boom"); } };
    await pool.query("UPDATE board_snapshots SET next_refresh_at = NOW() WHERE project_id = $1 AND window_key = '3d'", [projectId]);
    const logged = console.error;
    console.error = () => undefined;
    const failure = await refreshDueBoards(pool, failing).finally(() => { console.error = logged; });
    assert.ok(failure.failed >= 1);
    const kept = (await rowsOf()).find((row) => row.window_key === "3d");
    assert.ok(kept.board, "the last good board stays");
    assert.ok(Date.parse(kept.next_refresh_at) > Date.now() + 60_000, "and it tries again later");
  } finally {
    server.close();
    await pool.query("DELETE FROM board_snapshots WHERE project_id = $1", [projectId]).catch(() => undefined);
    for (const table of ["scores", "usage_components", "spans", "traces", "events"]) await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

test("without the job, nothing stored is read or written", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_snap_off_${suffix}`;
  const projectId = `project_snap_off_${suffix}`;
  const app = express();
  app.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: `owner-${suffix}`, orgId, role: "owner" }; next(); });
  app.use(createInsightsRouter(pool));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await withMigrationLock(pool, (client) => ensureBoardSnapshotSchema(client));
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Off',$2)", [orgId, `snap-off-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Off',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    const window = boardWindowAt("30d", "UTC", new Date());
    await storeBoardSnapshot(pool, { projectId, key: "30d", timezone: "UTC", window, board: { old: true }, computedAt: new Date(), durationMs: 1, viewed: false });
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/projects/${projectId}/insights/board?${new URLSearchParams(window)}`);
    assert.equal(response.headers.get("x-costkey-board"), null);
    assert.ok((await response.json() as { runs?: unknown }).runs, "computed, not the stored row");
  } finally {
    server.close();
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

test("only one instance refreshes at a time, and nothing is computed twice", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_snap_lock_${suffix}`;
  const projectId = `project_snap_lock_${suffix}`;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await withMigrationLock(pool, (client) => ensureBoardSnapshotSchema(client));
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Lock',$2)", [orgId, `snap-lock-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Lock',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    await pool.query("INSERT INTO board_snapshots (project_id, window_key) SELECT $1, key FROM unnest($2::text[]) AS key", [projectId, BOARD_WINDOW_KEYS]);
    const computed: string[] = [];
    const counting: BoardSource = {
      ...boardSource,
      load: async (_pool, id, window) => {
        if (id === projectId) computed.push(window.from);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true };
      },
    };
    const results = await Promise.all([refreshDueBoards(pool, counting), refreshDueBoards(pool, counting), refreshDueBoards(pool, counting)]);
    assert.ok(results.some((result) => result.ran));
    assert.ok(results.some((result) => !result.ran), "the others skip the tick");
    assert.equal(computed.length, BOARD_WINDOW_KEYS.length, "each preset once");
    computed.length = 0;
    await refreshDueBoards(pool, counting);
    assert.equal(computed.length, 0, "nothing is due until its next refresh");
  } finally {
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

test("usage rows take their context from the call they name, else the earliest of their trace or execution", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_snap_usage_${suffix}`;
  const projectId = `project_snap_usage_${suffix}`;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Usage',$2)", [orgId, `snap-usage-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Usage',$2,$3)", [projectId, orgId, `key_${suffix}`]);
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const call = (id: string, name: string, minutes: number, fields: { trace?: string; execution?: string; charge?: string; cost?: number | null }) => pool.query(
      `INSERT INTO events (id, project_id, timestamp, provider, model, cost_usd, status_code, trace_id, trace_name, execution_id, charge_id, context)
       VALUES ($1,$2,$3,'openai','gpt',$8,200,$4,$5,$6,$7,'{}'::jsonb)`,
      [id, projectId, at(minutes), fields.trace ?? null, name, fields.execution ?? null, fields.charge ?? null, fields.cost === undefined ? 0.01 : fields.cost],
    );
    const usage = (id: string, minutes: number, fields: { trace?: string; execution?: string; charge?: string }) => pool.query(
      `INSERT INTO usage_components (id, project_id, charge_id, component_id, context, trace_id, execution_id, component, provider, model, unit_kind, unit_value, unit, amount, currency, amount_kind, aggregation, revision, payload_hash, active, accounting_at, observed_at)
       VALUES ($1,$2,$3,'part','{}'::jsonb,$4,$5,'search','tavily','search','requests',1,'requests',0.25,'USD','reported','delta',1,$1,TRUE,$6,$6)`,
      [id, projectId, fields.charge ?? null, fields.trace ?? null, fields.execution ?? null, at(minutes)],
    );
    // The same trace: an earlier call, and a later one the usage names by charge id or by call id.
    // Those have no price, so the usage row's amount is the charge that stands.
    await call("trace_first", "earliest in trace", 50, { trace: "t1" });
    await call("trace_named", "named by charge id", 40, { trace: "t1", charge: "charge_named", cost: null });
    await call("id_named", "named by call id", 40, { trace: "t2", cost: null });
    await call("trace2_first", "earliest in trace 2", 50, { trace: "t2" });
    await call("exec_later", "later in execution", 30, { execution: "x1" });
    await call("exec_first", "earliest in execution", 35, { execution: "x1" });
    await call("both_trace", "trace before execution", 45, { trace: "t3" });
    await call("both_exec", "execution after trace", 44, { execution: "x3" });
    await usage("by_charge", 20, { charge: "charge_named", trace: "t1" });
    await usage("by_call_id", 20, { charge: "id_named", trace: "t2" });
    await usage("by_trace", 20, { trace: "t1" });
    await usage("by_execution", 20, { execution: "x1" });
    await usage("by_either", 20, { trace: "t3", execution: "x3" });
    await usage("by_nothing", 20, { charge: "no_such_call" });
    const charges = await loadCanonicalCharges(pool, projectId, { from: at(120), to: at(0) });
    const nameOf = (id: string) => charges.find((charge) => charge.record_id === id)?.trace_name ?? null;
    assert.equal(nameOf("by_charge"), "named by charge id");
    assert.equal(nameOf("by_call_id"), "named by call id");
    assert.equal(nameOf("by_trace"), "earliest in trace");
    assert.equal(nameOf("by_execution"), "earliest in execution");
    assert.equal(nameOf("by_either"), "trace before execution");
    assert.equal(nameOf("by_nothing"), null);
  } finally {
    for (const table of ["usage_components", "events"]) await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

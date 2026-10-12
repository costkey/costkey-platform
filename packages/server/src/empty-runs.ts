import type pg from "pg";

/**
 * Runs that did no AI work are noise: a background job that woke, found
 * nothing to do and finished sends only its start and end. Once such a run
 * has been quiet for a grace period (so late calls in a later batch still
 * count), it is removed: no model call, no span, no score, no usage row.
 *
 * COSTKEY_KEEP_EMPTY_RUNS=true keeps them.
 */
export async function sweepEmptyRuns(
  pool: pg.Pool,
  options: { graceSeconds?: number; limit?: number } = {},
): Promise<number> {
  if (process.env["COSTKEY_KEEP_EMPTY_RUNS"] === "true") return 0;
  const graceSeconds = options.graceSeconds ?? 120;
  const limit = options.limit ?? 1000;
  const client = await pool.connect();
  try {
    // Tables some installs create later (quality checks) or not at all.
    const existing = new Set((await client.query<{ name: string }>(
      `SELECT t AS name FROM unnest(ARRAY['spans','scores','usage_components','quality_check_jobs']) t
        WHERE to_regclass(t) IS NOT NULL`,
    )).rows.map((row) => row.name));
    const linked = ["spans", "scores", "usage_components"]
      .filter((table) => existing.has(table))
      .map((table) => `AND NOT EXISTS (SELECT 1 FROM ${table} x WHERE x.project_id = e.project_id AND x.trace_id = e.trace_id)`)
      .join("\n          ");
    await client.query("BEGIN");
    const empty = await client.query<{ project_id: string; trace_id: string }>(
      `SELECT e.project_id, e.trace_id
         FROM events e
        WHERE e.trace_id IS NOT NULL
        GROUP BY e.project_id, e.trace_id
       HAVING bool_and(e.event_type = 'lifecycle')
          AND max(e.timestamp) < NOW() - make_interval(secs => $1)
          ${linked}
        LIMIT $2`,
      [graceSeconds, limit],
    );
    if (empty.rows.length === 0) {
      await client.query("COMMIT");
      return 0;
    }
    const projects = empty.rows.map((row) => row.project_id);
    const traces = empty.rows.map((row) => row.trace_id);
    const pairs = `SELECT * FROM unnest($1::text[], $2::text[]) AS gone(project_id, trace_id)`;
    if (existing.has("quality_check_jobs")) {
      await client.query(
        `DELETE FROM quality_check_jobs q USING (${pairs}) gone WHERE q.project_id = gone.project_id AND q.trace_id = gone.trace_id`,
        [projects, traces],
      );
    }
    await client.query(
      `DELETE FROM events e USING (${pairs}) gone WHERE e.project_id = gone.project_id AND e.trace_id = gone.trace_id AND e.event_type = 'lifecycle'`,
      [projects, traces],
    );
    await client.query(
      `DELETE FROM traces t USING (${pairs}) gone WHERE t.project_id = gone.project_id AND t.id = gone.trace_id`,
      [projects, traces],
    );
    await client.query("COMMIT");
    return empty.rows.length;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function startEmptyRunSweeper(pool: pg.Pool, intervalMs = 60_000): NodeJS.Timeout {
  let running = false;
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    void sweepEmptyRuns(pool)
      .then((removed) => { if (removed > 0) console.log(`[costkey] Removed ${removed} runs with no model calls`); })
      .catch((error) => console.error("[costkey] Empty run sweep error:", error))
      .finally(() => { running = false; });
  }, intervalMs);
  handle.unref();
  return handle;
}

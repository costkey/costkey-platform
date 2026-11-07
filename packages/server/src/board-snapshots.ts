import type pg from "pg";
import type { BoardWindow } from "./insights-api.js";

/**
 * The Overview board for the console's long presets, kept in Postgres so every
 * instance shares it and it survives a deploy. A job computes each answer with
 * loadOverviewBoard and stores it whole, and a request reads the row.
 *
 * Why the answer and not a daily runs rollup: the board's p50/p95 latency,
 * distinct runs per tool and check, top-20 lists and retry outcomes don't add
 * up across days, so a rollup could only match the on-demand numbers by keeping
 * nearly every sample. A stored answer matches because it is the same code.
 *
 * Presets under a day, a custom range and an environment or release filter
 * stay on demand: they read little, or there are too many to keep.
 *
 * A row is served only if it is for the window asked (same anchor, same
 * timezone) and was computed after the project last changed. Otherwise the
 * request computes it, and stores what it computed for the next one.
 */

const DAY_MS = 86_400_000;
/** Presets that end now and start a fixed length before (periodDates in the console). */
const ROLLING_MS: Record<string, number> = { "24h": DAY_MS, "3d": 3 * DAY_MS, "90d": 90 * DAY_MS };
/** Presets that start at a local midnight, so a new day is a new window. */
const ANCHORED = ["today", "7d", "30d", "mtd"];
export const BOARD_WINDOW_KEYS = [...Object.keys(ROLLING_MS), ...ANCHORED];

/** A "to" this close to now means now: the console sends its own clock. */
const NEAR_NOW_MS = 5 * 60_000;
/** Raise when the board's shape or meaning changes: older rows stop being served. */
const BOARD_FORMAT = 1;
/** Past this the job has stopped keeping up: compute rather than show old numbers. */
const MAX_SERVE_AGE_MS = 3 * 60 * 60_000;
/** Someone looked at this board this recently: keep it close to live. */
const WATCHED_MS = 10 * 60_000;
const WATCHED_MIN_MS = 30_000;
const IDLE_MIN_MS = 30 * 60_000;
const IDLE_MAX_MS = 60 * 60_000;
const RETRY_MS = 5 * 60_000;
const SEED_EVERY_MS = 15 * 60_000;
/** One instance refreshes at a time. A session lock, so a dead instance holds nothing. */
const REFRESH_LOCK_KEY = "costkey:board-snapshots";

/** Time between refreshes, bounded by what one costs: a fifth of one connection's time while watched. */
function refreshAfter(durationMs: number): { watchedMs: number; idleMs: number } {
  return {
    watchedMs: Math.max(WATCHED_MIN_MS, durationMs * 4),
    idleMs: Math.min(IDLE_MAX_MS, Math.max(IDLE_MIN_MS, durationMs * 60)),
  };
}

export async function ensureBoardSnapshotSchema(client: pg.Pool | pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS board_snapshots (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      window_key TEXT NOT NULL,
      timezone TEXT,
      window_from TIMESTAMPTZ,
      window_to TIMESTAMPTZ,
      format INTEGER,
      -- JSON, not JSONB: served exactly as the endpoint computed it.
      board JSON,
      computed_at TIMESTAMPTZ,
      duration_ms DOUBLE PRECISION,
      viewed_at TIMESTAMPTZ,
      -- When the project last changed (a price, a mapping): anything computed before no longer counts.
      stale_at TIMESTAMPTZ,
      next_refresh_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, window_key)
    );
    CREATE INDEX IF NOT EXISTS idx_board_snapshots_due ON board_snapshots(next_refresh_at);
  `);
}

/** A preset's start at this moment, computed as the console's periodDates does, DST included. */
function anchoredFrom(key: string, timezone: string, now: Date): string {
  const part = (parts: Intl.DateTimeFormatPart[], type: string) => Number(parts.find((item) => item.type === type)?.value);
  const today = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const local = new Date(Date.UTC(part(today, "year"), part(today, "month") - 1, part(today, "day")));
  if (key === "mtd") local.setUTCDate(1);
  if (key === "7d") local.setUTCDate(local.getUTCDate() - 7);
  if (key === "30d") local.setUTCDate(local.getUTCDate() - 30);
  const wall = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(local);
  const offset = Date.UTC(part(wall, "year"), part(wall, "month") - 1, part(wall, "day"), part(wall, "hour"), part(wall, "minute"), part(wall, "second")) - local.getTime();
  return new Date(local.getTime() - offset).toISOString();
}

/** The window a preset covers at this moment. */
export function boardWindowAt(key: string, timezone: string, now: Date): { from: string; to: string } {
  const rolling = ROLLING_MS[key];
  return {
    from: rolling ? new Date(now.getTime() - rolling).toISOString() : anchoredFrom(key, timezone, now),
    to: now.toISOString(),
  };
}

/** Which preset this request is, or null to compute it on demand. */
export function standardBoardWindow(window: BoardWindow, timezone: string, now = new Date()): string | null {
  if (window.environment || window.release) return null;
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (Math.abs(to - now.getTime()) >= NEAR_NOW_MS) return null;
  for (const [key, length] of Object.entries(ROLLING_MS)) if (to - from === length) return key;
  for (const key of ANCHORED) if (Date.parse(anchoredFrom(key, timezone, now)) === from) return key;
  return null;
}

const isAnchored = (key: string) => ANCHORED.includes(key);

/** Tell the job someone is looking: this row is refreshed on the watched schedule from now on. */
async function markViewed(pool: pg.Pool, projectId: string, key: string): Promise<void> {
  await pool.query(
    `UPDATE board_snapshots
     SET viewed_at = NOW(),
         next_refresh_at = LEAST(next_refresh_at, GREATEST(NOW(),
           COALESCE(computed_at, NOW()) + GREATEST($3::double precision, COALESCE(duration_ms, 0) * 4) * INTERVAL '1 millisecond'))
     WHERE project_id = $1 AND window_key = $2`,
    [projectId, key, WATCHED_MIN_MS],
  );
}

/** A stored board that answers this window, and the database's clock. */
export async function readBoardSnapshot(pool: pg.Pool, projectId: string, key: string, window: Pick<BoardWindow, "from">, timezone: string): Promise<{ board: unknown | null; now: Date }> {
  const { rows } = await pool.query(
    `SELECT NOW() AS now, b.board,
            (b.project_id IS NOT NULL AND (b.viewed_at IS NULL OR b.viewed_at < NOW() - INTERVAL '1 minute')) AS mark_viewed,
            (b.board IS NOT NULL AND b.format = $3 AND b.timezone = $4
             AND (b.stale_at IS NULL OR b.computed_at >= b.stale_at)
             AND b.computed_at > NOW() - $5::double precision * INTERVAL '1 millisecond'
             AND ($6::timestamptz IS NULL OR b.window_from = $6::timestamptz)) AS usable
     FROM (SELECT 1) one
     LEFT JOIN board_snapshots b ON b.project_id = $1 AND b.window_key = $2`,
    [projectId, key, BOARD_FORMAT, timezone, MAX_SERVE_AGE_MS, isAnchored(key) ? window.from : null],
  );
  const row = rows[0] as { now: Date; board: unknown; mark_viewed: boolean; usable: boolean };
  if (row.mark_viewed) void markViewed(pool, projectId, key).catch((error) => console.error("[costkey] Board snapshot view error:", error));
  return { board: row.usable ? row.board : null, now: row.now };
}

export interface StoredBoard {
  projectId: string;
  key: string;
  timezone: string;
  window: { from: string; to: string };
  board: unknown;
  /** When the computation began, on the database's clock: it saw changes up to here. */
  computedAt: Date;
  durationMs: number;
  /** A person asked for this answer, as opposed to the job. */
  viewed: boolean;
}

/** Keep a computed board, unless a newer one is already there, and schedule its next refresh. */
export async function storeBoardSnapshot(pool: pg.Pool | pg.PoolClient, stored: StoredBoard): Promise<void> {
  const { watchedMs, idleMs } = refreshAfter(stored.durationMs);
  await pool.query(
    `INSERT INTO board_snapshots AS b (project_id, window_key, timezone, window_from, window_to, format, board, computed_at, duration_ms, viewed_at, next_refresh_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::json, $8, $9, CASE WHEN $10::boolean THEN NOW() END, NOW() + $11::double precision * INTERVAL '1 millisecond')
     ON CONFLICT (project_id, window_key) DO UPDATE SET
       timezone = EXCLUDED.timezone, window_from = EXCLUDED.window_from, window_to = EXCLUDED.window_to,
       format = EXCLUDED.format, board = EXCLUDED.board, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms,
       viewed_at = COALESCE(EXCLUDED.viewed_at, b.viewed_at),
       next_refresh_at = CASE
         -- The project changed while this was computing: it won't be served, so redo it now.
         WHEN b.stale_at > EXCLUDED.computed_at THEN NOW()
         ELSE LEAST(
           NOW() + (CASE WHEN COALESCE(EXCLUDED.viewed_at, b.viewed_at) > NOW() - $12::double precision * INTERVAL '1 millisecond' THEN $11 ELSE $13 END)::double precision * INTERVAL '1 millisecond',
           -- A preset anchored at midnight is a different window once the day turns.
           CASE WHEN $14::boolean THEN (date_trunc('day', NOW() AT TIME ZONE EXCLUDED.timezone) + INTERVAL '1 day') AT TIME ZONE EXCLUDED.timezone END)
       END
     WHERE b.computed_at IS NULL OR b.computed_at <= EXCLUDED.computed_at`,
    [
      stored.projectId, stored.key, stored.timezone, stored.window.from, stored.window.to, BOARD_FORMAT,
      JSON.stringify(stored.board), stored.computedAt, stored.durationMs, stored.viewed,
      watchedMs, WATCHED_MS, idleMs, isAnchored(stored.key),
    ],
  );
}

/**
 * After a project changes (a price, a mapping) its stored boards no longer
 * count. With no project (a price list sync, one workspace's settings) nobody
 * needs a board computed in their request: refresh them soon, and keep serving.
 * A changed timezone is caught on read.
 */
export async function markBoardsStale(pool: pg.Pool, projectId?: string): Promise<void> {
  if (!projectId) {
    await pool.query("UPDATE board_snapshots SET next_refresh_at = NOW() WHERE next_refresh_at > NOW()");
    return;
  }
  // In milliseconds, as computed_at comes back through the driver.
  await pool.query("UPDATE board_snapshots SET stale_at = date_trunc('milliseconds', NOW()), next_refresh_at = NOW() WHERE project_id = $1", [projectId]);
}

/** How a board is computed. Passed in because insights-api, which holds it, calls this module. */
export interface BoardSource {
  load: (pool: pg.Pool, projectId: string, window: BoardWindow, timezone: string) => Promise<unknown>;
  timezoneOf: (pool: pg.Pool, projectId: string) => Promise<string>;
}

/** Requests waiting on the same computation in this process share it. */
const computing = new Map<string, Promise<unknown>>();

/** The board for a preset: the stored one, or computed now and stored for the next request. */
export async function standardBoard(
  pool: pg.Pool, source: BoardSource, projectId: string, key: string, window: BoardWindow, timezone: string,
): Promise<{ board: unknown; source: "snapshot" | "computed" }> {
  const { board: stored, now } = await readBoardSnapshot(pool, projectId, key, window, timezone);
  if (stored != null) return { board: stored, source: "snapshot" };
  const id = [projectId, key, timezone, isAnchored(key) ? window.from : ""].join("\u0000");
  let pending = computing.get(id);
  if (!pending) {
    const started = Date.now();
    pending = source.load(pool, projectId, window, timezone)
      .then(async (board) => {
        await storeBoardSnapshot(pool, { projectId, key, timezone, window, board, computedAt: now, durationMs: Date.now() - started, viewed: true })
          .catch((error) => console.error("[costkey] Board snapshot store error:", error));
        return board;
      })
      .finally(() => computing.delete(id));
    computing.set(id, pending);
  }
  return { board: await pending, source: "computed" };
}

/** Every recently active project has a row per preset; rows nobody needs any more go. */
async function seedBoardSnapshots(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO board_snapshots (project_id, window_key)
     SELECT p.id, key FROM projects p CROSS JOIN unnest($1::text[]) AS key
     WHERE EXISTS (SELECT 1 FROM events e WHERE e.project_id = p.id AND e.timestamp >= NOW() - INTERVAL '90 days')
     ON CONFLICT (project_id, window_key) DO NOTHING`,
    [BOARD_WINDOW_KEYS],
  );
  await client.query("UPDATE board_snapshots SET next_refresh_at = NOW() WHERE format <> $1 AND next_refresh_at > NOW()", [BOARD_FORMAT]);
  await client.query(
    `DELETE FROM board_snapshots b
     WHERE (b.viewed_at IS NULL OR b.viewed_at < NOW() - INTERVAL '30 days')
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.project_id = b.project_id AND e.timestamp >= NOW() - INTERVAL '90 days')`,
  );
}

export interface BoardRefreshResult { ran: boolean; refreshed: number; failed: number }

/**
 * Compute boards that are due, watched ones first, until none are or the time
 * budget runs out. Only one instance works at a time, so one heavy board at
 * most is running against the database because of this job.
 */
export async function refreshDueBoards(
  pool: pg.Pool, source: BoardSource, options: { seed?: boolean; budgetMs?: number } = {},
): Promise<BoardRefreshResult> {
  const result: BoardRefreshResult = { ran: false, refreshed: 0, failed: 0 };
  const holder = await pool.connect();
  // A lost connection frees the lock; the worst case is two instances working for a moment.
  const ignore = () => undefined;
  holder.on("error", ignore);
  try {
    const lock = await holder.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [REFRESH_LOCK_KEY]);
    if (!lock.rows[0]?.locked) return result;
    result.ran = true;
    try {
      if (options.seed) await seedBoardSnapshots(holder);
      const deadline = Date.now() + (options.budgetMs ?? 60_000);
      do {
        const due = await holder.query<{ project_id: string; window_key: string; now: Date }>(
          `SELECT project_id, window_key, NOW() AS now FROM board_snapshots
           WHERE next_refresh_at <= NOW()
           ORDER BY (viewed_at IS NOT NULL AND viewed_at > NOW() - $1::double precision * INTERVAL '1 millisecond') DESC, next_refresh_at, project_id, window_key
           LIMIT 1`,
          [WATCHED_MS],
        );
        const row = due.rows[0];
        if (!row) break;
        const { project_id: projectId, window_key: key, now } = row;
        try {
          const timezone = await source.timezoneOf(pool, projectId);
          const window = boardWindowAt(key, timezone, now);
          const started = Date.now();
          const board = await source.load(pool, projectId, { ...window, environment: null, release: null }, timezone);
          await storeBoardSnapshot(holder, { projectId, key, timezone, window, board, computedAt: now, durationMs: Date.now() - started, viewed: false });
          result.refreshed += 1;
        } catch (error) {
          // The last good row keeps serving until it ages out.
          result.failed += 1;
          console.error(`[costkey] Board snapshot ${key} for ${projectId} failed:`, error);
          await holder.query(
            "UPDATE board_snapshots SET next_refresh_at = NOW() + $3::double precision * INTERVAL '1 millisecond' WHERE project_id = $1 AND window_key = $2",
            [projectId, key, RETRY_MS],
          );
        }
      } while (Date.now() < deadline);
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [REFRESH_LOCK_KEY]).catch(ignore);
    }
    return result;
  } finally {
    holder.off("error", ignore);
    holder.release();
  }
}

/** Keep the presets' boards current. An instance that finds another at work skips the tick. */
export function startBoardSnapshotWorker(pool: pg.Pool, source: BoardSource, intervalMs = 10_000): NodeJS.Timeout {
  let running = false;
  let seededAt = 0;
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    const seed = Date.now() - seededAt >= SEED_EVERY_MS;
    void refreshDueBoards(pool, source, { seed })
      .then((result) => { if (seed && result.ran) seededAt = Date.now(); })
      .catch((error) => console.error("[costkey] Board snapshot worker error:", error))
      .finally(() => { running = false; });
  }, intervalMs);
  handle.unref();
  return handle;
}

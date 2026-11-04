import type pg from "pg";
import type { TransportPayload } from "@costkey/shared";
import { ingestBatch } from "./ingest.js";

/**
 * Postgres-backed ingest queue. The events endpoint stores each SDK batch as
 * one `ingest_jobs` row and answers 202. Workers claim rows with SKIP LOCKED
 * and store each batch through ingestBatch, deleting the row inside that same
 * transaction, so a batch is stored exactly once. NOTIFY wakes idle workers;
 * a slow poll covers a missed notification, retries and expired leases.
 */

const CHANNEL = "costkey_ingest";
/** A claimed job is due again after this long, in case its worker died. */
const LEASE_MS = 5 * 60_000;
/** After this many failed attempts a job stays in the table, marked failed. */
const MAX_ATTEMPTS = 8;

export async function ensureIngestQueueSchema(p: pg.Pool | pg.PoolClient): Promise<void> {
  await p.query(`
    CREATE TABLE IF NOT EXISTS ingest_jobs (
      id BIGSERIAL PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      payload JSON NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ingest_jobs_due ON ingest_jobs(next_run_at, id) WHERE failed_at IS NULL;
  `);
}

/** Store a batch for the worker and wake one, in a single statement. */
export async function enqueueIngestBatch(pool: pg.Pool, projectId: string, payload: TransportPayload): Promise<void> {
  // JSON, not JSONB: the batch is kept as sent (JSONB rejects \u0000 escapes).
  await pool.query(
    `WITH job AS (INSERT INTO ingest_jobs (project_id, payload) VALUES ($1, $2) RETURNING id)
     SELECT pg_notify($3, '') FROM job`,
    [projectId, JSON.stringify(payload), CHANNEL],
  );
}

/** Claim and store the oldest due batch. False when nothing is due. */
export async function processNextIngestJob(pool: pg.Pool): Promise<boolean> {
  const claimed = await pool.query<{ id: string; project_id: string; payload: TransportPayload; attempts: number }>(
    `UPDATE ingest_jobs j
     SET attempts = j.attempts + 1, locked_at = NOW(),
         next_run_at = NOW() + ($1::double precision * INTERVAL '1 millisecond')
     WHERE j.id = (
       SELECT id FROM ingest_jobs
       WHERE failed_at IS NULL AND next_run_at <= NOW()
       ORDER BY next_run_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING j.id, j.project_id, j.payload, j.attempts`,
    [LEASE_MS],
  );
  const job = claimed.rows[0];
  if (!job) return false;
  try {
    const { accepted, rejected } = await ingestBatch(pool, job.project_id, job.payload, {
      beforeCommit: async (client) => { await client.query("DELETE FROM ingest_jobs WHERE id = $1", [job.id]); },
    });
    if (rejected.length > 0) {
      console.warn(`[costkey] Ingest job ${job.id}: stored ${accepted}, rejected ${rejected.length}:`,
        rejected.slice(0, 5).map((item) => `${item.id ?? `#${item.index}`} ${item.code}: ${item.error}`).join("; "));
    }
  } catch (error) {
    // The whole batch rolled back. Retry with backoff; give up after MAX_ATTEMPTS.
    console.error(`[costkey] Ingest job ${job.id} attempt ${job.attempts} failed:`, error);
    await pool.query(
      `UPDATE ingest_jobs
       SET locked_at = NULL, last_error = $2,
           next_run_at = NOW() + ($3::double precision * INTERVAL '1 millisecond'),
           failed_at = CASE WHEN attempts >= $4 THEN NOW() END
       WHERE id = $1`,
      [job.id, error instanceof Error ? error.message : String(error), Math.min(1000 * 2 ** job.attempts, LEASE_MS), MAX_ATTEMPTS],
    );
  }
  return true;
}

export type IngestWorker = { wake(): void; stop(): void };

export function startIngestWorker(
  pool: pg.Pool,
  options: { concurrency?: number; pollMs?: number } = {},
): IngestWorker {
  const concurrency = Math.max(1, options.concurrency ?? (Number(process.env["COSTKEY_INGEST_WORKERS"]) || 4));
  let stopped = false;
  let active = 0;
  // Set by every wake, so a loop that found nothing while a job was being
  // enqueued looks once more instead of leaving it for the next poll.
  let woken = false;

  const loop = async (): Promise<void> => {
    try {
      while (!stopped) {
        woken = false;
        if (!(await processNextIngestJob(pool)) && !woken) break;
      }
    } catch (error) {
      console.error("[costkey] Ingest worker error:", error);
    } finally {
      active -= 1;
    }
  };
  const wake = (): void => {
    woken = true;
    while (!stopped && active < concurrency) {
      active += 1;
      void loop();
    }
  };

  // One pooled connection listens for new jobs and is closed, never reused,
  // when it fails or the worker stops. The poll carries on without it.
  let closeListener: (() => void) | null = null;
  const listen = async (): Promise<void> => {
    if (stopped) return;
    let client: pg.PoolClient | null = null;
    let closed = false;
    const close = (): void => {
      if (closed || !client) return;
      closed = true;
      client.off("notification", wake);
      client.release(true);
      closeListener = null;
    };
    const retry = (error: unknown): void => {
      console.error("[costkey] Ingest listener error:", error);
      close();
      setTimeout(() => void listen(), 5_000).unref();
    };
    try {
      client = await pool.connect();
      client.on("notification", wake);
      // Stays attached after close: a closing connection can still report an error.
      client.on("error", (error) => { if (!closed) retry(error); });
      closeListener = close;
      await client.query(`LISTEN ${CHANNEL}`);
      if (stopped) close();
    } catch (error) {
      if (!closed) retry(error);
    }
  };
  void listen();

  const poll = setInterval(wake, options.pollMs ?? 2_000);
  poll.unref();
  wake();

  return {
    wake,
    stop: () => {
      stopped = true;
      clearInterval(poll);
      closeListener?.();
    },
  };
}

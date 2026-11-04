import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { accountingLockKey } from "../accounting.js";
import { createIngestRouter, ingestBatch } from "../ingest.js";
import { enqueueIngestBatch, ensureIngestQueueSchema, processNextIngestJob, startIngestWorker } from "../ingest-queue.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { configureRequestParsing } from "../request-parsing.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

async function withProject(fn: (ctx: { pool: pg.Pool; projectId: string; key: string; suffix: string }) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_queue_${suffix}`;
  const projectId = `project_queue_${suffix}`;
  const key = `key_queue_${suffix}`;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await ensureIngestQueueSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Queue',$2)", [orgId, `queue-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Queue',$2,$3)", [projectId, orgId, key]);
    await fn({ pool, projectId, key, suffix });
  } finally {
    await pool.query("DELETE FROM ingest_jobs WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM events WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
}

function callEvent(id: string): Record<string, unknown> {
  return {
    id, timestamp: new Date().toISOString(), durationMs: 400, provider: "openai", model: "gpt-4o", statusCode: 200,
    url: "https://api.openai.com/v1/chat/completions", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}

test("a queued batch is stored by the worker exactly once", { skip: !connectionString }, async () => {
  await withProject(async ({ pool, projectId, key, suffix }) => {
    const app = express();
    configureRequestParsing(app);
    app.use(createIngestRouter(pool, { queue: true }));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ sdkVersion: "0.7.4", events: [callEvent(`ev_a_${suffix}`), callEvent(`ev_b_${suffix}`)] }),
      });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { accepted: 2, queued: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const before = await pool.query("SELECT COUNT(*)::int AS n FROM events WHERE project_id = $1", [projectId]);
    assert.equal(before.rows[0].n, 0, "the request does not store events itself");
    const jobs = await pool.query("SELECT COUNT(*)::int AS n FROM ingest_jobs WHERE project_id = $1", [projectId]);
    assert.equal(jobs.rows[0].n, 1, "the batch waits as one job");

    // Drain whatever is due (other tests' jobs included) until ours is gone.
    while (await processNextIngestJob(pool)) { /* keep going */ }
    const after = await pool.query("SELECT COUNT(*)::int AS n FROM events WHERE project_id = $1", [projectId]);
    assert.equal(after.rows[0].n, 2, "the worker stores every event");
    const left = await pool.query("SELECT COUNT(*)::int AS n FROM ingest_jobs WHERE project_id = $1", [projectId]);
    assert.equal(left.rows[0].n, 0, "the job is removed with the batch it stored");
  });
});

test("a running worker is woken by a new batch and lets go of its connection when stopped", { skip: !connectionString }, async () => {
  await withProject(async ({ pool, projectId, suffix }) => {
    const until = async (what: string, check: () => Promise<boolean>): Promise<void> => {
      const deadline = Date.now() + 15_000;
      while (!await check()) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const listening = async (): Promise<number> => (await pool.query(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND query = 'LISTEN costkey_ingest' AND state = 'idle'`,
    )).rows[0].n as number;

    // The poll is far beyond the deadline, so only the notification can wake it.
    const worker = startIngestWorker(pool, { pollMs: 3_600_000 });
    try {
      await until("the worker to listen", async () => await listening() === 1);
      await enqueueIngestBatch(pool, projectId, { events: [callEvent(`ev_w_${suffix}`)] } as never);
      await until("the worker to store the batch", async () => (await pool.query(
        "SELECT 1 FROM events WHERE project_id = $1 AND id = $2",
        [projectId, `ev_w_${suffix}`],
      )).rows.length === 1);
      await until("the job to be removed", async () => (await pool.query(
        "SELECT 1 FROM ingest_jobs WHERE project_id = $1",
        [projectId],
      )).rows.length === 0);
    } finally {
      worker.stop();
    }
    await until("the listener to close", async () => await listening() === 0);
  });
});

test("a batch that fails is retried later with its error kept", { skip: !connectionString }, async () => {
  await withProject(async ({ pool, projectId }) => {
    const inserted = await pool.query(
      "INSERT INTO ingest_jobs (project_id, payload) VALUES ($1, $2) RETURNING id",
      [projectId, JSON.stringify({ events: "not a list" })],
    );
    const id = String(inserted.rows[0].id);
    while (await processNextIngestJob(pool)) {
      const mine = await pool.query("SELECT attempts FROM ingest_jobs WHERE id = $1", [id]);
      if (Number(mine.rows[0]?.attempts) >= 1) break;
    }
    const job = await pool.query(
      "SELECT attempts, last_error, failed_at, next_run_at > NOW() AS later FROM ingest_jobs WHERE id = $1",
      [id],
    );
    assert.equal(job.rows[0].attempts, 1);
    assert.ok(job.rows[0].last_error, "the error is kept on the job");
    assert.equal(job.rows[0].failed_at, null, "one failure does not give up");
    assert.equal(job.rows[0].later, true, "the retry waits");
  });
});

test("batches for one project no longer wait on each other", { skip: !connectionString }, async () => {
  await withProject(async ({ pool, projectId, suffix }) => {
    // Another batch is mid-transaction for the same project.
    const other = await pool.connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [accountingLockKey(projectId)]);
      const stored = await Promise.race([
        ingestBatch(pool, projectId, { events: [callEvent(`ev_c_${suffix}`)] } as never),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5_000).unref()),
      ]);
      assert.notEqual(stored, "blocked");
      assert.equal((stored as { accepted: number }).accepted, 1);
    } finally {
      await other.query("ROLLBACK");
      other.release();
    }
  });
});

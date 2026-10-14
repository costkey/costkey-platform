import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { createIngestRouter } from "../ingest.js";
import { loadOverviewBoard } from "../insights-api.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { ensureReleaseSchema, listReleases } from "../releases.js";
import { configureRequestParsing } from "../request-parsing.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";

test("each deploy is recorded with its commit and repository, and metrics narrow to one deploy", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_rel_${suffix}`;
  const projectId = `project_rel_${suffix}`;
  const key = `key_rel_${suffix}`;
  const app = express();
  configureRequestParsing(app);
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await ensureReleaseSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Releases',$2)", [orgId, `rel-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Releases',$2,$3)", [projectId, orgId, key]);
    app.use(createIngestRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    const send = async (release: string, extra: Record<string, unknown>, calls: number, minutesAgo: number) => {
      const events = Array.from({ length: calls }, (_, index) => ({
        id: `ev_rel_${suffix}_${release.slice(0, 4)}_${index}`,
        timestamp: new Date(Date.now() - (minutesAgo - index) * 60_000).toISOString(),
        durationMs: 500, provider: "openai", model: "gpt-4o-mini", statusCode: 200,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }));
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ sdkVersion: "0.7.7", release, ...extra, events }),
      });
      assert.equal(response.status, 202, await response.text());
    };
    try {
      await send(OLD, { commit: OLD, repository: "git@github.com:acme/app.git" }, 3, 120);
      await send(NEW, { commit: NEW, repository: "https://token@github.com/acme/app.git" }, 2, 30);
      // The release record is written beside the batch; give it a moment.
      for (let attempt = 0; attempt < 50; attempt++) {
        const rows = await pool.query("SELECT 1 FROM releases WHERE project_id = $1", [projectId]);
        if (rows.rowCount === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const { releases } = await listReleases(pool, projectId);
      assert.deepEqual(releases.map((row) => row.release), [NEW, OLD], "newest deploy first");
      assert.equal(releases[0]!.repository, "https://github.com/acme/app", "no credentials kept");
      assert.equal(releases[0]!.commitUrl, `https://github.com/acme/app/commit/${NEW}`);
      assert.equal(releases[1]!.calls, 3);

      const window = { from: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), environment: null };
      const all = await loadOverviewBoard(pool, projectId, window, "UTC");
      const old = await loadOverviewBoard(pool, projectId, { ...window, release: OLD }, "UTC");
      const calls = (board: typeof all) => board.models.reduce((sum, model) => sum + model.calls, 0);
      assert.equal(calls(all), 5);
      assert.equal(calls(old), 3, "one deploy's calls only");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

test("a release without a commit links through the project's repository when it is a SHA", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_rel2_${suffix}`;
  const projectId = `project_rel2_${suffix}`;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await ensureReleaseSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Releases',$2)", [orgId, `rel2-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Releases',$2,$3)", [projectId, orgId, `key_rel2_${suffix}`]);
    await pool.query("INSERT INTO project_settings (project_id, repository_url) VALUES ($1, 'https://github.com/acme/app') ON CONFLICT (project_id) DO UPDATE SET repository_url = EXCLUDED.repository_url", [projectId]);
    // An older call that carries its release in the column only.
    await pool.query("INSERT INTO events (id, project_id, timestamp, provider, model, release) VALUES ($1, $2, NOW(), 'openai', 'gpt-4o-mini', 'abcdef1')", [`ev_rel2_${suffix}`, projectId]);
    await pool.query("INSERT INTO events (id, project_id, timestamp, provider, model, release) VALUES ($1, $2, NOW(), 'openai', 'gpt-4o-mini', 'v1.4.0')", [`ev_rel2b_${suffix}`, projectId]);
    const { releases } = await listReleases(pool, projectId);
    const sha = releases.find((row) => row.release === "abcdef1");
    const named = releases.find((row) => row.release === "v1.4.0");
    assert.equal(sha?.commitUrl, "https://github.com/acme/app/commit/abcdef1");
    assert.equal(named?.commitUrl, null, "a release name isn't a commit");
  } finally {
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]).catch(() => undefined);
    await pool.end();
  }
});

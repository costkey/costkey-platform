import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { initDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { createPrivacyRouter } from "../privacy.js";
import { cleanChunk, createReplayIngestRouter, createReplayRouter, purgeExpiredReplay } from "../replay.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

test("replay chunks are checked before they're stored", () => {
  const ok = cleanChunk({ recordingId: "rec_12345678", seq: 0, traceId: "tr_1", events: [{ type: 4, timestamp: 1_700_000_000_000 }, { type: 2, timestamp: 1_700_000_000_500 }] });
  assert.ok(typeof ok !== "string");
  assert.equal(ok.events.length, 2);
  assert.equal(ok.startedAt?.getTime(), 1_700_000_000_000);
  assert.equal(ok.endedAt?.getTime(), 1_700_000_000_500);
  assert.equal(typeof cleanChunk({ recordingId: "short", seq: 0, events: [{ type: 2, timestamp: 1 }] }), "string");
  assert.equal(typeof cleanChunk({ recordingId: "rec_12345678", seq: -1, events: [{ type: 2, timestamp: 1 }] }), "string");
  assert.equal(typeof cleanChunk({ recordingId: "rec_12345678", seq: 0, events: [] }), "string");
  assert.equal(typeof cleanChunk({ recordingId: "rec_12345678", seq: 0, events: [{ type: "x", timestamp: 1 }] }), "string");
  assert.equal(typeof cleanChunk({ recordingId: "rec_12345678", seq: 0, traceId: 5, events: [{ type: 2, timestamp: 1 }] }), "string");
  const untraced = cleanChunk({ recordingId: "rec_12345678", seq: 3, events: [{ type: 3, timestamp: 2 }] });
  assert.ok(typeof untraced !== "string" && untraced.traceId === null);
});

test("browser replay: switch, chunks, assets, reads, retention and deletion", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_replay_${suffix}`;
  const otherOrgId = `org_replay_other_${suffix}`;
  const projectId = `project_replay_${suffix}`;
  const key = `key_replay_${suffix}`;
  const userId = `user_replay_${suffix}`;
  const traceId = `tr_replay_${suffix}`;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    // Orgs and their owners in one transaction: other test files check every workspace has an owner.
    const setup = await pool.connect();
    try {
      await setup.query("BEGIN");
      await setup.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Replay',$2), ($3,'Other',$4)", [orgId, `replay-${suffix}`, otherOrgId, `replay-other-${suffix}`]);
      await setup.query("INSERT INTO users(id,email,name,password_hash,org_id,role) VALUES ($1,$2,'Owner','x',$3,'owner'), ($4,$5,'Owner','x',$6,'owner')", [userId, `replay-${suffix}@example.test`, orgId, `${userId}_other`, `replay-other-${suffix}@example.test`, otherOrgId]);
      await setup.query("COMMIT");
    } finally {
      setup.release();
    }
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Replay',$2,$3)", [projectId, orgId, key]);
    await pool.query(
      `INSERT INTO project_settings (project_id, capture_mode, body_capture_enabled, source_access_enabled, screen_capture_enabled)
       VALUES ($1, 'metadata', FALSE, TRUE, FALSE)`,
      [projectId],
    );

    let currentUser: Record<string, unknown> | null = { id: userId, orgId, role: "owner" };
    const app = express();
    app.use((req, _res, next) => { if (currentUser) (req as unknown as { user: unknown }).user = currentUser; next(); });
    app.use("/api/v1/replay/chunks", express.json({ limit: "16mb" }));
    app.use(express.json());
    app.use(createReplayIngestRouter(pool));
    app.use(createReplayRouter(pool));
    app.use(createPrivacyRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const now = Date.now();
    const chunk = (recordingId: string, seq: number, trace: string | null, events: unknown[]) => fetch(`${base}/api/v1/replay/chunks`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${key}` },
      body: gzipSync(Buffer.from(JSON.stringify({ recordingId, seq, traceId: trace, events }))),
    });
    const png = Buffer.from("89504e470d0a1a0a" + "00".repeat(40), "hex");
    const pngSha = createHash("sha256").update(png).digest("hex");
    const asset = (method: "HEAD" | "PUT", sha = pngSha, type = "image/png", body?: Buffer) => fetch(`${base}/api/v1/replay/assets/${sha}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": type },
      body: method === "PUT" ? (body ?? png) : undefined,
    });
    const readReplay = async () => {
      const res = await fetch(`${base}/api/v1/projects/${projectId}/traces/${traceId}/replay`);
      return { status: res.status, body: (await res.json()) as { recordings: Array<{ id: string; events: Array<{ type: number; timestamp: number }>; startedAt: string }>; truncated: boolean } };
    };

    try {
      // Off: refused with 422 so the recorder stops.
      assert.equal((await chunk("rec_page_one", 0, traceId, [{ type: 2, timestamp: now }])).status, 422);
      assert.equal((await asset("HEAD")).status, 422);
      assert.equal((await asset("PUT")).status, 422);
      await pool.query("UPDATE project_settings SET screen_capture_enabled = TRUE WHERE project_id = $1", [projectId]);

      // Chunks: auth, shape, idempotent per (recording, seq).
      const badKey = await fetch(`${base}/api/v1/replay/chunks`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" }, body: "{}" });
      assert.equal(badKey.status, 401);
      assert.equal((await chunk("bad", 0, traceId, [{ type: 2, timestamp: now }])).status, 400);
      // Two pages in the run, the second page's chunks arriving out of order.
      assert.equal((await chunk("rec_page_one", 0, traceId, [{ type: 4, timestamp: now }, { type: 2, timestamp: now + 1 }])).status, 201);
      assert.equal((await chunk("rec_page_one", 1, traceId, [{ type: 3, timestamp: now + 500 }, { type: 5, timestamp: now + 600, data: { tag: "costkey.action" } }])).status, 201);
      assert.equal((await chunk("rec_page_one", 1, traceId, [{ type: 3, timestamp: now + 500 }])).status, 200, "a retried chunk is ignored");
      assert.equal((await chunk("rec_page_two", 1, traceId, [{ type: 3, timestamp: now + 3000 }])).status, 201);
      assert.equal((await chunk("rec_page_two", 0, traceId, [{ type: 4, timestamp: now + 2000 }, { type: 2, timestamp: now + 2001 }])).status, 201);
      // Another run on the same page, and a page outside any run.
      assert.equal((await chunk("rec_page_one", 2, `${traceId}_next`, [{ type: 4, timestamp: now + 9000 }])).status, 201);
      assert.equal((await chunk("rec_page_three", 0, null, [{ type: 4, timestamp: now + 9000 }])).status, 201);

      // Assets: HEAD says whether to upload; PUT checks type and hash.
      assert.equal((await asset("HEAD")).status, 404);
      assert.equal((await asset("PUT", pngSha, "text/html")).status, 415);
      assert.equal((await asset("PUT", "d".repeat(64))).status, 400);
      assert.equal((await asset("PUT")).status, 201);
      assert.equal((await asset("PUT")).status, 200);
      assert.equal((await asset("HEAD")).status, 200);

      // The run's replay: both pages, each in order, by start time.
      const { status, body } = await readReplay();
      assert.equal(status, 200);
      assert.equal(body.truncated, false);
      assert.deepEqual(body.recordings.map((recording) => recording.id), ["rec_page_one", "rec_page_two"]);
      assert.deepEqual(body.recordings[0]!.events.map((event) => event.type), [4, 2, 3, 5]);
      assert.deepEqual(body.recordings[1]!.events.map((event) => event.timestamp - now), [2000, 2001, 3000]);
      assert.equal(new Date(body.recordings[0]!.startedAt).getTime(), now);

      // Assets for members; other orgs, viewers and signed-out requests get nothing.
      const read = await fetch(`${base}/api/v1/projects/${projectId}/replay-assets/${pngSha}`);
      assert.equal(read.status, 200);
      assert.equal(read.headers.get("content-type"), "image/png");
      assert.equal(read.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await read.arrayBuffer()), png);
      currentUser = { id: `someone_${suffix}`, orgId: otherOrgId, role: "owner" };
      assert.equal((await fetch(`${base}/api/v1/projects/${projectId}/traces/${traceId}/replay`)).status, 404);
      assert.equal((await fetch(`${base}/api/v1/projects/${projectId}/replay-assets/${pngSha}`)).status, 404);
      await pool.query("INSERT INTO project_memberships (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [projectId, userId]);
      currentUser = { id: userId, orgId, role: "viewer" };
      assert.deepEqual((await readReplay()).body.recordings, []);
      assert.equal((await fetch(`${base}/api/v1/projects/${projectId}/replay-assets/${pngSha}`)).status, 404);
      currentUser = { id: userId, orgId, role: "developer" };
      assert.equal((await readReplay()).body.recordings.length, 2);
      currentUser = null;
      assert.equal((await fetch(`${base}/api/v1/projects/${projectId}/traces/${traceId}/replay`)).status, 401);
      currentUser = { id: userId, orgId, role: "owner" };

      // Retention: old chunks go; an asset stays while recent replays still use it.
      await pool.query("UPDATE replay_chunks SET created_at = NOW() - INTERVAL '30 days' WHERE project_id = $1 AND recording_id = 'rec_page_three'", [projectId]);
      await pool.query("UPDATE replay_assets SET created_at = NOW() - INTERVAL '30 days' WHERE project_id = $1", [projectId]);
      assert.equal(await purgeExpiredReplay(pool, new Date(), otherOrgId), 0, "another org's run leaves these alone");
      assert.equal(await purgeExpiredReplay(pool), 1);
      assert.equal((await asset("HEAD")).status, 200);
      await pool.query("UPDATE replay_assets SET last_used_at = NOW() - INTERVAL '30 days' WHERE project_id = $1", [projectId]);
      assert.equal(await purgeExpiredReplay(pool), 1);
      assert.equal((await asset("HEAD")).status, 404);

      // Deleting captured content removes every replay.
      assert.equal((await asset("PUT")).status, 201);
      const deleted = await fetch(`${base}/api/v1/projects/${projectId}/privacy/delete-content`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmProjectId: projectId }),
      });
      assert.equal(deleted.status, 200, await deleted.clone().text());
      assert.equal(Number((await pool.query("SELECT COUNT(*) FROM replay_chunks WHERE project_id = $1", [projectId])).rows[0].count), 0);
      assert.equal(Number((await pool.query("SELECT COUNT(*) FROM replay_assets WHERE project_id = $1", [projectId])).rows[0].count), 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [[userId, `${userId}_other`]]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = ANY($1)", [[orgId, otherOrgId]]).catch(() => undefined);
    await pool.end();
  }
});

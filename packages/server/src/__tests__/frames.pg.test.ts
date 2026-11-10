import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import { initDatabase } from "../db.js";
import { ensurePlatformSchema } from "../platform-storage.js";
import { createIngestRouter } from "../ingest.js";
import { createIngestRuntimeConfigRouter, createPrivacyRouter, privacyIngestGuard } from "../privacy.js";
import { cleanFrameRefs, createFrameIngestRouter, createFramesRouter, purgeExpiredFrames } from "../frames.js";
import { invalidateSummaries } from "../response-cache.js";

const connectionString = process.env["ACCOUNTING_TEST_DATABASE_URL"];

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(fill: number): { data: Buffer; sha256: string } {
  const data = Buffer.concat([PNG_HEADER, Buffer.alloc(300, fill)]);
  return { data, sha256: createHash("sha256").update(data).digest("hex") };
}

test("frame lists are kept only when well formed", () => {
  const sha = "a".repeat(64);
  assert.deepEqual(cleanFrameRefs([{ sha256: sha, mediaType: "IMAGE/PNG", bytes: 10, extra: 1 }]), [{ sha256: sha, mediaType: "image/png", bytes: 10 }]);
  assert.deepEqual(cleanFrameRefs([{ sha256: sha, mediaType: "image/png", bytes: 10, omitted: "too_large" }])?.[0]?.omitted, "too_large");
  assert.equal(cleanFrameRefs([{ sha256: "nope", mediaType: "image/png", bytes: 10 }]), null);
  assert.equal(cleanFrameRefs([{ sha256: sha, mediaType: "text/html", bytes: 10 }]), null);
  assert.equal(cleanFrameRefs([]), null);
  assert.equal(cleanFrameRefs("x"), null);
  assert.equal(cleanFrameRefs(Array.from({ length: 80 }, () => ({ sha256: sha, mediaType: "image/png", bytes: 1 })))?.length, 64);
});

test("screen capture: project setting, uploads, ingest, reads and retention", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const suffix = randomBytes(6).toString("hex");
  const orgId = `org_frames_${suffix}`;
  const otherOrgId = `org_frames_other_${suffix}`;
  const projectId = `project_frames_${suffix}`;
  const key = `key_frames_${suffix}`;
  const userId = `user_frames_${suffix}`;
  try {
    await initDatabase();
    await ensurePlatformSchema(pool);
    await pool.query("INSERT INTO orgs(id,name,slug) VALUES ($1,'Frames',$2), ($3,'Other',$4)", [orgId, `frames-${suffix}`, otherOrgId, `frames-other-${suffix}`]);
    await pool.query("INSERT INTO projects(id,name,org_id,auth_key) VALUES ($1,'Frames',$2,$3)", [projectId, orgId, key]);
    await pool.query(
      `INSERT INTO project_settings (project_id, capture_mode, body_capture_enabled, source_access_enabled)
       VALUES ($1, 'metadata', FALSE, TRUE)`,
      [projectId],
    );

    let currentUser: Record<string, unknown> | null = { id: userId, orgId, role: "owner" };
    const app = express();
    app.use((req, _res, next) => { if (currentUser) (req as unknown as { user: unknown }).user = currentUser; next(); });
    app.use("/api/v1/events", express.json({ limit: "2mb" }), privacyIngestGuard(pool));
    app.use(express.json());
    app.use(createIngestRuntimeConfigRouter(pool));
    app.use(createIngestRouter(pool));
    app.use(createFrameIngestRouter(pool));
    app.use(createFramesRouter(pool));
    // The privacy router's PATCH writes updated_by; give it a real user.
    await pool.query("INSERT INTO users(id,email,name,password_hash,org_id,role) VALUES ($1,$2,'Owner','x',$3,'owner')", [userId, `frames-${suffix}@example.test`, orgId]);
    app.use(createPrivacyRouter(pool));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const put = (frame: { data: Buffer; sha256: string }, options: { key?: string; type?: string; path?: string } = {}) =>
      fetch(`${base}/api/v1/frames/${options.path ?? frame.sha256}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${options.key ?? key}`, "content-type": options.type ?? "image/png" },
        body: frame.data,
      });
    const config = async () => (await (await fetch(`${base}/api/v1/projects/${projectId}/config`, { headers: { authorization: `Bearer ${key}` } })).json()) as { capture: Record<string, unknown> };
    const shot = png(1);
    const call = (id: string, frames: unknown) => ({
      id,
      timestamp: new Date().toISOString(),
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      statusCode: 200,
      durationMs: 120,
      streaming: false,
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      context: { traceId: `tr_${suffix}` },
      frames,
    });
    const postEvents = (events: unknown[]) => fetch(`${base}/api/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ sdkVersion: "0.7.8", events }),
    });
    const refs = [{ sha256: shot.sha256, mediaType: "image/png", bytes: shot.data.length }];

    try {
      // Off by default: the config says so, uploads are refused, frame lists are dropped.
      assert.equal((await config()).capture["screenCaptureEnabled"], false);
      assert.equal((await put(shot)).status, 422);
      assert.equal((await postEvents([call(`evt_off_${suffix}`, refs)])).status, 202);
      const off = await pool.query("SELECT frames FROM events WHERE project_id = $1 AND id = $2", [projectId, `evt_off_${suffix}`]);
      assert.equal(off.rows[0]?.frames, null);

      // An owner turns it on through the privacy settings, with the whole
      // form as the console sends it (capture mode and body capture together).
      const patched = await fetch(`${base}/api/v1/projects/${projectId}/privacy`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ captureMode: "metadata", bodyCaptureEnabled: false, bodyRetentionDays: 7, metadataRetentionDays: 30, screenCaptureEnabled: true }),
      });
      assert.equal(patched.status, 200, await patched.clone().text());
      assert.equal(((await patched.json()) as { settings: Record<string, unknown> }).settings["screenCaptureEnabled"], true);
      invalidateSummaries(projectId);
      assert.equal((await config()).capture["screenCaptureEnabled"], true);

      // Uploads: checked, stored once.
      assert.equal((await put(shot, { key: "wrong" })).status, 401);
      assert.equal((await put(shot, { type: "text/html" })).status, 415);
      assert.equal((await put(shot, { path: "b".repeat(64) })).status, 400, "the body must match its hash");
      assert.equal((await put(shot)).status, 201);
      assert.equal((await put(shot)).status, 200);
      assert.equal(Number((await pool.query("SELECT COUNT(*) FROM frames WHERE project_id = $1", [projectId])).rows[0].count), 1);

      // Calls keep their frame list.
      assert.equal((await postEvents([call(`evt_on_${suffix}`, refs)])).status, 202);
      const on = await pool.query("SELECT frames FROM events WHERE project_id = $1 AND id = $2", [projectId, `evt_on_${suffix}`]);
      assert.deepEqual(on.rows[0]?.frames, refs);

      // Members read the bytes; other orgs and signed-out requests can't.
      const read = await fetch(`${base}/api/v1/projects/${projectId}/frames/${shot.sha256}`);
      assert.equal(read.status, 200);
      assert.equal(read.headers.get("content-type"), "image/png");
      assert.deepEqual(Buffer.from(await read.arrayBuffer()), shot.data);
      assert.equal((await fetch(`${base}/api/v1/projects/${projectId}/frames/${"c".repeat(64)}`)).status, 404);
      currentUser = { id: `someone_${suffix}`, orgId: otherOrgId, role: "owner" };
      assert.equal((await fetch(`${base}/api/v1/projects/${projectId}/frames/${shot.sha256}`)).status, 404);
      currentUser = null;
      assert.equal((await fetch(`${base}/api/v1/projects/${projectId}/frames/${shot.sha256}`)).status, 401);
      currentUser = { id: userId, orgId, role: "owner" };

      // Retention: frames older than body retention go.
      await pool.query("UPDATE frames SET created_at = NOW() - INTERVAL '30 days' WHERE project_id = $1", [projectId]);
      assert.equal(await purgeExpiredFrames(pool, new Date(), otherOrgId), 0, "another org's run leaves these alone");
      assert.equal(await purgeExpiredFrames(pool), 1);
      assert.equal((await fetch(`${base}/api/v1/projects/${projectId}/frames/${shot.sha256}`)).status, 404);

      // Deleting captured content removes frames and frame lists.
      assert.equal((await put(shot)).status, 201);
      const deleted = await fetch(`${base}/api/v1/projects/${projectId}/privacy/delete-content`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmProjectId: projectId }),
      });
      assert.equal(deleted.status, 200, await deleted.clone().text());
      assert.equal(Number((await pool.query("SELECT COUNT(*) FROM frames WHERE project_id = $1", [projectId])).rows[0].count), 0);
      assert.equal((await pool.query("SELECT COUNT(*) FROM events WHERE project_id = $1 AND frames IS NOT NULL", [projectId])).rows[0].count, "0");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await pool.query("DELETE FROM events WHERE project_id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id = ANY($1)", [[orgId, otherOrgId]]).catch(() => undefined);
    await pool.end();
  }
});

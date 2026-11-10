import express, { Router as createRouter, type Request, type Response, type Router } from "express";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import { assertProjectAccess, roleCanReadContent } from "./permissions.js";

/**
 * Browser replays from `@costkey/replay`: rrweb recordings of the pages an
 * agent drove, uploaded as ordered chunks per page (recording) and tagged with
 * the run (trace) they happened in, plus the images and fonts those pages
 * loaded, stored once per project by SHA-256. Same switch and retention as
 * screen capture frames: off unless the project turns screen recordings on,
 * kept for the body retention period, readable only with content access.
 */

const SHA256 = /^[0-9a-f]{64}$/;
const RECORDING_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_EVENTS_PER_CHUNK = 50_000;
const MAX_TRACE_ID = 200;
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
/** What one run's replay may add up to when read back (uncompressed event JSON). */
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const ASSET_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon",
  "font/woff", "font/woff2", "font/ttf", "font/otf", "font/sfnt",
  "application/font-woff", "application/font-woff2", "application/x-font-woff", "application/x-font-ttf", "application/x-font-otf", "application/vnd.ms-fontobject",
]);

export async function ensureReplaySchema(client: pg.Pool | pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS replay_chunks (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      recording_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      trace_id TEXT,
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      event_count INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, recording_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_replay_chunks_trace ON replay_chunks(project_id, trace_id) WHERE trace_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_replay_chunks_created ON replay_chunks(project_id, created_at);
    CREATE TABLE IF NOT EXISTS replay_assets (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL,
      media_type TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, sha256)
    );
    CREATE INDEX IF NOT EXISTS idx_replay_assets_used ON replay_assets(project_id, last_used_at);
  `);
}

interface CleanChunk {
  recordingId: string;
  seq: number;
  traceId: string | null;
  events: Array<{ type: number; timestamp: number }>;
  startedAt: Date | null;
  endedAt: Date | null;
}

/** A chunk as the recorder sends it, or a reason it can't be stored. */
export function cleanChunk(body: unknown): CleanChunk | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Expected a JSON object";
  const { recordingId, seq, traceId, events } = body as Record<string, unknown>;
  if (typeof recordingId !== "string" || !RECORDING_ID.test(recordingId)) return "recordingId must be 8–64 letters, digits, - or _";
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > 1_000_000) return "seq must be a whole number from 0";
  if (traceId !== null && traceId !== undefined && (typeof traceId !== "string" || traceId.length === 0 || traceId.length > MAX_TRACE_ID)) return "traceId must be a string or null";
  if (!Array.isArray(events) || events.length === 0) return "events must be a non-empty array";
  if (events.length > MAX_EVENTS_PER_CHUNK) return `A chunk holds at most ${MAX_EVENTS_PER_CHUNK} events`;
  let first = Infinity;
  let last = -Infinity;
  for (const event of events) {
    if (!event || typeof event !== "object") return "Every event must be an object";
    const { type, timestamp } = event as { type?: unknown; timestamp?: unknown };
    if (typeof type !== "number" || !Number.isInteger(type) || typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      return "Every event needs a numeric type and timestamp";
    }
    first = Math.min(first, timestamp);
    last = Math.max(last, timestamp);
  }
  const date = (ms: number) => (ms > 0 && ms < 8.64e15 ? new Date(ms) : null);
  return { recordingId, seq, traceId: (traceId as string | null | undefined) ?? null, events: events as CleanChunk["events"], startedAt: date(first), endedAt: date(last) };
}

/** The project for a DSN key, and whether it records screens. */
async function projectForKey(pool: pg.Pool, req: Request): Promise<{ id: string; enabled: boolean } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const result = await pool.query(
    `SELECT p.id, COALESCE(s.screen_capture_enabled, FALSE) AS screen_capture_enabled
     FROM projects p LEFT JOIN project_settings s ON s.project_id = p.id
     WHERE p.auth_key = $1`,
    [authHeader.slice(7)],
  );
  const row = result.rows[0] as { id: string; screen_capture_enabled: boolean } | undefined;
  return row ? { id: row.id, enabled: row.screen_capture_enabled } : null;
}

/** Recorder uploads, DSN auth: chunks, and assets checked with HEAD then sent with PUT. */
export function createReplayIngestRouter(pool: pg.Pool): Router {
  const router = createRouter();

  router.post("/api/v1/replay/chunks", async (req: Request, res: Response) => {
    try {
      const project = await projectForKey(pool, req);
      if (!project) { res.status(401).json({ error: "Missing or invalid authorization" }); return; }
      // 422, not 403: the recorder stops for good and the agent carries on.
      if (!project.enabled) { res.status(422).json({ error: "Screen recordings are off for this project" }); return; }
      const chunk = cleanChunk(req.body);
      if (typeof chunk === "string") { res.status(400).json({ error: chunk }); return; }
      const json = Buffer.from(JSON.stringify(chunk.events));
      const result = await pool.query(
        `INSERT INTO replay_chunks (project_id, recording_id, seq, trace_id, started_at, ended_at, event_count, bytes, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (project_id, recording_id, seq) DO NOTHING`,
        [project.id, chunk.recordingId, chunk.seq, chunk.traceId, chunk.startedAt, chunk.endedAt, chunk.events.length, json.length, gzipSync(json)],
      );
      res.status((result.rowCount ?? 0) > 0 ? 201 : 200).end();
    } catch (error) {
      console.error("[costkey] Replay chunk error:", error instanceof Error ? error.message : error);
      res.status(500).json({ error: "Replay upload failed" });
    }
  });

  router.head("/api/v1/replay/assets/:sha256", async (req: Request, res: Response) => {
    try {
      const sha256 = String(req.params.sha256 ?? "").toLowerCase();
      if (!SHA256.test(sha256)) { res.status(400).end(); return; }
      const project = await projectForKey(pool, req);
      if (!project) { res.status(401).end(); return; }
      if (!project.enabled) { res.status(422).end(); return; }
      // A hit keeps the asset alive: newer replays reference it without uploading it again.
      const found = await pool.query(
        "UPDATE replay_assets SET last_used_at = NOW() WHERE project_id = $1 AND sha256 = $2",
        [project.id, sha256],
      );
      res.status((found.rowCount ?? 0) > 0 ? 200 : 404).end();
    } catch (error) {
      console.error("[costkey] Replay asset check error:", error instanceof Error ? error.message : error);
      res.status(500).end();
    }
  });

  router.put(
    "/api/v1/replay/assets/:sha256",
    express.raw({ type: () => true, limit: MAX_ASSET_BYTES + 1024 }),
    async (req: Request, res: Response) => {
      try {
        const sha256 = String(req.params.sha256 ?? "").toLowerCase();
        if (!SHA256.test(sha256)) { res.status(400).json({ error: "The path must be the asset's SHA-256" }); return; }
        const project = await projectForKey(pool, req);
        if (!project) { res.status(401).json({ error: "Missing or invalid authorization" }); return; }
        if (!project.enabled) { res.status(422).json({ error: "Screen recordings are off for this project" }); return; }
        const mediaType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        if (!ASSET_TYPES.has(mediaType)) { res.status(415).json({ error: "Assets must be images or fonts" }); return; }
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (data.length === 0) { res.status(400).json({ error: "Empty asset" }); return; }
        if (data.length > MAX_ASSET_BYTES) { res.status(413).json({ error: "Assets are limited to 2 MB" }); return; }
        if (createHash("sha256").update(data).digest("hex") !== sha256) {
          res.status(400).json({ error: "The body doesn't match the SHA-256 in the path" }); return;
        }
        const result = await pool.query(
          `INSERT INTO replay_assets (project_id, sha256, media_type, bytes, data) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (project_id, sha256) DO UPDATE SET last_used_at = NOW()
           RETURNING (xmax = 0) AS created`,
          [project.id, sha256, mediaType, data.length, data],
        );
        res.status((result.rows[0] as { created: boolean } | undefined)?.created ? 201 : 200).end();
      } catch (error) {
        console.error("[costkey] Replay asset upload error:", error instanceof Error ? error.message : error);
        res.status(500).json({ error: "Replay asset upload failed" });
      }
    },
  );

  return router;
}

export interface ReplayRecording {
  id: string;
  startedAt: string | null;
  endedAt: string | null;
  events: unknown[];
}

/** One run's recordings, each page's chunks joined in order. Read once per request. */
export async function loadRunReplay(pool: pg.Pool, projectId: string, traceId: string): Promise<{ recordings: ReplayRecording[]; truncated: boolean }> {
  const result = await pool.query(
    `SELECT recording_id, started_at, ended_at, data
     FROM replay_chunks
     WHERE project_id = $1 AND trace_id = $2
     ORDER BY recording_id, seq`,
    [projectId, traceId],
  );
  const byId = new Map<string, ReplayRecording>();
  let total = 0;
  let truncated = false;
  for (const row of result.rows as Array<{ recording_id: string; started_at: Date | null; ended_at: Date | null; data: Buffer }>) {
    const json = gunzipSync(row.data);
    total += json.length;
    if (total > MAX_REPLAY_BYTES) { truncated = true; break; }
    const recording = byId.get(row.recording_id) ?? { id: row.recording_id, startedAt: null, endedAt: null, events: [] };
    for (const event of JSON.parse(json.toString("utf8")) as unknown[]) recording.events.push(event);
    const started = row.started_at?.toISOString() ?? null;
    const ended = row.ended_at?.toISOString() ?? null;
    if (started && (!recording.startedAt || started < recording.startedAt)) recording.startedAt = started;
    if (ended && (!recording.endedAt || ended > recording.endedAt)) recording.endedAt = ended;
    byId.set(row.recording_id, recording);
  }
  const recordings = [...byId.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  return { recordings, truncated };
}

type AuthedRequest = Request & { user?: { id: string; orgId: string; role: string } };

/** Console reads, for signed-in members who can read captured content. */
export function createReplayRouter(pool: pg.Pool): Router {
  const router = createRouter();

  router.get("/api/v1/projects/:projectId/traces/:traceId/replay", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = (req as AuthedRequest).user!;
      const projectId = String(req.params.projectId);
      await assertProjectAccess(pool, user, projectId);
      // Recordings are captured content: Viewers get nothing, not an error.
      if (!roleCanReadContent(user.role)) { res.json({ recordings: [], truncated: false }); return; }
      const traceId = String(req.params.traceId ?? "");
      if (!traceId || traceId.length > MAX_TRACE_ID) { res.json({ recordings: [], truncated: false }); return; }
      res.set("Cache-Control", "private, no-store").json(await loadRunReplay(pool, projectId, traceId));
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status) { res.status(status).json({ error: (error as Error).message }); return; }
      console.error("[costkey] Replay read error:", error);
      res.status(500).json({ error: "Failed to read the replay" });
    }
  });

  router.get("/api/v1/projects/:projectId/replay-assets/:sha256", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = (req as AuthedRequest).user!;
      const projectId = String(req.params.projectId);
      const sha256 = String(req.params.sha256 ?? "").toLowerCase();
      if (!SHA256.test(sha256)) { res.status(404).json({ error: "Asset not found" }); return; }
      await assertProjectAccess(pool, user, projectId);
      if (!roleCanReadContent(user.role)) { res.status(404).json({ error: "Asset not found" }); return; }
      const result = await pool.query("SELECT media_type, data FROM replay_assets WHERE project_id = $1 AND sha256 = $2", [projectId, sha256]);
      const row = result.rows[0] as { media_type: string; data: Buffer } | undefined;
      if (!row) { res.status(404).json({ error: "Asset not found" }); return; }
      res.set({
        "Content-Type": row.media_type,
        "Cache-Control": "private, max-age=86400, immutable",
        "X-Content-Type-Options": "nosniff",
        // SVGs opened on their own can't run anything.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        "Cross-Origin-Resource-Policy": "same-origin",
      }).send(row.data);
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status) { res.status(status).json({ error: (error as Error).message }); return; }
      console.error("[costkey] Replay asset read error:", error);
      res.status(500).json({ error: "Failed to read the asset" });
    }
  });

  return router;
}

/** Delete replay chunks older than each project's body retention, and assets no recent replay used. */
export async function purgeExpiredReplay(pool: pg.Pool, now = new Date(), orgId?: string): Promise<number> {
  const chunks = await pool.query(
    `DELETE FROM replay_chunks c
     USING project_settings s, projects p
     WHERE c.project_id = s.project_id AND p.id = c.project_id
       AND ($2::text IS NULL OR p.org_id = $2)
       AND c.created_at < $1::timestamptz - make_interval(days => s.body_retention_days)`,
    [now, orgId ?? null],
  );
  const assets = await pool.query(
    `DELETE FROM replay_assets a
     USING project_settings s, projects p
     WHERE a.project_id = s.project_id AND p.id = a.project_id
       AND ($2::text IS NULL OR p.org_id = $2)
       AND a.last_used_at < $1::timestamptz - make_interval(days => s.body_retention_days)`,
    [now, orgId ?? null],
  );
  return (chunks.rowCount ?? 0) + (assets.rowCount ?? 0);
}

/** Delete every replay a project holds (with "Delete stored prompts"). */
export async function deleteProjectReplay(pool: pg.Pool, projectId: string): Promise<number> {
  const chunks = await pool.query("DELETE FROM replay_chunks WHERE project_id = $1", [projectId]);
  const assets = await pool.query("DELETE FROM replay_assets WHERE project_id = $1", [projectId]);
  return (chunks.rowCount ?? 0) + (assets.rowCount ?? 0);
}

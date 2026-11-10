import express, { Router as createRouter, type Request, type Response, type Router } from "express";
import { createHash } from "node:crypto";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import { assertProjectAccess, roleCanReadContent } from "./permissions.js";

/**
 * Screen capture: images an agent sent to the model, uploaded once each by the
 * SDK and keyed by the SHA-256 of their bytes. Call events list them in
 * request order (`events.frames`); the console replays a run from them.
 * Off unless the project turns screen capture on (and the app opts in).
 */

/** The largest image the SDK uploads; anything bigger is listed as omitted. */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_REFS_PER_CALL = 64;
const SHA256 = /^[0-9a-f]{64}$/;
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface FrameRef {
  sha256: string;
  mediaType: string;
  bytes: number;
  omitted?: "too_large";
}

/** Where frame bytes live. Postgres today; object storage can implement the same two calls. */
export interface FrameStore {
  /** Store bytes under their hash; false when the project already had them. */
  put(projectId: string, sha256: string, mediaType: string, data: Buffer): Promise<boolean>;
  get(projectId: string, sha256: string): Promise<{ mediaType: string; data: Buffer } | null>;
}

export function postgresFrameStore(pool: pg.Pool): FrameStore {
  return {
    async put(projectId, sha256, mediaType, data) {
      const result = await pool.query(
        `INSERT INTO frames (project_id, sha256, media_type, bytes, data)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, sha256) DO NOTHING`,
        [projectId, sha256, mediaType, data.length, data],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async get(projectId, sha256) {
      const result = await pool.query(
        "SELECT media_type, data FROM frames WHERE project_id = $1 AND sha256 = $2",
        [projectId, sha256],
      );
      const row = result.rows[0] as { media_type: string; data: Buffer } | undefined;
      return row ? { mediaType: row.media_type, data: row.data } : null;
    },
  };
}

export async function ensureFramesSchema(client: pg.Pool | pg.PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS screen_capture_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS frames (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL,
      media_type TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, sha256)
    );
    CREATE INDEX IF NOT EXISTS idx_frames_created ON frames(project_id, created_at);
  `);
}

/**
 * The frame list an SDK sent, kept only when well formed: at most 64 entries
 * of {sha256, mediaType, bytes[, omitted]}. Anything else is dropped whole.
 */
export function cleanFrameRefs(value: unknown): FrameRef[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const refs: FrameRef[] = [];
  for (const entry of value.slice(0, MAX_REFS_PER_CALL)) {
    if (!entry || typeof entry !== "object") return null;
    const { sha256, mediaType, bytes, omitted } = entry as Record<string, unknown>;
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) return null;
    if (typeof mediaType !== "string" || !mediaType.toLowerCase().startsWith("image/") || mediaType.length > 64) return null;
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) return null;
    refs.push({ sha256, mediaType: mediaType.toLowerCase(), bytes, ...(omitted === "too_large" ? { omitted } : {}) });
  }
  return refs;
}

/** Delete frame bytes older than each project's body retention, except ones in a dataset. */
export async function purgeExpiredFrames(pool: pg.Pool, now = new Date(), orgId?: string): Promise<number> {
  const result = await pool.query(
    `DELETE FROM frames f
     USING project_settings s, projects p
     WHERE f.project_id = s.project_id AND p.id = f.project_id
       AND ($2::text IS NULL OR p.org_id = $2)
       AND f.created_at < $1::timestamptz - make_interval(days => s.body_retention_days)
       -- A screenshot someone put in a dataset stays while the item does.
       AND NOT EXISTS (SELECT 1 FROM dataset_items di WHERE di.project_id = f.project_id AND di.frame_sha256 = f.sha256)`,
    [now, orgId ?? null],
  );
  return result.rowCount ?? 0;
}

/** Delete every frame a project holds and the frame lists on its calls. */
export async function deleteProjectFrames(pool: pg.Pool, projectId: string): Promise<number> {
  const deleted = await pool.query("DELETE FROM frames WHERE project_id = $1", [projectId]);
  await pool.query("UPDATE events SET frames = NULL WHERE project_id = $1 AND frames IS NOT NULL", [projectId]);
  return deleted.rowCount ?? 0;
}

/** SDK upload: `PUT /api/v1/frames/:sha256` with the image as the body and the DSN key as bearer token. */
export function createFrameIngestRouter(pool: pg.Pool, store: FrameStore = postgresFrameStore(pool)): Router {
  const router = createRouter();
  router.put(
    "/api/v1/frames/:sha256",
    express.raw({ type: () => true, limit: MAX_FRAME_BYTES + 1024 }),
    async (req: Request, res: Response) => {
      try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith("Bearer ")) { res.status(401).json({ error: "Missing or invalid authorization" }); return; }
        const sha256 = String(req.params.sha256 ?? "").toLowerCase();
        if (!SHA256.test(sha256)) { res.status(400).json({ error: "The path must be the image's SHA-256" }); return; }
        const mediaType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        if (!MEDIA_TYPES.has(mediaType)) { res.status(415).json({ error: "Frames must be PNG, JPEG, WebP or GIF" }); return; }
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (data.length === 0) { res.status(400).json({ error: "Empty frame" }); return; }
        if (data.length > MAX_FRAME_BYTES) { res.status(413).json({ error: "Frames are limited to 2 MB" }); return; }
        if (createHash("sha256").update(data).digest("hex") !== sha256) {
          res.status(400).json({ error: "The body doesn't match the SHA-256 in the path" }); return;
        }
        const project = await pool.query(
          `SELECT p.id, COALESCE(s.screen_capture_enabled, FALSE) AS screen_capture_enabled
           FROM projects p LEFT JOIN project_settings s ON s.project_id = p.id
           WHERE p.auth_key = $1`,
          [authHeader.slice(7)],
        );
        const row = project.rows[0] as { id: string; screen_capture_enabled: boolean } | undefined;
        if (!row) { res.status(401).json({ error: "Invalid auth key" }); return; }
        // Not 403: the SDK keeps going and only uploads while the project config allows it.
        if (!row.screen_capture_enabled) { res.status(422).json({ error: "Screen capture is off for this project" }); return; }
        const created = await store.put(row.id, sha256, mediaType, data);
        res.status(created ? 201 : 200).end();
      } catch (error) {
        console.error("[costkey] Frame upload error:", error instanceof Error ? error.message : error);
        res.status(500).json({ error: "Frame upload failed" });
      }
    },
  );
  return router;
}

/** Console: `GET /api/v1/projects/:projectId/frames/:sha256` for a signed-in member of the project. */
export function createFramesRouter(pool: pg.Pool, store: FrameStore = postgresFrameStore(pool)): Router {
  const router = createRouter();
  router.get("/api/v1/projects/:projectId/frames/:sha256", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: { id: string; orgId: string; role: string } }).user!;
      const projectId = String(req.params.projectId);
      const sha256 = String(req.params.sha256 ?? "").toLowerCase();
      if (!SHA256.test(sha256)) { res.status(404).json({ error: "Frame not found" }); return; }
      await assertProjectAccess(pool, user, projectId);
      // Screenshots are captured content: Viewers don't get them.
      if (!roleCanReadContent(user.role)) { res.status(404).json({ error: "Frame not found" }); return; }
      const frame = await store.get(projectId, sha256);
      if (!frame) { res.status(404).json({ error: "Frame not found" }); return; }
      res.set({
        "Content-Type": frame.mediaType,
        "Cache-Control": "private, max-age=86400, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      }).send(frame.data);
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status) { res.status(status).json({ error: (error as Error).message }); return; }
      console.error("[costkey] Frame read error:", error);
      res.status(500).json({ error: "Failed to read frame" });
    }
  });
  return router;
}

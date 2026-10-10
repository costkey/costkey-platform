/**
 * Sourcemap upload, list, and delete API.
 *
 * CI uses a project auth key for backwards compatibility. Dashboard requests
 * additionally require an authenticated Owner/Admin session so a Viewer
 * cannot turn a copied link or credential into source access.
 */
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import express from "express";
import type pg from "pg";
import { canAccessProject, roleCanManageWorkspace } from "./permissions.js";

type SessionUser = { id: string; orgId: string; role: string };

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `smap_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
async function projectFromBearer(pool: pg.Pool, req: Request): Promise<{ id: string } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const result = await pool.query("SELECT id, org_id FROM projects WHERE auth_key = $1", [authHeader.slice(7)]);
  return (result.rows[0] as { id: string } | undefined) ?? null;
}

async function authorize(
  pool: pg.Pool,
  req: Request,
  res: Response,
  action: "read" | "write",
  options: { allowDsnWrite?: boolean } = {},
): Promise<string | null> {
  const user = (req as Request & { user?: SessionUser }).user;
  const routeProjectId = typeof req.params.projectId === "string" ? req.params.projectId : undefined;
  const project = await projectFromBearer(pool, req);
  const projectId = routeProjectId ?? project?.id;

  const settings = projectId ? await pool.query(
    "SELECT COALESCE(source_access_enabled, FALSE) AS enabled FROM project_settings WHERE project_id = $1",
    [projectId],
  ).catch(() => ({ rows: [] as Array<{ enabled?: boolean }> })) : { rows: [] as Array<{ enabled?: boolean }> };
  const dsnUpload = !user && action === "write" && options.allowDsnWrite !== false;
  if (settings.rows[0]?.enabled !== true && !dsnUpload) {
    res.status(403).json({ error: "Source access is disabled for this project" });
    return null;
  }

  if (user) {
    if (!projectId || !await canAccessProject(pool, user, projectId)) {
      res.status(404).json({ error: "Project not found" });
      return null;
    }
    if (action === "write" && !roleCanManageWorkspace(user.role)) {
      res.status(403).json({ error: "Only owners and admins can manage sourcemaps" });
      return null;
    }
    if (action === "read" && !roleCanManageWorkspace(user.role)) {
      res.status(403).json({ error: "Source access is restricted to owners and admins" });
      return null;
    }
    return projectId;
  }

  // CI's project key is intentionally limited to this project and these
  // sourcemap operations; it does not create a dashboard session.
  if (action === "write" && options.allowDsnWrite === false) {
    res.status(403).json({ error: "Sourcemap deletion requires an Owner or Admin session" });
    return null;
  }
  if (!project || (routeProjectId && routeProjectId !== project.id)) {
    res.status(401).json({ error: project ? "Project does not match auth key" : "Missing or invalid authorization" });
    return null;
  }
  return project.id;
}

async function uploadSourcemap(pool: pg.Pool, req: Request, res: Response, projectId: string): Promise<void> {
  const { release, fileName, sourcemapJson } = req.body as {
    release?: string;
    fileName?: string;
    sourcemapJson?: string;
  };
  if (!release || !fileName || !sourcemapJson) {
    res.status(400).json({ error: "Missing required fields: release, fileName, sourcemapJson" });
    return;
  }
  if (release.length > 200 || fileName.length > 1_000 || sourcemapJson.length > 50 * 1024 * 1024) {
    res.status(413).json({ error: "Sourcemap exceeds the allowed size" });
    return;
  }
  try {
    JSON.parse(sourcemapJson);
  } catch {
    res.status(400).json({ error: "Invalid sourcemap JSON" });
    return;
  }
  const id = randomId();
  await pool.query(
    `INSERT INTO sourcemaps (id, project_id, release, file_name, sourcemap_json)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id, release, file_name)
     DO UPDATE SET sourcemap_json = EXCLUDED.sourcemap_json`,
    [id, projectId, release, fileName, sourcemapJson],
  );
  res.status(201).json({ uploaded: true, release, fileName });
}

export function createSourcemapsRouter(pool: pg.Pool): Router {
  const router = createRouter();

  // Higher body limit for sourcemap uploads (maps can be 10-50MB).
  router.use("/api/v1/sourcemaps", express.json({ limit: "50mb" }));
  router.use("/api/v1/projects/:projectId/sourcemaps", express.json({ limit: "50mb" }));

  const upload = async (req: Request, res: Response) => {
    try {
      // DSN/project-key uploads remain supported for CI.  The delete handler
      // below is the operation that must require a dashboard Owner/Admin.
      const projectId = await authorize(pool, req, res, "write");
      if (projectId) await uploadSourcemap(pool, req, res, projectId);
    } catch (err) {
      console.error("[costkey] Sourcemap upload error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  };

  const list = async (req: Request, res: Response) => {
    try {
      const projectId = await authorize(pool, req, res, "read");
      if (!projectId) return;
      const release = String(req.params.release);
      const result = await pool.query(
        `SELECT id, file_name, created_at, length(sourcemap_json) AS size_bytes
         FROM sourcemaps WHERE project_id = $1 AND release = $2 ORDER BY file_name`,
        [projectId, release],
      );
      res.json({ release, sourcemaps: result.rows });
    } catch (err) {
      console.error("[costkey] Sourcemap list error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  };

  const remove = async (req: Request, res: Response) => {
    try {
      const projectId = await authorize(pool, req, res, "write", { allowDsnWrite: false });
      if (!projectId) return;
      const release = String(req.params.release);
      const result = await pool.query(
        "DELETE FROM sourcemaps WHERE project_id = $1 AND release = $2",
        [projectId, release],
      );
      res.json({ deleted: result.rowCount ?? 0, release });
    } catch (err) {
      console.error("[costkey] Sourcemap delete error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  };

  router.post("/api/v1/sourcemaps", upload);
  router.get("/api/v1/sourcemaps/:release", list);
  router.delete("/api/v1/sourcemaps/:release", remove);
  router.post("/api/v1/projects/:projectId/sourcemaps", upload);
  router.get("/api/v1/projects/:projectId/sourcemaps/:release", list);
  router.delete("/api/v1/projects/:projectId/sourcemaps/:release", remove);

  return router;
}

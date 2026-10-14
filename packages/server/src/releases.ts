import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import { assertProjectAccess, roleCanManageWorkspace } from "./permissions.js";
import { RELEASE_SQL } from "./insights-api.js";

/**
 * Releases are deploys: the `release` the SDK sends with every batch, usually
 * the commit SHA. SDKs also send the commit and the repository when they can
 * find them, so the console can link a release to its commit and compare one
 * deploy with the one before it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SHA = /^[0-9a-f]{7,40}$/;

export async function ensureReleaseSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS releases (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      release TEXT NOT NULL,
      commit_sha TEXT,
      repository TEXT,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, release)
    );
    ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS repository_url TEXT;
  `);
}

/** A full or short commit SHA, lowercased; null for anything else. */
export function commitSha(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return SHA.test(value) ? value : null;
}

/**
 * The repository as an https URL without credentials or ".git":
 * git@github.com:org/repo.git and https://token@github.com/org/repo.git both
 * become https://github.com/org/repo. Null when it isn't a repository URL.
 */
export function repositoryUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value || value.length > 500) return null;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(value);
  if (scp) value = `https://${scp[1]}/${scp[2]}`;
  else if (/^ssh:\/\//.test(value)) value = value.replace(/^ssh:\/\/(?:[^@/]+@)?/, "https://");
  else if (!/^https?:\/\//.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\.git$/, "").replace(/\/+$/, "");
    if (!url.hostname.includes(".") || path.split("/").filter(Boolean).length < 2) return null;
    return `https://${url.hostname}${path}`;
  } catch {
    return null;
  }
}

/** The commit's page on GitHub, GitLab or Bitbucket; elsewhere the GitHub layout. */
export function commitUrl(repository: string | null, sha: string | null): string | null {
  if (!repository || !sha) return null;
  const host = new URL(repository).hostname;
  if (host.includes("gitlab")) return `${repository}/-/commit/${sha}`;
  if (host.includes("bitbucket")) return `${repository}/commits/${sha}`;
  return `${repository}/commit/${sha}`;
}

/** Recently written (project, release) pairs: one write per release a minute is plenty. */
const recent = new Map<string, number>();

/** Note a batch's release, with its commit and repository when the SDK sent them. Never throws. */
export async function recordRelease(pool: pg.Pool, projectId: string, input: { release: unknown; commit?: unknown; repository?: unknown }): Promise<void> {
  const release = typeof input.release === "string" ? input.release.trim().slice(0, 200) : "";
  if (!release) return;
  const commit = commitSha(input.commit) ?? commitSha(release);
  const repository = repositoryUrl(input.repository);
  const key = `${projectId}\u0001${release}\u0001${commit ?? ""}\u0001${repository ?? ""}`;
  const now = Date.now();
  if ((recent.get(key) ?? 0) > now - 60_000) return;
  recent.set(key, now);
  if (recent.size > 10_000) recent.clear();
  try {
    await pool.query(
      `INSERT INTO releases (project_id, release, commit_sha, repository)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, release) DO UPDATE
         SET commit_sha = COALESCE(EXCLUDED.commit_sha, releases.commit_sha),
             repository = COALESCE(EXCLUDED.repository, releases.repository),
             last_seen = NOW()`,
      [projectId, release, commit, repository],
    );
  } catch (error) {
    recent.delete(key);
    console.error("[costkey] Release record error:", (error as Error).message);
  }
}

export interface ReleaseRow {
  release: string;
  commit: string | null;
  repository: string | null;
  commitUrl: string | null;
  /** When calls from this release started and stopped arriving. */
  firstSeen: string;
  lastSeen: string;
  calls: number;
}

/**
 * Releases with calls in the last `days`, newest deploy first. A release's
 * first and last call come from the calls themselves, so releases recorded
 * before the releases table existed are listed too.
 */
export async function listReleases(pool: pg.Pool, projectId: string, options: { days?: number; environment?: string | null } = {}): Promise<{ repository: string | null; releases: ReleaseRow[] }> {
  const days = Math.min(Math.max(Math.round(options.days ?? 90), 1), 395);
  const [rows, settings] = await Promise.all([
    pool.query(
      `WITH seen AS (
         SELECT ${RELEASE_SQL("e")} AS release, MIN(e.timestamp) AS first_call, MAX(e.timestamp) AS last_call, COUNT(*)::int AS calls
         FROM events e
         WHERE e.project_id = $1 AND e.timestamp >= $2
           AND COALESCE(e.event_type, 'call') = 'call'
           AND ${RELEASE_SQL("e")} IS NOT NULL
           AND ($3::text IS NULL OR COALESCE(NULLIF(e.context->>'environment', ''), '(unassigned)') = $3)
         GROUP BY 1
       )
       SELECT s.release, s.calls, s.first_call, s.last_call, r.commit_sha, r.repository, r.first_seen
       FROM seen s
       LEFT JOIN releases r ON r.project_id = $1 AND r.release = s.release
       ORDER BY LEAST(s.first_call, COALESCE(r.first_seen, s.first_call)) DESC
       LIMIT 100`,
      [projectId, new Date(Date.now() - days * DAY_MS).toISOString(), options.environment ?? null],
    ),
    pool.query("SELECT repository_url FROM project_settings WHERE project_id = $1", [projectId]).catch(() => ({ rows: [] })),
  ]);
  const projectRepository = repositoryUrl((settings.rows[0] as { repository_url?: string } | undefined)?.repository_url);
  const releases = (rows.rows as Array<Record<string, unknown>>).map((row) => {
    const release = String(row.release);
    const commit = commitSha(row.commit_sha) ?? commitSha(release);
    const repository = repositoryUrl(row.repository) ?? projectRepository;
    const firstCall = new Date(String(row.first_call));
    const recorded = row.first_seen ? new Date(String(row.first_seen)) : null;
    return {
      release,
      commit,
      repository,
      commitUrl: commitUrl(repository, commit),
      firstSeen: (recorded && recorded < firstCall ? recorded : firstCall).toISOString(),
      lastSeen: new Date(String(row.last_call)).toISOString(),
      calls: Number(row.calls) || 0,
    };
  });
  return { repository: projectRepository, releases };
}

export function createReleasesRouter(pool: pg.Pool): Router {
  const router = Router();
  router.use("/api/v1/projects/:projectId/releases", requireAuth);
  router.use("/api/v1/projects/:projectId/repository", requireAuth);

  router.get("/api/v1/projects/:projectId/releases", async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: { id: string; orgId: string; role: string } }).user;
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const projectId = String(req.params.projectId);
      await assertProjectAccess(pool, user, projectId);
      const environment = typeof req.query["environment"] === "string" && req.query["environment"] && req.query["environment"] !== "all" ? req.query["environment"] : null;
      const days = Number(req.query["days"]);
      res.json(await listReleases(pool, projectId, { environment, days: Number.isFinite(days) ? days : undefined }));
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status) { res.status(status).json({ error: (error as Error).message }); return; }
      console.error("[costkey] Releases error:", error);
      res.status(500).json({ error: "Couldn't load releases" });
    }
  });

  /** The repository releases link to when the SDK doesn't send one. Empty clears it. */
  router.put("/api/v1/projects/:projectId/repository", async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: { id: string; orgId: string; role: string } }).user;
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      if (!roleCanManageWorkspace(user.role)) { res.status(403).json({ error: "Only owners and admins can change the repository" }); return; }
      const projectId = String(req.params.projectId);
      await assertProjectAccess(pool, user, projectId);
      const raw = (req.body as { url?: unknown } | undefined)?.url;
      const url = typeof raw === "string" && raw.trim() === "" ? null : repositoryUrl(raw);
      if (raw !== null && typeof raw === "string" && raw.trim() !== "" && !url) {
        res.status(400).json({ error: "Enter the repository's URL, like https://github.com/acme/app" });
        return;
      }
      await pool.query(
        `INSERT INTO project_settings (project_id, repository_url) VALUES ($1, $2)
         ON CONFLICT (project_id) DO UPDATE SET repository_url = EXCLUDED.repository_url, updated_at = NOW()`,
        [projectId, url],
      );
      res.json({ repository: url });
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status) { res.status(status).json({ error: (error as Error).message }); return; }
      console.error("[costkey] Repository update error:", error);
      res.status(500).json({ error: "Couldn't save the repository" });
    }
  });

  return router;
}

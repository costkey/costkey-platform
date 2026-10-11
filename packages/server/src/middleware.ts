/**
 * Middleware for org-scoping, rate limiting, and request validation.
 */
import type { Request, Response, NextFunction } from "express";
import type pg from "pg";
import type { AuthUser } from "./auth.js";
import { canAccessProject, normalizeRole, redactResponseForDisabledSource, redactResponseForViewer, roleCanManageWorkspace, type AuthPrincipal } from "./permissions.js";

/**
 * Org-scoping middleware for /api/v1/projects/:projectId/* routes.
 * Verifies the requested project belongs to the authenticated user's org.
 * Rejects with 404 if project doesn't exist or doesn't belong to user's org.
 */
export function orgScope(pool: pg.Pool) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = (req as any).user as AuthUser | undefined;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const projectId = typeof req.params.projectId === "string" ? req.params.projectId : undefined;
    if (!projectId) {
      next();
      return;
    }

    if (!await canAccessProject(pool, user, projectId)) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    next();
  };
}

/**
 * Guard project mutations mounted before legacy API routes. This keeps role
 * enforcement server-side even while older routers are being migrated.
 */
export function projectMutationGuard() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: AuthUser }).user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    if (!roleCanManageWorkspace(user.role)) {
      res.status(403).json({ error: "Only owners and admins can change project settings" });
      return;
    }
    next();
  };
}

/**
 * Apply project-level access and content redaction to every API response.
 * Route-specific handlers can still add stricter checks, but cannot weaken
 * the Viewer boundary by forgetting to hide a newly returned content field.
 */
export function platformResponseGuards(pool: pg.Pool) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = (req as Request & { user?: AuthUser }).user;
    const projectId = typeof req.params.projectId === "string" ? req.params.projectId : undefined;
    if (user && projectId && !(await canAccessProject(pool, user, projectId))) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    let sourceAccessEnabled = false;
    if (projectId) {
      try {
        const result = await pool.query(
          "SELECT source_access_enabled FROM project_settings WHERE project_id = $1",
          [projectId],
        );
        sourceAccessEnabled = result.rows[0]?.source_access_enabled === true;
      } catch {
        // If the policy cannot be read, do not expose source material.
      }
    }
    const continueResponse = (error?: unknown): void => {
      if (error) { next(error); return; }
      if (!sourceAccessEnabled) redactResponseForDisabledSource(res, () => redactResponseForViewer(req, res, next));
      else redactResponseForViewer(req, res, next);
    };
    continueResponse();
  };
}

export function roleForRequest(req: Request): ReturnType<typeof normalizeRole> | null {
    const user = (req as Request & { user?: AuthPrincipal }).user;
  return user ? normalizeRole(user.role) : null;
}

/**
 * Simple in-memory rate limiter.
 * Limits requests per key (IP or auth key) within a time window.
 */
export function rateLimit(opts: { windowMs: number; max: number; keyFn?: (req: Request) => string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Cleanup old entries every minute
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of hits) {
      if (val.resetAt < now) hits.delete(key);
    }
  }, 60_000).unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = opts.keyFn ? opts.keyFn(req) : req.ip ?? "unknown";
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }

    entry.count++;
    if (entry.count > opts.max) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }

    next();
  };
}

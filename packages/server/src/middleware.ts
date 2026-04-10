/**
 * Middleware for org-scoping, rate limiting, and request validation.
 */
import type { Request, Response, NextFunction } from "express";
import type pg from "pg";
import type { AuthUser } from "./auth.js";

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

    const { projectId } = req.params;
    if (!projectId) {
      next();
      return;
    }

    const result = await pool.query(
      "SELECT id FROM projects WHERE id = $1 AND org_id = $2",
      [projectId, user.orgId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    next();
  };
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

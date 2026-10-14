/**
 * Personal access tokens for coding agents.
 *
 * A token (`ck_pat_...`) is read-only: it may read a project's data through
 * the same routes the console uses, and call the MCP endpoint, and nothing
 * else. It acts as its owner, never above the owner's current role, and can
 * be limited to some projects. Only a hash is stored. Tokens are created and
 * revoked from a console session; a token can't mint another token.
 */
import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import { normalizeRole } from "./permissions.js";
import { publicAppUrl } from "./public-url.js";
import { rateLimit } from "./middleware.js";

export const API_TOKEN_PREFIX = "ck_pat_";

/** What authMiddleware attaches to a request made with a token. */
export interface ApiTokenContext {
  id: string;
  name: string;
  scopes: string[];
  /** The projects this token may read; null for every project its owner can. */
  projectIds: string[] | null;
}

export interface ApiTokenUser {
  id: string;
  email: string;
  name: string;
  orgId: string;
  role: string;
  tokenProjectIds: string[] | null;
}

export function mcpEnabled(): boolean {
  const raw = process.env["COSTKEY_MCP_ENABLED"]?.trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isApiTokenHeader(header: string | undefined): boolean {
  return typeof header === "string" && /^Bearer\s+ck_pat_/.test(header);
}

export function apiTokenFromHeader(header: string | undefined): string | null {
  if (!isApiTokenHeader(header)) return null;
  return header!.replace(/^Bearer\s+/, "").trim();
}

/**
 * The only routes a token may use: reading projects, and the MCP endpoint.
 * `path` is relative to the app (below any base path).
 */
export function apiTokenRouteAllowed(method: string, path: string): boolean {
  if (path === "/mcp" || path === "/mcp/") return true;
  if (method !== "GET" && method !== "HEAD") return false;
  return path === "/api/v1/projects" || path === "/api/v1/projects/" || path.startsWith("/api/v1/projects/");
}

/** The project a route reads, from `/api/v1/projects/:projectId/...`. */
export function projectIdFromPath(path: string): string | null {
  const match = /^\/api\/v1\/projects\/([^/]+)/.exec(path);
  if (!match) return null;
  try { return decodeURIComponent(match[1]!); } catch { return match[1]!; }
}

// last_used_at is written at most once a minute per token.
const LAST_USED_WRITE_MS = 60_000;

/**
 * Resolve a token to its owner as they are now: their current role and
 * organization, re-read on every request. Null when the token is unknown,
 * revoked, expired, or its owner has left the organization it was made in.
 */
export async function authenticateApiToken(
  pool: pg.Pool,
  token: string,
): Promise<{ user: ApiTokenUser; token: ApiTokenContext } | null> {
  if (!token.startsWith(API_TOKEN_PREFIX) || token.length < API_TOKEN_PREFIX.length + 20) return null;
  const result = await pool.query(
    `SELECT t.id AS token_id, t.name AS token_name, t.scopes, t.project_ids, t.last_used_at,
            u.id, u.email, u.name, u.org_id, u.role
     FROM api_tokens t
     JOIN users u ON u.id = t.user_id AND u.org_id = t.org_id
     WHERE t.token_hash = $1
       AND t.revoked_at IS NULL
       AND (t.expires_at IS NULL OR t.expires_at > NOW())`,
    [hashApiToken(token)],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const scopes = Array.isArray(row.scopes) ? (row.scopes as unknown[]).map(String) : [];
  if (!scopes.includes("read")) return null;
  const lastUsed = row.last_used_at ? new Date(String(row.last_used_at)).getTime() : 0;
  if (!lastUsed || Date.now() - lastUsed > LAST_USED_WRITE_MS) {
    void pool.query("UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1", [row.token_id])
      .catch((error) => console.error("[costkey] Token last-used update error:", error));
  }
  const projectIds = Array.isArray(row.project_ids) ? (row.project_ids as unknown[]).map(String) : null;
  return {
    user: {
      id: String(row.id),
      email: String(row.email),
      name: String(row.name),
      orgId: String(row.org_id),
      role: normalizeRole(row.role),
      tokenProjectIds: projectIds,
    },
    token: { id: String(row.token_id), name: String(row.token_name), scopes, projectIds },
  };
}

function apiTokenOf(req: Request): ApiTokenContext | undefined {
  return (req as Request & { apiToken?: ApiTokenContext }).apiToken;
}

const SECRET_KEYS = new Set(["auth_key", "authKey", "dsn"]);

/** A read-only token never receives a project's ingest key or DSN. */
export function stripIngestSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripIngestSecrets);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key)) continue;
    result[key] = stripIngestSecrets(entry);
  }
  return result;
}

/**
 * Guards for token requests, mounted right after authMiddleware: a per-token
 * read limit, the project restriction on the project list, and no ingest
 * secrets in any response.
 */
export function apiTokenGuards(options: { windowMs?: number; max?: number } = {}) {
  const limiter = rateLimit({
    windowMs: options.windowMs ?? 60_000,
    max: options.max ?? (Number.parseInt(process.env["COSTKEY_TOKEN_RATE_LIMIT"] ?? "", 10) || 300),
    keyFn: (req) => `pat:${apiTokenOf(req)?.id ?? "unknown"}`,
  });
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = apiTokenOf(req);
    if (!token) { next(); return; }
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      let safe = stripIngestSecrets(body);
      if (token.projectIds && (req.path === "/api/v1/projects" || req.path === "/api/v1/projects/")
        && safe && typeof safe === "object" && Array.isArray((safe as { projects?: unknown }).projects)) {
        const allowed = new Set(token.projectIds);
        safe = {
          ...(safe as Record<string, unknown>),
          projects: ((safe as { projects: Array<{ id?: unknown }> }).projects).filter((project) => allowed.has(String(project.id))),
        };
      }
      return originalJson(safe);
    }) as typeof res.json;
    limiter(req, res, next);
  };
}

function serializeToken(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    hint: row.token_hint ?? null,
    scopes: row.scopes ?? ["read"],
    projectIds: row.project_ids ?? null,
    createdAt: row.created_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    expiresAt: row.expires_at ?? null,
    revokedAt: row.revoked_at ?? null,
  };
}

interface SessionUser { id: string; orgId: string; role: string }

/** Token management needs a console session: not a token, not a CLI bearer. */
function sessionUser(req: Request, res: Response): SessionUser | null {
  const user = (req as Request & { user?: SessionUser }).user;
  if (!user) { res.status(401).json({ error: "Authentication required" }); return null; }
  if (apiTokenOf(req) || (req as Request & { authKind?: string }).authKind !== "session") {
    res.status(403).json({ error: "Manage tokens from the console" });
    return null;
  }
  return user;
}

const MAX_ACTIVE_TOKENS = 50;

export function createApiTokensRouter(pool: pg.Pool): Router {
  const router = createRouter();

  router.get("/api/v1/agent-tokens", async (req, res) => {
    const user = sessionUser(req, res);
    if (!user) return;
    try {
      const result = await pool.query(
        `SELECT id, name, token_hint, scopes, project_ids, created_at, last_used_at, expires_at, revoked_at
         FROM api_tokens
         WHERE user_id = $1 AND org_id = $2 AND revoked_at IS NULL
         ORDER BY created_at DESC, id DESC`,
        [user.id, user.orgId],
      );
      res.json({
        tokens: result.rows.map((row) => serializeToken(row as Record<string, unknown>)),
        mcpUrl: `${publicAppUrl()}/mcp`,
        mcpEnabled: mcpEnabled(),
      });
    } catch (error) {
      console.error("[costkey] Token list error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/v1/agent-tokens", async (req, res) => {
    const user = sessionUser(req, res);
    if (!user) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    if (!name) { res.status(400).json({ error: "Name the token" }); return; }
    if (name.length > 100) { res.status(400).json({ error: "Token name must be at most 100 characters" }); return; }
    let projectIds: string[] | null = null;
    if (body["projectIds"] !== undefined && body["projectIds"] !== null) {
      if (!Array.isArray(body["projectIds"]) || body["projectIds"].some((id) => typeof id !== "string")) {
        res.status(400).json({ error: "projectIds must be a list of project ids" });
        return;
      }
      projectIds = [...new Set(body["projectIds"] as string[])];
      if (projectIds.length === 0) projectIds = null;
    }
    let expiresAt: string | null = null;
    if (body["expiresAt"] !== undefined && body["expiresAt"] !== null && body["expiresAt"] !== "") {
      const date = new Date(String(body["expiresAt"]));
      if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
        res.status(400).json({ error: "Expiry must be a date in the future" });
        return;
      }
      expiresAt = date.toISOString();
    }
    try {
      if (projectIds) {
        // Only projects this person can open now.
        const role = normalizeRole(user.role);
        const accessible = await pool.query(
          `SELECT p.id FROM projects p
           WHERE p.org_id = $1 AND p.id = ANY($2::text[])
             AND ($3 IN ('owner', 'admin') OR EXISTS (
               SELECT 1 FROM project_memberships pm WHERE pm.project_id = p.id AND pm.user_id = $4
             ))`,
          [user.orgId, projectIds, role, user.id],
        );
        if (accessible.rows.length !== projectIds.length) {
          res.status(400).json({ error: "One or more projects aren't available to you" });
          return;
        }
      }
      const active = await pool.query(
        "SELECT COUNT(*)::int AS count FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())",
        [user.id],
      );
      if (Number(active.rows[0]?.count ?? 0) >= MAX_ACTIVE_TOKENS) {
        res.status(400).json({ error: `You can have ${MAX_ACTIVE_TOKENS} tokens. Revoke one first.` });
        return;
      }
      const token = generateApiToken();
      const id = `pat_${randomBytes(12).toString("hex")}`;
      const result = await pool.query(
        `INSERT INTO api_tokens (id, user_id, org_id, name, token_hash, token_hint, scopes, project_ids, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, ARRAY['read']::text[], $7, $8)
         RETURNING id, name, token_hint, scopes, project_ids, created_at, last_used_at, expires_at, revoked_at`,
        [id, user.id, user.orgId, name, hashApiToken(token), token.slice(-4), projectIds, expiresAt],
      );
      res.status(201).json({
        token: serializeToken(result.rows[0] as Record<string, unknown>),
        // Shown once. Only its hash is kept.
        secret: token,
        mcpUrl: `${publicAppUrl()}/mcp`,
      });
    } catch (error) {
      console.error("[costkey] Token create error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/v1/agent-tokens/:tokenId", async (req, res) => {
    const user = sessionUser(req, res);
    if (!user) return;
    try {
      const result = await pool.query(
        `UPDATE api_tokens SET revoked_at = NOW()
         WHERE id = $1 AND user_id = $2 AND org_id = $3 AND revoked_at IS NULL
         RETURNING id`,
        [req.params["tokenId"], user.id, user.orgId],
      );
      if (result.rows.length === 0) { res.status(404).json({ error: "Token not found" }); return; }
      res.json({ revoked: true });
    } catch (error) {
      console.error("[costkey] Token revoke error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

import type { Router, Request, Response, NextFunction } from "express";
import { Router as createRouter } from "express";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getDb, getPool } from "./db.js";
import { users, orgs, projects } from "./schema.js";

const JWT_SECRET = process.env["COSTKEY_JWT_SECRET"] ?? "costkey-dev-secret-change-in-prod";
const JWT_EXPIRES = "7d";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  orgId: string;
  role: string;
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function setTokenCookie(res: Response, token: string): void {
  res.cookie("ck_token", token, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function createAuthRouter(): Router {
  const router = createRouter();
  const db = getDb();

  // POST /auth/signup
  router.post("/auth/signup", async (req: Request, res: Response) => {
    try {
      const { email, password, name, orgName } = req.body as {
        email: string; password: string; name: string; orgName?: string;
      };

      if (!email || !password || !name) {
        res.status(400).json({ error: "Missing email, password, or name" });
        return;
      }
      if (password.length < 8) {
        res.status(400).json({ error: "Password must be at least 8 characters" });
        return;
      }

      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (existing.length > 0) {
        res.status(409).json({ error: "Email already registered" });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const orgId = `org_${randomId()}`;
      const userId = `usr_${randomId()}`;
      const projectId = `proj_${randomId()}`;
      const authKey = `ck_${randomId()}`;
      const orgSlug = slugify(orgName ?? name);
      const displayOrgName = orgName ?? `${name}'s Org`;

      // Transaction via raw pool (drizzle transactions need different setup)
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)", [orgId, displayOrgName, orgSlug]);
        await client.query("INSERT INTO users (id, email, password_hash, name, org_id, role) VALUES ($1,$2,$3,$4,$5,$6)", [userId, email, passwordHash, name, orgId, "owner"]);
        await client.query("INSERT INTO projects (id, name, org_id, auth_key) VALUES ($1,$2,$3,$4)", [projectId, "Default Project", orgId, authKey]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      const token = jwt.sign({ userId, orgId, role: "owner" }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
      setTokenCookie(res, token);

      res.status(201).json({
        user: { id: userId, email, name, orgId, role: "owner" },
        org: { id: orgId, name: displayOrgName, slug: orgSlug },
        project: { id: projectId, name: "Default Project", authKey },
        dsn: `https://${authKey}@app.costkey.dev/${projectId}`,
        token,
      });
    } catch (err) {
      console.error("[costkey] Signup error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /auth/login
  router.post("/auth/login", async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body as { email: string; password: string };
      if (!email || !password) {
        res.status(400).json({ error: "Missing email or password" });
        return;
      }

      const result = await db.select().from(users).where(eq(users.email, email));
      if (result.length === 0) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      const user = result[0];
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      const token = jwt.sign({ userId: user.id, orgId: user.orgId, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
      setTokenCookie(res, token);

      res.json({
        user: { id: user.id, email: user.email, name: user.name, orgId: user.orgId, role: user.role },
        token,
      });
    } catch (err) {
      console.error("[costkey] Login error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /auth/logout
  router.post("/auth/logout", (_req: Request, res: Response) => {
    res.clearCookie("ck_token");
    res.json({ ok: true });
  });

  // GET /auth/me
  router.get("/auth/me", async (req: Request, res: Response) => {
    const authUser = (req as any).user as AuthUser | undefined;
    if (!authUser) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const org = await db.select({ id: orgs.id, name: orgs.name, slug: orgs.slug }).from(orgs).where(eq(orgs.id, authUser.orgId));
    const projs = await db.select({
      id: projects.id, name: projects.name, authKey: projects.authKey, createdAt: projects.createdAt,
    }).from(projects).where(eq(projects.orgId, authUser.orgId));
    const members = await db.select({
      id: users.id, email: users.email, name: users.name, role: users.role, createdAt: users.createdAt,
    }).from(users).where(eq(users.orgId, authUser.orgId));

    res.json({
      user: authUser,
      org: org[0],
      projects: projs,
      members,
    });
  });

  // POST /auth/admin/impersonate — login as any user (admin only)
  router.post("/auth/admin/impersonate", async (req: Request, res: Response) => {
    try {
      const adminKey = req.headers["x-admin-key"];
      const ADMIN_SECRET = process.env["COSTKEY_ADMIN_SECRET"] ?? "ck-admin-secret-change-me";

      if (!adminKey || adminKey !== ADMIN_SECRET) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const { userId } = req.body as { userId?: string };
      if (!userId) {
        res.status(400).json({ error: "Missing userId" });
        return;
      }

      const pool = getPool();
      const result = await pool.query(
        "SELECT id, email, name, org_id, role FROM users WHERE id = $1",
        [userId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const user = result.rows[0];
      const token = jwt.sign(
        { userId: user.id, email: user.email, orgId: user.org_id, role: user.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES },
      );

      setTokenCookie(res, token);
      res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
    } catch (err) {
      console.error("[costkey] Admin impersonate error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

/** Auth middleware */
export function authMiddleware() {
  const db = getDb();

  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token =
      req.cookies?.["ck_token"] ??
      req.headers.authorization?.replace("Bearer ", "");

    if (!token) { next(); return; }

    try {
      const payload = jwt.verify(token, JWT_SECRET) as { userId: string; orgId: string; role: string };
      const result = await db.select({
        id: users.id, email: users.email, name: users.name, orgId: users.orgId, role: users.role,
      }).from(users).where(eq(users.id, payload.userId));

      if (result.length > 0) {
        (req as any).user = result[0] as AuthUser;
      }
    } catch { /* invalid token */ }

    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!(req as any).user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

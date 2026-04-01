import type { Router, Request, Response, NextFunction } from "express";
import { Router as createRouter } from "express";
import type Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

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

export function createAuthRouter(db: Database.Database): Router {
  const router = createRouter();

  // POST /auth/signup — create account + org + first project
  router.post("/auth/signup", async (req: Request, res: Response) => {
    try {
      const { email, password, name, orgName } = req.body as {
        email: string;
        password: string;
        name: string;
        orgName?: string;
      };

      if (!email || !password || !name) {
        res.status(400).json({ error: "Missing email, password, or name" });
        return;
      }
      if (password.length < 8) {
        res.status(400).json({ error: "Password must be at least 8 characters" });
        return;
      }

      // Check if user exists
      const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
      if (existing) {
        res.status(409).json({ error: "Email already registered" });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const orgId = `org_${randomId()}`;
      const userId = `usr_${randomId()}`;
      const projectId = `proj_${randomId()}`;
      const authKey = `ck_${randomId()}`;
      const orgSlug = slugify(orgName ?? name);

      const createAll = db.transaction(() => {
        db.prepare("INSERT INTO orgs (id, name, slug) VALUES (?, ?, ?)").run(
          orgId,
          orgName ?? `${name}'s Org`,
          orgSlug,
        );
        db.prepare("INSERT INTO users (id, email, password_hash, name, org_id, role) VALUES (?, ?, ?, ?, ?, ?)").run(
          userId, email, passwordHash, name, orgId, "owner",
        );
        db.prepare("INSERT INTO projects (id, name, org_id, auth_key) VALUES (?, ?, ?, ?)").run(
          projectId, "Default Project", orgId, authKey,
        );
      });

      createAll();

      const token = jwt.sign({ userId, orgId, role: "owner" }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

      res.cookie("ck_token", token, {
        httpOnly: true,
        secure: process.env["NODE_ENV"] === "production",
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.status(201).json({
        user: { id: userId, email, name, orgId, role: "owner" },
        org: { id: orgId, name: orgName ?? `${name}'s Org`, slug: orgSlug },
        project: { id: projectId, name: "Default Project", authKey },
        dsn: `https://${authKey}@costkey.dev/${projectId}`,
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

      const user = db.prepare(
        "SELECT id, email, password_hash, name, org_id, role FROM users WHERE email = ?",
      ).get(email) as {
        id: string;
        email: string;
        password_hash: string;
        name: string;
        org_id: string;
        role: string;
      } | undefined;

      if (!user) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      const token = jwt.sign(
        { userId: user.id, orgId: user.org_id, role: user.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES },
      );

      res.cookie("ck_token", token, {
        httpOnly: true,
        secure: process.env["NODE_ENV"] === "production",
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.json({
        user: { id: user.id, email: user.email, name: user.name, orgId: user.org_id, role: user.role },
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

  // GET /auth/me — get current user
  router.get("/auth/me", (req: Request, res: Response) => {
    const user = (req as unknown as { user?: AuthUser }).user;
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const org = db.prepare("SELECT id, name, slug FROM orgs WHERE id = ?").get(user.orgId);
    const projects = db.prepare("SELECT id, name, auth_key, created_at FROM projects WHERE org_id = ?").all(user.orgId);

    res.json({ user, org, projects });
  });

  return router;
}

/**
 * Auth middleware — verifies JWT from cookie or Authorization header.
 * Sets req.user if valid, passes through if not (for public routes).
 */
export function authMiddleware(db: Database.Database) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token =
      req.cookies?.["ck_token"] ??
      req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      next();
      return;
    }

    try {
      const payload = jwt.verify(token, JWT_SECRET) as {
        userId: string;
        orgId: string;
        role: string;
      };

      const user = db.prepare(
        "SELECT id, email, name, org_id, role FROM users WHERE id = ?",
      ).get(payload.userId) as {
        id: string;
        email: string;
        name: string;
        org_id: string;
        role: string;
      } | undefined;

      if (user) {
        (req as unknown as { user: AuthUser }).user = {
          id: user.id,
          email: user.email,
          name: user.name,
          orgId: user.org_id,
          role: user.role,
        };
      }
    } catch {
      // Invalid token — treat as unauthenticated
    }

    next();
  };
}

/**
 * Require auth — returns 401 if not authenticated.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = (req as unknown as { user?: AuthUser }).user;
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

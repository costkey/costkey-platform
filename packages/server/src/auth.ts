import type { Router, Request, Response, NextFunction } from "express";
import { Router as createRouter } from "express";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Resend } from "resend";
import { getDb, getPool } from "./db.js";
import { users, orgs, projects } from "./schema.js";

const resend = new Resend(process.env["RESEND_API_KEY"]!);

async function sendWelcomeEmail(to: string, name: string, dsn: string): Promise<void> {
  try {
    await resend.emails.send({
      from: "Naman from CostKey <naman@costkey.dev>",
      to,
      subject: "Welcome to CostKey — you're set up",
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;color:#1a1a1a">
          <p style="font-size:16px;line-height:1.6;margin:0 0 20px">Hey ${name},</p>
          <p style="font-size:16px;line-height:1.6;margin:0 0 20px">Thanks for signing up for CostKey. Your project is ready.</p>
          <p style="font-size:16px;line-height:1.6;margin:0 0 8px">Your DSN:</p>
          <div style="background:#f4f4f5;border-radius:6px;padding:12px 16px;margin:0 0 20px">
            <code style="font-family:'JetBrains Mono',monospace;font-size:13px;word-break:break-all;color:#18181b">${dsn}</code>
          </div>
          <p style="font-size:16px;line-height:1.6;margin:0 0 8px">Add this to your app:</p>
          <div style="background:#18181b;border-radius:6px;padding:16px;margin:0 0 24px">
            <code style="font-family:'JetBrains Mono',monospace;font-size:13px;color:#a1a1aa;line-height:1.8;display:block"><span style="color:#fafafa">Python:</span> pip install costkey<br>import costkey<br>costkey.init(dsn="${dsn}")<br><br><span style="color:#fafafa">TypeScript:</span> npm install costkey<br>import { CostKey } from 'costkey'<br>CostKey.init({ dsn: '${dsn}' })</code>
          </div>
          <p style="font-size:16px;line-height:1.6;margin:0 0 24px">That's it. Every AI call will show up in <a href="https://app.costkey.dev" style="color:#18181b;font-weight:600">your dashboard</a> automatically.</p>
          <p style="font-size:16px;line-height:1.6;margin:0 0 4px">If anything's confusing or broken, just reply to this email. I read every one.</p>
          <p style="font-size:16px;line-height:1.6;margin:24px 0 0">— Naman</p>
          <p style="font-size:13px;color:#a1a1aa;margin:4px 0 0">Founder, CostKey</p>
        </div>
      `,
    });
    console.log(`[costkey] Welcome email sent to ${to}`);
  } catch (err) {
    console.error(`[costkey] Failed to send welcome email to ${to}:`, err);
  }
}

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
      const { email: rawEmail, password, name, orgName, inviteToken } = req.body as {
        email: string; password: string; name: string; orgName?: string; inviteToken?: string;
      };

      if (!rawEmail || !password || !name) {
        res.status(400).json({ error: "Missing email, password, or name" });
        return;
      }
      if (password.length < 8) {
        res.status(400).json({ error: "Password must be at least 8 characters" });
        return;
      }

      const email = rawEmail.trim().toLowerCase();

      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (existing.length > 0) {
        res.status(409).json({ error: "Email already registered" });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const userId = `usr_${randomId()}`;
      const pool = getPool();

      // Check if signing up via invite
      let joinedViaInvite = false;
      let orgId = "";
      let role = "owner";
      let projectId: string | null = null;
      let authKey: string | null = null;
      let displayOrgName = "";
      let orgSlug = "";

      if (inviteToken) {
        // Fail closed — an invalid/expired/revoked invite must not silently
        // degrade into a new-org signup (that's a silent-authorization bug).

        // Sweep so an expired-but-not-flipped row gets the right status
        await pool.query(
          "UPDATE team_invites SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW()",
        );

        const invite = await pool.query(
          "SELECT id, org_id, email, role, status, expires_at FROM team_invites WHERE token = $1",
          [inviteToken],
        );

        if (invite.rows.length === 0) {
          res.status(400).json({ error: "Invalid invite token", code: "invite_not_found" });
          return;
        }

        const inv = invite.rows[0];

        if (inv.status === "revoked") {
          res.status(410).json({ error: "This invite was revoked", code: "invite_revoked" });
          return;
        }
        if (inv.status === "accepted") {
          res.status(409).json({ error: "This invite has already been used", code: "invite_already_accepted" });
          return;
        }
        if (inv.status === "expired") {
          res.status(410).json({ error: "This invite has expired. Ask an admin to resend it.", code: "invite_expired" });
          return;
        }
        if (inv.status !== "pending") {
          res.status(400).json({ error: "Invalid invite state" });
          return;
        }

        // Enforce email match so the token can't be used to create an account
        // under a different identity than the one that was invited.
        if (email !== inv.email.trim().toLowerCase()) {
          res.status(403).json({
            error: `This invite was sent to ${inv.email}. Sign up with that email to accept it.`,
            code: "invite_email_mismatch",
          });
          return;
        }

        orgId = inv.org_id;
        role = inv.role;
        joinedViaInvite = true;

        const orgResult = await pool.query("SELECT name, slug FROM orgs WHERE id = $1", [orgId]);
        displayOrgName = orgResult.rows[0]?.name ?? "Team";
        orgSlug = orgResult.rows[0]?.slug ?? "team";

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // User must exist before we can set accepted_by (FK constraint)
          await client.query(
            "INSERT INTO users (id, email, password_hash, name, org_id, role) VALUES ($1,$2,$3,$4,$5,$6)",
            [userId, email, passwordHash, name, orgId, role],
          );
          // Atomic: only flip the invite if it's still pending — if two signup
          // requests race we want exactly one to win.
          const accepted = await client.query(
            `UPDATE team_invites
             SET status = 'accepted', accepted_at = NOW(), accepted_by = $1
             WHERE id = $2 AND status = 'pending'
             RETURNING id`,
            [userId, inv.id],
          );
          if (accepted.rows.length === 0) {
            await client.query("ROLLBACK");
            res.status(409).json({ error: "Invite is no longer available", code: "invite_race" });
            return;
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }

        // Get first project for DSN
        const proj = await pool.query("SELECT id, auth_key FROM projects WHERE org_id = $1 LIMIT 1", [orgId]);
        if (proj.rows.length > 0) {
          projectId = proj.rows[0].id;
          authKey = proj.rows[0].auth_key;
        }
      }

      if (!joinedViaInvite) {
        // Normal signup — create new org + project
        orgId = `org_${randomId()}`;
        role = "owner";
        projectId = `proj_${randomId()}`;
        authKey = `ck_${randomId()}`;
        orgSlug = slugify(orgName ?? name);
        displayOrgName = orgName ?? `${name}'s Org`;

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
      }

      const finalRole = role as string;
      const token = jwt.sign({ userId, orgId, role: finalRole }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
      setTokenCookie(res, token);

      const dsnUrl = authKey ? `https://${authKey}@app.costkey.dev/${projectId}` : null;

      res.status(201).json({
        user: { id: userId, email, name, orgId, role: finalRole },
        org: { id: orgId, name: displayOrgName, slug: orgSlug },
        project: projectId ? { id: projectId, name: "Default Project", authKey } : null,
        dsn: dsnUrl,
        token,
        joinedViaInvite,
      });

      // Send welcome email (fire and forget)
      if (dsnUrl && !joinedViaInvite) {
        void sendWelcomeEmail(email, name, dsnUrl);
      }
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
      if (!user.passwordHash) {
        // GitHub-only account — can't login with password
        res.status(401).json({ error: "This account uses GitHub login. Please sign in with GitHub." });
        return;
      }
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
      res.json({ authenticated: false });
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

  // ── GitHub OAuth ──
  const GITHUB_CLIENT_ID = process.env["GITHUB_CLIENT_ID"] ?? "";
  const GITHUB_CLIENT_SECRET = process.env["GITHUB_CLIENT_SECRET"] ?? "";

  // GET /auth/github — redirect to GitHub OAuth. Accepts ?invite=TOKEN so the
  // callback can consume the invite (avoids creating a new org for an invited user).
  router.get("/auth/github", (req: Request, res: Response) => {
    if (!GITHUB_CLIENT_ID) {
      res.status(503).json({ error: "GitHub OAuth not configured" });
      return;
    }
    const invite = typeof req.query["invite"] === "string" ? req.query["invite"] : null;
    if (invite) {
      // Short-lived, HttpOnly cookie — survives the GitHub round-trip.
      res.cookie("ck_invite_token", invite, {
        maxAge: 10 * 60 * 1000,
        httpOnly: true,
        sameSite: "lax",
        secure: process.env["NODE_ENV"] === "production",
      });
    }
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      scope: "user:email",
      redirect_uri: `${process.env["PUBLIC_URL"] ?? "https://app.costkey.dev"}/auth/github/callback`,
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  // GET /auth/github/callback — exchange code for token, create/find user
  router.get("/auth/github/callback", async (req: Request, res: Response) => {
    try {
      const code = req.query["code"] as string;
      if (!code) { res.redirect("/login?error=github_denied"); return; }

      // Exchange code for access token
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
        }),
      });
      const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
      if (!tokenData.access_token) {
        console.error("[costkey] GitHub OAuth error:", tokenData);
        res.redirect("/login?error=github_failed");
        return;
      }

      // Fetch GitHub user profile
      const ghUserRes = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "CostKey" },
      });
      const ghUser = await ghUserRes.json() as { id: number; login: string; name: string | null; email: string | null; avatar_url: string };

      // Fetch primary email if not public
      let emailRaw = ghUser.email;
      if (!emailRaw) {
        const emailsRes = await fetch("https://api.github.com/user/emails", {
          headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "CostKey" },
        });
        const emails = await emailsRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
        const primary = emails.find((e) => e.primary && e.verified);
        emailRaw = primary?.email ?? emails[0]?.email ?? null;
      }

      if (!emailRaw) {
        res.redirect("/login?error=github_no_email");
        return;
      }

      const email = emailRaw.trim().toLowerCase();
      const githubId = String(ghUser.id);
      const name = ghUser.name ?? ghUser.login;
      const pool = getPool();

      // Pull any pending invite handoff from the pre-redirect cookie, then clear it.
      const inviteToken: string | null = req.cookies?.["ck_invite_token"] ?? null;
      res.clearCookie("ck_invite_token");

      // Validate the invite now so we can route new users straight into the
      // inviting org (no throwaway org/project). Invalid invites fall through
      // to normal sign-in; the /invite/TOKEN page will surface the error.
      type ValidInvite = { id: string; orgId: string; role: string; email: string };
      let validInvite: ValidInvite | null = null;
      if (inviteToken) {
        await pool.query(
          "UPDATE team_invites SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW()",
        );
        const inv = (await pool.query(
          "SELECT id, org_id, email, role, status FROM team_invites WHERE token = $1",
          [inviteToken],
        )).rows[0];
        if (inv && inv.status === "pending" && inv.email.trim().toLowerCase() === email) {
          validInvite = { id: inv.id, orgId: inv.org_id, role: inv.role, email: inv.email };
        }
      }

      // Check if user exists by github_id
      let userRow = (await pool.query("SELECT id, email, name, org_id, role FROM users WHERE github_id = $1", [githubId])).rows[0];

      // Check if user exists by email (link accounts)
      if (!userRow) {
        userRow = (await pool.query("SELECT id, email, name, org_id, role FROM users WHERE LOWER(email) = $1", [email])).rows[0];
        if (userRow) {
          // Link GitHub to existing account
          await pool.query("UPDATE users SET github_id = $1 WHERE id = $2", [githubId, userRow.id]);
        }
      }

      // Create new user if not found. If we have a valid invite, join the
      // inviter's org directly instead of spawning a new one.
      if (!userRow) {
        const userId = `usr_${randomId()}`;

        if (validInvite) {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            await client.query(
              "INSERT INTO users (id, email, password_hash, name, org_id, role, github_id) VALUES ($1,$2,NULL,$3,$4,$5,$6)",
              [userId, email, name, validInvite.orgId, validInvite.role, githubId],
            );
            const accepted = await client.query(
              `UPDATE team_invites
               SET status = 'accepted', accepted_at = NOW(), accepted_by = $1
               WHERE id = $2 AND status = 'pending'
               RETURNING id`,
              [userId, validInvite.id],
            );
            if (accepted.rows.length === 0) {
              // Raced with a concurrent accept — roll back and fall through to
              // normal new-org creation so the user isn't stranded.
              await client.query("ROLLBACK");
              validInvite = null;
            } else {
              await client.query("COMMIT");
              userRow = { id: userId, email, name, org_id: validInvite.orgId, role: validInvite.role };
            }
          } catch (err) {
            await client.query("ROLLBACK");
            throw err;
          } finally {
            client.release();
          }
        }

        if (!userRow) {
          const orgId = `org_${randomId()}`;
          const projectId = `proj_${randomId()}`;
          const authKey = `ck_${randomId()}`;
          const orgSlug = slugify(name);

          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            await client.query("INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)", [orgId, `${name}'s Org`, orgSlug]);
            await client.query(
              "INSERT INTO users (id, email, password_hash, name, org_id, role, github_id) VALUES ($1,$2,NULL,$3,$4,'owner',$5)",
              [userId, email, name, orgId, githubId],
            );
            await client.query("INSERT INTO projects (id, name, org_id, auth_key) VALUES ($1,$2,$3,$4)", [projectId, "Default Project", orgId, authKey]);
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK");
            throw err;
          } finally {
            client.release();
          }

          userRow = { id: userId, email, name, org_id: orgId, role: "owner" };
          const ghDsn = `https://${authKey}@app.costkey.dev/${projectId}`;
          void sendWelcomeEmail(email, name, ghDsn);
        }

        const token = jwt.sign({ userId: userRow.id, orgId: userRow.org_id, role: userRow.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
        setTokenCookie(res, token);

        // Invited users land in the dashboard; fresh signups go through onboarding.
        res.redirect(validInvite ? "/" : "/onboarding");
        return;
      }

      // Existing user — sign in. If an invite token came through, send them to
      // the Invite page so accept-invite runs with our centralized validation
      // (email-match, sole-owner guard, atomic status flip).
      const token = jwt.sign(
        { userId: userRow.id, orgId: userRow.org_id, role: userRow.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES },
      );
      setTokenCookie(res, token);
      res.redirect(inviteToken ? `/invite/${inviteToken}` : "/");
    } catch (err) {
      console.error("[costkey] GitHub OAuth callback error:", err);
      res.redirect("/login?error=github_failed");
    }
  });

  // ── CLI Auth Flow ──
  // The CLI starts a localhost HTTP server, then opens the browser to this endpoint.
  // After the user logs in (via normal login/signup/GitHub), the server redirects
  // back to the CLI's localhost with a long-lived CLI token.

  // GET /auth/cli — start CLI auth flow, redirect to login with cli callback info
  router.get("/auth/cli", (req: Request, res: Response) => {
    const port = req.query["port"] as string;
    const state = req.query["state"] as string;
    if (!port || !state) {
      res.status(400).json({ error: "Missing port or state parameter" });
      return;
    }
    // Store CLI callback info in a short-lived cookie so we can redirect after login
    res.cookie("ck_cli_port", port, { maxAge: 10 * 60 * 1000, httpOnly: true, sameSite: "lax" });
    res.cookie("ck_cli_state", state, { maxAge: 10 * 60 * 1000, httpOnly: true, sameSite: "lax" });
    res.redirect("/login?cli=1");
  });

  // POST /auth/cli-token — generate a long-lived CLI token for an authenticated user
  // Called by the dashboard after login when cli=1 query param is present
  router.post("/auth/cli-token", async (req: Request, res: Response) => {
    const authUser = (req as any).user as AuthUser | undefined;
    if (!authUser) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const port = req.cookies?.["ck_cli_port"];
    const state = req.cookies?.["ck_cli_state"];

    if (!port || !state) {
      res.status(400).json({ error: "No CLI auth session found" });
      return;
    }

    // Generate a long-lived CLI token (90 days)
    const cliToken = jwt.sign(
      { userId: authUser.id, orgId: authUser.orgId, role: authUser.role, type: "cli" },
      JWT_SECRET,
      { expiresIn: "90d" },
    );

    // Clear the CLI cookies
    res.clearCookie("ck_cli_port");
    res.clearCookie("ck_cli_state");

    res.json({ token: cliToken, port, state });
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

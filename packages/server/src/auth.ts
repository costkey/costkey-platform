import type { Router, Request, Response, NextFunction } from "express";
import { Router as createRouter } from "express";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Resend } from "resend";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb, getPool } from "./db.js";
import { users, orgs, projects } from "./schema.js";
import { syncSeatsLater } from "./subscription.js";
import {
  listAccessibleProjects,
  normalizeRole,
  roleCanManageWorkspace,
} from "./permissions.js";
import { projectDsn, publicOrigin, secureCookies } from "./public-url.js";

async function sendWelcomeEmail(to: string, name: string, projectId: string): Promise<void> {
  if (!process.env["RESEND_API_KEY"]
    || process.env["NODE_ENV"] === "test"
    || process.env["COSTKEY_NOTIFICATION_SINK"] === "memory"
    || (process.env["NODE_ENV"] !== "production" && process.env["COSTKEY_ALLOW_EXTERNAL_NOTIFICATIONS"] !== "true")) return;
  const setupUrl = `${publicOrigin()}/onboarding?project=${encodeURIComponent(projectId)}`;
  try {
    const resend = new Resend(process.env["RESEND_API_KEY"]!);
    await resend.emails.send({
      from: "Naman from CostKey <naman@costkey.dev>",
      to,
      subject: "Welcome to CostKey — you're set up",
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;color:#1a1a1a">
          <p style="font-size:16px;line-height:1.6;margin:0 0 20px">Hey ${escapeHtml(name)},</p>
          <p style="font-size:16px;line-height:1.6;margin:0 0 20px">Thanks for signing up for CostKey. Your project is ready.</p>
          <p style="font-size:16px;line-height:1.6;margin:0 0 24px">Continue setup in your authenticated CostKey workspace to retrieve the project DSN and setup instructions:</p>
          <p style="margin:0 0 24px"><a href="${escapeHtml(setupUrl)}" style="color:#18181b;font-weight:600">Open project setup</a></p>
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] ?? char));
}

// A missing signing key must stop startup in every non-test environment.  The
// deterministic value is intentionally available only to isolated tests; it
// is never a development/docker fallback that can mint real sessions.
const JWT_SECRET = process.env["COSTKEY_JWT_SECRET"]
  ?? (process.env["NODE_ENV"] === "test" ? "costkey-test-only-secret" : "");
const JWT_EXPIRES = "7d";
if (!JWT_SECRET) {
  throw new Error("COSTKEY_JWT_SECRET must be configured outside test environments");
}

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
    secure: secureCookies(),
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

const OAUTH_STATE_COOKIE = "ck_oauth_state";
const OAUTH_COOKIE_MAX_AGE = 10 * 60 * 1000;

/**
 * Keep post-login redirects same-origin and inside the dashboard. This is the
 * server-side counterpart to the dashboard Login guard; OAuth must not trust
 * a return target just because the browser rendered it in a link.
 */
export function safeInternalReturnTo(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.includes("\u0000")) return null;
  try {
    const resolved = new URL(raw, "https://costkey.invalid");
    const decodedPath = decodeURIComponent(resolved.pathname);
    if (resolved.origin !== "https://costkey.invalid"
      || !resolved.pathname.startsWith("/")
      || resolved.pathname.startsWith("//")
      || decodedPath.startsWith("//")
      || decodedPath.includes("\\")) return null;
    if (resolved.pathname.startsWith("/login")
      || resolved.pathname.startsWith("/signup")
      || resolved.pathname.startsWith("/auth")) return null;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return null;
  }
}

/** Accept only a TCP port that can address the CLI's loopback listener. */
export function parseCliCallbackPort(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

/** Build the callback URL structurally so user input can never change its host. */
export function cliCallbackUrl(raw: unknown): URL | null {
  const port = parseCliCallbackPort(raw);
  if (port === null) return null;
  const callback = new URL("http://localhost/");
  callback.port = String(port);
  callback.pathname = "/callback";
  return callback;
}

function equalSecret(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return expectedBytes.length > 0
    && expectedBytes.length === actualBytes.length
    && timingSafeEqual(expectedBytes, actualBytes);
}

export function verifiedGithubEmail(
  profileEmail: unknown,
  emails: unknown,
): string | null {
  const candidates = Array.isArray(emails) ? emails : [];
  const emailEntry = (entry: unknown, primaryOnly: boolean): string | null => {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.email !== "string" || record.verified !== true || (primaryOnly && record.primary !== true)) return null;
    return record.email.trim() || null;
  };
  const verified = candidates.map((entry) => emailEntry(entry, true)).find((email): email is string => Boolean(email))
    ?? candidates.map((entry) => emailEntry(entry, false)).find((email): email is string => Boolean(email));
  if (verified) return verified;
  // A public profile email is only accepted when it is also represented by a
  // verified email returned by GitHub. Never fall back to an unverified value.
  if (typeof profileEmail === "string") {
    const normalized = profileEmail.trim().toLowerCase();
    const matching = candidates.map((entry) => emailEntry(entry, false))
      .find((email) => email?.toLowerCase() === normalized);
    if (matching) return matching;
  }
  return null;
}

/** Compare the short-lived OAuth nonce without exposing a timing oracle. */
export function verifyOAuthState(expected: unknown, actual: unknown): boolean {
  if (typeof expected !== "string" || typeof actual !== "string" || expected.length === 0 || actual.length === 0) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export interface OAuthStatePayload {
  issuedAt: number;
  nonce: string;
  returnTo: string;
}

function encodeOAuthState(payload: OAuthStatePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signOAuthState(encodedPayload: string): string {
  return createHmac("sha256", JWT_SECRET).update(encodedPayload).digest("base64url");
}

/**
 * Issue a portable, signed state envelope. It contains no credential and can
 * be verified by another app instance without shared process memory. The
 * HttpOnly cookie still binds the browser's callback to this exact value.
 */
export function issueOAuthState(returnTo = "/", now = Date.now()): string {
  const payload: OAuthStatePayload = {
    issuedAt: now,
    nonce: randomBytes(32).toString("base64url"),
    returnTo: safeInternalReturnTo(returnTo) ?? "/",
  };
  const encoded = encodeOAuthState(payload);
  return `${encoded}.${signOAuthState(encoded)}`;
}

export function consumeOAuthStatePayload(
  expected: unknown,
  actual: unknown,
  now = Date.now(),
): OAuthStatePayload | null {
  const candidate = typeof actual === "string" ? actual : "";
  if (!verifyOAuthState(expected, candidate)) return null;
  const separator = candidate.lastIndexOf(".");
  if (separator <= 0 || separator === candidate.length - 1) return null;
  const encoded = candidate.slice(0, separator);
  const signature = candidate.slice(separator + 1);
  const expectedSignature = signOAuthState(encoded);
  const expectedBytes = Buffer.from(expectedSignature, "utf8");
  const actualBytes = Buffer.from(signature, "utf8");
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) return null;
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OAuthStatePayload;
  } catch {
    return null;
  }
  if (!payload || !Number.isSafeInteger(payload.issuedAt) || typeof payload.nonce !== "string"
    || payload.nonce.length < 32 || typeof payload.returnTo !== "string") return null;
  const safeReturnTo = safeInternalReturnTo(payload.returnTo);
  if (!safeReturnTo || safeReturnTo !== payload.returnTo) return null;
  const age = now - payload.issuedAt;
  if (age < -60_000 || age > OAUTH_COOKIE_MAX_AGE) return null;
  return payload;
}

/** Validate the signed state envelope; provider authorization codes remain one-use. */
export function consumeOAuthState(expected: unknown, actual: unknown, now = Date.now()): boolean {
  return consumeOAuthStatePayload(expected, actual, now) !== null;
}

function oauthCookieOptions() {
  return {
    maxAge: OAUTH_COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: secureCookies(),
    path: "/",
  };
}

function clearOAuthCookies(res: Response): void {
  const options = { ...oauthCookieOptions(), maxAge: undefined };
  res.clearCookie(OAUTH_STATE_COOKIE, options);
  res.clearCookie("ck_invite_token", options);
}

export function createAuthRouter(pool?: pg.Pool): Router {
  const router = createRouter();
  const authPool = pool ?? getPool();
  const db = pool ? drizzle(authPool) : getDb();

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
        await authPool.query(
          "UPDATE team_invites SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW()",
        );

        const invite = await authPool.query(
          "SELECT id, org_id, email, role, project_ids, status, expires_at FROM team_invites WHERE token = $1",
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
        role = normalizeRole(inv.role);
        joinedViaInvite = true;

        const orgResult = await authPool.query("SELECT name, slug FROM orgs WHERE id = $1", [orgId]);
        displayOrgName = orgResult.rows[0]?.name ?? "Team";
        orgSlug = orgResult.rows[0]?.slug ?? "team";

        const client = await authPool.connect();
        try {
          await client.query("BEGIN");
          const assignedProjectIds = Array.isArray(inv.project_ids)
            ? (inv.project_ids as unknown[]).filter((id): id is string => typeof id === "string")
            : (await client.query("SELECT id FROM projects WHERE org_id = $1", [orgId])).rows.map((row: { id: string }) => row.id);
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
          for (const assignedProjectId of assignedProjectIds) {
            await client.query(
              `INSERT INTO project_memberships(project_id, user_id, assigned_by)
               VALUES ($1, $2, NULL) ON CONFLICT (project_id, user_id) DO NOTHING`,
              [assignedProjectId, userId],
            );
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
        syncSeatsLater(authPool, orgId);

        // Management roles receive setup access. Other invited roles only get
        // a project returned when the invitation explicitly assigned one.
        const proj = roleCanManageWorkspace(role)
          ? await authPool.query("SELECT id, auth_key FROM projects WHERE org_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1", [orgId])
          : await authPool.query(
            `SELECT p.id, NULL::text AS auth_key
             FROM projects p JOIN project_memberships pm ON pm.project_id = p.id
             WHERE p.org_id = $1 AND pm.user_id = $2
             ORDER BY p.created_at ASC, p.id ASC LIMIT 1`,
            [orgId, userId],
          );
        if (proj.rows.length > 0) {
          projectId = proj.rows[0].id;
          authKey = roleCanManageWorkspace(role) ? proj.rows[0].auth_key : null;
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
        // Workspace names are not unique; keep the slug unique instead of
        // failing the whole signup with a constraint violation.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const taken = await authPool.query("SELECT 1 FROM orgs WHERE slug = $1", [orgSlug]);
          if (taken.rows.length === 0) break;
          orgSlug = `${slugify(orgName ?? name)}-${randomId().slice(0, 6)}`;
        }

        const client = await authPool.connect();
        try {
          await client.query("BEGIN");
          await client.query("INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)", [orgId, displayOrgName, orgSlug]);
          await client.query("INSERT INTO workspace_settings (org_id, timezone, reporting_currency) VALUES ($1, 'UTC', 'USD') ON CONFLICT (org_id) DO NOTHING", [orgId]);
          await client.query("INSERT INTO users (id, email, password_hash, name, org_id, role) VALUES ($1,$2,$3,$4,$5,$6)", [userId, email, passwordHash, name, orgId, "owner"]);
          await client.query("INSERT INTO projects (id, name, org_id, auth_key) VALUES ($1,$2,$3,$4)", [projectId, "Default Project", orgId, authKey]);
          await client.query(
            `INSERT INTO project_settings (
               project_id, capture_mode, body_capture_enabled, redaction_enabled,
               body_retention_days, metadata_retention_days, aggregate_retention_days,
               source_access_enabled
             ) VALUES ($1, 'metadata', FALSE, TRUE, 7, 30, 395, TRUE)
             ON CONFLICT (project_id) DO NOTHING`,
            [projectId],
          );
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

      const dsnUrl = authKey && projectId ? projectDsn(authKey, projectId) : null;

      res.status(201).json({
        user: { id: userId, email, name, orgId, role: finalRole },
        org: { id: orgId, name: displayOrgName, slug: orgSlug },
        project: projectId ? { id: projectId, name: "Default Project", authKey } : null,
        dsn: dsnUrl,
        token,
        joinedViaInvite,
      });

      // Send welcome email (fire and forget)
      if (projectId && !joinedViaInvite) {
        void sendWelcomeEmail(email, name, projectId);
      }
    } catch (err) {
      console.error("[costkey] Signup error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /auth/login
  router.post("/auth/login", async (req: Request, res: Response) => {
    try {
      const { email: rawEmail, password } = req.body as { email: string; password: string };
      if (!rawEmail || !password) {
        res.status(400).json({ error: "Missing email or password" });
        return;
      }

      const email = rawEmail.trim().toLowerCase();

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

      const role = normalizeRole(user.role);
      const token = jwt.sign({ userId: user.id, orgId: user.orgId, role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
      setTokenCookie(res, token);

      res.json({
        user: { id: user.id, email: user.email, name: user.name, orgId: user.orgId, role },
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
    const workspaceSettingsResult = await authPool.query(
      `SELECT timezone, reporting_currency, fx_rate, fx_source, fx_as_of, updated_at
       FROM workspace_settings WHERE org_id = $1`,
      [authUser.orgId],
    );
    const workspaceSettings = workspaceSettingsResult.rows[0] as {
      timezone?: string; reporting_currency?: string; fx_rate?: number | null;
      fx_source?: string | null; fx_as_of?: string | Date | null; updated_at?: string | Date | null;
    } | undefined;
    const orgSettings = {
      timezone: workspaceSettings?.timezone ?? "UTC",
      reportingCurrency: workspaceSettings?.reporting_currency ?? "USD",
      fx: workspaceSettings?.reporting_currency === "INR"
        ? {
          available: workspaceSettings.fx_rate != null && Boolean(workspaceSettings.fx_source) && Boolean(workspaceSettings.fx_as_of),
          rate: workspaceSettings.fx_rate ?? null,
          source: workspaceSettings.fx_source ?? null,
          asOf: workspaceSettings.fx_as_of ?? null,
        }
        : { available: true, rate: 1, source: "native USD", asOf: null },
      updatedAt: workspaceSettings?.updated_at ?? null,
    };
    const visibleRole = normalizeRole(authUser.role);
    const projectRows = await listAccessibleProjects(authPool, authUser, {
      includeAuthKey: roleCanManageWorkspace(visibleRole),
    });
    const projs = projectRows.map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description ?? null,
      authKey: roleCanManageWorkspace(visibleRole) ? project.auth_key : null,
      createdAt: project.created_at,
      captureMode: project.capture_mode ?? "metadata",
      bodyCaptureEnabled: project.body_capture_enabled ?? false,
      redactionEnabled: project.redaction_enabled ?? true,
      sourceAccessEnabled: project.source_access_enabled ?? false,
    }));
    const memberRows = await db.select({
      id: users.id, email: users.email, name: users.name, role: users.role, createdAt: users.createdAt,
    }).from(users).where(eq(users.orgId, authUser.orgId));
    const members = memberRows.map((member) => ({ ...member, role: normalizeRole(member.role) }));

    res.json({
      user: { ...authUser, role: visibleRole },
      org: org[0] ? { ...org[0], ...orgSettings } : org[0],
      workspaceSettings: orgSettings,
      projects: projs,
      members,
    });
  });

  // POST /auth/admin/impersonate — login as any user (admin only)
  router.post("/auth/admin/impersonate", async (req: Request, res: Response) => {
    try {
      // This endpoint exists only for the disposable local acceptance harness.
      // Production support must use a separately authenticated admin flow; a
      // static header is never a product login mechanism.
      const localAcceptance = process.env["NODE_ENV"] === "test"
        && Boolean(process.env["ACCEPTANCE_BASE_URL"])
        && Boolean(process.env["ACCEPTANCE_DATABASE_URL"]);
      if (!localAcceptance) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      const adminKey = req.headers["x-admin-key"];
      const configuredAdminSecret = process.env["COSTKEY_ADMIN_SECRET"];
      const ADMIN_SECRET = configuredAdminSecret ?? "";

      if (!equalSecret(ADMIN_SECRET, adminKey)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const { userId } = req.body as { userId?: string };
      if (!userId) {
        res.status(400).json({ error: "Missing userId" });
        return;
      }

      const result = await authPool.query(
        "SELECT id, email, name, org_id, role FROM users WHERE id = $1",
        [userId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const user = result.rows[0];
      const token = jwt.sign(
        { userId: user.id, email: user.email, orgId: user.org_id, role: normalizeRole(user.role) },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES },
      );

      await authPool.query(
        `INSERT INTO workspace_audit_log(id, org_id, actor_user_id, action, target_user_id, details)
         VALUES ($1, $2, NULL, 'test_impersonation', $3, $4::jsonb)`,
        [`audit_${randomId()}`, user.org_id, user.id, JSON.stringify({ source: "local_acceptance" })],
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
    const returnTo = safeInternalReturnTo(req.query["returnTo"]) ?? "/";
    const state = issueOAuthState(returnTo);
    // The signed state carries only the validated internal return path; the
    // exact envelope is bound to the browser by this HttpOnly cookie and is
    // never trusted from the provider query alone.
    res.cookie(OAUTH_STATE_COOKIE, state, oauthCookieOptions());
    const invite = typeof req.query["invite"] === "string" ? req.query["invite"] : null;
    if (invite) {
      // Short-lived, HttpOnly cookie — survives the GitHub round-trip.
      res.cookie("ck_invite_token", invite, oauthCookieOptions());
    }
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      scope: "user:email",
      state,
      redirect_uri: `${publicOrigin()}/auth/github/callback`,
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  // GET /auth/github/callback — exchange code for token, create/find user
  router.get("/auth/github/callback", async (req: Request, res: Response) => {
    const expectedState = req.cookies?.[OAUTH_STATE_COOKIE];
    const actualState = typeof req.query["state"] === "string" ? req.query["state"] : null;
    // Validate the signed state before doing any provider work. Clearing the
    // cookie makes the browser callback one-shot; GitHub authorization codes
    // are also single-use at the provider boundary.
    const statePayload = consumeOAuthStatePayload(expectedState, actualState);
    clearOAuthCookies(res);
    if (!statePayload) {
      res.redirect("/login?error=github_state");
      return;
    }
    const returnTo = statePayload.returnTo;
    try {
      const code = typeof req.query["code"] === "string" ? req.query["code"] : "";
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
      if (!ghUserRes.ok) {
        res.redirect("/login?error=github_failed");
        return;
      }
      const ghUser = await ghUserRes.json() as { id: number; login: string; name: string | null; email: string | null; avatar_url: string };

      // Always resolve identity from a verified GitHub email. The profile's
      // public email and the first API email can both be absent/unverified.
      const emailsRes = await fetch("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "CostKey" },
      });
      if (!emailsRes.ok) {
        res.redirect("/login?error=github_no_email");
        return;
      }
      const emails = await emailsRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
      const emailRaw = verifiedGithubEmail(ghUser.email, emails);

      if (!emailRaw) {
        res.redirect("/login?error=github_no_email");
        return;
      }

      const email = emailRaw.trim().toLowerCase();
      const githubId = String(ghUser.id);
      const name = ghUser.name ?? ghUser.login;
      // Pull any pending invite handoff from the pre-redirect cookie, then clear it.
      const inviteToken: string | null = req.cookies?.["ck_invite_token"] ?? null;

      // Validate the invite now so we can route new users straight into the
      // inviting org (no throwaway org/project). Invalid invites fall through
      // to normal sign-in; the /invite/TOKEN page will surface the error.
      type ValidInvite = { id: string; orgId: string; role: string; email: string; projectIds: string[] | null };
      let validInvite: ValidInvite | null = null;
      if (inviteToken) {
        await authPool.query(
          "UPDATE team_invites SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW()",
        );
        const inv = (await authPool.query(
          "SELECT id, org_id, email, role, project_ids, status FROM team_invites WHERE token = $1",
          [inviteToken],
        )).rows[0];
        if (inv && inv.status === "pending" && inv.email.trim().toLowerCase() === email) {
          validInvite = {
            id: inv.id,
            orgId: inv.org_id,
            role: normalizeRole(inv.role),
            email: inv.email,
            projectIds: Array.isArray(inv.project_ids)
              ? inv.project_ids.filter((id: unknown): id is string => typeof id === "string")
              : null,
          };
        }
      }

      // Check if user exists by github_id
      let userRow = (await authPool.query("SELECT id, email, name, org_id, role FROM users WHERE github_id = $1", [githubId])).rows[0];

      // Check if user exists by email (link accounts)
      if (!userRow) {
        userRow = (await authPool.query("SELECT id, email, name, org_id, role FROM users WHERE LOWER(email) = $1", [email])).rows[0];
        if (userRow) {
          // Link GitHub to existing account
          await authPool.query("UPDATE users SET github_id = $1 WHERE id = $2", [githubId, userRow.id]);
        }
      }

      // Create new user if not found. If we have a valid invite, join the
      // inviter's org directly instead of spawning a new one.
      if (!userRow) {
        const userId = `usr_${randomId()}`;

        if (validInvite) {
          const assignedProjectIds = validInvite.projectIds ??
            (await authPool.query("SELECT id FROM projects WHERE org_id = $1", [validInvite.orgId])).rows.map((row: { id: string }) => row.id);
          const client = await authPool.connect();
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
              for (const assignedProjectId of assignedProjectIds) {
                await client.query(
                  `INSERT INTO project_memberships(project_id, user_id, assigned_by)
                   VALUES ($1, $2, NULL) ON CONFLICT (project_id, user_id) DO NOTHING`,
                  [assignedProjectId, userId],
                );
              }
              await client.query("COMMIT");
              userRow = { id: userId, email, name, org_id: validInvite.orgId, role: validInvite.role };
              syncSeatsLater(authPool, validInvite.orgId);
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

          const client = await authPool.connect();
          try {
            await client.query("BEGIN");
            await client.query("INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)", [orgId, `${name}'s Org`, orgSlug]);
            await client.query("INSERT INTO workspace_settings (org_id, timezone, reporting_currency) VALUES ($1, 'UTC', 'USD') ON CONFLICT (org_id) DO NOTHING", [orgId]);
            await client.query(
              "INSERT INTO users (id, email, password_hash, name, org_id, role, github_id) VALUES ($1,$2,NULL,$3,$4,'owner',$5)",
              [userId, email, name, orgId, githubId],
            );
            await client.query("INSERT INTO projects (id, name, org_id, auth_key) VALUES ($1,$2,$3,$4)", [projectId, "Default Project", orgId, authKey]);
            await client.query(
              `INSERT INTO project_settings (
                 project_id, capture_mode, body_capture_enabled, redaction_enabled,
                 body_retention_days, metadata_retention_days, aggregate_retention_days,
                 source_access_enabled
               ) VALUES ($1, 'metadata', FALSE, TRUE, 7, 30, 395, TRUE)
               ON CONFLICT (project_id) DO NOTHING`,
              [projectId],
            );
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK");
            throw err;
          } finally {
            client.release();
          }

          userRow = { id: userId, email, name, org_id: orgId, role: "owner" };
          void sendWelcomeEmail(email, name, projectId);
        }

        const token = jwt.sign({ userId: userRow.id, orgId: userRow.org_id, role: userRow.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
        setTokenCookie(res, token);

        // Invited users land in the dashboard; fresh signups go through
        // onboarding while preserving a validated deep link for after setup.
        const onboardingPath = returnTo === "/"
          ? "/onboarding"
          : `/onboarding?returnTo=${encodeURIComponent(returnTo)}`;
        res.redirect(validInvite ? returnTo : onboardingPath);
        return;
      }

      // Existing user — sign in. If an invite token came through, send them to
      // the Invite page so accept-invite runs with our centralized validation
      // (email-match, sole-owner guard, atomic status flip).
      const token = jwt.sign(
        { userId: userRow.id, orgId: userRow.org_id, role: normalizeRole(userRow.role) },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES },
      );
      setTokenCookie(res, token);
      if (inviteToken) {
        const invitePath = `/invite/${encodeURIComponent(inviteToken)}`;
        res.redirect(returnTo === "/" ? invitePath : `${invitePath}?returnTo=${encodeURIComponent(returnTo)}`);
      } else {
        res.redirect(returnTo);
      }
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
    const port = parseCliCallbackPort(req.query["port"]);
    const state = typeof req.query["state"] === "string" ? req.query["state"] : null;
    if (port === null || !state || !/^[A-Za-z0-9_-]{16,256}$/.test(state)) {
      res.status(400).json({ error: "Missing port or state parameter" });
      return;
    }
    // Store CLI callback info in a short-lived cookie so we can redirect after login
    res.cookie("ck_cli_port", String(port), {
      maxAge: 10 * 60 * 1000, httpOnly: true, sameSite: "lax", secure: secureCookies(),
    });
    res.cookie("ck_cli_state", state, {
      maxAge: 10 * 60 * 1000, httpOnly: true, sameSite: "lax", secure: secureCookies(),
    });
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

    const port = parseCliCallbackPort(req.cookies?.["ck_cli_port"]);
    const state = req.cookies?.["ck_cli_state"];

    if (port === null || !state || !/^[A-Za-z0-9_-]{16,256}$/.test(state) || !cliCallbackUrl(String(port))) {
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

    res.json({ token: cliToken, port: String(port), state });
  });

  return router;
}

/** Auth middleware */
export function authMiddleware(pool?: pg.Pool) {
  const authPool = pool ?? getPool();
  const db = pool ? drizzle(authPool) : getDb();

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
        (req as any).user = { ...result[0], role: normalizeRole(result[0].role) } as AuthUser;
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

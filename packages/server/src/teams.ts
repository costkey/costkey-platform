import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { Resend } from "resend";
import { requireAuth } from "./auth.js";

const resend = new Resend(process.env["RESEND_API_KEY"]!);

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const APP_URL = process.env["PUBLIC_URL"] ?? "https://app.costkey.dev";

async function sendInviteEmail(to: string, inviterName: string, orgName: string, inviteUrl: string): Promise<void> {
  try {
    await resend.emails.send({
      from: "CostKey <noreply@costkey.dev>",
      to,
      subject: `${inviterName} invited you to ${orgName} on CostKey`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto;padding:40px 20px">
          <h2 style="margin:0 0 16px;font-size:20px;color:#111">You've been invited to CostKey</h2>
          <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 24px">
            <strong>${inviterName}</strong> invited you to join <strong>${orgName}</strong> on CostKey.
            CostKey tracks your AI API costs per function, automatically.
          </p>
          <a href="${inviteUrl}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 28px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:600">
            Accept Invite
          </a>
          <p style="color:#999;font-size:12px;margin:24px 0 0">
            This invite expires in 7 days. If you didn't expect this, you can ignore this email.
          </p>
        </div>
      `,
    });
    console.log(`[costkey] Invite email sent to ${to}`);
  } catch (err) {
    console.error(`[costkey] Failed to send invite email to ${to}:`, err);
  }
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  // Pragmatic check — RFC-compliant is overkill; the invite URL + user action is
  // the real verification.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/**
 * Lazy sweep: flip any pending invites past their expiry to `expired`.
 * Called on every list/accept/create so status always matches reality.
 */
async function sweepExpiredInvites(pool: pg.Pool, orgId?: string): Promise<void> {
  if (orgId) {
    await pool.query(
      "UPDATE team_invites SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW() AND org_id = $1",
      [orgId],
    );
  } else {
    await pool.query(
      "UPDATE team_invites SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW()",
    );
  }
}

/**
 * Returns true if `userId` is the sole owner of `orgId`. Used to block a user
 * from accepting an invite that would orphan their current org.
 */
async function isSoleOwner(pool: pg.Pool, userId: string, orgId: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT id FROM users WHERE org_id = $1 AND role = 'owner'",
    [orgId],
  );
  if (result.rows.length !== 1) return false;
  return result.rows[0].id === userId;
}

export function createTeamsRouter(pool: pg.Pool): Router {
  const router = createRouter();

  // All team routes require auth
  router.use(requireAuth);

  // POST /api/v1/team/invite — invite a team member
  router.post("/api/v1/team/invite", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can invite members" });
        return;
      }

      const rawEmail = (req.body?.email ?? "") as string;
      const role = req.body?.role as string | undefined;
      const email = normalizeEmail(rawEmail);

      if (!email) {
        res.status(400).json({ error: "Missing email" });
        return;
      }
      if (!isValidEmail(email)) {
        res.status(400).json({ error: "Invalid email address" });
        return;
      }

      const memberRole = role === "admin" ? "admin" : "member";

      // Sweep expired invites first so the "pending" check below is accurate
      await sweepExpiredInvites(pool, user.orgId);

      // Reject if the email already belongs to a member of this org
      const existing = await pool.query(
        "SELECT id FROM users WHERE LOWER(email) = $1 AND org_id = $2",
        [email, user.orgId],
      );
      if (existing.rows.length > 0) {
        res.status(409).json({ error: "User is already a member of this organization" });
        return;
      }

      // Only one pending invite per (org, email) at a time
      const pendingInvite = await pool.query(
        "SELECT id FROM team_invites WHERE LOWER(email) = $1 AND org_id = $2 AND status = 'pending'",
        [email, user.orgId],
      );
      if (pendingInvite.rows.length > 0) {
        res.status(409).json({
          error: "An invite is already pending for this email. Revoke it or use Resend instead.",
          inviteId: pendingInvite.rows[0].id,
        });
        return;
      }

      const id = `inv_${randomId()}`;
      const token = randomToken();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

      await pool.query(
        `INSERT INTO team_invites (id, org_id, email, role, invited_by, token, status, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
        [id, user.orgId, email, memberRole, user.id, token, expiresAt],
      );

      const inviteUrl = `${APP_URL}/invite/${token}`;

      const orgResult = await pool.query("SELECT name FROM orgs WHERE id = $1", [user.orgId]);
      const orgName = orgResult.rows[0]?.name ?? "your team";

      void sendInviteEmail(email, user.name, orgName, inviteUrl);

      res.status(201).json({
        id,
        email,
        role: memberRole,
        inviteUrl,
        expiresAt,
      });
    } catch (err) {
      console.error("[costkey] Invite error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/team/invites — list invites (all statuses, newest first)
  router.get("/api/v1/team/invites", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;

      // Sweep so UI never shows a stale "pending" for an expired invite
      await sweepExpiredInvites(pool, user.orgId);

      const result = await pool.query(
        `SELECT i.id, i.email, i.role, i.status, i.created_at, i.expires_at,
                i.accepted_at, i.revoked_at, i.resent_count, i.last_resent_at,
                u.name as invited_by_name
        FROM team_invites i
        JOIN users u ON u.id = i.invited_by
        WHERE i.org_id = $1
        ORDER BY i.created_at DESC`,
        [user.orgId],
      );
      res.json({ invites: result.rows });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/v1/team/invites/:inviteId — revoke a pending invite
  router.delete("/api/v1/team/invites/:inviteId", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can revoke invites" });
        return;
      }

      // Atomic: only revoke if currently pending — prevents revoking an
      // already-accepted invite and clobbering the audit trail.
      const result = await pool.query(
        `UPDATE team_invites
         SET status = 'revoked', revoked_at = NOW(), revoked_by = $1
         WHERE id = $2 AND org_id = $3 AND status = 'pending'
         RETURNING id`,
        [user.id, req.params.inviteId, user.orgId],
      );

      if (result.rows.length === 0) {
        // Distinguish "not found" from "not pending" for better UX
        const lookup = await pool.query(
          "SELECT status FROM team_invites WHERE id = $1 AND org_id = $2",
          [req.params.inviteId, user.orgId],
        );
        if (lookup.rows.length === 0) {
          res.status(404).json({ error: "Invite not found" });
          return;
        }
        res.status(409).json({
          error: `Cannot revoke invite with status '${lookup.rows[0].status}'`,
          status: lookup.rows[0].status,
        });
        return;
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/v1/team/invites/:inviteId/resend — rotate token + extend expiry + re-email
  router.post("/api/v1/team/invites/:inviteId/resend", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can resend invites" });
        return;
      }

      const inviteRes = await pool.query(
        "SELECT id, email, role, status FROM team_invites WHERE id = $1 AND org_id = $2",
        [req.params.inviteId, user.orgId],
      );
      if (inviteRes.rows.length === 0) {
        res.status(404).json({ error: "Invite not found" });
        return;
      }
      const inv = inviteRes.rows[0];
      if (inv.status === "accepted") {
        res.status(409).json({ error: "Invite has already been accepted" });
        return;
      }
      if (inv.status === "revoked") {
        res.status(409).json({ error: "Invite was revoked. Create a new invite instead." });
        return;
      }

      // Rotate token, reset expiry, flip back to pending
      const newToken = randomToken();
      const newExpiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

      await pool.query(
        `UPDATE team_invites
         SET token = $1,
             expires_at = $2,
             status = 'pending',
             resent_count = resent_count + 1,
             last_resent_at = NOW()
         WHERE id = $3`,
        [newToken, newExpiresAt, inv.id],
      );

      const inviteUrl = `${APP_URL}/invite/${newToken}`;
      const orgResult = await pool.query("SELECT name FROM orgs WHERE id = $1", [user.orgId]);
      const orgName = orgResult.rows[0]?.name ?? "your team";

      void sendInviteEmail(inv.email, user.name, orgName, inviteUrl);

      res.json({
        id: inv.id,
        email: inv.email,
        role: inv.role,
        inviteUrl,
        expiresAt: newExpiresAt,
      });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/v1/team/accept-invite — accept an invite as the currently logged-in user.
  // The client hits this first; if the user is not logged in the requireAuth
  // middleware returns 401 and the frontend routes them to /signup?invite=…
  router.post("/api/v1/team/accept-invite", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { token } = req.body as { token?: string };
      if (!token) {
        res.status(400).json({ error: "Missing invite token" });
        return;
      }

      // Lazily flip any due-expiry invites so the switch below is accurate
      await sweepExpiredInvites(pool);

      // Lookup the invite unconditionally so we can return specific errors
      const inviteRes = await pool.query(
        "SELECT id, org_id, email, role, status, expires_at FROM team_invites WHERE token = $1",
        [token],
      );
      if (inviteRes.rows.length === 0) {
        res.status(404).json({ error: "Invite not found", code: "invite_not_found" });
        return;
      }
      const inv = inviteRes.rows[0];

      switch (inv.status) {
        case "revoked":
          res.status(410).json({ error: "This invite was revoked", code: "invite_revoked" });
          return;
        case "accepted":
          res.status(409).json({ error: "This invite has already been accepted", code: "invite_already_accepted" });
          return;
        case "expired":
          res.status(410).json({ error: "This invite has expired. Ask an admin to resend it.", code: "invite_expired" });
          return;
        case "pending":
          break;
        default:
          res.status(500).json({ error: "Invalid invite state" });
          return;
      }

      // Enforce email match — the token alone must not be sufficient to hijack
      // an invite for a different account.
      if (normalizeEmail(user.email) !== normalizeEmail(inv.email)) {
        res.status(403).json({
          error: `This invite was sent to ${inv.email}. Sign in as that user to accept it.`,
          code: "invite_email_mismatch",
        });
        return;
      }

      // Block if accepting would orphan the user's current org (enterprise safety net)
      if (user.orgId !== inv.org_id && await isSoleOwner(pool, user.id, user.orgId)) {
        res.status(409).json({
          error: "You are the sole owner of your current organization. Transfer ownership or remove it before joining a new org.",
          code: "would_orphan_org",
        });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Atomic acceptance — fails silently if someone else just accepted/revoked it
        const accepted = await client.query(
          `UPDATE team_invites
           SET status = 'accepted', accepted_at = NOW(), accepted_by = $1
           WHERE id = $2 AND status = 'pending'
           RETURNING id`,
          [user.id, inv.id],
        );
        if (accepted.rows.length === 0) {
          await client.query("ROLLBACK");
          res.status(409).json({ error: "Invite is no longer available", code: "invite_race" });
          return;
        }

        // Move the user to the new org with the invite's role
        await client.query(
          "UPDATE users SET org_id = $1, role = $2 WHERE id = $3",
          [inv.org_id, inv.role, user.id],
        );

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      res.json({ ok: true, orgId: inv.org_id, role: inv.role });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/v1/team/members/:memberId — change role
  router.patch("/api/v1/team/members/:memberId", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner") {
        res.status(403).json({ error: "Only owners can change roles" });
        return;
      }

      const { memberId } = req.params;
      const { role } = req.body as { role: string };

      if (!["owner", "admin", "member"].includes(role)) {
        res.status(400).json({ error: "Invalid role" });
        return;
      }

      if (memberId === user.id) {
        res.status(400).json({ error: "Cannot change your own role" });
        return;
      }

      await pool.query(
        "UPDATE users SET role = $1 WHERE id = $2 AND org_id = $3",
        [role, memberId, user.orgId],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/v1/team/members/:memberId — remove from org
  router.delete("/api/v1/team/members/:memberId", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner") {
        res.status(403).json({ error: "Only owners can remove members" });
        return;
      }

      const { memberId } = req.params;
      if (memberId === user.id) {
        res.status(400).json({ error: "Cannot remove yourself" });
        return;
      }

      await pool.query("DELETE FROM users WHERE id = $1 AND org_id = $2", [memberId, user.orgId]);
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

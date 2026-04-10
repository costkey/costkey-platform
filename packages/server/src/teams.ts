import type { Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { Resend } from "resend";
import { requireAuth } from "./auth.js";

const resend = new Resend(process.env["RESEND_API_KEY"]!);

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

export function createTeamsRouter(pool: pg.Pool): Router {
  const router = createRouter();

  // All team routes require auth
  router.use(requireAuth);

  // POST /api/v1/team/invite — invite a team member
  router.post("/api/v1/team/invite", async (req, res) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can invite members" });
        return;
      }

      const { email, role } = req.body as { email: string; role?: string };
      if (!email) {
        res.status(400).json({ error: "Missing email" });
        return;
      }

      const memberRole = role === "admin" ? "admin" : "member";

      // Check if already a member
      const existing = await pool.query(
        "SELECT id FROM users WHERE email = $1 AND org_id = $2",
        [email, user.orgId],
      );
      if (existing.rows.length > 0) {
        res.status(409).json({ error: "User is already a member of this organization" });
        return;
      }

      // Check if invite already pending
      const pendingInvite = await pool.query(
        "SELECT id FROM team_invites WHERE email = $1 AND org_id = $2 AND status = 'pending'",
        [email, user.orgId],
      );
      if (pendingInvite.rows.length > 0) {
        res.status(409).json({ error: "Invite already pending for this email" });
        return;
      }

      const id = `inv_${randomId()}`;
      const token = randomToken();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

      await pool.query(
        `INSERT INTO team_invites (id, org_id, email, role, invited_by, token, status, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
        [id, user.orgId, email, memberRole, user.id, token, expiresAt],
      );

      const inviteUrl = `https://app.costkey.dev/invite/${token}`;

      // Get org name for the email
      const orgResult = await pool.query("SELECT name FROM orgs WHERE id = $1", [user.orgId]);
      const orgName = orgResult.rows[0]?.name ?? "your team";

      // Send invite email
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

  // GET /api/v1/team/invites — list pending invites
  router.get("/api/v1/team/invites", async (req, res) => {
    try {
      const user = (req as any).user;
      const result = await pool.query(
        `SELECT i.id, i.email, i.role, i.status, i.created_at, i.expires_at,
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

  // DELETE /api/v1/team/invites/:inviteId — revoke an invite
  router.delete("/api/v1/team/invites/:inviteId", async (req, res) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can revoke invites" });
        return;
      }

      await pool.query(
        "UPDATE team_invites SET status = 'revoked' WHERE id = $1 AND org_id = $2",
        [req.params.inviteId, user.orgId],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/v1/team/accept-invite — accept an invite (called by new user)
  router.post("/api/v1/team/accept-invite", async (req, res) => {
    try {
      const { token } = req.body as { token: string };
      if (!token) {
        res.status(400).json({ error: "Missing invite token" });
        return;
      }

      const invite = await pool.query(
        "SELECT * FROM team_invites WHERE token = $1 AND status = 'pending'",
        [token],
      );

      if (invite.rows.length === 0) {
        res.status(404).json({ error: "Invite not found or expired" });
        return;
      }

      const inv = invite.rows[0];

      // Check if expired
      if (new Date(inv.expires_at) < new Date()) {
        await pool.query("UPDATE team_invites SET status = 'expired' WHERE id = $1", [inv.id]);
        res.status(410).json({ error: "Invite has expired" });
        return;
      }

      // Check if user already exists with this email
      const existingUser = await pool.query("SELECT id, org_id FROM users WHERE email = $1", [inv.email]);

      if (existingUser.rows.length > 0) {
        // User exists — move them to the new org
        const u = existingUser.rows[0];
        await pool.query("UPDATE users SET org_id = $1, role = $2 WHERE id = $3", [inv.org_id, inv.role, u.id]);
      }
      // If user doesn't exist, they need to signup first — the invite will be checked during signup

      await pool.query("UPDATE team_invites SET status = 'accepted' WHERE id = $1", [inv.id]);

      res.json({ ok: true, orgId: inv.org_id });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/v1/team/members/:memberId — change role
  router.patch("/api/v1/team/members/:memberId", async (req, res) => {
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

      // Can't change your own role
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
  router.delete("/api/v1/team/members/:memberId", async (req, res) => {
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

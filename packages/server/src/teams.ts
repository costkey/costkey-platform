import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { Resend } from "resend";
import { requireAuth } from "./auth.js";
import { syncSeatsLater } from "./subscription.js";
import {
  normalizeRole,
  roleCanManageWorkspace,
} from "./permissions.js";
import { publicOrigin } from "./public-url.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const APP_URL = publicOrigin();

function inviteEmailEnabled(): boolean {
  return Boolean(process.env["RESEND_API_KEY"])
    && process.env["NODE_ENV"] !== "test"
    && process.env["COSTKEY_NOTIFICATION_SINK"] !== "memory"
    && (process.env["NODE_ENV"] === "production" || process.env["COSTKEY_ALLOW_EXTERNAL_NOTIFICATIONS"] === "true");
}

async function sendInviteEmail(to: string, inviterName: string, orgName: string, inviteUrl: string, role = "viewer"): Promise<void> {
  if (!inviteEmailEnabled()) return;
  try {
    const resend = new Resend(process.env["RESEND_API_KEY"]!);
    await resend.emails.send({
      from: "CostKey <noreply@costkey.dev>",
      to,
      subject: `${inviterName} invited you to ${orgName} on CostKey`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto;padding:40px 20px">
          <h2 style="margin:0 0 16px;font-size:20px;color:#111">You've been invited to CostKey</h2>
          <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 24px">
            <strong>${escapeHtml(inviterName)}</strong> invited you to join <strong>${escapeHtml(orgName)}</strong> on CostKey.
            CostKey tracks your AI API costs per function, automatically.
          </p>
          <p style="color:#555;font-size:14px;line-height:1.5;margin:0 0 24px">Access: <strong>${escapeHtml(role)}</strong></p>
          <a href="${escapeHtml(inviteUrl)}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 28px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:600">
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] ?? char));
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

type WorkspaceActor = { id: string; orgId: string; role: string };

class WorkspaceActionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "WorkspaceActionError";
  }
}

function requireOwnerConfirmation(actor: WorkspaceActor, confirmation: string | undefined): void {
  if (normalizeRole(actor.role) !== "owner") {
    throw new WorkspaceActionError(403, "owner_required", "Only the current workspace owner can perform this action");
  }
  if (!confirmation || confirmation !== actor.orgId) {
    throw new WorkspaceActionError(400, "confirmation_required", "confirmOrgId must match the workspace");
  }
}

async function currentOwner(client: pg.Pool | pg.PoolClient, orgId: string): Promise<{ id: string } | null> {
  const result = await client.query(
    "SELECT id FROM users WHERE org_id = $1 AND role = 'owner' ORDER BY id FOR UPDATE",
    [orgId],
  );
  if (result.rows.length !== 1) return null;
  return result.rows[0] as { id: string };
}

/**
 * Transfer ownership under a workspace advisory lock. The old owner is
 * demoted before the target is promoted inside one transaction, so readers
 * never observe a committed zero-owner or two-owner state.
 */
export async function transferWorkspaceOwnership(
  pool: pg.Pool,
  actor: WorkspaceActor,
  targetUserId: string,
  confirmTargetUserId: string | undefined,
): Promise<{ owner: { id: string; email: string; name: string }; previousOwner: { id: string; role: "admin" }; auditId: string }> {
  if (!targetUserId || targetUserId !== confirmTargetUserId) {
    throw new WorkspaceActionError(400, "confirmation_required", "confirmTargetUserId must match targetUserId");
  }
  if (normalizeRole(actor.role) !== "owner") {
    throw new WorkspaceActionError(403, "owner_required", "Only the current workspace owner can transfer ownership");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`workspace-owner:${actor.orgId}`]);
    const owner = await currentOwner(client, actor.orgId);
    if (!owner) throw new WorkspaceActionError(409, "ownership_state_invalid", "Workspace must have exactly one current owner");
    if (owner.id !== actor.id) throw new WorkspaceActionError(409, "ownership_race", "Ownership changed while this transfer was being confirmed");

    const targetResult = await client.query(
      "SELECT id, email, name, role FROM users WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [targetUserId, actor.orgId],
    );
    const target = targetResult.rows[0] as { id: string; email: string; name: string; role: string } | undefined;
    if (!target) throw new WorkspaceActionError(404, "member_not_found", "Target member was not found in this workspace");
    if (target.id === actor.id || normalizeRole(target.role) === "owner") {
      throw new WorkspaceActionError(400, "invalid_target", "Choose an existing non-owner workspace member");
    }

    const demoted = await client.query(
      "UPDATE users SET role = 'admin' WHERE id = $1 AND org_id = $2 AND role = 'owner'",
      [actor.id, actor.orgId],
    );
    const promoted = await client.query(
      "UPDATE users SET role = 'owner' WHERE id = $1 AND org_id = $2 AND role <> 'owner'",
      [target.id, actor.orgId],
    );
    if ((demoted.rowCount ?? 0) !== 1 || (promoted.rowCount ?? 0) !== 1) {
      throw new WorkspaceActionError(409, "ownership_race", "Ownership changed while this transfer was being confirmed");
    }
    const invariant = await client.query(
      "SELECT COUNT(*)::int AS count FROM users WHERE org_id = $1 AND role = 'owner'",
      [actor.orgId],
    );
    if (Number(invariant.rows[0]?.count ?? 0) !== 1) {
      throw new WorkspaceActionError(409, "ownership_state_invalid", "Workspace must have exactly one current owner");
    }
    const auditId = `audit_${randomId()}`;
    await client.query(
      `INSERT INTO workspace_audit_log(id, org_id, actor_user_id, action, target_user_id, details)
       VALUES ($1, $2, $3, 'ownership_transferred', $4, $5::jsonb)`,
      [auditId, actor.orgId, actor.id, target.id, JSON.stringify({ previousOwnerId: actor.id, previousOwnerRole: "admin", targetPreviousRole: normalizeRole(target.role) })],
    );
    await client.query("COMMIT");
    return {
      owner: { id: target.id, email: target.email, name: target.name },
      previousOwner: { id: actor.id, role: "admin" },
      auditId,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function workspaceClosureImpact(
  client: pg.Pool | pg.PoolClient,
  orgId: string,
): Promise<Record<string, unknown>> {
  const projects = await client.query("SELECT COUNT(*)::int AS count FROM projects WHERE org_id = $1", [orgId]);
  const members = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE org_id = $1", [orgId]);
  const subscription = await client.query(
    `SELECT provider, status, cancel_at_period_end, provider_customer_id, provider_subscription_id
     FROM subscriptions WHERE org_id = $1`,
    [orgId],
  );
  const policyTable = await client.query("SELECT to_regclass('spending_policies') AS table_name");
  const activePolicies = policyTable.rows[0]?.table_name
    ? await client.query(
      `SELECT COUNT(*)::int AS count
       FROM spending_policies sp JOIN projects p ON p.id = sp.project_id
       WHERE p.org_id = $1 AND sp.status = 'active'`,
      [orgId],
    )
    : { rows: [{ count: 0 }] };
  const pending = await client.query(
    `SELECT id, status, requested_at
     FROM workspace_closure_requests
     WHERE org_id = $1 AND status = 'requested'
     ORDER BY requested_at DESC LIMIT 1`,
    [orgId],
  );
  const subscriptionRow = subscription.rows[0] as {
    provider?: string; status?: string; cancel_at_period_end?: boolean;
    provider_customer_id?: string | null; provider_subscription_id?: string | null;
  } | undefined;
  const projectCount = Number(projects.rows[0]?.count ?? 0);
  const subscriptionStatus = subscriptionRow?.status ?? "not_configured";
  return {
    generatedAt: new Date().toISOString(),
    projects: { count: projectCount, dsnCount: projectCount, dsnAction: "Project credentials are not revoked by this preview or request; rotate/revoke installed SDK credentials before closure." },
    members: { count: Number(members.rows[0]?.count ?? 0), accessAction: "Members retain access until a reviewed closure action is approved." },
    subscription: {
      provider: subscriptionRow?.provider ?? "unconfigured",
      status: subscriptionStatus,
      cancelAtPeriodEnd: Boolean(subscriptionRow?.cancel_at_period_end),
      providerCustomerBound: Boolean(subscriptionRow?.provider_customer_id),
      providerSubscriptionBound: Boolean(subscriptionRow?.provider_subscription_id),
      action: subscriptionStatus === "active" ? "No provider cancellation was sent; cancel through the billing provider or request closure review." : "No active provider subscription is recorded.",
    },
    policies: { activeCount: Number(activePolicies.rows[0]?.count ?? 0), action: "Policies remain unchanged until an explicit reviewed closure action; no enforcement state is changed here." },
    data: { capturedContent: "retained", deletion: "not_requested", aggregateHistory: "retained" },
    pendingRequest: pending.rows[0] ?? null,
  };
}

export async function requestWorkspaceClosure(
  pool: pg.Pool,
  actor: WorkspaceActor,
  confirmOrgId: string | undefined,
  acknowledgeImpact: boolean,
): Promise<{ created: boolean; requestId: string; status: "requested"; impact: Record<string, unknown> }> {
  requireOwnerConfirmation(actor, confirmOrgId);
  if (acknowledgeImpact !== true) {
    throw new WorkspaceActionError(400, "impact_acknowledgement_required", "acknowledgeImpact must be true after reviewing closure impact");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`workspace-owner:${actor.orgId}`]);
    const owner = await currentOwner(client, actor.orgId);
    if (!owner || owner.id !== actor.id) throw new WorkspaceActionError(403, "owner_required", "Only the current workspace owner can request closure");
    const impact = await workspaceClosureImpact(client, actor.orgId);
    const existing = await client.query(
      `SELECT id FROM workspace_closure_requests
       WHERE org_id = $1 AND status = 'requested'
       ORDER BY requested_at DESC LIMIT 1 FOR UPDATE`,
      [actor.orgId],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { created: false, requestId: String(existing.rows[0].id), status: "requested", impact };
    }
    const requestId = `closure_${randomId()}`;
    await client.query(
      `INSERT INTO workspace_closure_requests(id, org_id, requested_by, status, impact)
       VALUES ($1, $2, $3, 'requested', $4::jsonb)`,
      [requestId, actor.orgId, actor.id, JSON.stringify(impact)],
    );
    const auditId = `audit_${randomId()}`;
    await client.query(
      `INSERT INTO workspace_audit_log(id, org_id, actor_user_id, action, details)
       VALUES ($1, $2, $3, 'closure_requested', $4::jsonb)`,
      [auditId, actor.orgId, actor.id, JSON.stringify({ requestId, impactAcknowledged: true })],
    );
    await client.query("COMMIT");
    return { created: true, requestId, status: "requested", impact };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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

/**
 * Public invite preview. Mounted ahead of the authenticated routers in the
 * app, because several of them apply requireAuth to every request they see;
 * a signed-out invitee must still be able to read their invitation.
 */
export function createInvitePreviewRouter(pool: pg.Pool): Router {
  const router = createRouter();
  // GET /api/v1/team/invite-preview/:token — public, read-only invite details.
  // The token is the capability to view this bounded invitation summary; no
  // credentials, project data or membership mutation is exposed.
  router.get("/api/v1/team/invite-preview/:token", async (req: Request, res: Response) => {
    try {
      const inviteResult = await pool.query(
        `SELECT i.org_id, i.email, i.role, i.project_ids, i.status, i.expires_at,
                o.name AS workspace_name, u.name AS inviter_name
         FROM team_invites i
         JOIN orgs o ON o.id = i.org_id
         JOIN users u ON u.id = i.invited_by
         WHERE i.token = $1`,
        [req.params.token],
      );
      const invite = inviteResult.rows[0] as {
        org_id: string;
        email: string;
        role: string;
        project_ids: string[] | null;
        status: string;
        expires_at: string | Date;
        workspace_name: string;
        inviter_name: string;
      } | undefined;
      if (!invite) {
        res.status(404).json({ error: "Invite not found", code: "invite_not_found" });
        return;
      }
      if (invite.status === "revoked") {
        res.status(410).json({ error: "This invite was revoked", code: "invite_revoked" });
        return;
      }
      if (invite.status === "accepted") {
        res.status(409).json({ error: "This invite has already been accepted", code: "invite_already_accepted" });
        return;
      }
      if (invite.status === "expired" || new Date(invite.expires_at).getTime() <= Date.now()) {
        res.status(410).json({ error: "This invite has expired. Ask an admin to resend it.", code: "invite_expired" });
        return;
      }
      if (invite.status !== "pending") {
        res.status(500).json({ error: "Invalid invite state" });
        return;
      }

      const projectQuery = Array.isArray(invite.project_ids)
        ? pool.query(
          "SELECT id, name FROM projects WHERE org_id = $1 AND id = ANY($2::text[]) ORDER BY name",
          [invite.org_id, invite.project_ids],
        )
        : pool.query(
          "SELECT id, name FROM projects WHERE org_id = $1 ORDER BY name",
          [invite.org_id],
        );
      const projectResult = await projectQuery;
      res.json({
        invitation: {
          email: invite.email,
          role: normalizeRole(invite.role),
          expiresAt: new Date(invite.expires_at).toISOString(),
          workspace: { id: invite.org_id, name: invite.workspace_name },
          inviter: { name: invite.inviter_name },
          projects: projectResult.rows.map((project) => ({ id: project.id, name: project.name })),
        },
      });
    } catch (err) {
      console.error("[costkey] Invite preview error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  return router;
}

export function createTeamsRouter(pool: pg.Pool): Router {
  const router = createRouter();

  router.use(createInvitePreviewRouter(pool));

  // All team routes require auth
  router.use("/api", requireAuth);

  // POST /api/v1/team/invite — invite a team member
  router.post("/api/v1/team/invite", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!roleCanManageWorkspace(user.role)) {
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

      const memberRole = role === "admin" || role === "developer" || role === "viewer"
        ? role
        : "viewer";
      const rawProjectIds = req.body?.projectIds;
      if (rawProjectIds !== undefined && (!Array.isArray(rawProjectIds) || rawProjectIds.some((id) => typeof id !== "string"))) {
        res.status(400).json({ error: "projectIds must be an array of project IDs" });
        return;
      }
      // Membership scope must be explicit. Omitting projectIds creates a
      // member with no project access; it must never silently grant every
      // project in the workspace.
      const projectIds = rawProjectIds as string[] | undefined;
      const assignedProjectIds = projectIds ?? [];

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

      const availableProjects = await pool.query("SELECT id FROM projects WHERE org_id = $1", [user.orgId]);
      const availableIds = new Set(availableProjects.rows.map((row: { id: string }) => row.id));
      if (projectIds && projectIds.some((projectId) => !availableIds.has(projectId))) {
        res.status(400).json({ error: "One or more projects are not in this organization" });
        return;
      }

      const id = `inv_${randomId()}`;
      const token = randomToken();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

      await pool.query(
        `INSERT INTO team_invites (id, org_id, email, role, project_ids, invited_by, token, status, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
        [id, user.orgId, email, memberRole, assignedProjectIds, user.id, token, expiresAt],
      );

      const inviteUrl = `${APP_URL}/invite/${token}`;

      const orgResult = await pool.query("SELECT name FROM orgs WHERE id = $1", [user.orgId]);
      const orgName = orgResult.rows[0]?.name ?? "your team";

      void sendInviteEmail(email, user.name, orgName, inviteUrl, memberRole);

      res.status(201).json({
        id,
        email,
        role: memberRole,
        projectIds: assignedProjectIds,
        inviteUrl,
        emailSent: inviteEmailEnabled(),
        expiresAt,
      });
    } catch (err) {
      console.error("[costkey] Invite error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Project assignments are intentionally a separate read so the team table
  // can load them per member without exposing assignments across workspaces.
  router.get("/api/v1/team/members/:memberId/projects", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!roleCanManageWorkspace(user.role)) {
        res.status(403).json({ error: "Only owners and admins can view project assignments" });
        return;
      }
      const result = await pool.query(
        `SELECT pm.project_id
         FROM project_memberships pm
         JOIN projects p ON p.id = pm.project_id AND p.org_id = $2
         WHERE pm.user_id = $1
         ORDER BY pm.project_id`,
        [req.params.memberId, user.orgId],
      );
      res.json({ projectIds: result.rows.map((row) => String(row.project_id)) });
    } catch (err) {
      console.error("[costkey] Project assignment list error:", err);
      res.status(500).json({ error: "Failed to fetch project assignments" });
    }
  });

  // GET /api/v1/team/invites — list invites (all statuses, newest first)
  router.get("/api/v1/team/invites", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!roleCanManageWorkspace(user.role)) {
        res.status(403).json({ error: "Only owners and admins can view invitations" });
        return;
      }

      // Sweep so UI never shows a stale "pending" for an expired invite
      await sweepExpiredInvites(pool, user.orgId);

      const result = await pool.query(
        `SELECT i.id, i.email, i.role, i.project_ids, i.status, i.created_at, i.expires_at,
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
      if (!roleCanManageWorkspace(user.role)) {
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
      if (!roleCanManageWorkspace(user.role)) {
        res.status(403).json({ error: "Only owners and admins can resend invites" });
        return;
      }

      const inviteRes = await pool.query(
        "SELECT id, email, role, project_ids, status FROM team_invites WHERE id = $1 AND org_id = $2",
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

      void sendInviteEmail(inv.email, user.name, orgName, inviteUrl, normalizeRole(inv.role));

      res.json({
        id: inv.id,
        email: inv.email,
        role: inv.role,
        projectIds: inv.project_ids ?? [],
        inviteUrl,
        emailSent: inviteEmailEnabled(),
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
        "SELECT id, org_id, email, role, project_ids, status, expires_at FROM team_invites WHERE token = $1",
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
        const assignedProjectIds = Array.isArray(inv.project_ids)
          ? (inv.project_ids as unknown[]).filter((id): id is string => typeof id === "string")
          : (await client.query("SELECT id FROM projects WHERE org_id = $1", [inv.org_id])).rows.map((row: { id: string }) => row.id);

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
          [inv.org_id, normalizeRole(inv.role), user.id],
        );
        // A user can belong to only one workspace in this legacy model. Move
        // their explicit assignments in the same transaction as invite use.
        await client.query("DELETE FROM project_memberships WHERE user_id = $1", [user.id]);
        for (const assignedProjectId of assignedProjectIds) {
          await client.query(
            `INSERT INTO project_memberships(project_id, user_id, assigned_by)
             VALUES ($1, $2, $3) ON CONFLICT (project_id, user_id) DO NOTHING`,
            [assignedProjectId, user.id, user.id],
          );
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      // One seat moves: onto the inviting workspace, off the one they left.
      syncSeatsLater(pool, inv.org_id, user.orgId);
      res.json({ ok: true, orgId: inv.org_id, role: normalizeRole(inv.role) });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/v1/team/members/:memberId — change role
  router.patch("/api/v1/team/members/:memberId", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const actorRole = normalizeRole(user.role);
      if (!roleCanManageWorkspace(actorRole)) {
        res.status(403).json({ error: "Only owners and admins can change roles" });
        return;
      }

      const { memberId } = req.params;
      const { role } = req.body as { role: string; projectIds?: unknown };
      const nextRole = normalizeRole(role);

      if (!["admin", "developer", "viewer"].includes(nextRole)) {
        res.status(400).json({ error: "Role must be admin, developer, or viewer" });
        return;
      }

      if (memberId === user.id) {
        res.status(400).json({ error: "Cannot change your own role" });
        return;
      }

      const rawProjectIds = req.body?.projectIds;
      if (rawProjectIds !== undefined && (!Array.isArray(rawProjectIds) || rawProjectIds.some((id) => typeof id !== "string"))) {
        res.status(400).json({ error: "projectIds must be an array of project IDs" });
        return;
      }
      const projectIds = rawProjectIds as string[] | undefined;
      if (projectIds) {
        const available = await pool.query("SELECT id FROM projects WHERE org_id = $1", [user.orgId]);
        const availableIds = new Set(available.rows.map((row: { id: string }) => row.id));
        if (projectIds.some((projectId) => !availableIds.has(projectId))) {
          res.status(400).json({ error: "One or more projects are not in this organization" });
          return;
        }
      }
      const client = projectIds ? await pool.connect() : null;
      let updated: { rowCount?: number | null };
      try {
        if (client) await client.query("BEGIN");
        const executor = client ?? pool;
        updated = await executor.query(
          "UPDATE users SET role = $1 WHERE id = $2 AND org_id = $3 AND role <> 'owner'",
          [nextRole, memberId, user.orgId],
        );
        if (client && (updated.rowCount ?? 0) === 1) {
          await client.query("DELETE FROM project_memberships WHERE user_id = $1", [memberId]);
          for (const projectId of projectIds ?? []) {
            await client.query(
              `INSERT INTO project_memberships(project_id, user_id, assigned_by)
               VALUES ($1, $2, $3) ON CONFLICT (project_id, user_id) DO NOTHING`,
              [projectId, memberId, user.id],
            );
          }
        }
        if (client) await client.query("COMMIT");
      } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client?.release();
      }
      if ((updated.rowCount ?? 0) === 0) {
        res.status(404).json({ error: "Member not found or is an owner" });
        return;
      }
      res.json({ ok: true, role: nextRole, ...(projectIds ? { projectIds } : {}) });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/v1/team/members/:memberId — remove from org
  router.delete("/api/v1/team/members/:memberId", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const actorRole = normalizeRole(user.role);
      if (!roleCanManageWorkspace(actorRole)) {
        res.status(403).json({ error: "Only owners and admins can remove members" });
        return;
      }

      const { memberId } = req.params;
      if (memberId === user.id) {
        res.status(400).json({ error: "Cannot remove yourself" });
        return;
      }

      const target = await pool.query("SELECT role FROM users WHERE id = $1 AND org_id = $2", [memberId, user.orgId]);
      if (target.rows[0]?.role === "owner") {
        res.status(403).json({ error: "Owners cannot be removed" });
        return;
      }
      await pool.query("DELETE FROM users WHERE id = $1 AND org_id = $2", [memberId, user.orgId]);
      syncSeatsLater(pool, user.orgId);
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/v1/team/transfer-ownership — explicit current-owner handoff.
  router.post("/api/v1/team/transfer-ownership", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user as WorkspaceActor;
      const targetUserId = typeof req.body?.targetUserId === "string" ? req.body.targetUserId : "";
      const confirmTargetUserId = typeof req.body?.confirmTargetUserId === "string" ? req.body.confirmTargetUserId : undefined;
      const result = await transferWorkspaceOwnership(pool, user, targetUserId, confirmTargetUserId);
      res.json({ ok: true, ...result });
    } catch (error) {
      const action = error as Partial<WorkspaceActionError>;
      if (typeof action.status === "number") {
        res.status(action.status).json({ error: error instanceof Error ? error.message : "Workspace action failed", code: action.code });
        return;
      }
      console.error("[costkey] Ownership transfer error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const closureImpactHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const user = (req as any).user as WorkspaceActor;
      if (normalizeRole(user.role) !== "owner") {
        res.status(403).json({ error: "Only the current workspace owner can review closure impact", code: "owner_required" });
        return;
      }
      const owner = await pool.query(
        "SELECT id FROM users WHERE id = $1 AND org_id = $2 AND role = 'owner'",
        [user.id, user.orgId],
      );
      if (owner.rows.length !== 1) {
        res.status(403).json({ error: "Only the current workspace owner can review closure impact", code: "owner_required" });
        return;
      }
      res.json({ impact: await workspaceClosureImpact(pool, user.orgId) });
    } catch (error) {
      console.error("[costkey] Closure impact error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  };
  router.get("/api/v1/workspace/closure-impact", closureImpactHandler);
  router.get("/api/v1/workspace/closure", closureImpactHandler);

  // POST /api/v1/workspace/closure — record an explicit, reviewable request.
  // This endpoint intentionally does not delete data, revoke DSNs, alter
  // policies, or call a billing provider; it makes the impact visible first.
  router.post("/api/v1/workspace/closure", async (req: Request, res: Response) => {
    try {
      const user = (req as any).user as WorkspaceActor;
      const confirmOrgId = typeof req.body?.confirmOrgId === "string" ? req.body.confirmOrgId : undefined;
      const result = await requestWorkspaceClosure(pool, user, confirmOrgId, req.body?.acknowledgeImpact === true);
      res.status(result.created ? 201 : 200).json({
        ok: true,
        closureRequested: true,
        deletionStarted: false,
        ...result,
      });
    } catch (error) {
      const action = error as Partial<WorkspaceActionError>;
      if (typeof action.status === "number") {
        res.status(action.status).json({ error: error instanceof Error ? error.message : "Workspace action failed", code: action.code });
        return;
      }
      console.error("[costkey] Workspace closure error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

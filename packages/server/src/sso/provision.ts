/**
 * Turn a verified SSO email into a CostKey user. Users are matched by email,
 * so switching an install from passwords to SSO keeps everyone's data.
 *
 * Rules, in order:
 *   1. An existing user with this email signs in as they are.
 *   2. A pending invite for this email joins its workspace with its role and
 *      projects. In SSO modes an invite is just "add this email with this role".
 *   3. An email an owner or admin removed from the team stays out until it is
 *      invited again, so removal still means something behind SSO.
 *   4. In an empty install the first person creates the workspace and is owner.
 *   5. Everyone else joins the oldest workspace with COSTKEY_SSO_DEFAULT_ROLE
 *      and is assigned to its projects. A workspace with no owner gets this
 *      person as owner instead.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { normalizeRole } from "../permissions.js";
import { syncSeatsLater } from "../subscription.js";
import { ssoEnabled, type SsoRole } from "./config.js";
import { publicAppUrl } from "./urls.js";

export interface ProvisionedUser {
  id: string;
  email: string;
  name: string;
  orgId: string;
  role: string;
  /** How this sign-in resolved, for logs and redirects. */
  outcome: "existing" | "invited" | "created_workspace" | "joined";
}

export class SsoAccessError extends Error {
  constructor(public readonly code: "access_removed", message: string) {
    super(message);
    this.name = "SsoAccessError";
  }
}

// An arbitrary constant: serializes SSO provisioning so two first sign-ins
// cannot both create a workspace.
const PROVISION_LOCK_KEY = 7_311_204_517;

const schemaReady = new WeakMap<pg.Pool, Promise<void>>();

export function ensureSsoSchema(pool: pg.Pool): Promise<void> {
  let ready = schemaReady.get(pool);
  if (!ready) {
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS sso_removed_members (
        email TEXT PRIMARY KEY,
        org_id TEXT,
        removed_by TEXT,
        removed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).then(() => undefined);
    ready.catch(() => schemaReady.delete(pool));
    schemaReady.set(pool, ready);
  }
  return ready;
}

function randomId(): string {
  return randomBytes(12).toString("hex");
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "workspace";
}

function displayName(email: string, name: string | null | undefined): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed.slice(0, 200);
  return email.slice(0, email.indexOf("@")) || email;
}

/** Remember that a member was removed so SSO does not silently re-add them. */
export async function recordSsoRemoval(pool: pg.Pool, email: string, orgId: string, removedBy: string | null): Promise<void> {
  await ensureSsoSchema(pool);
  await pool.query(
    `INSERT INTO sso_removed_members(email, org_id, removed_by) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET org_id = EXCLUDED.org_id, removed_by = EXCLUDED.removed_by, removed_at = NOW()`,
    [email.trim().toLowerCase(), orgId, removedBy],
  );
}

export async function findOrProvisionSsoUser(
  pool: pg.Pool,
  identity: { email: string; name?: string | null },
  defaultRole: SsoRole,
): Promise<ProvisionedUser> {
  const email = identity.email.trim().toLowerCase();
  const existing = await pool.query(
    "SELECT id, email, name, org_id, role FROM users WHERE LOWER(email) = $1 LIMIT 1",
    [email],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return { id: row.id, email: row.email, name: row.name, orgId: row.org_id, role: normalizeRole(row.role), outcome: "existing" };
  }

  await ensureSsoSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [PROVISION_LOCK_KEY]);

    // Another request may have provisioned this email while we waited.
    const raced = await client.query("SELECT id, email, name, org_id, role FROM users WHERE LOWER(email) = $1 LIMIT 1", [email]);
    if (raced.rows[0]) {
      await client.query("COMMIT");
      const row = raced.rows[0];
      return { id: row.id, email: row.email, name: row.name, orgId: row.org_id, role: normalizeRole(row.role), outcome: "existing" };
    }

    const userId = `usr_${randomId()}`;
    const name = displayName(email, identity.name);

    const invite = (await client.query(
      `SELECT id, org_id, role, project_ids FROM team_invites
       WHERE LOWER(email) = $1 AND status = 'pending' AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [email],
    )).rows[0] as { id: string; org_id: string; role: string; project_ids: unknown } | undefined;
    if (invite) {
      const role = normalizeRole(invite.role) === "owner" ? "admin" : normalizeRole(invite.role);
      const projectIds = Array.isArray(invite.project_ids)
        ? invite.project_ids.filter((id): id is string => typeof id === "string")
        : (await client.query("SELECT id FROM projects WHERE org_id = $1", [invite.org_id])).rows.map((row: { id: string }) => row.id);
      await client.query(
        "INSERT INTO users (id, email, password_hash, name, org_id, role) VALUES ($1, $2, NULL, $3, $4, $5)",
        [userId, email, name, invite.org_id, role],
      );
      await client.query(
        "UPDATE team_invites SET status = 'accepted', accepted_at = NOW(), accepted_by = $1 WHERE id = $2",
        [userId, invite.id],
      );
      await assignProjects(client, userId, projectIds);
      await client.query("DELETE FROM sso_removed_members WHERE email = $1", [email]);
      await client.query("COMMIT");
      syncSeatsLater(pool, invite.org_id);
      return { id: userId, email, name, orgId: invite.org_id, role, outcome: "invited" };
    }

    const removed = await client.query("SELECT 1 FROM sso_removed_members WHERE email = $1", [email]);
    if (removed.rows.length > 0) {
      await client.query("ROLLBACK");
      throw new SsoAccessError("access_removed", `${email} was removed from the workspace. An owner or admin must invite them again.`);
    }

    const org = (await client.query("SELECT id FROM orgs ORDER BY created_at ASC NULLS LAST, id ASC LIMIT 1")).rows[0] as { id: string } | undefined;
    if (!org) {
      const created = await createWorkspace(client, userId, email, name);
      await client.query("COMMIT");
      return { id: userId, email, name, orgId: created.orgId, role: "owner", outcome: "created_workspace" };
    }

    const hasOwner = await client.query("SELECT 1 FROM users WHERE org_id = $1 AND role = 'owner' LIMIT 1", [org.id]);
    const role = hasOwner.rows.length > 0 ? defaultRole : "owner";
    await client.query(
      "INSERT INTO users (id, email, password_hash, name, org_id, role) VALUES ($1, $2, NULL, $3, $4, $5)",
      [userId, email, name, org.id, role],
    );
    if (role !== "owner") {
      const projectIds = (await client.query("SELECT id FROM projects WHERE org_id = $1", [org.id])).rows.map((row: { id: string }) => row.id);
      await assignProjects(client, userId, projectIds);
    }
    await client.query("COMMIT");
    syncSeatsLater(pool, org.id);
    return { id: userId, email, name, orgId: org.id, role, outcome: "joined" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function assignProjects(client: pg.PoolClient, userId: string, projectIds: string[]): Promise<void> {
  for (const projectId of projectIds) {
    await client.query(
      `INSERT INTO project_memberships(project_id, user_id, assigned_by)
       VALUES ($1, $2, NULL) ON CONFLICT (project_id, user_id) DO NOTHING`,
      [projectId, userId],
    );
  }
}

/** The same workspace, settings and default project a password signup creates. */
async function createWorkspace(client: pg.PoolClient, userId: string, email: string, name: string): Promise<{ orgId: string; projectId: string }> {
  const orgId = `org_${randomId()}`;
  const projectId = `proj_${randomId()}`;
  const authKey = `ck_${randomId()}`;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const orgName = domain || `${name}'s Org`;
  let slug = slugify(orgName);
  if ((await client.query("SELECT 1 FROM orgs WHERE slug = $1", [slug])).rows.length > 0) {
    slug = `${slug}-${randomId().slice(0, 6)}`;
  }
  await client.query("INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)", [orgId, orgName, slug]);
  await client.query(
    "INSERT INTO workspace_settings (org_id, timezone, reporting_currency) VALUES ($1, 'UTC', 'USD') ON CONFLICT (org_id) DO NOTHING",
    [orgId],
  );
  await client.query(
    "INSERT INTO users (id, email, password_hash, name, org_id, role) VALUES ($1, $2, NULL, $3, $4, 'owner')",
    [userId, email, name, orgId],
  );
  await client.query("INSERT INTO projects (id, name, org_id, auth_key) VALUES ($1, $2, $3, $4)", [projectId, "Default Project", orgId, authKey]);
  await client.query(
    `INSERT INTO project_settings (
       project_id, capture_mode, body_capture_enabled, redaction_enabled,
       body_retention_days, metadata_retention_days, aggregate_retention_days,
       source_access_enabled
     ) VALUES ($1, 'metadata', FALSE, TRUE, 7, 30, 395, TRUE)
     ON CONFLICT (project_id) DO NOTHING`,
    [projectId],
  );
  return { orgId, projectId };
}

/**
 * Invites in SSO modes are "add this email with this role": the person just
 * signs in through SSO and the invite applies. They last longer than
 * password invites because nothing has to be clicked. Null in password mode.
 */
export function ssoInviteTerms(): { ttlMs: number; url: string } | null {
  if (!ssoEnabled()) return null;
  return { ttlMs: 90 * 24 * 60 * 60 * 1000, url: `${publicAppUrl()}/login` };
}

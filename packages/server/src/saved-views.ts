import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import {
  canAccessProject,
  roleCanPublishSharedView,
} from "./permissions.js";
import { publicAppUrl } from "./public-url.js";

type SavedViewUser = { id: string; orgId: string; role: string };

// Saved views are filters/state, not a general JSON document store.  Keep this
// list deliberately tied to the console's public filter vocabulary so a
// viewer cannot persist or later retrieve prompts, source, credentials, or an
// attacker-controlled arbitrary payload under a benign-looking view.
const ALLOWED_DEFINITION_KEYS = new Set([
  "route", "tab", "query", "q", "period", "sort", "filters",
  "provider", "model", "feature", "function", "customer", "environment",
  "lifecycle", "status", "accounting", "coverage", "service", "release",
  "groupBy", "groupValue", "contextKey", "contextValue", "executionId", "traceId",
  "from", "to", "currency", "timezone", "view", "selection", "selected",
  "operations", "volume", "users", "conversations", "operationsPerUser",
  "operationsPerConversation", "assumedCostPerOperation", "assumedCostPerUnit",
  "targetPeriodDays", "volumeUnit", "accountScope", "fullyPricedOnly",
]);

const MAX_DEFINITION_DEPTH = 6;
const MAX_DEFINITION_ARRAY_ITEMS = 100;
const MAX_DEFINITION_STRING_CHARS = 2_048;
const ALLOWED_CONTEXT_KEYS = new Set([
  "environment", "service", "release", "operation", "feature", "function", "functionName",
  "group", "groupName", "groupType", "executionId", "execution_id", "phase", "caseId", "case_id",
  "datasetRevision", "dataset_revision", "customer", "customerId", "customer_id", "traceId", "trace_id",
  "traceName", "trace_name", "runtime", "task",
]);

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `view_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function userOf(req: Request): SavedViewUser | null {
  return (req as Request & { user?: SavedViewUser }).user ?? null;
}

export function scrubDefinition(value: unknown, key?: string, depth = 0): unknown {
  if (key && !ALLOWED_DEFINITION_KEYS.has(key)) return undefined;
  if (depth > MAX_DEFINITION_DEPTH) return undefined;
  if (key === "contextKey" && (typeof value !== "string" || !ALLOWED_CONTEXT_KEYS.has(value.trim()))) return undefined;
  if (typeof value === "string") return value.length > MAX_DEFINITION_STRING_CHARS ? value.slice(0, MAX_DEFINITION_STRING_CHARS) : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DEFINITION_ARRAY_ITEMS)
      .map((item) => scrubDefinition(item, undefined, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return undefined;
  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    const scrubbed = scrubDefinition(entryValue, entryKey, depth + 1);
    if (scrubbed !== undefined) result[entryKey] = scrubbed;
  }
  return result;
}

export function validateDefinition(value: unknown): Record<string, unknown> {
  const scrubbed = scrubDefinition(value ?? {});
  if (!scrubbed || typeof scrubbed !== "object" || Array.isArray(scrubbed)) {
    throw Object.assign(new Error("definition must be an object"), { status: 400 });
  }
  if (Buffer.byteLength(JSON.stringify(scrubbed), "utf8") > 64 * 1024) {
    throw Object.assign(new Error("definition is too large"), { status: 413 });
  }
  return scrubbed as Record<string, unknown>;
}

function formatRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind,
    visibility: row.visibility,
    // Re-sanitize on every read as well as on write.  This protects viewers
    // from rows created before the allowlist (or by a direct DB migration).
    definition: validateDefinition(row.definition ?? {}),
    pinned: row.pinned,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function canReadView(pool: pg.Pool, user: SavedViewUser, row: Record<string, unknown>): Promise<boolean> {
  if (row.org_id !== user.orgId) return false;
  if (row.owner_user_id === user.id) {
    return !row.project_id || await canAccessProject(pool, user, String(row.project_id));
  }
  if (row.visibility !== "workspace") return false;
  return !row.project_id || await canAccessProject(pool, user, String(row.project_id));
}

export function createSavedViewsRouter(pool: pg.Pool): Router {
  const router = createRouter();
  router.use("/api", requireAuth);

  router.post("/api/v1/saved-views/scenario/calculate", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const baselineCost = Number(body.baselineCost);
      const baselineOperations = Number(body.baselineOperations);
      const targetOperations = Number(body.targetOperations);
      if (![baselineCost, baselineOperations, targetOperations].every(Number.isFinite)
        || baselineCost < 0 || baselineOperations <= 0 || targetOperations < 0) {
        res.status(400).json({ error: "baselineCost, baselineOperations, and targetOperations must be valid non-negative numbers" });
        return;
      }
      const unitCost = baselineCost / baselineOperations;
      const result = {
        unitCost,
        projectedCost: unitCost * targetOperations,
        assumptions: {
          baselineCost,
          baselineOperations,
          targetOperations,
          source: body.source ?? "captured cohort",
          calculatedAt: new Date().toISOString(),
        },
      };
      res.json(result);
    } catch (error) {
      console.error("[costkey] Scenario calculation error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/v1/saved-views", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const params: unknown[] = [user.orgId, user.id];
      let filter = "AND (owner_user_id = $2 OR visibility = 'workspace')";
      if (typeof req.query.projectId === "string") {
        params.push(req.query.projectId);
        filter += ` AND project_id = $${params.length}`;
      }
      if (typeof req.query.kind === "string") {
        if (req.query.kind !== "view" && req.query.kind !== "scenario") {
          res.status(400).json({ error: "kind must be view or scenario" }); return;
        }
        params.push(req.query.kind);
        filter += ` AND kind = $${params.length}`;
      }
      const rows = await pool.query(
        `SELECT id, org_id, owner_user_id, project_id, name, kind, visibility,
                definition, pinned, created_at, updated_at
         FROM saved_views WHERE org_id = $1 ${filter}
         ORDER BY pinned DESC, updated_at DESC`,
        params,
      );
      const views = [];
      for (const row of rows.rows as Array<Record<string, unknown>>) {
        if (await canReadView(pool, user, row)) views.push(formatRow(row));
      }
      res.json({ views });
    } catch (error) {
      console.error("[costkey] Saved view list error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/v1/saved-views", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const kind = body.kind === "scenario" ? "scenario" : "view";
      const visibility = body.visibility === "workspace" ? "workspace" : "private";
      if (!name || name.length > 120) { res.status(400).json({ error: "name is required and must be at most 120 characters" }); return; }
      if (visibility === "workspace" && !roleCanPublishSharedView(user.role)) {
        res.status(403).json({ error: "Viewer accounts can only create personal saved views" }); return;
      }
      const projectId = body.projectId == null ? null : String(body.projectId);
      if (projectId && !await canAccessProject(pool, user, projectId)) {
        res.status(404).json({ error: "Project not found" }); return;
      }
      const definition = validateDefinition(body.definition);
      const id = randomId();
      const result = await pool.query(
        `INSERT INTO saved_views(id, org_id, owner_user_id, project_id, name, kind, visibility, definition, pinned)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, FALSE)
         RETURNING id, org_id, owner_user_id, project_id, name, kind, visibility, definition, pinned, created_at, updated_at`,
        [id, user.orgId, user.id, projectId, name, kind, visibility, JSON.stringify(definition)],
      );
      res.status(201).json({ view: formatRow(result.rows[0] as Record<string, unknown>) });
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status) { res.status(status).json({ error: (error as Error).message }); return; }
      console.error("[costkey] Saved view create error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/v1/saved-views/:viewId", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const viewId = String(req.params.viewId);
      const result = await pool.query("SELECT * FROM saved_views WHERE id = $1 AND org_id = $2", [viewId, user.orgId]);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row || !await canReadView(pool, user, row)) { res.status(404).json({ error: "Saved view not found" }); return; }
      res.json({ view: formatRow(row) });
    } catch (error) {
      console.error("[costkey] Saved view read error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.patch("/api/v1/saved-views/:viewId", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const viewId = String(req.params.viewId);
      const existingResult = await pool.query("SELECT * FROM saved_views WHERE id = $1 AND org_id = $2", [viewId, user.orgId]);
      const existing = existingResult.rows[0] as Record<string, unknown> | undefined;
      if (!existing || !await canReadView(pool, user, existing)) { res.status(404).json({ error: "Saved view not found" }); return; }
      if (existing.visibility === "workspace" && !roleCanPublishSharedView(user.role)) {
        res.status(403).json({ error: "Insufficient permissions to edit a workspace view" }); return;
      }
      if (existing.owner_user_id !== user.id && existing.visibility !== "workspace") {
        res.status(403).json({ error: "Only the owner can edit a personal view" }); return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updates: string[] = [];
      const params: unknown[] = [user.orgId];
      let index = 2;
      if (body.name !== undefined) {
        if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) { res.status(400).json({ error: "Invalid name" }); return; }
        updates.push(`name = $${index++}`); params.push(body.name.trim());
      }
      if (body.definition !== undefined) { updates.push(`definition = $${index++}::jsonb`); params.push(JSON.stringify(validateDefinition(body.definition))); }
      if (body.pinned !== undefined) {
        if (typeof body.pinned !== "boolean") { res.status(400).json({ error: "pinned must be boolean" }); return; }
        updates.push(`pinned = $${index++}`); params.push(body.pinned);
      }
      if (body.visibility !== undefined) {
        if (body.visibility !== "private" && body.visibility !== "workspace") { res.status(400).json({ error: "visibility must be private or workspace" }); return; }
        if (body.visibility === "workspace" && !roleCanPublishSharedView(user.role)) { res.status(403).json({ error: "Viewer accounts cannot publish workspace views" }); return; }
        updates.push(`visibility = $${index++}`); params.push(body.visibility);
      }
      if (updates.length === 0) { res.status(400).json({ error: "Nothing to update" }); return; }
      updates.push("updated_at = NOW()"); params.push(viewId);
      const result = await pool.query(
        `UPDATE saved_views SET ${updates.join(", ")} WHERE id = $${index} AND org_id = $1 RETURNING *`,
        params,
      );
      res.json({ view: formatRow(result.rows[0] as Record<string, unknown>) });
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status) { res.status(status).json({ error: (error as Error).message }); return; }
      console.error("[costkey] Saved view update error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/v1/saved-views/:viewId", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const viewId = String(req.params.viewId);
      const existing = (await pool.query("SELECT owner_user_id, visibility FROM saved_views WHERE id = $1 AND org_id = $2", [viewId, user.orgId])).rows[0] as { owner_user_id?: string; visibility?: string } | undefined;
      if (!existing) { res.status(404).json({ error: "Saved view not found" }); return; }
      if (existing.owner_user_id !== user.id && (!roleCanPublishSharedView(user.role) || existing.visibility !== "workspace")) {
        res.status(403).json({ error: "Insufficient permissions" }); return;
      }
      await pool.query("DELETE FROM saved_views WHERE id = $1 AND org_id = $2", [viewId, user.orgId]);
      res.json({ ok: true });
    } catch (error) {
      console.error("[costkey] Saved view delete error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/v1/saved-views/:viewId/copy-link", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const viewId = String(req.params.viewId);
      const row = (await pool.query("SELECT * FROM saved_views WHERE id = $1 AND org_id = $2", [viewId, user.orgId])).rows[0] as Record<string, unknown> | undefined;
      if (!row || !await canReadView(pool, user, row)) { res.status(404).json({ error: "Saved view not found" }); return; }
      const base = publicAppUrl();
      // This is an authenticated deep link, not a bearer token or access grant.
      res.json({ url: `${base}/traces?view=${encodeURIComponent(viewId)}`, access: "requires_workspace_permission" });
    } catch (error) {
      console.error("[costkey] Saved view link error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

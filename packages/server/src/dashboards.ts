import { Router as createRouter, type Request, type Response, type Router } from "express";
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import { assertProjectAccess, roleCanPublishSharedView } from "./permissions.js";

/**
 * Custom dashboards: a named, ordered list of widgets a team arranges for a
 * project. Widgets are specs, not queries: the console fills them from the
 * existing /trends and /costs endpoints, so a dashboard adds no new load.
 */

export const WIDGET_KINDS = ["total", "trend", "breakdown"] as const;
export const WIDGET_METRICS = ["cost", "calls", "tokens"] as const;
export const WIDGET_GROUPS = ["model", "provider", "feature", "customer", "function"] as const;
export const WIDGET_PERIODS = ["24h", "7d", "30d"] as const;
const MAX_WIDGETS = 24;

export interface WidgetSpec {
  id: string;
  title: string;
  kind: typeof WIDGET_KINDS[number];
  metric: typeof WIDGET_METRICS[number];
  groupBy?: typeof WIDGET_GROUPS[number];
  period: typeof WIDGET_PERIODS[number];
  width: "half" | "full";
}

type User = { id: string; orgId: string; role: string };

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function ensureDashboardsSchema(client: pg.Pool | pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS dashboards (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      widgets JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dashboards_project ON dashboards(project_id, updated_at DESC);
  `);
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new HttpError(400, `${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

/** Widgets as sent, checked one by one; anything unknown is refused, not dropped. */
export function cleanWidgets(value: unknown): WidgetSpec[] {
  if (!Array.isArray(value)) throw new HttpError(400, "widgets must be a list");
  if (value.length > MAX_WIDGETS) throw new HttpError(400, `A dashboard holds at most ${MAX_WIDGETS} widgets`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new HttpError(400, `Widget ${index + 1} is not an object`);
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : `w${index}_${randomBytes(3).toString("hex")}`;
    if (seen.has(id)) throw new HttpError(400, "Widget ids must be unique");
    seen.add(id);
    const kind = oneOf(raw.kind, WIDGET_KINDS, "kind");
    const metric = oneOf(raw.metric, WIDGET_METRICS, "metric");
    const period = oneOf(raw.period, WIDGET_PERIODS, "period");
    const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 80) : "";
    const width = raw.width === "full" ? "full" : "half";
    const widget: WidgetSpec = { id, title, kind, metric, period, width };
    if (kind === "breakdown") {
      widget.groupBy = oneOf(raw.groupBy, WIDGET_GROUPS, "groupBy");
      if (metric === "tokens") throw new HttpError(400, "Breakdowns show cost or calls");
    }
    return widget;
  });
}

function cleanName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "name is required");
  if (value.trim().length > 80) throw new HttpError(400, "name is limited to 80 characters");
  return value.trim();
}

function serialize(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    widgets: row.widgets ?? [],
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function access(pool: pg.Pool, req: Request, write: boolean): Promise<{ user: User; projectId: string }> {
  const user = (req as Request & { user?: User }).user!;
  const projectId = String(req.params.projectId);
  await assertProjectAccess(pool, user, projectId);
  if (write && !roleCanPublishSharedView(user.role)) throw new HttpError(403, "Viewers can look at dashboards but not change them");
  return { user, projectId };
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : (error as Error & { status?: number }).status;
      if (status) { res.status(status).json({ error: (error as Error).message }); return; }
      console.error("[costkey] Dashboard error:", error);
      res.status(500).json({ error: "Dashboard request failed" });
    }
  };
}

/** A starting layout for a new dashboard, so it isn't empty. */
export function starterWidgets(): WidgetSpec[] {
  return [
    { id: "spend", title: "Spend", kind: "total", metric: "cost", period: "7d", width: "half" },
    { id: "calls", title: "Calls", kind: "total", metric: "calls", period: "7d", width: "half" },
    { id: "trend", title: "Spend by day", kind: "trend", metric: "cost", period: "30d", width: "full" },
    { id: "models", title: "Spend by model", kind: "breakdown", metric: "cost", groupBy: "model", period: "30d", width: "half" },
    { id: "features", title: "Spend by feature", kind: "breakdown", metric: "cost", groupBy: "feature", period: "30d", width: "half" },
  ];
}

export function createDashboardsRouter(pool: pg.Pool): Router {
  const router = createRouter();
  const base = "/api/v1/projects/:projectId/dashboards";

  router.get(base, requireAuth, handle(async (req, res) => {
    const { projectId } = await access(pool, req, false);
    const result = await pool.query("SELECT * FROM dashboards WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 100", [projectId]);
    res.json({ dashboards: result.rows.map((row) => serialize(row as Record<string, unknown>)) });
  }));

  router.post(base, requireAuth, handle(async (req, res) => {
    const { user, projectId } = await access(pool, req, true);
    const name = cleanName(req.body?.name);
    const widgets = req.body?.widgets === undefined ? starterWidgets() : cleanWidgets(req.body.widgets);
    const result = await pool.query(
      `INSERT INTO dashboards (id, org_id, project_id, name, widgets, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6) RETURNING *`,
      [`dash_${randomBytes(10).toString("hex")}`, user.orgId, projectId, name, JSON.stringify(widgets), user.id],
    );
    res.status(201).json({ dashboard: serialize(result.rows[0] as Record<string, unknown>) });
  }));

  router.get(`${base}/:dashboardId`, requireAuth, handle(async (req, res) => {
    const { projectId } = await access(pool, req, false);
    const result = await pool.query("SELECT * FROM dashboards WHERE project_id = $1 AND id = $2", [projectId, String(req.params.dashboardId)]);
    if (!result.rows[0]) throw new HttpError(404, "Dashboard not found");
    res.json({ dashboard: serialize(result.rows[0] as Record<string, unknown>) });
  }));

  router.put(`${base}/:dashboardId`, requireAuth, handle(async (req, res) => {
    const { user, projectId } = await access(pool, req, true);
    const current = await pool.query("SELECT * FROM dashboards WHERE project_id = $1 AND id = $2", [projectId, String(req.params.dashboardId)]);
    const row = current.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, "Dashboard not found");
    const name = req.body?.name === undefined ? row.name : cleanName(req.body.name);
    const widgets = req.body?.widgets === undefined ? row.widgets : cleanWidgets(req.body.widgets);
    const result = await pool.query(
      "UPDATE dashboards SET name = $1, widgets = $2::jsonb, updated_by = $3, updated_at = NOW() WHERE id = $4 RETURNING *",
      [name, JSON.stringify(widgets), user.id, row.id],
    );
    res.json({ dashboard: serialize(result.rows[0] as Record<string, unknown>) });
  }));

  router.delete(`${base}/:dashboardId`, requireAuth, handle(async (req, res) => {
    const { projectId } = await access(pool, req, true);
    const deleted = await pool.query("DELETE FROM dashboards WHERE project_id = $1 AND id = $2", [projectId, String(req.params.dashboardId)]);
    if (!deleted.rowCount) throw new HttpError(404, "Dashboard not found");
    res.status(204).end();
  }));

  return router;
}

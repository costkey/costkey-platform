import type { NextFunction, Request, Response } from "express";
import type pg from "pg";

export type WorkspaceRole = "owner" | "admin" | "developer" | "viewer";
export interface AuthPrincipal {
  id: string;
  orgId: string;
  role: string;
  /** Set when a personal access token limits the request to some projects. */
  tokenProjectIds?: string[] | null;
}

const RESTRICTED_KEYS = new Set([
  "request_body",
  "response_body",
  // Screen capture: screenshots are captured content.
  "screen_frames",
  "requestBody",
  "responseBody",
  "system_prompt",
  "systemPrompt",
  // Keep the ambiguous `source` key available for cost/pricing provenance.
  // Code/source-map payloads use explicit names so a Viewer can still see
  // effective-price provenance without receiving source material.
  "source_code",
  "sourceCode",
  "source_text",
  "sourceText",
  "code",
  "code_snippet",
  "codeSnippet",
  "source_map",
  "sourceMap",
  "call_site_frames",
  "callSiteFrames",
  "call_site_raw",
  "callSiteRaw",
  "file_name",
  "fileName",
  "line_number",
  "lineNumber",
  "bl_file",
  "bl_function",
  "bl_line",
  "stack",
  "stack_trace",
  "stackTrace",
  "configuration",
  "auth_key",
  "authKey",
  "dsn",
]);

const SENSITIVE_METADATA_KEYS = new Set([
  "prompt",
  "prompts",
  "completion",
  "response",
  "responses",
  "messages",
  "contents",
  "input",
  "output",
  "system",
  "developer",
  "tool_calls",
  "toolCalls",
  "raw",
  "raw_body",
  "rawBody",
  "tool_results",
  "toolResults",
  "citations",
  "agent",
  "config",
]);

const SAFE_CONTEXT_KEYS = new Set([
  "environment",
  "service",
  "release",
  "operation",
  "feature",
  "function",
  "functionName",
  "group",
  "groupName",
  "groupType",
  "executionId",
  "execution_id",
  "phase",
  "caseId",
  "case_id",
  "datasetRevision",
  "dataset_revision",
  "customer",
  "customerId",
  "customer_id",
  "traceId",
  "trace_id",
  "traceName",
  "trace_name",
  "runtime",
  "task",
]);

const COST_PROVENANCE_CONTAINERS = new Set([
  "cost", "pricing", "effective_price", "effectivePrice", "provenance", "billing",
]);

const SOURCE_KEYS = new Set([
  "call_site_raw", "callSiteRaw", "call_site_frames", "callSiteFrames",
  "file_name", "fileName", "line_number", "lineNumber",
  "bl_file", "blFile", "bl_line", "blLine", "bl_function", "blFunction",
  "call_site_key", "callSiteKey", "function_name", "functionName",
  "rootFunction", "rootFile", "rootLine", "stack", "stack_trace", "stackTrace",
  // Legacy insights/explorer serializers use shorter aliases for the same
  // source locations. They must obey the project source-access switch too.
  "file", "function", "line", "module", "frames", "callSite", "call_site",
  "sourceCode", "source_code", "sourceMap", "source_map", "rawStack", "raw_stack",
]);

export function normalizeRole(role: unknown): WorkspaceRole {
  switch (String(role ?? "").toLowerCase()) {
    case "owner": return "owner";
    case "admin": return "admin";
    case "developer": return "developer";
    case "viewer": return "viewer";
    // `member` was the pre-RBAC role and could inspect bodies. Keep existing
    // customers' access stable while rendering the new fixed role label.
    case "member": return "developer";
    default: return "viewer";
  }
}

export function roleCanManageWorkspace(role: unknown): boolean {
  const normalized = normalizeRole(role);
  return normalized === "owner" || normalized === "admin";
}

export function roleCanManageSubscription(role: unknown): boolean {
  return normalizeRole(role) === "owner";
}

export function roleCanReadContent(role: unknown): boolean {
  const normalized = normalizeRole(role);
  return normalized !== "viewer";
}

export function roleCanPublishSharedView(role: unknown): boolean {
  return normalizeRole(role) !== "viewer";
}

export function roleCanManagePolicy(role: unknown): boolean {
  return roleCanManageWorkspace(role);
}

export async function canAccessProject(
  pool: pg.Pool,
  user: AuthPrincipal,
  projectId: string,
): Promise<boolean> {
  if (user.tokenProjectIds && !user.tokenProjectIds.includes(projectId)) return false;
  const role = normalizeRole(user.role);
  const result = await pool.query(
    `SELECT p.id
     FROM projects p
     WHERE p.id = $1
       AND p.org_id = $2
       AND ($3 IN ('owner', 'admin') OR EXISTS (
         SELECT 1 FROM project_memberships pm
         WHERE pm.project_id = p.id AND pm.user_id = $4
       ))`,
    [projectId, user.orgId, role, user.id],
  );
  return result.rows.length > 0;
}

export async function listAccessibleProjects(
  pool: pg.Pool,
  user: AuthPrincipal,
  options: { includeAuthKey?: boolean } = {},
): Promise<Array<Record<string, unknown>>> {
  const role = normalizeRole(user.role);
  const result = await pool.query(
    `SELECT p.id, p.name, p.description, p.org_id, p.auth_key, p.created_at,
            s.capture_mode, s.body_capture_enabled, s.redaction_enabled,
            s.body_retention_days, s.metadata_retention_days,
            s.aggregate_retention_days, s.source_access_enabled
     FROM projects p
     LEFT JOIN project_settings s ON s.project_id = p.id
     WHERE p.org_id = $1
       AND ($2 IN ('owner', 'admin') OR EXISTS (
         SELECT 1 FROM project_memberships pm
         WHERE pm.project_id = p.id AND pm.user_id = $3
       ))
     ORDER BY p.created_at ASC, p.id ASC`,
    [user.orgId, role, user.id],
  );
  const tokenProjects = user.tokenProjectIds ? new Set(user.tokenProjectIds) : null;
  return result.rows.filter((row: Record<string, unknown>) => !tokenProjects || tokenProjects.has(String(row.id))).map((row: Record<string, unknown>) => {
    const project = { ...row };
    if (!options.includeAuthKey) delete project.auth_key;
    return project;
  });
}

export async function assertProjectAccess(
  pool: pg.Pool,
  user: AuthPrincipal,
  projectId: string,
): Promise<void> {
  if (!await canAccessProject(pool, user, projectId)) {
    const error = new Error("Project not found");
    (error as Error & { status?: number }).status = 404;
    throw error;
  }
}

/** Assign a member to explicit projects, replacing their prior assignments. */
export async function replaceProjectAssignments(
  pool: pg.Pool,
  orgId: string,
  userId: string,
  projectIds: string[] | undefined,
  assignedBy: string,
): Promise<string[]> {
  const projects = await pool.query(
    "SELECT id FROM projects WHERE org_id = $1 ORDER BY created_at ASC, id ASC",
    [orgId],
  );
  const available = new Set(projects.rows.map((row: { id: string }) => row.id));
  const requested = projectIds === undefined
    ? [...available]
    : [...new Set(projectIds.filter((id): id is string => typeof id === "string" && available.has(id)))];

  if (projectIds !== undefined && requested.length !== new Set(projectIds).size) {
    const error = new Error("One or more projects are not in this organization");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM project_memberships WHERE user_id = $1", [userId]);
    for (const projectId of requested) {
      await client.query(
        `INSERT INTO project_memberships(project_id, user_id, assigned_by)
         VALUES ($1, $2, $3) ON CONFLICT (project_id, user_id) DO UPDATE SET assigned_by = EXCLUDED.assigned_by`,
        [projectId, userId, assignedBy],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return requested;
}

export async function ensureProjectAssignment(
  pool: pg.Pool,
  userId: string,
  projectIds: string[],
  assignedBy: string | null,
): Promise<void> {
  for (const projectId of projectIds) {
    await pool.query(
      `INSERT INTO project_memberships(project_id, user_id, assigned_by)
       VALUES ($1, $2, $3) ON CONFLICT (project_id, user_id) DO NOTHING`,
      [projectId, userId, assignedBy],
    );
  }
}

export function requireRole(...roles: WorkspaceRole[]) {
  const allowed = new Set(roles);
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: AuthPrincipal }).user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!allowed.has(normalizeRole(user.role))) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

/**
 * Remove content/source fields at the response boundary for viewers. This is
 * intentionally a deny-by-default transform: adding a new API response does
 * not accidentally make captured text or source available to a Viewer.
 */
export function redactRestrictedContent(value: unknown, key?: string, parentKey?: string): unknown {
  if (key === "content_status" || key === "contentStatus") return "restricted";
  if (key && RESTRICTED_KEYS.has(key)) return undefined;
  if (Array.isArray(value)) {
    const containerKey = key ?? parentKey;
    return value.map((item) => redactRestrictedContent(item, undefined, containerKey)).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  if (key === "metadata" || key === "context") {
    const safe: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(source)) {
      if (!SAFE_CONTEXT_KEYS.has(entryKey)) continue;
      if (typeof entryValue === "string" || typeof entryValue === "number" || typeof entryValue === "boolean") {
        safe[entryKey] = entryValue;
      }
    }
    return safe;
  }
  const result: Record<string, unknown> = {};
  const containerKey = key ?? parentKey;
  for (const [entryKey, entryValue] of Object.entries(source)) {
    if (RESTRICTED_KEYS.has(entryKey)) continue;
    if (SENSITIVE_METADATA_KEYS.has(entryKey)) continue;
    // `source` remains available for cost/pricing provenance, but an
    // arbitrary nested source property is not a safe way to smuggle code or a
    // provider payload through a Viewer response.
    if (entryKey === "source"
      && (containerKey !== undefined && !COST_PROVENANCE_CONTAINERS.has(containerKey)
        || containerKey === undefined && entryValue !== null && typeof entryValue === "object")) continue;
    const redacted = redactRestrictedContent(entryValue, entryKey, containerKey);
    if (redacted !== undefined) result[entryKey] = redacted;
  }
  return result;
}

export function redactResponseForViewer(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: AuthPrincipal }).user;
  if (!user || roleCanReadContent(user.role)) {
    next();
    return;
  }

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => originalJson(redactRestrictedContent(body))) as typeof res.json;
  next();
}

/** Remove all source-location material when a project disables source access. */
export function redactSourceContent(value: unknown, key?: string): unknown {
  if (key && SOURCE_KEYS.has(key)) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => redactSourceContent(item)).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    const redacted = redactSourceContent(entryValue, entryKey);
    if (redacted !== undefined) result[entryKey] = redacted;
  }
  return result;
}

export function redactResponseForDisabledSource(res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => originalJson(redactSourceContent(body))) as typeof res.json;
  next();
}

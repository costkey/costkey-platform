import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { requireAuth } from "./auth.js";
import {
  canAccessProject,
  normalizeRole,
  roleCanReadContent,
  roleCanManageWorkspace,
} from "./permissions.js";
import { chargesCte, scopeClauses, type ChargeScope } from "./charge-cohort.js";

function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function slugPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
}

type PlatformUser = { id: string; orgId: string; role: string };

function userOf(req: Request): PlatformUser | null {
  return (req as Request & { user?: PlatformUser }).user ?? null;
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value.length <= 80;
  } catch {
    return false;
  }
}

async function ensureWorkspaceSettings(pool: pg.Pool, orgId: string): Promise<Record<string, unknown>> {
  const existing = await pool.query("SELECT * FROM workspace_settings WHERE org_id = $1", [orgId]);
  if (existing.rows[0]) return existing.rows[0] as Record<string, unknown>;
  const inserted = await pool.query(
    `INSERT INTO workspace_settings(org_id, timezone, reporting_currency)
     VALUES ($1, 'UTC', 'USD')
     ON CONFLICT (org_id) DO UPDATE SET org_id = EXCLUDED.org_id
     RETURNING *`,
    [orgId],
  );
  return inserted.rows[0] as Record<string, unknown>;
}

function workspaceSettingsResponse(row: Record<string, unknown>): Record<string, unknown> {
  const currency = String(row.reporting_currency ?? "USD");
  return {
    timezone: row.timezone,
    reportingCurrency: currency,
    fx: currency === "USD"
      ? { available: true, source: "native USD", asOf: null, rate: 1 }
      : {
        available: typeof row.fx_rate === "number" && typeof row.fx_source === "string" && Boolean(row.fx_as_of),
        source: row.fx_source ?? null,
        asOf: row.fx_as_of ?? null,
        rate: row.fx_rate ?? null,
      },
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  // Spreadsheet applications evaluate formula-like cells even when the field
  // is CSV-quoted. Prefix dangerous leading characters with a literal apostrophe.
  const text = /^[\t \r\n]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(row: Record<string, unknown>, columns: string[]): string {
  return columns.map((column) => csvCell(row[column])).join(",");
}

function exportProjectId(req: Request): string {
  return String(req.params.projectId);
}

const EXPORT_CHUNK_SIZE = 1_000;
const EXPORT_CONTEXT_KEYS = new Set([
  "environment", "service", "release", "operation", "feature", "function", "functionName",
  "group", "groupName", "groupType", "executionId", "execution_id", "phase", "caseId", "case_id",
  "datasetRevision", "dataset_revision", "customer", "customerId", "customer_id", "traceId", "trace_id",
  "traceName", "trace_name", "runtime", "task",
]);

function exportQueryValues(raw: unknown): string | string[] | undefined {
  const values = (Array.isArray(raw) ? raw : [raw])
    .flatMap((item) => typeof item === "string" ? item.split(",") : [])
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : [...new Set(values)];
}

function exportContext(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!EXPORT_CONTEXT_KEYS.has(key)) continue;
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") result[key] = item;
  }
  return Object.keys(result).length > 0 ? result : {};
}

function exportRow(row: Record<string, unknown>, includeContent: boolean, restricted: boolean, sourceAllowed: boolean): Record<string, unknown> {
  const contentStatus = restricted ? "restricted" : String(row.event_content_status ?? "unknown");
  const contentAllowed = includeContent && !restricted && contentStatus === "captured";
  const result: Record<string, unknown> = {
    id: row.record_id,
    charge_id: row.charge_key,
    record_type: row.record_type,
    timestamp: row.timestamp,
    provider: row.provider,
    model: row.model,
    request_model: row.request_model,
    status_code: row.event_status_code ?? null,
    lifecycle_state: row.event_lifecycle_state ?? null,
    content_status: contentStatus,
    cost_usd: row.cost_usd,
    cost_basis: row.cost_basis,
    cost_source: row.cost_source,
    cost_currency: row.cost_currency,
    pricing_id: row.pricing_id,
    duration_ms: row.duration_ms,
    trace_id: row.trace_id,
    trace_name: row.trace_name,
    // Function attribution is a cost lens, not a source location. Keep it
    // available without exposing file paths or line/stack data.
    function_name: sourceAllowed ? row.bl_function ?? null : null,
    context: exportContext(row.context),
    execution_id: row.execution_id,
    group_id: row.group_id,
    group_name: row.group_name,
    group_kind: row.group_kind,
    phase: row.phase,
    case_id: row.case_id,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    total_tokens: row.total_tokens,
    unit_kind: row.unit_kind,
    unit_value: row.unit_value,
    unit: row.unit,
    revision: row.revision,
  };
  if (includeContent) {
    result.request_body = contentAllowed ? row.event_request_body ?? null : null;
    result.response_body = contentAllowed ? row.event_response_body ?? null : null;
    result.system_prompt = contentAllowed ? row.event_system_prompt ?? null : null;
    result.call_site_raw = contentAllowed && sourceAllowed ? row.event_call_site_raw ?? null : null;
    result.call_site_frames = contentAllowed && sourceAllowed ? row.event_call_site_frames ?? null : null;
    result.file_name = contentAllowed && sourceAllowed ? row.event_bl_file ?? null : null;
    result.line_number = contentAllowed && sourceAllowed ? row.event_bl_line ?? null : null;
  }
  return result;
}

function writeExportChunk(res: Response, chunk: string): Promise<void> {
  if (res.destroyed || res.writableEnded) return Promise.resolve();
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => {
    const cleanup = () => {
      res.removeListener("drain", onDrain);
      res.removeListener("close", onClose);
      resolve();
    };
    const onDrain = () => cleanup();
    const onClose = () => cleanup();
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

async function exportEvents(pool: pg.Pool, req: Request, res: Response): Promise<void> {
  const user = userOf(req);
  if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
  const projectId = exportProjectId(req);
  if (!await canAccessProject(pool, user, projectId)) { res.status(404).json({ error: "Project not found" }); return; }
  let sourceAllowed = false;
  try {
    const sourceSettings = await pool.query(
      "SELECT source_access_enabled FROM project_settings WHERE project_id = $1",
      [projectId],
    );
    sourceAllowed = sourceSettings.rows[0]?.source_access_enabled === true;
  } catch {
    // Unknown source policy must not become an export bypass.
  }
  const includeContent = String(req.query.includeContent ?? "false") === "true";
  if (includeContent && !roleCanReadContent(user.role)) {
    res.status(403).json({ error: "Captured content/source export is restricted" }); return;
  }
  const format = String(req.query.format ?? "csv").toLowerCase();
  if (format !== "csv" && format !== "json") { res.status(400).json({ error: "format must be csv or json" }); return; }
  const rawFrom = exportQueryValues(req.query.from);
  const rawTo = exportQueryValues(req.query.to);
  if (Array.isArray(rawFrom) || Array.isArray(rawTo)) { res.status(400).json({ error: "from and to must each be a single timestamp" }); return; }
  const from = rawFrom ? new Date(rawFrom) : null;
  const to = rawTo ? new Date(rawTo) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) { res.status(400).json({ error: "Invalid export timestamp" }); return; }
  if (from && to && from >= to) { res.status(400).json({ error: "from must be before to" }); return; }
  const restricted = !roleCanReadContent(user.role);
  const rawContextKey = req.query.contextKey;
  const contextKey = rawContextKey === undefined
    ? undefined
    : typeof rawContextKey === "string" && EXPORT_CONTEXT_KEYS.has(rawContextKey.trim())
      ? rawContextKey.trim()
      : null;
  if (rawContextKey !== undefined && contextKey === null) {
    res.status(400).json({ error: "contextKey is not an allowed metadata key" }); return;
  }
  const scope: ChargeScope = {
    from: from?.toISOString(),
    to: to?.toISOString(),
    environment: exportQueryValues(req.query.environment),
    feature: exportQueryValues(req.query.feature),
    function: restricted ? undefined : exportQueryValues(req.query.function ?? req.query.fn),
    customer: exportQueryValues(req.query.customer),
    model: exportQueryValues(req.query.model),
    provider: exportQueryValues(req.query.provider),
    traceId: exportQueryValues(req.query.traceId ?? req.query.trace_id),
    executionId: exportQueryValues(req.query.executionId ?? req.query.execution_id),
    // `scopeClauses` is shared with the canonical CTE and expects q to use
    // `charge_key`; build the export q predicate below so it remains valid for
    // both the canonical and staged-schema fallback relations.
    q: undefined,
    contextKey,
    contextValue: exportQueryValues(req.query.contextValue),
    searchSource: !restricted,
  };
  const client = await pool.connect();
  let disconnected = false;
  const onRequestAbort = () => { disconnected = true; };
  const onResponseClose = () => {
    if (!res.writableEnded) disconnected = true;
  };
  req.once("aborted", onRequestAbort);
  res.once("close", onResponseClose);
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    // The fallback keeps the platform export route usable during a staged
    // schema rollout; initialized applications always use canonical charges,
    // including deduped explicit usage components.
    const usageTable = await client.query("SELECT to_regclass('usage_components') AS table_name");
    const contentStatusColumn = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'events' AND column_name = 'content_status'
       ) AS available`,
    );
    const hasContentStatus = Boolean(contentStatusColumn.rows[0]?.available);
    const canonical = usageTable.rows[0]?.table_name
      ? chargesCte()
      : `WITH charges AS (
           SELECT e.project_id, e.id AS record_id, COALESCE(e.charge_id, e.id) AS charge_key,
                  e.timestamp, e.provider, e.model, e.request_model, e.pricing_id,
                  e.cost_usd, e.cost_basis, e.cost_source, e.cost_currency, e.duration_ms,
                  e.trace_id, e.trace_name, e.context, e.feature_source, e.feature_mapping_id,
                  e.feature_mapping_action_id, e.feature_original, e.execution_id, e.group_id,
                  e.group_name, e.group_kind, e.phase, e.case_id, e.bl_file, e.bl_function,
                  e.bl_line, 'call'::text AS record_type, e.input_tokens, e.output_tokens,
                  e.total_tokens, NULL::double precision AS unit_value, NULL::text AS unit,
                  NULL::text AS unit_kind, NULL::integer AS revision
           FROM events e WHERE COALESCE(e.event_type, 'call') = 'call'
         )`;
    const eventContentStatus = hasContentStatus ? "e.content_status" : "NULL::text";
    const enrichedFields = includeContent
      ? `e.status_code AS event_status_code, e.lifecycle_state AS event_lifecycle_state,
         ${eventContentStatus} AS event_content_status, e.request_body AS event_request_body,
         e.response_body AS event_response_body, e.system_prompt AS event_system_prompt,
         e.call_site_raw AS event_call_site_raw, e.call_site_frames AS event_call_site_frames,
         e.bl_file AS event_bl_file, e.bl_line AS event_bl_line`
      : `e.status_code AS event_status_code, e.lifecycle_state AS event_lifecycle_state,
         ${eventContentStatus} AS event_content_status`;
    const cte = `${canonical}, enriched AS (
      SELECT c.*, ${enrichedFields}
      FROM charges c
      LEFT JOIN events e
        ON c.record_type = 'call' AND e.project_id = c.project_id AND e.id = c.record_id
    )`;
    const params: unknown[] = [projectId];
    const filters = scopeClauses(scope, params, "c");
    const qTerms = exportQueryValues(req.query.q);
    if (qTerms) {
      const qClauses: string[] = [];
      for (const term of Array.isArray(qTerms) ? qTerms : [qTerms]) {
        params.push(`%${term}%`);
        const qParam = `$${params.length}`;
        qClauses.push(`(c.record_id ILIKE ${qParam}
          OR c.charge_key ILIKE ${qParam}
          OR COALESCE(c.trace_id, '') ILIKE ${qParam}
          OR COALESCE(c.trace_name, '') ILIKE ${qParam}
          OR COALESCE(c.model, '') ILIKE ${qParam}
          OR COALESCE(c.provider, '') ILIKE ${qParam}
          OR COALESCE(c.context->>'feature', '') ILIKE ${qParam}
          OR COALESCE(c.context->>'customer', '') ILIKE ${qParam}
          OR COALESCE(c.context->>'environment', '') ILIKE ${qParam}
          OR COALESCE(c.phase, '') ILIKE ${qParam}
          ${restricted ? "" : `OR COALESCE(c.bl_file, '') ILIKE ${qParam} OR COALESCE(c.bl_function, '') ILIKE ${qParam}`} )`);
      }
      filters.push(`(${qClauses.join(" OR ")})`);
    }
    const statuses = exportQueryValues(req.query.status);
    if (statuses) {
      const items = (Array.isArray(statuses) ? statuses : [statuses]).map((item) => Number(item)).filter(Number.isInteger);
      if (items.length > 0) { params.push(items); filters.push(`c.event_status_code = ANY($${params.length}::int[])`); }
    }
    const lifecycles = exportQueryValues(req.query.lifecycle);
    if (lifecycles) {
      params.push(Array.isArray(lifecycles) ? lifecycles : [lifecycles]);
      filters.push(`c.event_lifecycle_state = ANY($${params.length}::text[])`);
    }
    const accounting = exportQueryValues(req.query.accounting);
    if (accounting) {
      const stateClauses: string[] = [];
      for (const state of Array.isArray(accounting) ? accounting : [accounting]) {
        if (state === "complete") stateClauses.push("c.cost_usd IS NOT NULL");
        if (state === "partial" || state === "pending") stateClauses.push("c.cost_usd IS NULL");
      }
      if (stateClauses.length > 0) filters.push(`(${stateClauses.join(" OR ")})`);
    }
    const coverage = exportQueryValues(req.query.coverage);
    if (coverage) {
      const coverageClauses: string[] = [];
      for (const item of Array.isArray(coverage) ? coverage : [coverage]) {
        if (item === "complete" || item === "priced") coverageClauses.push("c.cost_usd IS NOT NULL");
        if (item === "partial" || item === "unpriced") coverageClauses.push("c.cost_usd IS NULL");
      }
      if (coverageClauses.length > 0) filters.push(`(${coverageClauses.join(" OR ")})`);
    }
    const contentStatuses = exportQueryValues(req.query.contentStatus ?? req.query.content_status);
    if (contentStatuses) {
      params.push(Array.isArray(contentStatuses) ? contentStatuses : [contentStatuses]);
      filters.push(`COALESCE(c.event_content_status, 'not_available') = ANY($${params.length}::text[])`);
    }
    const where = filters.join(" AND ");
    // Materialize this repeatable-read snapshot once in a connection-local
    // temporary table. It keeps the full export bounded by database disk,
    // rather than a hard row limit or an in-process array, and lets the writer
    // fetch keyset chunks while honoring response backpressure.
    await client.query(`CREATE TEMP TABLE costkey_export_rows ON COMMIT DROP AS ${cte} SELECT c.* FROM enriched c WHERE ${where}`, params);
    await client.query("CREATE INDEX costkey_export_rows_order ON costkey_export_rows(timestamp DESC, record_id DESC)");
    const count = await client.query("SELECT COUNT(*)::bigint AS count FROM costkey_export_rows");
    const matchedCount = Number(count.rows[0]?.count ?? 0);
    const columns = includeContent
      ? ["id", "charge_id", "record_type", "timestamp", "provider", "model", "request_model", "status_code", "lifecycle_state", "content_status", "cost_usd", "cost_basis", "cost_source", "cost_currency", "pricing_id", "duration_ms", "trace_id", "trace_name", "function_name", "context", "execution_id", "group_id", "group_name", "group_kind", "phase", "case_id", "input_tokens", "output_tokens", "total_tokens", "unit_kind", "unit_value", "unit", "revision", "request_body", "response_body", "system_prompt", "call_site_raw", "call_site_frames", "file_name", "line_number"]
      : ["id", "charge_id", "record_type", "timestamp", "provider", "model", "request_model", "status_code", "lifecycle_state", "content_status", "cost_usd", "cost_basis", "cost_source", "cost_currency", "pricing_id", "duration_ms", "trace_id", "trace_name", "function_name", "context", "execution_id", "group_id", "group_name", "group_kind", "phase", "case_id", "input_tokens", "output_tokens", "total_tokens", "unit_kind", "unit_value", "unit", "revision"];
    if (format === "json") {
      res.type("application/json");
      await writeExportChunk(res, `{"projectId":${JSON.stringify(projectId)},"scope":{"filters":${JSON.stringify(req.query)},"paginationApplied":false},"includeContent":${includeContent},"matchedCount":${matchedCount},"events":[`);
    } else {
      res.type("text/csv").setHeader("Content-Disposition", `attachment; filename="costkey-${projectId}-events.csv"`);
      await writeExportChunk(res, columns.join(",") + "\n");
    }

    let lastTimestamp: unknown = null;
    let lastRecordId: string | null = null;
    let first = true;
    while (!disconnected && !res.destroyed && !res.writableEnded) {
      const chunkParams: unknown[] = [];
      let keyset = "";
      if (lastTimestamp !== null && lastRecordId !== null) {
        chunkParams.push(lastTimestamp, lastRecordId);
        keyset = `WHERE (c.timestamp, c.record_id) < ($${chunkParams.length - 1}::timestamptz, $${chunkParams.length})`;
      }
      chunkParams.push(EXPORT_CHUNK_SIZE);
      const result = await client.query<Record<string, unknown>>(
        `SELECT c.* FROM costkey_export_rows c ${keyset}
         ORDER BY c.timestamp DESC NULLS LAST, c.record_id DESC LIMIT $${chunkParams.length}`,
        chunkParams,
      );
      if (result.rows.length === 0) break;
      for (const rawRow of result.rows as Array<Record<string, unknown>>) {
        const row = exportRow(rawRow, includeContent, restricted, sourceAllowed);
        const serialized = format === "json" ? `${first ? "" : ","}${JSON.stringify(row)}` : csvLine(row, columns) + "\n";
        first = false;
        await writeExportChunk(res, serialized);
        if (disconnected || res.destroyed) break;
        lastTimestamp = rawRow.timestamp;
        lastRecordId = String(rawRow.record_id);
      }
      if (result.rows.length < EXPORT_CHUNK_SIZE) break;
    }
    if (disconnected || res.destroyed) {
      await client.query("ROLLBACK");
      return;
    }
    if (format === "json") await writeExportChunk(res, "]}");
    await client.query("COMMIT");
    if (!res.destroyed && !res.writableEnded) res.end();
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    req.removeListener("aborted", onRequestAbort);
    res.removeListener("close", onResponseClose);
    client.release();
  }
}

function publicProject(row: Record<string, unknown>, includeAuthKey: boolean): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    created_at: row.created_at,
    event_count: Number(row.event_count ?? 0),
    total_cost: row.total_cost,
    authKey: includeAuthKey ? row.auth_key : null,
    dsn: includeAuthKey && row.auth_key ? `https://${row.auth_key}@app.costkey.dev/${row.id}` : null,
    captureMode: row.capture_mode ?? "metadata",
    bodyCaptureEnabled: row.body_capture_enabled ?? false,
    sourceAccessEnabled: row.source_access_enabled ?? false,
  };
}

export function createPlatformRouter(pool: pg.Pool): Router {
  const router = createRouter();
  router.use("/api", requireAuth);

  router.get("/api/v1/workspace/settings", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const settings = await ensureWorkspaceSettings(pool, user.orgId);
      res.json({ settings: workspaceSettingsResponse(settings), canManage: roleCanManageWorkspace(user.role) });
    } catch (error) {
      console.error("[costkey] Workspace settings read error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.patch("/api/v1/workspace/settings", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      if (!roleCanManageWorkspace(user.role)) { res.status(403).json({ error: "Only owners and admins can change workspace defaults" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const current = await ensureWorkspaceSettings(pool, user.orgId);
      const timezone = body.timezone === undefined ? String(current.timezone ?? "UTC") : String(body.timezone);
      const reportingCurrency = body.reportingCurrency === undefined ? String(current.reporting_currency ?? "USD") : String(body.reportingCurrency).toUpperCase();
      if (!validTimezone(timezone)) { res.status(400).json({ error: "Invalid IANA timezone" }); return; }
      if (reportingCurrency !== "USD" && reportingCurrency !== "INR") { res.status(400).json({ error: "reportingCurrency must be USD or INR" }); return; }

      let fxRate: number | null = reportingCurrency === "USD" ? null : (typeof current.fx_rate === "number" ? current.fx_rate : null);
      let fxSource: string | null = reportingCurrency === "USD" ? null : (typeof current.fx_source === "string" ? current.fx_source : null);
      let fxAsOf: string | null = reportingCurrency === "USD" ? null : (current.fx_as_of ? String(current.fx_as_of) : null);
      if (body.fxRate !== undefined || body.fxSource !== undefined || body.fxAsOf !== undefined) {
        if (reportingCurrency === "USD") { res.status(400).json({ error: "FX provenance is only used for INR reporting" }); return; }
        if (typeof body.fxRate !== "number" || !Number.isFinite(body.fxRate) || body.fxRate <= 0
          || typeof body.fxSource !== "string" || !body.fxSource.trim()
          || typeof body.fxAsOf !== "string" || Number.isNaN(new Date(body.fxAsOf).getTime())) {
          res.status(400).json({ error: "fxRate, fxSource, and fxAsOf are required together for an INR conversion basis" }); return;
        }
        fxRate = body.fxRate;
        fxSource = body.fxSource.trim().slice(0, 160);
        fxAsOf = new Date(body.fxAsOf).toISOString();
      }
      const result = await pool.query(
        `UPDATE workspace_settings
         SET timezone = $1, reporting_currency = $2, fx_rate = $3,
             fx_source = $4, fx_as_of = $5, updated_by = $6, updated_at = NOW()
         WHERE org_id = $7 RETURNING *`,
        [timezone, reportingCurrency, fxRate, fxSource, fxAsOf, user.id, user.orgId],
      );
      res.json({ settings: workspaceSettingsResponse(result.rows[0] as Record<string, unknown>) });
    } catch (error) {
      console.error("[costkey] Workspace settings update error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/v1/projects", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const role = normalizeRole(user.role);
      const projectRows = await pool.query(
        `SELECT p.id, p.name, p.description, p.auth_key, p.created_at,
                COUNT(e.id)::int AS event_count,
                SUM(e.cost_usd) FILTER (WHERE e.cost_usd IS NOT NULL) AS total_cost,
                s.capture_mode, s.body_capture_enabled, s.source_access_enabled
         FROM projects p
         LEFT JOIN events e ON e.project_id = p.id
         LEFT JOIN project_settings s ON s.project_id = p.id
         WHERE p.org_id = $1
           AND ($2 IN ('owner', 'admin') OR EXISTS (
             SELECT 1 FROM project_memberships pm
             WHERE pm.project_id = p.id AND pm.user_id = $3
           ))
         GROUP BY p.id, s.capture_mode, s.body_capture_enabled, s.source_access_enabled
         ORDER BY p.created_at DESC, p.id DESC`,
        [user.orgId, role, user.id],
      );
      const includeAuthKey = roleCanManageWorkspace(role);
      res.json({ projects: projectRows.rows.map((row: Record<string, unknown>) => publicProject(row, includeAuthKey)) });
    } catch (error) {
      console.error("[costkey] Project list error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/v1/projects", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      if (!roleCanManageWorkspace(user.role)) { res.status(403).json({ error: "Only owners and admins can create projects" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const description = typeof body.description === "string" ? body.description.trim() : null;
      if (!name || name.length > 120) { res.status(400).json({ error: "Project name is required and must be at most 120 characters" }); return; }
      if (description && description.length > 500) { res.status(400).json({ error: "Project description must be at most 500 characters" }); return; }
      const id = randomId("proj");
      const authKey = randomId("ck");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO projects (id, name, description, org_id, auth_key) VALUES ($1, $2, $3, $4, $5)",
          [id, name, description, user.orgId, authKey],
        );
        await client.query(
          `INSERT INTO project_settings(
             project_id, capture_mode, body_capture_enabled, redaction_enabled,
             body_retention_days, metadata_retention_days, aggregate_retention_days,
             source_access_enabled, updated_by
           ) VALUES ($1, 'metadata', FALSE, TRUE, 7, 30, 395, TRUE, $2)`,
          [id, user.id],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const dsn = `https://${authKey}@app.costkey.dev/${id}`;
      res.status(201).json({ id, name, description, authKey, dsn, captureMode: "metadata", bodyCaptureEnabled: false });
    } catch (error) {
      console.error("[costkey] Project create error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/v1/projects/:projectId", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const projectId = String(req.params.projectId);
      if (!await canAccessProject(pool, user, projectId)) { res.status(404).json({ error: "Project not found" }); return; }
      const result = await pool.query(
        `SELECT p.id, p.name, p.description, p.created_at,
                s.capture_mode, s.body_capture_enabled, s.redaction_enabled,
                s.body_retention_days, s.metadata_retention_days,
                s.aggregate_retention_days, s.source_access_enabled
         FROM projects p LEFT JOIN project_settings s ON s.project_id = p.id
         WHERE p.id = $1 AND p.org_id = $2`,
        [projectId, user.orgId],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) { res.status(404).json({ error: "Project not found" }); return; }
      res.json({ project: row, canManage: roleCanManageWorkspace(user.role) });
    } catch (error) {
      console.error("[costkey] Project read error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Full filtered exports are server-side and intentionally separate from
  // paginated explorer responses. Default metadata excludes bodies/source;
  // content inclusion is explicit and still role-checked.
  router.get("/api/v1/projects/:projectId/export", (req, res, next) => {
    void exportEvents(pool, req, res).catch((error) => {
      console.error("[costkey] Project export error:", error);
      if (!res.headersSent) res.status(500).json({ error: "Export failed" });
      else next(error);
    });
  });
  router.get("/api/v1/projects/:projectId/events/export", (req, res, next) => {
    void exportEvents(pool, req, res).catch((error) => {
      console.error("[costkey] Project export error:", error);
      if (!res.headersSent) res.status(500).json({ error: "Export failed" });
      else next(error);
    });
  });
  router.get("/api/v1/projects/:projectId/exports", (req, res, next) => {
    void exportEvents(pool, req, res).catch((error) => {
      console.error("[costkey] Project export error:", error);
      if (!res.headersSent) res.status(500).json({ error: "Export failed" });
      else next(error);
    });
  });

  router.patch("/api/v1/projects/:projectId", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      if (!roleCanManageWorkspace(user.role)) { res.status(403).json({ error: "Only owners and admins can change projects" }); return; }
      const projectId = String(req.params.projectId);
      if (!await canAccessProject(pool, user, projectId)) { res.status(404).json({ error: "Project not found" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updates: string[] = [];
      const params: unknown[] = [];
      let index = 1;
      if (body.name !== undefined) {
        if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) { res.status(400).json({ error: "Invalid project name" }); return; }
        updates.push(`name = $${index++}`); params.push(body.name.trim());
      }
      if (body.description !== undefined) {
        if (body.description !== null && (typeof body.description !== "string" || body.description.length > 500)) { res.status(400).json({ error: "Invalid project description" }); return; }
        updates.push(`description = $${index++}`); params.push(body.description === null ? null : String(body.description).trim());
      }
      if (updates.length === 0) { res.status(400).json({ error: "Nothing to update" }); return; }
      params.push(projectId, user.orgId);
      await pool.query(`UPDATE projects SET ${updates.join(", ")} WHERE id = $${index++} AND org_id = $${index}`, params);
      const result = await pool.query("SELECT id, name, description, created_at FROM projects WHERE id = $1 AND org_id = $2", [projectId, user.orgId]);
      res.json({ project: result.rows[0] });
    } catch (error) {
      console.error("[costkey] Project update error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/v1/projects/:projectId", async (req: Request, res: Response) => {
    try {
      const user = userOf(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      if (!roleCanManageWorkspace(user.role)) { res.status(403).json({ error: "Only owners and admins can delete projects" }); return; }
      const projectId = String(req.params.projectId);
      if (!await canAccessProject(pool, user, projectId)) { res.status(404).json({ error: "Project not found" }); return; }
      if (req.body?.confirmProjectId !== projectId) { res.status(400).json({ error: "confirmProjectId must match the project" }); return; }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM call_site_stats WHERE project_id = $1", [projectId]);
        await client.query("DELETE FROM events WHERE project_id = $1", [projectId]);
        await client.query("DELETE FROM alerts WHERE project_id = $1", [projectId]);
        await client.query("DELETE FROM projects WHERE id = $1 AND org_id = $2", [projectId, user.orgId]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      res.json({ ok: true, deletedProjectId: projectId });
    } catch (error) {
      console.error("[costkey] Project delete error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

/**
 * DSN-only legacy budget visibility route. Keep it before any router with a
 * global `requireAuth`; the session API routers otherwise turn this SDK path
 * into an unrelated 401 before its project key can be checked.
 */
export function createSdkBudgetCompatibilityRouter(pool: pg.Pool): Router {
  const router = createRouter();
  router.get("/api/v1/sdk/budget/rules", async (req: Request, res: Response) => {
    try {
      const authorization = req.headers.authorization;
      if (!authorization?.startsWith("Bearer ")) { res.status(401).json({ error: "Missing or invalid authorization" }); return; }
      const project = await pool.query("SELECT id FROM projects WHERE auth_key = $1", [authorization.slice(7)]);
      if (!project.rows[0]) { res.status(401).json({ error: "Invalid auth key" }); return; }
      const result = await pool.query(
        `SELECT id, name, scope_model, scope_function, daily_usd, monthly_usd,
                calls_per_minute, tokens_per_minute, on_exceed, enabled
         FROM budget_rules WHERE project_id = $1 AND enabled = TRUE ORDER BY created_at ASC, id ASC`,
        [project.rows[0].id],
      );
      res.set("Cache-Control", "private, max-age=60").json({
        rules: result.rows.map((row: Record<string, unknown>) => ({
          id: row.id,
          name: row.name,
          scopeModel: row.scope_model,
          scopeFunction: row.scope_function,
          dailyUsd: row.daily_usd == null ? null : Number(row.daily_usd),
          monthlyUsd: row.monthly_usd == null ? null : Number(row.monthly_usd),
          callsPerMinute: row.calls_per_minute,
          tokensPerMinute: row.tokens_per_minute,
          onExceed: row.on_exceed,
        })),
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[costkey] SDK budget compatibility error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  return router;
}

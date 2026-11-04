import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { createHash } from "node:crypto";
import type pg from "pg";
import { onInvalidateSummaries } from "./response-cache.js";
import { requireAuth } from "./auth.js";
import {
  assertProjectAccess,
  roleCanManageWorkspace,
} from "./permissions.js";

type PrivacySettings = {
  project_id: string;
  capture_mode: "metadata" | "text";
  body_capture_enabled: boolean;
  redaction_enabled: boolean;
  body_retention_days: number;
  metadata_retention_days: number;
  aggregate_retention_days: number;
  source_access_enabled: boolean;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

function settingsResponse(row: PrivacySettings): Record<string, unknown> {
  return {
    projectId: row.project_id,
    captureMode: row.capture_mode,
    bodyCaptureEnabled: row.body_capture_enabled,
    redactionEnabled: row.redaction_enabled,
    bodyRetentionDays: row.body_retention_days,
    metadataRetentionDays: row.metadata_retention_days,
    aggregateRetentionDays: row.aggregate_retention_days,
    sourceAccessEnabled: row.source_access_enabled,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    storage: {
      primary: "CostKey primary database",
      backups: "Backup retention is governed by the configured database provider and is not changed by this setting",
    },
  };
}

function scrubAccountingMetadata(column: string): string {
  return `CASE
    WHEN ${column} IS NULL THEN NULL
    WHEN jsonb_typeof(${column}) <> 'object' THEN '{}'::jsonb
    ELSE (
      SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      FROM jsonb_each(${column}) AS entry(key, value)
      WHERE lower(entry.key) IN (
        'pricingid', 'pricing_id', 'componentid', 'component_id', 'chargeid', 'charge_id',
        'unit', 'unitkind', 'unit_kind', 'amount', 'currency', 'aggregation', 'revision',
        'provider', 'model', 'accountscope', 'account_scope'
      )
        AND jsonb_typeof(entry.value) IN ('string', 'number', 'boolean', 'null')
    )
  END`;
}

function scrubAccountingContext(column: string): string {
  return `CASE
    WHEN ${column} IS NULL THEN NULL
    WHEN jsonb_typeof(${column}) <> 'object' THEN '{}'::jsonb
    ELSE (
      SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      FROM jsonb_each(${column}) AS entry(key, value)
      WHERE lower(entry.key) IN (
        'environment', 'service', 'release', 'operation', 'feature', 'function', 'functionname',
        'group', 'groupname', 'grouptype', 'executionid', 'execution_id', 'phase',
        'caseid', 'case_id', 'datasetrevision', 'dataset_revision', 'customer',
        'customerid', 'customer_id', 'traceid', 'trace_id', 'tracename', 'trace_name', 'runtime', 'task'
      )
        AND jsonb_typeof(entry.value) IN ('string', 'number', 'boolean', 'null')
    )
  END`;
}

function scrubUsageMetadata(column: string): string {
  // Usage components retain only numeric native-unit maps and the small
  // accounting identity needed to reconcile them. Nested metadata/context is
  // passed through the same allowlists as event rows; prompt/tool payloads
  // therefore cannot survive an explicit content deletion.
  return `CASE
    WHEN ${column} IS NULL THEN NULL
    WHEN jsonb_typeof(${column}) <> 'object' THEN '{}'::jsonb
    ELSE (
      SELECT COALESCE(jsonb_object_agg(entry.key,
        CASE
          WHEN lower(entry.key) IN ('metadata', 'context') THEN ${scrubAccountingMetadata("entry.value")}
          WHEN lower(entry.key) IN ('usage', 'billingunits', 'billing_units')
            AND jsonb_typeof(entry.value) = 'object' THEN (
              SELECT COALESCE(jsonb_object_agg(unit.key, unit.value), '{}'::jsonb)
              FROM jsonb_each(entry.value) AS unit(key, value)
              WHERE jsonb_typeof(unit.value) = 'number'
            )
          ELSE entry.value
        END
      ), '{}'::jsonb)
      FROM jsonb_each(${column}) AS entry(key, value)
      WHERE lower(entry.key) IN (
        'metadata', 'context', 'usage', 'billingunits', 'billing_units',
        'pricingid', 'pricing_id', 'componentid', 'component_id', 'chargeid', 'charge_id',
        'unit', 'unitkind', 'unit_kind', 'amount', 'currency', 'aggregation', 'revision',
        'provider', 'model', 'accountscope', 'account_scope', 'amountkind', 'amount_kind'
      )
    )
  END`;
}

// Server-side defense in depth for text capture. The SDK redacts at its own
// boundary, but an older SDK, user hook, or direct DSN sender must not be able
// to persist obvious credentials merely because text capture is enabled. Keep
// this bounded and deterministic: it is a credential scrubber, not a content
// classifier, and it never logs the incoming value.
const SECRET_VALUE_PATTERNS = [
  /\bsk-ant-[a-zA-Z0-9-]{20,}\b/g,
  /\bsk-[a-zA-Z0-9]{20,}\b/g,
  /\bAIza[a-zA-Z0-9_-]{30,}\b/g,
  /\bghp_[a-zA-Z0-9]{30,}\b/g,
  /\bxox[bpras]-[a-zA-Z0-9-]{20,}\b/g,
  /\beyJ[a-zA-Z0-9_-]{20,}\b/g,
  /\bBearer\s+[a-zA-Z0-9._~+/=-]{20,}\b/gi,
];
const SECRET_KEYS = new Set([
  "api_key", "apikey", "api-key", "secret", "secret_key", "secretkey",
  "token", "access_token", "refresh_token", "password", "passwd",
  "credential", "authorization", "auth", "private_key", "privatekey",
]);
const MAX_REDACTION_DEPTH = 32;
const MAX_REDACTION_NODES = 20_000;

function redactSecretString(value: string): string {
  let result = value;
  for (const pattern of SECRET_VALUE_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  // Catch common inline assignments in plain-text prompts/bodies without
  // treating ordinary prose containing the word "token" as a secret.
  return result.replace(
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret)\s*[:=]\s*)(["']?)[^\s,"'}]+/gi,
    "$1$2[REDACTED]",
  );
}

export function redactCapturedContent(value: unknown): unknown {
  let nodes = 0;
  const visit = (input: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_REDACTION_NODES || depth > MAX_REDACTION_DEPTH) return "[REDACTED]";
    if (typeof input === "string") return redactSecretString(input);
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
      output[key] = SECRET_KEYS.has(key.trim().toLowerCase())
        ? "[REDACTED]"
        : visit(child, depth + 1);
    }
    return output;
  };
  return visit(value, 0);
}

export async function ensureProjectSettings(
  pool: pg.Pool,
  projectId: string,
  options: { newProject?: boolean; userId?: string | null } = {},
): Promise<void> {
  const isNew = options.newProject === true;
  await pool.query(
    `INSERT INTO project_settings (
       project_id, capture_mode, body_capture_enabled, redaction_enabled,
       body_retention_days, metadata_retention_days, aggregate_retention_days,
       source_access_enabled, updated_by
     ) VALUES ($1, $2, $3, TRUE, 7, 30, 395, TRUE, $4)
     ON CONFLICT (project_id) DO NOTHING`,
    [projectId, isNew ? "metadata" : "text", !isNew, options.userId ?? null],
  );
}

export function stripIngestEventPrivacy(
  event: Record<string, unknown>,
  options: { allowBody: boolean; allowSource: boolean; redactionEnabled?: boolean },
): void {
  if (!options.allowBody) {
    delete event.requestBody;
    delete event.responseBody;
    delete event.systemPrompt;
    delete event.metadata;
    delete event.request_body;
    delete event.response_body;
    delete event.system_prompt;
    event.contentStatus = "metadata_only";
    if (options.redactionEnabled !== false && Object.prototype.hasOwnProperty.call(event, "context")) {
      event.context = redactCapturedContent(event.context);
    }
  } else if (options.redactionEnabled) {
    for (const key of [
      "requestBody", "responseBody", "systemPrompt", "metadata", "context",
      "request_body", "response_body", "system_prompt",
    ]) {
      if (Object.prototype.hasOwnProperty.call(event, key)) {
        event[key] = redactCapturedContent(event[key]);
      }
    }
  }
  if (!options.allowSource) {
    delete event.callSite;
    delete event.call_site;
    delete event.callSiteRaw;
    delete event.callSiteFrames;
    delete event.call_site_raw;
    delete event.call_site_frames;
    delete event.blFile;
    delete event.blFunction;
    delete event.blLine;
    delete event.bl_file;
    delete event.bl_function;
    delete event.bl_line;
  }
}

/**
 * Enforce project capture settings at the telemetry boundary. This keeps a
 * metadata-only project metadata-only even when an older SDK still sends body
 * fields; no application router has to remember this policy.
 */
export function privacyIngestGuard(pool: pg.Pool) {
  return async (req: Request, _res: Response, next: (error?: unknown) => void): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) { next(); return; }
      const project = await pool.query(
        `SELECT p.id, s.capture_mode, s.body_capture_enabled, s.redaction_enabled, s.source_access_enabled
         FROM projects p LEFT JOIN project_settings s ON s.project_id = p.id
         WHERE p.auth_key = $1`,
        [authHeader.slice(7)],
      );
      const settings = project.rows[0] as { capture_mode?: string; body_capture_enabled?: boolean; redaction_enabled?: boolean; source_access_enabled?: boolean } | undefined;
      const payload = (req.body ?? {}) as Record<string, unknown>;
      const events = Array.isArray(payload.events) ? payload.events : [];
      // A project without a settings row is an incomplete/legacy migration,
      // not permission to capture.  Treat it like metadata-only with source
      // disabled until an owner explicitly creates the settings row.
      const allowBody = settings?.capture_mode === "text" && settings.body_capture_enabled !== false;
      const allowSource = settings?.source_access_enabled === true;
      for (const event of events) {
        if (!event || typeof event !== "object") continue;
        stripIngestEventPrivacy(event as Record<string, unknown>, {
          allowBody,
          allowSource,
          redactionEnabled: settings?.redaction_enabled !== false,
        });
      }
      next();
    } catch (error) {
      // Unknown policy is a privacy failure. Strip body/source before allowing
      // the best-effort ingest path to continue.
      const payload = (req.body ?? {}) as Record<string, unknown>;
      const events = Array.isArray(payload.events) ? payload.events : [];
      for (const event of events) {
        if (event && typeof event === "object") {
          stripIngestEventPrivacy(event as Record<string, unknown>, { allowBody: false, allowSource: false });
        }
      }
      console.warn("[costkey] Privacy ingest guard unavailable:", error instanceof Error ? error.message : error);
      next();
    }
  };
}

/**
 * Every SDK process polls its runtime config once a minute, so one service
 * with 30 workers asks 30 times a minute for settings that rarely change.
 * Answers are kept for RUNTIME_CONFIG_TTL_MS per project and key, and
 * requests that miss together share one lookup. A change to the project
 * through the API drops its entries here; another instance may answer from
 * its copy until it expires, and ingest enforces the current settings anyway.
 */
const RUNTIME_CONFIG_TTL_MS = 30_000;
type RuntimeConfig = Record<string, unknown>;
const runtimeConfigs = new Map<string, { projectId: string; at: number; config: Promise<RuntimeConfig | null> }>();

onInvalidateSummaries((projectId) => {
  for (const [key, entry] of runtimeConfigs) if (!projectId || entry.projectId === projectId) runtimeConfigs.delete(key);
});

async function loadRuntimeConfig(pool: pg.Pool, projectId: string, authKey: string): Promise<RuntimeConfig | null> {
  const project = await pool.query(
    `SELECT p.id, s.capture_mode, s.body_capture_enabled, s.redaction_enabled,
            s.body_retention_days, s.metadata_retention_days
     FROM projects p LEFT JOIN project_settings s ON s.project_id = p.id
     WHERE p.id = $1 AND p.auth_key = $2`,
    [projectId, authKey],
  );
  if (!project.rows[0]) return null;
  const providers = await pool.query(
    `SELECT id, name, hostname, usage_input_path, usage_output_path, model_path
     FROM custom_providers WHERE project_id = $1 AND enabled = TRUE ORDER BY created_at ASC`,
    [projectId],
  );
  const row = project.rows[0] as Record<string, unknown>;
  return {
    projectId,
    capture: {
      mode: row.capture_mode ?? "metadata",
      bodyCaptureEnabled: row.body_capture_enabled ?? false,
      redactionEnabled: row.redaction_enabled ?? true,
      bodyRetentionDays: row.body_retention_days ?? 7,
      metadataRetentionDays: row.metadata_retention_days ?? 30,
    },
    providers: providers.rows,
  };
}

function cachedRuntimeConfig(pool: pg.Pool, projectId: string, authKey: string): Promise<RuntimeConfig | null> {
  const key = `${projectId}\0${createHash("sha256").update(authKey).digest("hex")}`;
  const hit = runtimeConfigs.get(key);
  if (hit && Date.now() - hit.at < RUNTIME_CONFIG_TTL_MS) return hit.config;
  const entry = { projectId, at: Date.now(), config: loadRuntimeConfig(pool, projectId, authKey) };
  runtimeConfigs.set(key, entry);
  // Only a found project is kept: a wrong key or a failed lookup asks again next time.
  const forget = () => { if (runtimeConfigs.get(key) === entry) runtimeConfigs.delete(key); };
  entry.config.then((config) => { if (!config) forget(); }, forget);
  return entry.config;
}

/** Drop cached runtime config for a project, e.g. after its capture settings change. */
export function invalidateRuntimeConfig(projectId: string): void {
  for (const [key, entry] of runtimeConfigs) if (entry.projectId === projectId) runtimeConfigs.delete(key);
}

/** DSN-authenticated runtime configuration consumed before an SDK captures bodies. */
export function createIngestRuntimeConfigRouter(pool: pg.Pool): Router {
  const router = createRouter();
  router.get("/api/v1/projects/:projectId/config", async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) { res.status(401).json({ error: "Missing or invalid authorization" }); return; }
      const config = await cachedRuntimeConfig(pool, String(req.params.projectId), authHeader.slice(7));
      if (!config) { res.status(401).json({ error: "Invalid auth key" }); return; }
      res.set("Cache-Control", "private, max-age=60").json(config);
    } catch (error) {
      console.error("[costkey] Runtime privacy config error:", error);
      res.status(500).json({ error: "Runtime config unavailable" });
    }
  });
  return router;
}

async function getProjectSettings(pool: pg.Pool, projectId: string): Promise<PrivacySettings | null> {
  const result = await pool.query(
    `SELECT project_id, capture_mode, body_capture_enabled, redaction_enabled,
            body_retention_days, metadata_retention_days, aggregate_retention_days,
            source_access_enabled, updated_by, created_at, updated_at
     FROM project_settings WHERE project_id = $1`,
    [projectId],
  );
  return (result.rows[0] as PrivacySettings | undefined) ?? null;
}

export function createPrivacyRouter(pool: pg.Pool): Router {
  const router = createRouter();
  router.use("/api", requireAuth);

  router.get("/api/v1/projects/:projectId/privacy", async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: { id: string; orgId: string; role: string } }).user;
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      const projectId = String(req.params.projectId);
      await assertProjectAccess(pool, user, projectId);
      await ensureProjectSettings(pool, projectId);
      const settings = await getProjectSettings(pool, projectId);
      if (!settings) { res.status(404).json({ error: "Project privacy settings not found" }); return; }
      res.json({ settings: settingsResponse(settings), canManage: roleCanManageWorkspace(user.role) });
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status) { res.status(status).json({ error: (error as Error).message }); return; }
      console.error("[costkey] Privacy settings read error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.patch("/api/v1/projects/:projectId/privacy", async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: { id: string; orgId: string; role: string } }).user;
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      if (!roleCanManageWorkspace(user.role)) {
        res.status(403).json({ error: "Only owners and admins can change capture settings" });
        return;
      }
      const projectId = String(req.params.projectId);
      await assertProjectAccess(pool, user, projectId);
      await ensureProjectSettings(pool, projectId);

      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.captureMode === "metadata" && body.bodyCaptureEnabled === true) {
        res.status(400).json({ error: "Metadata-only capture cannot enable body capture" }); return;
      }
      if (body.captureMode === "text" && body.bodyCaptureEnabled === false) {
        res.status(400).json({ error: "Text capture requires bodyCaptureEnabled=true" }); return;
      }
      const updates: string[] = [];
      const params: unknown[] = [];
      let index = 1;

      if (body.captureMode !== undefined) {
        if (body.captureMode !== "metadata" && body.captureMode !== "text") {
          res.status(400).json({ error: "captureMode must be metadata or text" }); return;
        }
        updates.push(`capture_mode = $${index++}`);
        params.push(body.captureMode);
        updates.push(`body_capture_enabled = $${index++}`);
        params.push(body.captureMode === "text");
      }
      if (body.bodyCaptureEnabled !== undefined) {
        if (typeof body.bodyCaptureEnabled !== "boolean") {
          res.status(400).json({ error: "bodyCaptureEnabled must be boolean" }); return;
        }
        updates.push(`body_capture_enabled = $${index++}`);
        params.push(body.bodyCaptureEnabled);
        if (body.captureMode === undefined) {
          updates.push(`capture_mode = $${index++}`);
          params.push(body.bodyCaptureEnabled ? "text" : "metadata");
        }
      }
      if (body.redactionEnabled !== undefined) {
        if (typeof body.redactionEnabled !== "boolean") {
          res.status(400).json({ error: "redactionEnabled must be boolean" }); return;
        }
        updates.push(`redaction_enabled = $${index++}`);
        params.push(body.redactionEnabled);
      }
      if (body.sourceAccessEnabled !== undefined) {
        if (typeof body.sourceAccessEnabled !== "boolean") {
          res.status(400).json({ error: "sourceAccessEnabled must be boolean" }); return;
        }
        updates.push(`source_access_enabled = $${index++}`);
        params.push(body.sourceAccessEnabled);
      }
      for (const [field, column, min, max] of [
        ["bodyRetentionDays", "body_retention_days", 1, 7],
        ["metadataRetentionDays", "metadata_retention_days", 1, 30],
        ["aggregateRetentionDays", "aggregate_retention_days", 30, 395],
      ] as const) {
        if (body[field] === undefined) continue;
        const value = body[field];
        if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
          res.status(400).json({ error: `${field} must be an integer from ${min} to ${max}` }); return;
        }
        updates.push(`${column} = $${index++}`);
        params.push(value);
      }

      if (updates.length === 0) { res.status(400).json({ error: "Nothing to update" }); return; }
      updates.push("updated_by = $" + index++);
      params.push(user.id);
      updates.push("updated_at = NOW()");
      params.push(projectId);
      await pool.query(
        `UPDATE project_settings SET ${updates.join(", ")} WHERE project_id = $${index}`,
        params,
      );
      // The change middleware dropped the cache before this update landed; a
      // config read in between would have kept the old settings.
      invalidateRuntimeConfig(projectId);
      const settings = await getProjectSettings(pool, projectId);
      res.json({ settings: settings ? settingsResponse(settings) : null });
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status) { res.status(status).json({ error: (error as Error).message }); return; }
      console.error("[costkey] Privacy settings update error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Explicit deletion is separate from prospective capture changes. Require a
  // project-id confirmation so a stale UI cannot delete another project's data.
  router.post("/api/v1/projects/:projectId/privacy/delete-content", async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: { id: string; orgId: string; role: string } }).user;
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
      if (!roleCanManageWorkspace(user.role)) {
        res.status(403).json({ error: "Only owners and admins can delete captured content" }); return;
      }
      const projectId = String(req.params.projectId);
      await assertProjectAccess(pool, user, projectId);
      if (req.body?.confirmProjectId !== projectId) {
        res.status(400).json({ error: "confirmProjectId must match the project" }); return;
      }
      const statusColumn = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'events' AND column_name = 'content_status'
         ) AS available`,
      );
      const statusSet = statusColumn.rows[0]?.available
        ? `, content_status = CASE
             WHEN request_body IS NOT NULL OR response_body IS NOT NULL OR system_prompt IS NOT NULL
               OR configuration IS NOT NULL
               OR metadata IS DISTINCT FROM ${scrubAccountingMetadata("metadata")}
               OR usage_event IS DISTINCT FROM ${scrubUsageMetadata("usage_event")} THEN 'redacted' ELSE content_status END`
        : "";
      // Raw SDK telemetry follows metadata (the column exists from SDK 0.7 schema on).
      const rawTelemetryColumn = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'events' AND column_name = 'raw_telemetry'
         ) AS available`,
      );
      const rawTelemetryAvailable = Boolean(rawTelemetryColumn.rows[0]?.available);
      const result = await pool.query(
        `UPDATE events
         SET request_body = NULL, response_body = NULL, system_prompt = NULL,${rawTelemetryAvailable ? "\n             raw_telemetry = NULL," : ""}
             metadata = ${scrubAccountingMetadata("metadata")},
             usage_event = ${scrubUsageMetadata("usage_event")},
             configuration = NULL,
             context = ${scrubAccountingContext("context")}${statusSet}
         WHERE project_id = $1
           AND (request_body IS NOT NULL OR response_body IS NOT NULL OR system_prompt IS NOT NULL${rawTelemetryAvailable ? " OR raw_telemetry IS NOT NULL" : ""}
             OR metadata IS NOT NULL OR usage_event IS NOT NULL OR configuration IS NOT NULL OR context IS NOT NULL)`,
        [projectId],
      );
      let deletedContent = result.rowCount ?? 0;
      const availableTables = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name = ANY($1::text[])`,
        [["usage_components", "traces", "executions", "groups"]],
      );
      const tables = new Set(availableTables.rows.map((row) => String(row.table_name)));
      if (tables.has("usage_components")) {
        const usage = await pool.query(
          `UPDATE usage_components
           SET metadata = ${scrubUsageMetadata("metadata")},
               context = ${scrubAccountingContext("context")}
           WHERE project_id = $1 AND (metadata IS NOT NULL OR context IS NOT NULL)`,
          [projectId],
        );
        deletedContent += usage.rowCount ?? 0;
      }
      if (tables.has("traces")) {
        const traces = await pool.query(
          `UPDATE traces SET context = ${scrubAccountingContext("context")}
           WHERE project_id = $1 AND context IS NOT NULL`,
          [projectId],
        );
        deletedContent += traces.rowCount ?? 0;
      }
      if (tables.has("executions")) {
        const executions = await pool.query(
          `UPDATE executions
           SET configuration = NULL, context = ${scrubAccountingContext("context")}
           WHERE project_id = $1 AND (configuration IS NOT NULL OR context IS NOT NULL)`,
          [projectId],
        );
        deletedContent += executions.rowCount ?? 0;
      }
      if (tables.has("groups")) {
        const groups = await pool.query(
          `UPDATE groups SET metadata = ${scrubAccountingContext("metadata")}, updated_at = NOW()
           WHERE project_id = $1 AND metadata IS NOT NULL`,
          [projectId],
        );
        deletedContent += groups.rowCount ?? 0;
      }
      res.json({ deletedContent, projectId });
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status) { res.status(status).json({ error: (error as Error).message }); return; }
      console.error("[costkey] Captured content deletion error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

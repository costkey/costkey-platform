import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { orgScope } from "./middleware.js";
import { requireAuth } from "./auth.js";
import { normalizeRole, roleCanManageWorkspace } from "./permissions.js";

export interface FeatureMappingMatch {
  provider?: string;
  model?: string;
  file?: string;
  function?: string;
  service?: string;
  environment?: string;
  context?: Record<string, string>;
}

export interface FeatureMapping {
  id: string;
  project_id: string;
  feature: string;
  match: FeatureMappingMatch;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export class FeatureMappingInputError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "FeatureMappingInputError";
  }
}

function text(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length > 0 && result.length <= max ? result : null;
}

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseFeatureMapping(body: Record<string, unknown>): { feature: string; match: FeatureMappingMatch } | { error: string } {
  const feature = text(body["feature"], 120);
  const raw = object(body["match"]);
  if (!feature || !raw) return { error: "feature and match object are required" };
  const match: FeatureMappingMatch = {};
  for (const key of ["provider", "model", "file", "function", "service", "environment"] as const) {
    const value = text(raw[key]);
    if (value) match[key] = value;
  }
  const context = object(raw["context"]);
  if (context) {
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(context)) {
      const textValue = text(value);
      if (textValue && /^[a-zA-Z0-9_.:-]{1,80}$/.test(key)) values[key] = textValue;
    }
    if (Object.keys(values).length > 0) match.context = values;
  }
  if (Object.keys(match).length === 0) return { error: "match must include provider, model, file, function, service, environment, or context" };
  return { feature, match };
}

function wildcardMatch(pattern: string | undefined, candidate: string | null): boolean {
  if (!pattern) return true;
  if (!candidate) return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(candidate);
}

function eventContext(event: Record<string, unknown>): Record<string, unknown> {
  const parsed = event.context;
  if (typeof parsed === "string") {
    try { return JSON.parse(parsed) as Record<string, unknown>; } catch { return {}; }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function sqlLikePattern(pattern: string): string {
  // Mapping wildcards are intentionally small: `*` spans any characters and
  // `?` spans one. Escape SQL LIKE metacharacters before translating them so a
  // user cannot broaden a match accidentally (or inject a predicate).
  return pattern.replace(/[\\%_]/g, (character) => `\\${character}`).replace(/\*/g, "%").replace(/\?/g, "_");
}

function mappingPredicate(
  mapping: FeatureMapping,
  params: unknown[],
  alias = "e",
  options: { overrideExplicit?: boolean } = {},
): string[] {
  const clauses = [
    `${alias}.project_id = $1`,
    `COALESCE(${alias}.event_type, 'call') = 'call'`,
  ];
  const match = mapping.match;
  const addPattern = (expression: string, pattern: string | undefined): void => {
    if (!pattern) return;
    params.push(sqlLikePattern(pattern));
    clauses.push(`COALESCE(${expression}, '') ILIKE $${params.length} ESCAPE E'\\\\'`);
  };
  addPattern(`${alias}.provider`, match.provider);
  addPattern(`${alias}.model`, match.model);
  addPattern(`${alias}.bl_file`, match.file);
  addPattern(`${alias}.bl_function`, match.function);
  addPattern(`${alias}.context->>'service'`, match.service);
  addPattern(`${alias}.context->>'environment'`, match.environment);
  for (const [key, expected] of Object.entries(match.context ?? {})) {
    if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(key)) continue;
    addPattern(`${alias}.context->>'${key}'`, expected);
  }
  if (options.overrideExplicit !== true) {
    clauses.push(`NULLIF(BTRIM(${alias}.context->>'feature'), '') IS NULL`);
  }
  return clauses;
}

function normalizedRange(from: string | null | undefined, to: string | null | undefined): { from: string | null; to: string | null } {
  const parse = (input: string | null | undefined): string | null => {
    if (!input) return null;
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) throw new FeatureMappingInputError("from and to must be valid dates");
    return date.toISOString();
  };
  const normalizedFrom = parse(from);
  const normalizedTo = parse(to);
  if (normalizedFrom && normalizedTo && new Date(normalizedFrom) >= new Date(normalizedTo)) {
    throw new FeatureMappingInputError("from must be before to");
  }
  return { from: normalizedFrom, to: normalizedTo };
}

export function mappingMatches(mapping: FeatureMappingMatch, event: Record<string, unknown>, attribution?: { file?: string | null; function?: string | null }): boolean {
  const context = eventContext(event);
  if (!wildcardMatch(mapping.provider, typeof event.provider === "string" ? event.provider : null)) return false;
  if (!wildcardMatch(mapping.model, typeof event.model === "string" ? event.model : null)) return false;
  if (!wildcardMatch(mapping.file, attribution?.file ?? (typeof event.bl_file === "string" ? event.bl_file : null))) return false;
  if (!wildcardMatch(mapping.function, attribution?.function ?? (typeof event.bl_function === "string" ? event.bl_function : null))) return false;
  if (!wildcardMatch(mapping.service, typeof context["service"] === "string" ? context["service"] : null)) return false;
  if (!wildcardMatch(mapping.environment, typeof context["environment"] === "string" ? context["environment"] : null)) return false;
  for (const [key, expected] of Object.entries(mapping.context ?? {})) {
    const actual = context[key];
    if (!wildcardMatch(expected, typeof actual === "string" ? actual : actual == null ? null : String(actual))) return false;
  }
  return true;
}

function id(prefix: string): string { return `${prefix}${randomBytes(12).toString("hex")}`; }

async function mappingsForProject(pool: pg.Pool | pg.PoolClient, projectId: string, enabledOnly = false): Promise<FeatureMapping[]> {
  const result = await pool.query(
    `SELECT id, project_id, feature, match, enabled, created_by, created_at, updated_at
     FROM feature_mappings WHERE project_id = $1 ${enabledOnly ? "AND enabled = TRUE" : ""}
     ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  return result.rows.map((row) => ({
    ...row,
    match: object(row.match) ?? {},
  })) as FeatureMapping[];
}

export async function previewFeatureMapping(pool: pg.Pool, projectId: string, mapping: FeatureMapping, from?: string | null, to?: string | null): Promise<{ matchedCount: number; knownCost: number | null; unpricedCount: number; eventIds: string[]; sampleTruncated: boolean }> {
  const range = normalizedRange(from, to);
  const params: unknown[] = [projectId];
  const clauses = mappingPredicate(mapping, params, "e");
  if (range.from) { params.push(range.from); clauses.push(`e.timestamp >= $${params.length}`); }
  if (range.to) { params.push(range.to); clauses.push(`e.timestamp < $${params.length}`); }
  const stats = await pool.query(
    `SELECT COUNT(*)::int AS matched_count,
            COUNT(*) FILTER (WHERE e.cost_usd IS NULL)::int AS unpriced_count,
            SUM(e.cost_usd) FILTER (WHERE e.cost_usd IS NOT NULL) AS known_cost
     FROM events e WHERE ${clauses.join(" AND ")}`,
    params,
  );
  const sampleLimit = 100;
  const sample = await pool.query(
    `SELECT e.id FROM events e WHERE ${clauses.join(" AND ")}
     ORDER BY e.timestamp ASC, e.id ASC LIMIT $${params.length + 1}`,
    [...params, sampleLimit],
  );
  const matchedCount = Number(stats.rows[0]?.matched_count ?? 0);
  const unpricedCount = Number(stats.rows[0]?.unpriced_count ?? 0);
  return {
    matchedCount,
    knownCost: matchedCount - unpricedCount > 0 ? Number(stats.rows[0]?.known_cost ?? 0) : null,
    unpricedCount,
    eventIds: sample.rows.map((row) => String(row.id)),
    sampleTruncated: matchedCount > sampleLimit,
  };
}

export async function applyFeatureMapping(
  pool: pg.Pool,
  projectId: string,
  mapping: FeatureMapping,
  options: { from?: string | null; to?: string | null; overrideExplicit?: boolean; userId?: string | null } = {},
): Promise<{ matchedCount: number; actionId: string }> {
  const range = normalizedRange(options.from, options.to);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const actionId = id("mapact_");
    await client.query(
      `INSERT INTO feature_mapping_actions (
         id, mapping_id, project_id, action, from_time, to_time,
         matched_count, override_explicit, performed_by
       ) VALUES ($1,$2,$3,'historical_relabel',$4,$5,$6,$7,$8)`,
      [actionId, mapping.id, projectId, range.from, range.to,
        0, options.overrideExplicit === true, options.userId ?? null],
    );
    const updateParams: unknown[] = [projectId];
    const clauses = mappingPredicate(mapping, updateParams, "e", { overrideExplicit: options.overrideExplicit });
    if (range.from) { updateParams.push(range.from); clauses.push(`e.timestamp >= $${updateParams.length}`); }
    if (range.to) { updateParams.push(range.to); clauses.push(`e.timestamp < $${updateParams.length}`); }
    const featureParam = updateParams.push(mapping.feature);
    const mappingParam = updateParams.push(mapping.id);
    const actionParam = updateParams.push(actionId);
    const originalExpression = options.overrideExplicit === true
      ? `CASE WHEN NULLIF(BTRIM(e.context->>'feature'), '') IS NOT NULL AND e.feature_original IS NULL THEN e.context->>'feature' ELSE e.feature_original END`
      : "e.feature_original";
    const source = options.overrideExplicit === true ? "mapping_override" : "mapping";
    const updated = await client.query(
      `UPDATE events e
       SET context = jsonb_set(COALESCE(e.context, '{}'::jsonb), '{feature}', to_jsonb($${featureParam}::text), TRUE),
           feature_source = '${source}',
           feature_mapping_id = $${mappingParam},
           feature_mapping_action_id = $${actionParam},
           feature_original = ${originalExpression}
       WHERE ${clauses.join(" AND ")}`,
      updateParams,
    );
    const matchedCount = updated.rowCount ?? 0;
    await client.query("UPDATE feature_mapping_actions SET matched_count = $1 WHERE id = $2", [matchedCount, actionId]);
    await client.query("COMMIT");
    return { matchedCount, actionId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Apply a reusable future mapping only when the app did not supply feature meaning. */
export async function enrichFeatureContext(
  client: pg.Pool | pg.PoolClient,
  projectId: string,
  event: Record<string, unknown>,
  attribution: { file?: string | null; function?: string | null; sourceAccessEnabled?: boolean } = {},
): Promise<Record<string, unknown>> {
  // Ingest already resolved the project setting before opening its write
  // transaction. Passing the decision avoids querying an optional migration
  // table on the transaction client (a missing table would abort that
  // transaction even though mapping is simply unavailable).
  if (attribution.sourceAccessEnabled === false) return event;
  try {
    if (attribution.sourceAccessEnabled !== true) {
      const settings = await client.query(
        "SELECT COALESCE(source_access_enabled, FALSE) AS enabled FROM project_settings WHERE project_id = $1",
        [projectId],
      );
      if (settings.rows[0]?.enabled !== true) return event;
    }
  } catch {
    // Unknown source policy must not enable source-derived attribution.
    return event;
  }
  const context = eventContext(event);
  if (typeof context["feature"] === "string" && context["feature"].trim()) return event;
  const mappings = await mappingsForProject(client, projectId, true);
  const match = mappings.find((mapping) => mappingMatches(mapping.match, event, attribution));
  if (!match) return event;
  return {
    ...event,
    context: { ...context, feature: match.feature },
    featureSource: "mapping",
    featureMappingId: match.id,
  };
}

async function canUseMapping(pool: pg.Pool, req: Request, projectId: string): Promise<boolean> {
  if (normalizeRole((req as any).user?.role) === "viewer") return false;
  try {
    const result = await pool.query(
      "SELECT COALESCE(source_access_enabled, FALSE) AS enabled FROM project_settings WHERE project_id = $1",
      [projectId],
    );
    return result.rows[0]?.enabled === true;
  } catch {
    return false;
  }
}

export function createFeatureMappingsRouter(pool: pg.Pool): Router {
  const router = createRouter();
  router.use("/api/v1/projects/:projectId", requireAuth, orgScope(pool));

  router.get("/api/v1/projects/:projectId/feature-mappings", async (req, res) => {
    try {
      if (!await canUseMapping(pool, req, req.params["projectId"] as string)) { res.status(403).json({ error: "Source access is disabled for this project" }); return; }
      res.json({ mappings: await mappingsForProject(pool, req.params["projectId"] as string) });
    }
    catch (error) { console.error("[costkey] Feature mappings list error:", error); res.status(500).json({ error: "Failed to fetch feature mappings" }); }
  });

  router.post("/api/v1/projects/:projectId/feature-mappings", async (req, res) => {
    try {
      if (!await canUseMapping(pool, req, req.params["projectId"] as string)) { res.status(403).json({ error: "Source access is disabled or insufficient for this project" }); return; }
      const parsed = parseFeatureMapping((req.body ?? {}) as Record<string, unknown>);
      if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }
      const mappingId = id("map_");
      await pool.query(
        `INSERT INTO feature_mappings (id, project_id, feature, match, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [mappingId, req.params["projectId"], parsed.feature, JSON.stringify(parsed.match), (req as any).user?.id ?? null],
      );
      res.status(201).json({ id: mappingId, feature: parsed.feature, match: parsed.match, enabled: true });
    } catch (error) { console.error("[costkey] Feature mapping create error:", error); res.status(500).json({ error: "Failed to create feature mapping" }); }
  });

  router.get("/api/v1/projects/:projectId/feature-mappings/:mappingId/preview", async (req, res) => {
    try {
      const projectId = req.params["projectId"] as string;
      if (!await canUseMapping(pool, req, projectId)) { res.status(403).json({ error: "Source access is disabled or insufficient for this project" }); return; }
      const rows = await pool.query("SELECT id, project_id, feature, match, enabled, created_by, created_at, updated_at FROM feature_mappings WHERE id = $1 AND project_id = $2", [req.params["mappingId"], projectId]);
      if (rows.rows.length === 0) { res.status(404).json({ error: "Feature mapping not found" }); return; }
      const from = text(req.query["from"], 80);
      const to = text(req.query["to"], 80);
      const mapping = { ...rows.rows[0], match: object(rows.rows[0].match) ?? {} } as FeatureMapping;
      res.json({ mappingId: mapping.id, from, to, preview: await previewFeatureMapping(pool, projectId, mapping, from, to) });
    } catch (error) {
      if (error instanceof FeatureMappingInputError) { res.status(400).json({ error: error.message }); return; }
      console.error("[costkey] Feature mapping preview error:", error); res.status(500).json({ error: "Failed to preview feature mapping" });
    }
  });

  router.post("/api/v1/projects/:projectId/feature-mappings/:mappingId/apply", async (req, res) => {
    try {
      if (!await canUseMapping(pool, req, req.params["projectId"] as string)) { res.status(403).json({ error: "Source access is disabled or insufficient for this project" }); return; }
      const projectId = req.params["projectId"] as string;
      const rows = await pool.query("SELECT id, project_id, feature, match, enabled, created_by, created_at, updated_at FROM feature_mappings WHERE id = $1 AND project_id = $2", [req.params["mappingId"], projectId]);
      if (rows.rows.length === 0) { res.status(404).json({ error: "Feature mapping not found" }); return; }
      if ((req.body as Record<string, unknown> | undefined)?.confirm !== true) { res.status(400).json({ error: "confirm=true is required for historical relabelling" }); return; }
      const overrideExplicit = (req.body as Record<string, unknown> | undefined)?.overrideExplicit === true;
      if (overrideExplicit && !roleCanManageWorkspace((req as any).user?.role)) { res.status(403).json({ error: "Only owners and admins can override explicit feature labels" }); return; }
      const mapping = { ...rows.rows[0], match: object(rows.rows[0].match) ?? {} } as FeatureMapping;
      const from = text((req.body as Record<string, unknown> | undefined)?.from, 80);
      const to = text((req.body as Record<string, unknown> | undefined)?.to, 80);
      const result = await applyFeatureMapping(pool, projectId, mapping, { from, to, overrideExplicit, userId: (req as any).user?.id ?? null });
      res.json({ mappingId: mapping.id, ...result });
    } catch (error) {
      if (error instanceof FeatureMappingInputError) { res.status(400).json({ error: error.message }); return; }
      console.error("[costkey] Feature mapping apply error:", error); res.status(500).json({ error: "Failed to apply feature mapping" });
    }
  });

  router.patch("/api/v1/projects/:projectId/feature-mappings/:mappingId", async (req, res) => {
    try {
      if (!await canUseMapping(pool, req, req.params["projectId"] as string)) { res.status(403).json({ error: "Source access is disabled or insufficient for this project" }); return; }
      const enabled = (req.body as Record<string, unknown> | undefined)?.enabled;
      if (typeof enabled !== "boolean") { res.status(400).json({ error: "enabled boolean is required" }); return; }
      const result = await pool.query("UPDATE feature_mappings SET enabled = $1, updated_at = NOW() WHERE id = $2 AND project_id = $3 RETURNING id, enabled", [enabled, req.params["mappingId"], req.params["projectId"]]);
      if (result.rows.length === 0) { res.status(404).json({ error: "Feature mapping not found" }); return; }
      res.json({ mapping: result.rows[0] });
    } catch (error) { console.error("[costkey] Feature mapping update error:", error); res.status(500).json({ error: "Failed to update feature mapping" }); }
  });

  router.delete("/api/v1/projects/:projectId/feature-mappings/:mappingId", async (req, res) => {
    try {
      if (!await canUseMapping(pool, req, req.params["projectId"] as string)) { res.status(403).json({ error: "Source access is disabled or insufficient for this project" }); return; }
      const result = await pool.query("UPDATE feature_mappings SET enabled = FALSE, updated_at = NOW() WHERE id = $1 AND project_id = $2 RETURNING id", [req.params["mappingId"], req.params["projectId"]]);
      if (result.rows.length === 0) { res.status(404).json({ error: "Feature mapping not found" }); return; }
      res.json({ ok: true });
    } catch (error) { console.error("[costkey] Feature mapping delete error:", error); res.status(500).json({ error: "Failed to disable feature mapping" }); }
  });

  return router;
}

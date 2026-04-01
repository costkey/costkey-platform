import type { Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { groupIntoFeatures } from "./grouping.js";

export function createApiRouter(pool: pg.Pool): Router {
  const router = createRouter();

  // GET /api/v1/projects/:projectId/overview
  router.get("/api/v1/projects/:projectId/overview", async (req, res) => {
    try {
      const { projectId } = req.params;
      const { from, to } = req.query;
      const { clause, params } = timeFilter(from as string, to as string, 1);

      const overview = await pool.query(
        `SELECT
          COUNT(*)::int as total_calls,
          COALESCE(SUM(cost_usd), 0) as total_cost,
          COALESCE(SUM(input_tokens), 0)::bigint as total_input_tokens,
          COALESCE(SUM(output_tokens), 0)::bigint as total_output_tokens,
          COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
          COALESCE(AVG(CASE WHEN streaming THEN ttft END), 0) as avg_ttft,
          COALESCE(AVG(CASE WHEN streaming THEN tps END), 0) as avg_tps
        FROM events WHERE project_id = $1 ${clause}`,
        [projectId, ...params],
      );

      const byModel = await pool.query(
        `SELECT model, provider, COUNT(*)::int as calls,
          COALESCE(SUM(cost_usd), 0) as cost,
          COALESCE(SUM(input_tokens), 0)::bigint as input_tokens,
          COALESCE(SUM(output_tokens), 0)::bigint as output_tokens,
          COALESCE(AVG(duration_ms), 0) as avg_duration_ms
        FROM events WHERE project_id = $1 ${clause}
        GROUP BY model, provider ORDER BY cost DESC`,
        [projectId, ...params],
      );

      const byProvider = await pool.query(
        `SELECT provider, COUNT(*)::int as calls, COALESCE(SUM(cost_usd), 0) as cost
        FROM events WHERE project_id = $1 ${clause}
        GROUP BY provider ORDER BY cost DESC`,
        [projectId, ...params],
      );

      res.json({
        overview: overview.rows[0],
        byModel: byModel.rows,
        byProvider: byProvider.rows,
      });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/call-sites
  router.get("/api/v1/projects/:projectId/call-sites", async (req, res) => {
    try {
      const { projectId } = req.params;
      const limit = Math.min(parseInt(req.query["limit"] as string) || 50, 200);
      const sortBy = (req.query["sort"] as string) || "total_cost_usd";
      const validSorts = ["total_cost_usd", "total_calls", "total_input_tokens", "total_output_tokens", "avg_duration_ms"];
      const sort = validSorts.includes(sortBy) ? sortBy : "total_cost_usd";

      const result = await pool.query(
        `SELECT call_site_key, file_name, function_name, line_number,
          provider, model, total_calls::int, total_cost_usd,
          total_input_tokens::bigint, total_output_tokens::bigint,
          avg_duration_ms, avg_ttft, avg_tps, first_seen, last_seen
        FROM call_site_stats WHERE project_id = $1
        ORDER BY ${sort} DESC LIMIT $2`,
        [projectId, limit],
      );

      res.json({ callSites: result.rows });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/events
  router.get("/api/v1/projects/:projectId/events", async (req, res) => {
    try {
      const { projectId } = req.params;
      const limit = Math.min(parseInt(req.query["limit"] as string) || 50, 200);
      const offset = parseInt(req.query["offset"] as string) || 0;
      const { from, to, model, provider } = req.query;
      const { clause, params } = timeFilter(from as string, to as string, 1);

      let extra = "";
      const extraParams: string[] = [];
      let paramIdx = params.length + 2; // +1 for projectId, already counted in timeFilter

      if (model) { extra += ` AND model = $${paramIdx++}`; extraParams.push(model as string); }
      if (provider) { extra += ` AND provider = $${paramIdx++}`; extraParams.push(provider as string); }

      const events = await pool.query(
        `SELECT id, timestamp, provider, model, url, method, status_code,
          input_tokens, output_tokens, total_tokens, reasoning_tokens,
          cache_read_tokens, cache_creation_tokens,
          cost_usd, duration_ms, streaming, ttft, tps, stream_duration, chunk_count,
          call_site_raw, call_site_frames, context
        FROM events WHERE project_id = $1 ${clause} ${extra}
        ORDER BY timestamp DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        [projectId, ...params, ...extraParams, limit, offset],
      );

      const total = await pool.query(
        `SELECT COUNT(*)::int as count FROM events WHERE project_id = $1 ${clause} ${extra}`,
        [projectId, ...params, ...extraParams],
      );

      res.json({ events: events.rows, total: total.rows[0].count, limit, offset });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/events/:eventId
  router.get("/api/v1/projects/:projectId/events/:eventId", async (req, res) => {
    try {
      const { projectId, eventId } = req.params;
      const result = await pool.query(
        "SELECT * FROM events WHERE project_id = $1 AND id = $2",
        [projectId, eventId],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: "Event not found" });
        return;
      }
      res.json({ event: result.rows[0] });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/trends
  router.get("/api/v1/projects/:projectId/trends", async (req, res) => {
    try {
      const { projectId } = req.params;
      const { from, to } = req.query;
      const bucket = (req.query["bucket"] as string) || "hour";
      const { clause, params } = timeFilter(from as string, to as string, 1);
      const trunc = bucket === "day" ? "day" : "hour";

      const result = await pool.query(
        `SELECT date_trunc('${trunc}', timestamp) as bucket,
          COUNT(*)::int as calls,
          COALESCE(SUM(cost_usd), 0) as cost,
          COALESCE(SUM(input_tokens), 0)::bigint as input_tokens,
          COALESCE(SUM(output_tokens), 0)::bigint as output_tokens,
          COALESCE(AVG(duration_ms), 0) as avg_duration_ms
        FROM events WHERE project_id = $1 ${clause}
        GROUP BY bucket ORDER BY bucket ASC`,
        [projectId, ...params],
      );

      res.json({ trends: result.rows, bucket });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/traces
  router.get("/api/v1/projects/:projectId/traces", async (req, res) => {
    try {
      const { projectId } = req.params;
      const limit = Math.min(parseInt(req.query["limit"] as string) || 50, 200);
      const offset = parseInt(req.query["offset"] as string) || 0;

      const result = await pool.query(
        `SELECT trace_id, trace_name, COUNT(*)::int as call_count,
          COALESCE(SUM(cost_usd), 0) as total_cost,
          COALESCE(SUM(input_tokens), 0)::bigint as total_input_tokens,
          COALESCE(SUM(output_tokens), 0)::bigint as total_output_tokens,
          MIN(timestamp) as started_at, MAX(timestamp) as ended_at,
          COALESCE(SUM(duration_ms), 0) as total_duration_ms,
          STRING_AGG(DISTINCT model, ',') as models,
          STRING_AGG(DISTINCT provider, ',') as providers
        FROM events WHERE project_id = $1 AND trace_id IS NOT NULL
        GROUP BY trace_id, trace_name ORDER BY started_at DESC
        LIMIT $2 OFFSET $3`,
        [projectId, limit, offset],
      );

      const total = await pool.query(
        "SELECT COUNT(DISTINCT trace_id)::int as count FROM events WHERE project_id = $1 AND trace_id IS NOT NULL",
        [projectId],
      );

      res.json({ traces: result.rows, total: total.rows[0].count });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/traces/:traceId
  router.get("/api/v1/projects/:projectId/traces/:traceId", async (req, res) => {
    try {
      const { projectId, traceId } = req.params;

      const events = await pool.query(
        `SELECT id, timestamp, provider, model, url, method, status_code,
          input_tokens, output_tokens, total_tokens,
          cost_usd, duration_ms, streaming, ttft, tps,
          call_site_raw, call_site_frames, context
        FROM events WHERE project_id = $1 AND trace_id = $2
        ORDER BY timestamp ASC`,
        [projectId, traceId],
      );

      if (events.rows.length === 0) {
        res.status(404).json({ error: "Trace not found" });
        return;
      }

      const summary = await pool.query(
        `SELECT trace_name, COUNT(*)::int as call_count,
          COALESCE(SUM(cost_usd), 0) as total_cost,
          COALESCE(SUM(input_tokens), 0)::bigint as total_input_tokens,
          COALESCE(SUM(output_tokens), 0)::bigint as total_output_tokens,
          MIN(timestamp) as started_at, MAX(timestamp) as ended_at,
          COALESCE(SUM(duration_ms), 0) as total_duration_ms
        FROM events WHERE project_id = $1 AND trace_id = $2
        GROUP BY trace_name`,
        [projectId, traceId],
      );

      res.json({ traceId, summary: summary.rows[0], events: events.rows });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/features
  router.get("/api/v1/projects/:projectId/features", async (req, res) => {
    try {
      const { projectId } = req.params;

      const callSiteStats = await pool.query(
        `SELECT call_site_key, file_name, function_name, line_number,
          SUM(total_calls)::int as total_calls, SUM(total_cost_usd) as total_cost_usd,
          SUM(total_input_tokens)::bigint as total_input_tokens,
          SUM(total_output_tokens)::bigint as total_output_tokens,
          AVG(avg_duration_ms) as avg_duration_ms,
          AVG(avg_ttft) as avg_ttft, AVG(avg_tps) as avg_tps
        FROM call_site_stats WHERE project_id = $1
        GROUP BY call_site_key, file_name, function_name, line_number`,
        [projectId],
      );

      const eventFrames = await pool.query(
        `SELECT DISTINCT ON (call_site_frames) call_site_frames
        FROM events WHERE project_id = $1 AND call_site_frames IS NOT NULL`,
        [projectId],
      );

      const parsedFrames = eventFrames.rows.map((row: { call_site_frames: unknown }) => {
        const frames = (typeof row.call_site_frames === "string"
          ? JSON.parse(row.call_site_frames)
          : row.call_site_frames) as Array<{
          fileName: string | null;
          functionName: string | null;
          lineNumber: number | null;
          columnNumber: number | null;
        }>;
        const leaf = frames[0];
        const callSiteKey = leaf
          ? `${leaf.fileName}:${leaf.functionName}:${leaf.lineNumber}`
          : "unknown";
        return { call_site_key: callSiteKey, frames };
      });

      const features = groupIntoFeatures(callSiteStats.rows, parsedFrames);
      res.json({ features });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects
  router.get("/api/v1/projects", async (req, res) => {
    try {
      const user = (req as any).user;
      const orgFilter = user ? "WHERE p.org_id = $1" : "";
      const params = user ? [user.orgId] : [];

      const result = await pool.query(
        `SELECT p.id, p.name, p.auth_key, p.created_at,
          (SELECT COUNT(*)::int FROM events e WHERE e.project_id = p.id) as event_count,
          (SELECT COALESCE(SUM(cost_usd), 0) FROM events e WHERE e.project_id = p.id) as total_cost
        FROM projects p ${orgFilter} ORDER BY p.created_at DESC`,
        params,
      );

      res.json({ projects: result.rows });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/v1/projects
  router.post("/api/v1/projects", async (req, res) => {
    try {
      const user = (req as any).user;
      const { name } = req.body as { name: string };
      if (!name) {
        res.status(400).json({ error: "Missing project name" });
        return;
      }

      const orgId = user?.orgId;
      if (!orgId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const id = `proj_${randomId()}`;
      const authKey = `ck_${randomId()}`;

      await pool.query(
        "INSERT INTO projects (id, name, org_id, auth_key) VALUES ($1, $2, $3, $4)",
        [id, name, orgId, authKey],
      );

      res.status(201).json({ id, name, authKey, dsn: `https://${authKey}@costkey.dev/${id}` });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

function timeFilter(from?: string, to?: string, startIdx = 1): { clause: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  let idx = startIdx + 1; // +1 for the projectId already at $1
  if (from) { parts.push(`AND timestamp >= $${idx++}`); params.push(from); }
  if (to) { parts.push(`AND timestamp <= $${idx++}`); params.push(to); }
  return { clause: parts.join(" "), params };
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

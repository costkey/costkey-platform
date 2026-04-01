import type { Router } from "express";
import { Router as createRouter } from "express";
import type Database from "better-sqlite3";
import { groupIntoFeatures } from "./grouping.js";

export function createApiRouter(db: Database.Database): Router {
  const router = createRouter();

  // GET /api/v1/projects/:projectId/overview
  // Dashboard overview: total cost, calls, tokens, top models
  router.get("/api/v1/projects/:projectId/overview", (req, res) => {
    try {
      const { projectId } = req.params;
      const { from, to } = req.query;

      const timeFilter = buildTimeFilter(from as string, to as string);

      const overview = db.prepare(`
        SELECT
          COUNT(*) as total_calls,
          COALESCE(SUM(cost_usd), 0) as total_cost,
          COALESCE(SUM(input_tokens), 0) as total_input_tokens,
          COALESCE(SUM(output_tokens), 0) as total_output_tokens,
          COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
          COALESCE(AVG(CASE WHEN streaming = 1 THEN ttft END), 0) as avg_ttft,
          COALESCE(AVG(CASE WHEN streaming = 1 THEN tps END), 0) as avg_tps
        FROM events
        WHERE project_id = ? ${timeFilter.clause}
      `).get(projectId, ...timeFilter.params) as Record<string, number>;

      const byModel = db.prepare(`
        SELECT
          model,
          provider,
          COUNT(*) as calls,
          COALESCE(SUM(cost_usd), 0) as cost,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(AVG(duration_ms), 0) as avg_duration_ms
        FROM events
        WHERE project_id = ? ${timeFilter.clause}
        GROUP BY model, provider
        ORDER BY cost DESC
      `).all(projectId, ...timeFilter.params);

      const byProvider = db.prepare(`
        SELECT
          provider,
          COUNT(*) as calls,
          COALESCE(SUM(cost_usd), 0) as cost
        FROM events
        WHERE project_id = ? ${timeFilter.clause}
        GROUP BY provider
        ORDER BY cost DESC
      `).all(projectId, ...timeFilter.params);

      res.json({ overview, byModel, byProvider });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/call-sites
  // Top callers by cost — the killer feature
  router.get("/api/v1/projects/:projectId/call-sites", (req, res) => {
    try {
      const { projectId } = req.params;
      const limit = Math.min(parseInt(req.query["limit"] as string) || 50, 200);
      const sortBy = (req.query["sort"] as string) || "total_cost_usd";

      const validSorts = ["total_cost_usd", "total_calls", "total_input_tokens", "total_output_tokens", "avg_duration_ms"];
      const sort = validSorts.includes(sortBy) ? sortBy : "total_cost_usd";

      const callSites = db.prepare(`
        SELECT
          call_site_key,
          file_name,
          function_name,
          line_number,
          provider,
          model,
          total_calls,
          total_cost_usd,
          total_input_tokens,
          total_output_tokens,
          avg_duration_ms,
          avg_ttft,
          avg_tps,
          first_seen,
          last_seen
        FROM call_site_stats
        WHERE project_id = ?
        ORDER BY ${sort} DESC
        LIMIT ?
      `).all(projectId, limit);

      res.json({ callSites });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/events
  // Event list with pagination
  router.get("/api/v1/projects/:projectId/events", (req, res) => {
    try {
      const { projectId } = req.params;
      const limit = Math.min(parseInt(req.query["limit"] as string) || 50, 200);
      const offset = parseInt(req.query["offset"] as string) || 0;
      const { from, to, model, provider } = req.query;

      const timeFilter = buildTimeFilter(from as string, to as string);
      let extraWhere = "";
      const extraParams: string[] = [];

      if (model) {
        extraWhere += " AND model = ?";
        extraParams.push(model as string);
      }
      if (provider) {
        extraWhere += " AND provider = ?";
        extraParams.push(provider as string);
      }

      const events = db.prepare(`
        SELECT
          id, timestamp, provider, model, url, method, status_code,
          input_tokens, output_tokens, total_tokens, reasoning_tokens,
          cache_read_tokens, cache_creation_tokens,
          cost_usd, duration_ms, streaming,
          ttft, tps, stream_duration, chunk_count,
          call_site_raw, call_site_frames,
          context
        FROM events
        WHERE project_id = ? ${timeFilter.clause} ${extraWhere}
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `).all(projectId, ...timeFilter.params, ...extraParams, limit, offset);

      const total = db.prepare(`
        SELECT COUNT(*) as count
        FROM events
        WHERE project_id = ? ${timeFilter.clause} ${extraWhere}
      `).get(projectId, ...timeFilter.params, ...extraParams) as { count: number };

      res.json({ events, total: total.count, limit, offset });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/events/:eventId
  // Single event with full body (for replay)
  router.get("/api/v1/projects/:projectId/events/:eventId", (req, res) => {
    try {
      const { projectId, eventId } = req.params;

      const event = db.prepare(`
        SELECT *
        FROM events
        WHERE project_id = ? AND id = ?
      `).get(projectId, eventId);

      if (!event) {
        res.status(404).json({ error: "Event not found" });
        return;
      }

      res.json({ event });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/trends
  // Cost over time (hourly/daily buckets)
  router.get("/api/v1/projects/:projectId/trends", (req, res) => {
    try {
      const { projectId } = req.params;
      const { from, to } = req.query;
      const bucket = (req.query["bucket"] as string) || "hour";

      const timeFilter = buildTimeFilter(from as string, to as string);
      const dateFmt = bucket === "day" ? "%Y-%m-%d" : "%Y-%m-%dT%H:00:00";

      const trends = db.prepare(`
        SELECT
          strftime('${dateFmt}', timestamp) as bucket,
          COUNT(*) as calls,
          COALESCE(SUM(cost_usd), 0) as cost,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(AVG(duration_ms), 0) as avg_duration_ms
        FROM events
        WHERE project_id = ? ${timeFilter.clause}
        GROUP BY strftime('${dateFmt}', timestamp)
        ORDER BY bucket ASC
      `).all(projectId, ...timeFilter.params);

      res.json({ trends, bucket });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/traces
  // List traces with aggregated cost per trace
  router.get("/api/v1/projects/:projectId/traces", (req, res) => {
    try {
      const { projectId } = req.params;
      const limit = Math.min(parseInt(req.query["limit"] as string) || 50, 200);
      const offset = parseInt(req.query["offset"] as string) || 0;

      const traces = db.prepare(`
        SELECT
          trace_id,
          trace_name,
          COUNT(*) as call_count,
          COALESCE(SUM(cost_usd), 0) as total_cost,
          COALESCE(SUM(input_tokens), 0) as total_input_tokens,
          COALESCE(SUM(output_tokens), 0) as total_output_tokens,
          MIN(timestamp) as started_at,
          MAX(timestamp) as ended_at,
          COALESCE(SUM(duration_ms), 0) as total_duration_ms,
          GROUP_CONCAT(DISTINCT model) as models,
          GROUP_CONCAT(DISTINCT provider) as providers
        FROM events
        WHERE project_id = ? AND trace_id IS NOT NULL
        GROUP BY trace_id
        ORDER BY started_at DESC
        LIMIT ? OFFSET ?
      `).all(projectId, limit, offset);

      const total = db.prepare(`
        SELECT COUNT(DISTINCT trace_id) as count
        FROM events
        WHERE project_id = ? AND trace_id IS NOT NULL
      `).get(projectId) as { count: number };

      res.json({ traces, total: total.count });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/traces/:traceId
  // Single trace — all events in that trace, ordered by time
  router.get("/api/v1/projects/:projectId/traces/:traceId", (req, res) => {
    try {
      const { projectId, traceId } = req.params;

      const events = db.prepare(`
        SELECT
          id, timestamp, provider, model, url, method, status_code,
          input_tokens, output_tokens, total_tokens,
          cost_usd, duration_ms, streaming, ttft, tps,
          call_site_raw, call_site_frames, context
        FROM events
        WHERE project_id = ? AND trace_id = ?
        ORDER BY timestamp ASC
      `).all(projectId, traceId);

      if (events.length === 0) {
        res.status(404).json({ error: "Trace not found" });
        return;
      }

      const summary = db.prepare(`
        SELECT
          trace_name,
          COUNT(*) as call_count,
          COALESCE(SUM(cost_usd), 0) as total_cost,
          COALESCE(SUM(input_tokens), 0) as total_input_tokens,
          COALESCE(SUM(output_tokens), 0) as total_output_tokens,
          MIN(timestamp) as started_at,
          MAX(timestamp) as ended_at,
          COALESCE(SUM(duration_ms), 0) as total_duration_ms
        FROM events
        WHERE project_id = ? AND trace_id = ?
      `).get(projectId, traceId);

      res.json({ traceId, summary, events });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/features
  // Auto-detected features grouped by shared call chain ancestors
  router.get("/api/v1/projects/:projectId/features", (req, res) => {
    try {
      const { projectId } = req.params;

      // Get all call site stats
      const callSiteStats = db.prepare(`
        SELECT
          call_site_key, file_name, function_name, line_number,
          SUM(total_calls) as total_calls,
          SUM(total_cost_usd) as total_cost_usd,
          SUM(total_input_tokens) as total_input_tokens,
          SUM(total_output_tokens) as total_output_tokens,
          AVG(avg_duration_ms) as avg_duration_ms,
          AVG(avg_ttft) as avg_ttft,
          AVG(avg_tps) as avg_tps
        FROM call_site_stats
        WHERE project_id = ?
        GROUP BY call_site_key
      `).all(projectId) as Array<{
        call_site_key: string;
        file_name: string | null;
        function_name: string | null;
        line_number: number | null;
        total_calls: number;
        total_cost_usd: number;
        total_input_tokens: number;
        total_output_tokens: number;
        avg_duration_ms: number;
        avg_ttft: number | null;
        avg_tps: number | null;
      }>;

      // Get unique stack traces per call site from events
      const eventFrames = db.prepare(`
        SELECT DISTINCT call_site_frames,
          substr(call_site_raw, instr(call_site_raw, 'at ') + 3, instr(call_site_raw, ' (') - instr(call_site_raw, 'at ') - 3) as fn_hint
        FROM events
        WHERE project_id = ? AND call_site_frames IS NOT NULL
        GROUP BY call_site_frames
      `).all(projectId) as Array<{ call_site_frames: string; fn_hint: string }>;

      // Parse frames and map to call site keys
      const parsedFrames = eventFrames.map((ef) => {
        const frames = JSON.parse(ef.call_site_frames) as Array<{
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

      const features = groupIntoFeatures(callSiteStats, parsedFrames);

      res.json({ features });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects
  // List all projects
  router.get("/api/v1/projects", (_req, res) => {
    try {
      const projects = db.prepare(`
        SELECT p.id, p.name, p.created_at,
          (SELECT COUNT(*) FROM events e WHERE e.project_id = p.id) as event_count,
          (SELECT COALESCE(SUM(cost_usd), 0) FROM events e WHERE e.project_id = p.id) as total_cost
        FROM projects p
        ORDER BY p.created_at DESC
      `).all();

      res.json({ projects });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/v1/projects
  // Create a new project
  router.post("/api/v1/projects", (req, res) => {
    try {
      const { name } = req.body as { name: string };
      if (!name) {
        res.status(400).json({ error: "Missing project name" });
        return;
      }

      const id = `proj_${randomId()}`;
      const authKey = `ck_${randomId()}`;

      db.prepare("INSERT INTO projects (id, name, auth_key) VALUES (?, ?, ?)").run(id, name, authKey);

      res.status(201).json({
        id,
        name,
        authKey,
        dsn: `https://${authKey}@localhost:4100/${id}`,
      });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

function buildTimeFilter(from?: string, to?: string): { clause: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];

  if (from) {
    parts.push("AND timestamp >= ?");
    params.push(from);
  }
  if (to) {
    parts.push("AND timestamp <= ?");
    params.push(to);
  }

  return { clause: parts.join(" "), params };
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

import type { Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import { Resend } from "resend";
import { groupIntoFeatures } from "./grouping.js";
import { getAnomalies, dismissAnomaly } from "./anomaly.js";
import { orgScope } from "./middleware.js";
import { requireAuth } from "./auth.js";
import { createAccountingRouter } from "./accounting-api.js";
import { createPricingRouter } from "./pricing-api.js";
import { createInsightsRouter } from "./insights-api.js";
import { createModelDetailRouter } from "./model-detail-api.js";
import { createQualityRouter } from "./quality-api.js";
import { createFeatureMappingsRouter } from "./feature-mappings.js";
import { listAccessibleProjects, roleCanManageWorkspace } from "./permissions.js";
import { projectDsn } from "./public-url.js";

let resend: Resend | null = null;

function getResend(): Resend {
  return resend ??= new Resend(process.env["RESEND_API_KEY"] ?? "");
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createApiRouter(pool: pg.Pool): Router {
  const router = createRouter();

  // Apply org-scoping to ALL /api/v1/projects/:projectId/* routes
  router.use("/api/v1/projects/:projectId", requireAuth, orgScope(pool));

  // PRD accounting/inspection routes must be mounted before legacy explorer
  // routes so lifecycle-aware responses (partial cost, real elapsed time and
  // grouped receipts) are authoritative while old response aliases remain.
  router.use(createAccountingRouter(pool));
  router.use(createPricingRouter(pool));
  router.use(createInsightsRouter(pool));
  router.use(createModelDetailRouter(pool));
  router.use(createQualityRouter(pool));
  router.use(createFeatureMappingsRouter(pool));

  // GET /api/v1/projects/:projectId/summary
  router.get("/api/v1/projects/:projectId/summary", async (req, res) => {
    try {
      const { projectId } = req.params;

      // This month totals
      const thisMonthResult = await pool.query(
        `SELECT
          COALESCE(SUM(cost_usd), 0) as cost,
          COUNT(*)::int as calls,
          COALESCE(SUM(COALESCE(total_tokens, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))), 0)::bigint as tokens
        FROM events WHERE project_id = $1
          AND timestamp >= date_trunc('month', NOW())`,
        [projectId],
      );

      // Last month totals
      const lastMonthResult = await pool.query(
        `SELECT
          COALESCE(SUM(cost_usd), 0) as cost,
          COUNT(*)::int as calls,
          COALESCE(SUM(COALESCE(total_tokens, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))), 0)::bigint as tokens
        FROM events WHERE project_id = $1
          AND timestamp >= date_trunc('month', NOW() - INTERVAL '1 month')
          AND timestamp < date_trunc('month', NOW())`,
        [projectId],
      );

      // Top features by cost
      const topFeaturesResult = await pool.query(
        `SELECT function_name, file_name,
          SUM(total_cost_usd) as cost,
          SUM(total_calls)::int as calls
        FROM call_site_stats WHERE project_id = $1
        GROUP BY function_name, file_name
        ORDER BY cost DESC LIMIT 5`,
        [projectId],
      );

      const thisMonth = {
        cost: parseFloat(thisMonthResult.rows[0].cost),
        calls: thisMonthResult.rows[0].calls,
        tokens: parseInt(thisMonthResult.rows[0].tokens),
      };

      const lastMonth = {
        cost: parseFloat(lastMonthResult.rows[0].cost),
        calls: lastMonthResult.rows[0].calls,
        tokens: parseInt(lastMonthResult.rows[0].tokens),
      };

      const costChange = lastMonth.cost > 0
        ? ((thisMonth.cost - lastMonth.cost) / lastMonth.cost) * 100
        : 0;
      const callsChange = lastMonth.calls > 0
        ? ((thisMonth.calls - lastMonth.calls) / lastMonth.calls) * 100
        : 0;

      const dayOfMonth = new Date().getDate();
      const dailyAvg = dayOfMonth > 0 ? thisMonth.cost / dayOfMonth : 0;
      const projectedMonthly = dailyAvg * 30;

      const topFeatures = topFeaturesResult.rows.map((row: { function_name: string | null; file_name: string | null; cost: string; calls: number }) => ({
        function_name: row.function_name,
        file_name: row.file_name,
        cost: parseFloat(row.cost),
        calls: row.calls,
        pct: thisMonth.cost > 0 ? (parseFloat(row.cost) / thisMonth.cost) * 100 : 0,
      }));

      // Cost by release
      const byReleaseResult = await pool.query(
        `SELECT release,
          COUNT(*)::int as calls,
          COALESCE(SUM(cost_usd), 0) as cost,
          COALESCE(SUM(input_tokens), 0)::int as tokens,
          MIN(timestamp) as first_seen,
          MAX(timestamp) as last_seen
        FROM events
        WHERE project_id = $1 AND release IS NOT NULL
        GROUP BY release
        ORDER BY first_seen DESC
        LIMIT 10`,
        [projectId],
      );

      const byRelease = byReleaseResult.rows.map((row: { release: string; calls: number; cost: string; tokens: number; first_seen: string; last_seen: string }, i: number) => {
        const cost = parseFloat(row.cost);
        const costPerCall = row.calls > 0 ? cost / row.calls : 0;
        // Compare against the next row (previous release, since sorted by first_seen DESC)
        const prevRow = byReleaseResult.rows[i + 1] as { cost: string; calls: number } | undefined;
        let costChangePct: number | null = null;
        if (prevRow && prevRow.calls > 0) {
          const prevCostPerCall = parseFloat(prevRow.cost) / prevRow.calls;
          if (prevCostPerCall > 0) {
            costChangePct = ((costPerCall - prevCostPerCall) / prevCostPerCall) * 100;
          }
        }
        return {
          release: row.release,
          calls: row.calls,
          cost,
          tokens: row.tokens,
          first_seen: row.first_seen,
          last_seen: row.last_seen,
          cost_per_call: costPerCall,
          cost_change_pct: costChangePct,
        };
      });

      // Cost change from previous release (latest vs second-latest)
      const costChangeFromPrevRelease = byRelease.length > 0 ? byRelease[0].cost_change_pct : null;

      res.json({
        thisMonth,
        lastMonth,
        costChange,
        callsChange,
        topFeatures,
        dailyAvg,
        projectedMonthly,
        byRelease,
        costChangeFromPrevRelease,
      });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/health — pipeline health check
  router.get("/api/v1/projects/:projectId/health", async (req, res) => {
    try {
      const { projectId } = req.params;
      const lastEvent = await pool.query(
        "SELECT MAX(timestamp) as last_event_at FROM events WHERE project_id = $1",
        [projectId],
      );
      const recentCount = await pool.query(
        `SELECT COUNT(*)::int as cnt,
                COUNT(*) FILTER (WHERE COALESCE(lifecycle_state, '') IN ('failed', 'cancelled') OR COALESCE(status_code, 200) >= 400)::int AS failed
         FROM events WHERE project_id = $1 AND timestamp > NOW() - INTERVAL '1 hour'`,
        [projectId],
      );
      const lastAt = lastEvent.rows[0]?.last_event_at;
      const eventsLastHour = recentCount.rows[0]?.cnt ?? 0;
      const failedLastHour = recentCount.rows[0]?.failed ?? 0;

      let status: "active" | "idle" | "inactive" | "no_data" = "no_data";
      if (lastAt) {
        const msSince = Date.now() - new Date(lastAt).getTime();
        if (msSince < 5 * 60 * 1000) status = "active";
        else if (msSince < 24 * 60 * 60 * 1000) status = "idle";
        else status = "inactive";
      }

      // The sidebar's live dot polls with ?light=1: status only, no scans.
      if (req.query["light"] === "1") {
        res.json({ status, lastEventAt: lastAt ?? null, eventsLastHour, failedLastHour, hints: [] });
        return;
      }

      // Detect minified/bundled code without sourcemaps
      const hints: Array<{ type: string; message: string; link: string }> = [];
      const unpriced = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM events WHERE project_id = $1 AND cost_usd IS NULL",
        [projectId],
      );
      if (unpriced.rows[0].cnt > 0) {
        hints.push({
          type: "unpriced_calls",
          message: `${unpriced.rows[0].cnt} calls have no price yet.`,
          link: "/docs/providers",
        });
      }

      const minifiedCheck = await pool.query(
        `SELECT COUNT(*)::int as cnt FROM events
         WHERE project_id = $1 AND call_site_frames IS NOT NULL
         AND timestamp > NOW() - INTERVAL '7 days'
         AND (
           call_site_frames::text LIKE '%/.next/%' OR
           call_site_frames::text LIKE '%/dist/%' OR
           call_site_frames::text LIKE '%/.output/%' OR
           call_site_frames::text LIKE '%.chunk.%' OR
           call_site_frames::text LIKE '%webpack%' OR
           call_site_frames::text LIKE '%/chunks/%' OR
           call_site_frames::text LIKE '%__next%'
         )`,
        [projectId],
      );

      if (minifiedCheck.rows[0].cnt > 0) {
        const hasSourcemaps = await pool.query(
          "SELECT COUNT(*)::int as cnt FROM sourcemaps WHERE project_id = $1",
          [projectId],
        );
        if (hasSourcemaps.rows[0].cnt === 0) {
          hints.push({
            type: "sourcemaps_missing",
            message: "Your code appears to be bundled/minified. Upload sourcemaps to see real function names instead of minified ones.",
            link: "/docs/sourcemaps",
          });
        }
      }

      // Empty-stack hint: if a meaningful fraction of recent events have zero
      // frames at all, the SDK couldn't capture a stack (usually Vercel Edge
      // runtime or a similarly restricted environment). Sourcemaps don't help
      // here — the user needs to tag calls via CostKey.withContext.
      const stackShape = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE call_site_frames IS NULL OR jsonb_array_length(call_site_frames) = 0) AS no_frames,
           COUNT(*) AS total
         FROM events
         WHERE project_id = $1
           AND timestamp > NOW() - INTERVAL '7 days'`,
        [projectId],
      );
      const { no_frames, total } = stackShape.rows[0] ?? { no_frames: 0, total: 0 };
      if (Number(total) >= 20 && Number(no_frames) / Number(total) >= 0.3) {
        hints.push({
          type: "empty_stacks",
          message: `${Math.round((Number(no_frames) / Number(total)) * 100)}% of recent AI calls arrive with empty stack traces — usually Edge runtime or restricted environments. Use CostKey.withContext({ taskName }) at your route handlers so we can attribute without relying on stack capture.`,
          link: "/docs/context",
        });
      }

      res.json({ status, lastEventAt: lastAt, eventsLastHour, hints });
    } catch (err) {
      console.error("[costkey] Health check error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

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
          COALESCE(SUM(input_tokens), 0)::int as total_input_tokens,
          COALESCE(SUM(output_tokens), 0)::int as total_output_tokens,
          COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
          COALESCE(AVG(CASE WHEN streaming THEN ttft END), 0) as avg_ttft,
          COALESCE(AVG(CASE WHEN streaming THEN tps END), 0) as avg_tps
        FROM events WHERE project_id = $1 ${clause}`,
        [projectId, ...params],
      );

      const byModel = await pool.query(
        `SELECT model, provider, COUNT(*)::int as calls,
          COUNT(*) FILTER (WHERE cost_usd IS NULL)::int as unpriced_calls,
          COALESCE(SUM(cost_usd), 0) as cost,
          COALESCE(SUM(input_tokens), 0)::int as input_tokens,
          COALESCE(SUM(output_tokens), 0)::int as output_tokens,
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
          total_input_tokens::int, total_output_tokens::int,
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
      if (req.query["fn"]) { extra += ` AND bl_function = $${paramIdx++}`; extraParams.push(req.query["fn"] as string); }

      const events = await pool.query(
        `SELECT id, timestamp, provider, model, url, method, status_code,
          input_tokens, output_tokens, total_tokens, reasoning_tokens,
          image_output_tokens,
          cache_read_tokens, cache_creation_tokens,
          cost_usd, duration_ms, streaming, ttft, tps, stream_duration, chunk_count,
          call_site_raw, call_site_frames, context,
          bl_function, bl_file, bl_line
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
      const range = (req.query["range"] as string) || "mtd";
      const bucket = (req.query["bucket"] as string) || "day";
      if (bucket !== "day" && bucket !== "hour") {
        res.status(400).json({ error: "bucket must be 'day' or 'hour'" });
        return;
      }
      const trunc = bucket;

      // Compute from/to based on range
      let fromDate: string;
      let toDate: string = new Date().toISOString();
      if (range === "7d") {
        fromDate = new Date(Date.now() - 7 * 86400000).toISOString();
      } else if (range === "30d") {
        fromDate = new Date(Date.now() - 30 * 86400000).toISOString();
      } else if (range === "3m") {
        fromDate = new Date(Date.now() - 90 * 86400000).toISOString();
      } else if (range === "6m") {
        fromDate = new Date(Date.now() - 180 * 86400000).toISOString();
      } else if (range === "1y") {
        fromDate = new Date(Date.now() - 365 * 86400000).toISOString();
      } else {
        // mtd — start of current month
        const now = new Date();
        fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      }

      // Allow explicit from/to overrides
      if (req.query["from"]) fromDate = req.query["from"] as string;
      if (req.query["to"]) toDate = req.query["to"] as string;

      // Use generate_series to fill zero-usage days
      const result = await pool.query(
        `SELECT
          gs.bucket,
          COALESCE(e.calls, 0) as calls,
          COALESCE(e.cost, 0) as cost,
          COALESCE(e.input_tokens, 0) as input_tokens,
          COALESCE(e.output_tokens, 0) as output_tokens,
          COALESCE(e.avg_duration_ms, 0) as avg_duration_ms
        FROM generate_series(
          date_trunc('${trunc}', $2::timestamptz),
          date_trunc('${trunc}', $3::timestamptz),
          '1 ${trunc}'::interval
        ) AS gs(bucket)
        LEFT JOIN (
          SELECT date_trunc('${trunc}', timestamp) as bucket,
            COUNT(*)::int as calls,
            SUM(cost_usd) as cost,
            SUM(input_tokens)::int as input_tokens,
            SUM(output_tokens)::int as output_tokens,
            AVG(duration_ms) as avg_duration_ms
          FROM events WHERE project_id = $1
            AND timestamp >= $2::timestamptz
            AND timestamp <= $3::timestamptz
          GROUP BY 1
        ) e ON e.bucket = gs.bucket
        ORDER BY gs.bucket ASC`,
        [projectId, fromDate, toDate],
      );

      // Per-model breakdown if requested
      let byModel: Record<string, Array<{ bucket: string; cost: number }>> | undefined;
      if (req.query["groupBy"] === "model") {
        const modelResult = await pool.query(
          `SELECT date_trunc('${trunc}', timestamp) as bucket,
            COALESCE(model, 'unknown') as model,
            COALESCE(SUM(cost_usd), 0) as cost
          FROM events WHERE project_id = $1
            AND timestamp >= $2::timestamptz
            AND timestamp <= $3::timestamptz
          GROUP BY 1, 2 ORDER BY 1`,
          [projectId, fromDate, toDate],
        );
        byModel = {};
        for (const row of modelResult.rows) {
          const m = row.model as string;
          if (!byModel[m]) byModel[m] = [];
          byModel[m].push({ bucket: row.bucket, cost: Number(row.cost) });
        }
      }

      res.json({ trends: result.rows, bucket, range, byModel });
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
          COALESCE(SUM(input_tokens), 0)::int as total_input_tokens,
          COALESCE(SUM(output_tokens), 0)::int as total_output_tokens,
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
          image_output_tokens,
          cost_usd, duration_ms, streaming, ttft, tps,
          call_site_raw, call_site_frames, context,
          bl_function, bl_file, bl_line
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
          COALESCE(SUM(input_tokens), 0)::int as total_input_tokens,
          COALESCE(SUM(output_tokens), 0)::int as total_output_tokens,
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
          SUM(total_input_tokens)::int as total_input_tokens,
          SUM(total_output_tokens)::int as total_output_tokens,
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

  // GET /api/v1/projects/:projectId/anomalies
  router.get("/api/v1/projects/:projectId/anomalies", async (req, res) => {
    try {
      const { projectId } = req.params;
      const includeResolved = req.query["resolved"] === "true";
      const includeDismissed = req.query["dismissed"] === "true";
      const anomalies = await getAnomalies(pool, projectId, includeResolved, includeDismissed);
      res.json({ anomalies });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/projects/:projectId/attribution-health
  // Surfaces how many recent events couldn't be attributed to a user
  // function + a best-guess cause, so the dashboard can suggest a concrete
  // action (almost always: upload sourcemaps).
  router.get("/api/v1/projects/:projectId/attribution-health", async (req, res) => {
    try {
      const { projectId } = req.params;
      const sinceHours = Math.min(
        168, // hard cap at 7 days
        Math.max(1, parseInt((req.query["hours"] as string) ?? "168", 10) || 168),
      );

      // Totals + attribution success rate
      const totalsResult = await pool.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE bl_function IS NOT NULL AND bl_function <> '') AS attributed,
           COUNT(*) FILTER (WHERE bl_function IS NULL OR bl_function = '') AS unattributed,
           COUNT(*) FILTER (WHERE call_site_frames IS NULL
                              OR jsonb_array_length(call_site_frames) = 0) AS no_frames
         FROM events
         WHERE project_id = $1
           AND timestamp >= NOW() - ($2::int * INTERVAL '1 hour')`,
        [projectId, sinceHours],
      );
      const totals = totalsResult.rows[0] ?? { total: 0, attributed: 0, unattributed: 0, no_frames: 0 };

      // Of the unattributed events, bucket by the "shape" of their raw frames
      // so we can suggest a targeted fix. We care specifically about Next.js
      // bundled paths (most common failure mode) because sourcemap upload
      // solves them directly.
      const shapeResult = await pool.query(
        `WITH unattributed AS (
           SELECT id, call_site_frames
           FROM events
           WHERE project_id = $1
             AND timestamp >= NOW() - ($2::int * INTERVAL '1 hour')
             AND (bl_function IS NULL OR bl_function = '')
             AND call_site_frames IS NOT NULL
             AND jsonb_array_length(call_site_frames) > 0
         )
         SELECT
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM jsonb_array_elements(call_site_frames) AS f
             WHERE f->>'fileName' LIKE '%.next/server/chunks/%'
                OR f->>'fileName' LIKE '%.next/static/chunks/%'
                OR f->>'fileName' LIKE '%.next/dev/server/chunks/%'
           )) AS bundled_nextjs,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM jsonb_array_elements(call_site_frames) AS f
             WHERE f->>'fileName' LIKE '%/webpack-internal%'
                OR f->>'fileName' LIKE 'webpack://%'
           )) AS bundled_webpack,
           COUNT(*) AS with_frames_but_unattributed
         FROM unattributed`,
        [projectId, sinceHours],
      );
      const shapes = shapeResult.rows[0] ?? { bundled_nextjs: 0, bundled_webpack: 0, with_frames_but_unattributed: 0 };

      // Has this project ever uploaded sourcemaps?
      const smResult = await pool.query(
        `SELECT COUNT(*)::int AS cnt,
                MAX(created_at) AS latest
         FROM sourcemaps WHERE project_id = $1`,
        [projectId],
      );
      const sourcemaps = smResult.rows[0] ?? { cnt: 0, latest: null };

      // Figure out the dominant cause + a concrete suggestion
      const total = Number(totals.total);
      const unattr = Number(totals.unattributed);
      const bundled = Number(shapes.bundled_nextjs) + Number(shapes.bundled_webpack);
      const noFrames = Number(totals.no_frames);
      const attrRate = total > 0 ? Number(totals.attributed) / total : 1;

      let primaryCause: "ok" | "bundled_needs_sourcemaps" | "no_frames" | "mixed" = "ok";
      let suggestion: string | null = null;
      if (unattr > 0 && attrRate < 0.9) {
        if (bundled >= unattr * 0.5) {
          primaryCause = "bundled_needs_sourcemaps";
          suggestion = sourcemaps.cnt > 0
            ? "Upload sourcemaps for your latest release so CostKey can translate bundled paths back to source."
            : "Your AI calls happen inside bundled JS chunks. Upload sourcemaps with `npx costkey sourcemaps upload` so we can attribute to your source files.";
        } else if (noFrames >= unattr * 0.5) {
          primaryCause = "no_frames";
          suggestion = "Some AI calls are reaching us with empty stack traces — likely from Edge runtime or restricted environments. Use `CostKey.withContext({ taskName: '...' })` at your route handlers to preserve semantic info.";
        } else {
          primaryCause = "mixed";
          suggestion = "Mixed attribution gaps. Upload sourcemaps for your release and add `CostKey.withContext` at entry points.";
        }
      }

      res.json({
        windowHours: sinceHours,
        totals: {
          total,
          attributed: Number(totals.attributed),
          unattributed: unattr,
          noFrames,
          attributionRate: Math.round(attrRate * 1000) / 1000,
        },
        unattributedBreakdown: {
          bundledNextjs: Number(shapes.bundled_nextjs),
          bundledWebpack: Number(shapes.bundled_webpack),
          withFramesButUnattributed: Number(shapes.with_frames_but_unattributed),
          noFrames,
        },
        sourcemaps: {
          uploaded: Number(sourcemaps.cnt),
          latestAt: sourcemaps.latest,
        },
        primaryCause,
        suggestion,
      });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/v1/projects/:projectId/anomalies/:anomalyId/dismiss
  router.post("/api/v1/projects/:projectId/anomalies/:anomalyId/dismiss", async (req, res) => {
    try {
      const { projectId, anomalyId } = req.params;
      const ok = await dismissAnomaly(pool, projectId, anomalyId);
      if (!ok) { res.status(404).json({ error: "Anomaly not found" }); return; }
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Project management (org-scoped, requires auth) ──

  // GET /api/v1/projects — list user's org's projects
  router.get("/api/v1/projects", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const visibleProjects = await listAccessibleProjects(pool, user, {
        includeAuthKey: roleCanManageWorkspace(user.role),
      });
      const visibleIds = visibleProjects.map((project) => project.id as string);
      const result = await pool.query(
        `SELECT p.id,
          COUNT(e.id) FILTER (WHERE COALESCE(e.event_type, 'call') = 'call')::int AS event_count,
          SUM(e.cost_usd) FILTER (WHERE COALESCE(e.event_type, 'call') = 'call' AND e.cost_usd IS NOT NULL) AS total_cost,
          COUNT(e.id) FILTER (WHERE COALESCE(e.event_type, 'call') = 'call' AND e.cost_usd IS NULL)::int AS unpriced_count
        FROM projects p LEFT JOIN events e ON e.project_id = p.id
        WHERE p.id = ANY($1::text[])
        GROUP BY p.id`,
        [visibleIds],
      );
      const stats = new Map(result.rows.map((row) => [row.id as string, row]));
      res.json({ projects: visibleProjects.map((project) => ({
        ...project,
        auth_key: project.auth_key ?? null,
        event_count: stats.get(project.id as string)?.event_count ?? 0,
        total_cost: stats.get(project.id as string)?.total_cost ?? null,
        unpriced_count: stats.get(project.id as string)?.unpriced_count ?? 0,
      })) });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/v1/projects — create new project
  router.post("/api/v1/projects", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can create projects" });
        return;
      }
      const { name } = req.body as { name: string };
      if (!name) {
        res.status(400).json({ error: "Missing project name" });
        return;
      }

      const id = `proj_${randomId()}`;
      const authKey = `ck_${randomId()}`;

      await pool.query(
        "INSERT INTO projects (id, name, org_id, auth_key) VALUES ($1, $2, $3, $4)",
        [id, name, user.orgId, authKey],
      );

      res.status(201).json({ id, name, authKey, dsn: projectDsn(authKey, id) });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/v1/projects/:projectId — rename project
  router.patch("/api/v1/projects/:projectId", async (req, res) => {
    try {
      const { projectId } = req.params;
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can rename projects" });
        return;
      }
      const { name } = req.body as { name?: string };
      if (!name) {
        res.status(400).json({ error: "Missing name" });
        return;
      }
      await pool.query("UPDATE projects SET name = $1 WHERE id = $2", [name, projectId]);
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/v1/projects/:projectId — delete project and all its data
  router.delete("/api/v1/projects/:projectId", async (req, res) => {
    try {
      const { projectId } = req.params;
      const user = (req as any).user;
      if (user.role !== "owner") {
        res.status(403).json({ error: "Only org owners can delete projects" });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM call_site_stats WHERE project_id = $1", [projectId]);
        await client.query("DELETE FROM events WHERE project_id = $1", [projectId]);
        await client.query("DELETE FROM alerts WHERE project_id = $1", [projectId]);
        await client.query("DELETE FROM projects WHERE id = $1", [projectId]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/v1/projects/:projectId/rotate-key — generate new API key
  router.post("/api/v1/projects/:projectId/rotate-key", async (req, res) => {
    try {
      const { projectId } = req.params;
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can rotate keys" });
        return;
      }

      const newKey = `ck_${randomId()}`;
      await pool.query("UPDATE projects SET auth_key = $1 WHERE id = $2", [newKey, projectId]);

      res.json({
        authKey: newKey,
        dsn: projectDsn(newKey, projectId),
      });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Custom Providers CRUD (session auth, dashboard) ──

  // GET /api/v1/projects/:projectId/providers — list custom providers
  router.get("/api/v1/projects/:projectId/providers", async (req, res) => {
    try {
      const { projectId } = req.params;
      const result = await pool.query(
        `SELECT id, name, hostname, usage_input_path, usage_output_path, model_path, enabled, created_at
        FROM custom_providers WHERE project_id = $1 ORDER BY created_at DESC`,
        [projectId],
      );
      res.json({ providers: result.rows });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/v1/projects/:projectId/providers — create custom provider
  router.post("/api/v1/projects/:projectId/providers", async (req, res) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can manage custom providers" });
        return;
      }
      const { projectId } = req.params;
      const { name, hostname, usageInputPath, usageOutputPath, modelPath } = req.body as {
        name?: string;
        hostname?: string;
        usageInputPath?: string;
        usageOutputPath?: string;
        modelPath?: string;
      };

      if (!name || !hostname) {
        res.status(400).json({ error: "Missing required fields: name, hostname" });
        return;
      }

      const id = `cp_${randomId()}`;
      await pool.query(
        `INSERT INTO custom_providers (id, project_id, name, hostname, usage_input_path, usage_output_path, model_path)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, projectId, name, hostname,
          usageInputPath ?? "usage.prompt_tokens",
          usageOutputPath ?? "usage.completion_tokens",
          modelPath ?? "model"],
      );

      res.status(201).json({ id, name, hostname, usageInputPath, usageOutputPath, modelPath, enabled: true });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/v1/projects/:projectId/providers/:providerId — update custom provider
  router.patch("/api/v1/projects/:projectId/providers/:providerId", async (req, res) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can manage custom providers" });
        return;
      }
      const { projectId, providerId } = req.params;
      const { name, hostname, usageInputPath, usageOutputPath, modelPath, enabled } = req.body as {
        name?: string;
        hostname?: string;
        usageInputPath?: string;
        usageOutputPath?: string;
        modelPath?: string;
        enabled?: boolean;
      };

      const sets: string[] = [];
      const vals: unknown[] = [];
      let idx = 1;

      if (name !== undefined) { sets.push(`name = $${idx++}`); vals.push(name); }
      if (hostname !== undefined) { sets.push(`hostname = $${idx++}`); vals.push(hostname); }
      if (usageInputPath !== undefined) { sets.push(`usage_input_path = $${idx++}`); vals.push(usageInputPath); }
      if (usageOutputPath !== undefined) { sets.push(`usage_output_path = $${idx++}`); vals.push(usageOutputPath); }
      if (modelPath !== undefined) { sets.push(`model_path = $${idx++}`); vals.push(modelPath); }
      if (enabled !== undefined) { sets.push(`enabled = $${idx++}`); vals.push(enabled); }

      if (sets.length === 0) {
        res.status(400).json({ error: "No fields to update" });
        return;
      }

      await pool.query(
        `UPDATE custom_providers SET ${sets.join(", ")} WHERE id = $${idx++} AND project_id = $${idx}`,
        [...vals, providerId, projectId],
      );

      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/v1/projects/:projectId/providers/:providerId — delete custom provider
  router.delete("/api/v1/projects/:projectId/providers/:providerId", async (req, res) => {
    try {
      const user = (req as any).user;
      if (user.role !== "owner" && user.role !== "admin") {
        res.status(403).json({ error: "Only owners and admins can manage custom providers" });
        return;
      }
      const { projectId, providerId } = req.params;
      await pool.query(
        "DELETE FROM custom_providers WHERE id = $1 AND project_id = $2",
        [providerId, projectId],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] API error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/v1/feedback — send feedback email
  router.post("/api/v1/feedback", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const body = (req.body ?? {}) as { message?: unknown; type?: unknown };
      if (typeof body.message !== "string" || !body.message.trim()) {
        res.status(400).json({ error: "Message is required" });
        return;
      }
      if (body.message.length > 4_000) {
        res.status(413).json({ error: "Message is too large" });
        return;
      }
      const type = typeof body.type === "string" && /^[a-z0-9 _-]{1,40}$/i.test(body.type.trim())
        ? body.type.trim()
        : "feedback";
      if (body.type !== undefined && type === "feedback" && body.type !== "feedback") {
        res.status(400).json({ error: "Invalid feedback type" });
        return;
      }

      const fromName = user?.name ?? "Anonymous";
      const fromEmail = user?.email ?? "unknown";
      const feedbackType = type;
      const safeName = escapeHtml(fromName);
      const safeEmail = escapeHtml(fromEmail);
      const safeType = escapeHtml(feedbackType);
      const safeMessage = escapeHtml(body.message);

      await getResend().emails.send({
        from: "CostKey <noreply@costkey.dev>",
        to: "naman@costkey.dev",
        subject: `[CostKey ${feedbackType}] from ${String(fromName).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120)}`,
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:500px;padding:20px">
            <p><strong>From:</strong> ${safeName} (${safeEmail})</p>
            <p><strong>Type:</strong> ${safeType}</p>
            <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
            <p style="white-space:pre-wrap">${safeMessage}</p>
          </div>
        `,
      });

      // Do not put user email/message content into application logs. The
      // authenticated subject is sufficient for operational correlation.
      console.log(`[costkey] Feedback from user ${String(user?.id ?? "unknown")}: ${feedbackType}`);
      res.json({ ok: true });
    } catch (err) {
      console.error("[costkey] Feedback error:", err);
      res.status(500).json({ error: "Failed to send feedback" });
    }
  });

  // ── Insights: aggregated views by module, context, and service ──

  // GET /api/v1/projects/:projectId/insights
  router.get("/api/v1/projects/:projectId/insights", async (req, res) => {
    try {
      const { projectId } = req.params;
      const range = (req.query["range"] as string) ?? "30d";

      // Calculate time bounds
      const rangeMap: Record<string, string> = {
        "7d": "7 days", "30d": "30 days", "mtd": "0 days",
        "3m": "3 months", "6m": "6 months", "1y": "1 year",
      };
      const interval = rangeMap[range] ?? "30 days";
      const timeClause = range === "mtd"
        ? "AND timestamp >= date_trunc('month', NOW())"
        : `AND timestamp >= NOW() - INTERVAL '${interval}'`;
      const prevTimeClause = range === "mtd"
        ? "AND timestamp >= date_trunc('month', NOW() - INTERVAL '1 month') AND timestamp < date_trunc('month', NOW())"
        : `AND timestamp >= NOW() - INTERVAL '${interval}' - INTERVAL '${interval}' AND timestamp < NOW() - INTERVAL '${interval}'`;

      // 1. Module rollup: group by directory extracted from bl_file
      const moduleResult = await pool.query(
        `SELECT
          CASE
            WHEN bl_file IS NULL OR bl_file = '' THEN '(unknown)'
            WHEN bl_file LIKE '%/%' THEN substring(bl_file from '^(.*/)[^/]+$')
            ELSE bl_file
          END as module,
          COUNT(*)::int as calls,
          COALESCE(SUM(cost_usd), 0) as cost,
          COALESCE(SUM(COALESCE(total_tokens, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))), 0)::bigint as tokens,
          COUNT(DISTINCT bl_function) as functions
        FROM events WHERE project_id = $1 ${timeClause}
        GROUP BY module
        ORDER BY cost DESC
        LIMIT 20`,
        [projectId],
      );

      // 2. Module trends: daily cost per top 5 modules
      const topModules = moduleResult.rows.slice(0, 5).map((r: any) => r.module);
      let moduleTrends: any[] = [];
      if (topModules.length > 0) {
        const moduleTrendsResult = await pool.query(
          `SELECT
            date_trunc('day', timestamp)::date as day,
            CASE
              WHEN bl_file IS NULL OR bl_file = '' THEN '(unknown)'
              WHEN bl_file LIKE '%/%' THEN substring(bl_file from '^(.*/)[^/]+$')
              ELSE bl_file
            END as module,
            COALESCE(SUM(cost_usd), 0) as cost,
            COUNT(*)::int as calls
          FROM events WHERE project_id = $1 ${timeClause}
          GROUP BY day, module
          HAVING CASE
            WHEN bl_file IS NULL OR bl_file = '' THEN '(unknown)'
            WHEN bl_file LIKE '%/%' THEN substring(bl_file from '^(.*/)[^/]+$')
            ELSE bl_file
          END = ANY($2)
          ORDER BY day`,
          [projectId, topModules],
        );
        moduleTrends = moduleTrendsResult.rows;
      }

      // 3. Context rollup: group by each context key
      const contextResult = await pool.query(
        `SELECT
          key as context_key,
          value as context_value,
          COUNT(*)::int as calls,
          COALESCE(SUM(cost_usd), 0) as cost,
          COALESCE(SUM(COALESCE(total_tokens, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))), 0)::bigint as tokens
        FROM events, jsonb_each_text(context) AS kv(key, value)
        WHERE project_id = $1 ${timeClause}
          AND context IS NOT NULL AND context != '{}'::jsonb
          AND key NOT IN ('traceId', 'traceName')
        GROUP BY key, value
        ORDER BY cost DESC
        LIMIT 50`,
        [projectId],
      );

      // Group context results by key
      const contextByKey: Record<string, any[]> = {};
      for (const row of contextResult.rows) {
        const key = row.context_key;
        if (!contextByKey[key]) contextByKey[key] = [];
        contextByKey[key].push({
          value: row.context_value,
          calls: row.calls,
          cost: parseFloat(row.cost),
          tokens: parseInt(row.tokens),
        });
      }

      // 4. Function hotspots: top functions with current vs previous period cost
      const hotspotsResult = await pool.query(
        `SELECT
          bl_function as function,
          bl_file as file,
          COUNT(*)::int as calls,
          COALESCE(SUM(cost_usd), 0) as cost,
          COALESCE(AVG(cost_usd), 0) as avg_cost,
          COALESCE(SUM(COALESCE(total_tokens, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))), 0)::bigint as tokens
        FROM events WHERE project_id = $1 ${timeClause}
          AND bl_function IS NOT NULL AND bl_function != ''
        GROUP BY bl_function, bl_file
        ORDER BY cost DESC
        LIMIT 15`,
        [projectId],
      );

      // Previous period for comparison
      const prevHotspotsResult = await pool.query(
        `SELECT
          bl_function as function,
          bl_file as file,
          COALESCE(SUM(cost_usd), 0) as cost,
          COUNT(*)::int as calls
        FROM events WHERE project_id = $1 ${prevTimeClause}
          AND bl_function IS NOT NULL AND bl_function != ''
        GROUP BY bl_function, bl_file`,
        [projectId],
      );

      const prevCostMap = new Map<string, { cost: number; calls: number }>();
      for (const row of prevHotspotsResult.rows) {
        prevCostMap.set(`${row.file}:${row.function}`, {
          cost: parseFloat(row.cost),
          calls: row.calls,
        });
      }

      const hotspots = hotspotsResult.rows.map((row: any) => {
        const key = `${row.file}:${row.function}`;
        const prev = prevCostMap.get(key);
        const cost = parseFloat(row.cost);
        const prevCost = prev?.cost ?? 0;
        const costChange = prevCost > 0 ? ((cost - prevCost) / prevCost) * 100 : null;
        return {
          function: row.function,
          file: row.file,
          calls: row.calls,
          cost,
          avgCost: parseFloat(row.avg_cost),
          tokens: parseInt(row.tokens),
          prevCost,
          costChange,
        };
      });

      // 5. Overall totals for this period
      const totalResult = await pool.query(
        `SELECT
          COUNT(*)::int as calls,
          COALESCE(SUM(cost_usd), 0) as cost,
          COALESCE(SUM(COALESCE(total_tokens, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))), 0)::bigint as tokens
        FROM events WHERE project_id = $1 ${timeClause}`,
        [projectId],
      );

      res.json({
        range,
        totals: {
          calls: totalResult.rows[0].calls,
          cost: parseFloat(totalResult.rows[0].cost),
          tokens: parseInt(totalResult.rows[0].tokens),
        },
        modules: moduleResult.rows.map((r: any) => ({
          module: r.module,
          calls: r.calls,
          cost: parseFloat(r.cost),
          tokens: parseInt(r.tokens),
          functions: r.functions,
        })),
        moduleTrends: moduleTrends.map((r: any) => ({
          day: r.day,
          module: r.module,
          cost: parseFloat(r.cost),
          calls: r.calls,
        })),
        context: contextByKey,
        hotspots,
      });
    } catch (err) {
      console.error("[costkey] Insights error:", err);
      res.status(500).json({ error: "Failed to fetch insights" });
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

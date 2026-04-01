import type { Router } from "express";
import { Router as createRouter } from "express";
import type Database from "better-sqlite3";
import type { CostKeyEvent, TransportPayload } from "@costkey/shared";

export function createIngestRouter(db: Database.Database): Router {
  const router = createRouter();

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (
      id, timestamp, project_id, provider, model, url, method, status_code,
      input_tokens, output_tokens, total_tokens, reasoning_tokens,
      cache_read_tokens, cache_creation_tokens,
      cost_usd, duration_ms, streaming,
      ttft, tps, stream_duration, chunk_count,
      call_site_raw, call_site_frames,
      trace_id, trace_name,
      context, request_body, response_body
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?
    )
  `);

  const upsertCallSite = db.prepare(`
    INSERT INTO call_site_stats (
      project_id, call_site_key, file_name, function_name, line_number,
      provider, model,
      total_calls, total_cost_usd, total_input_tokens, total_output_tokens,
      avg_duration_ms, avg_ttft, avg_tps,
      first_seen, last_seen
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?,
      1, ?, ?, ?,
      ?, ?, ?,
      ?, ?
    )
    ON CONFLICT(project_id, call_site_key, model) DO UPDATE SET
      total_calls = total_calls + 1,
      total_cost_usd = total_cost_usd + excluded.total_cost_usd,
      total_input_tokens = total_input_tokens + excluded.total_input_tokens,
      total_output_tokens = total_output_tokens + excluded.total_output_tokens,
      avg_duration_ms = (avg_duration_ms * total_calls + excluded.avg_duration_ms) / (total_calls + 1),
      avg_ttft = CASE
        WHEN excluded.avg_ttft IS NOT NULL
        THEN COALESCE((avg_ttft * total_calls + excluded.avg_ttft) / (total_calls + 1), excluded.avg_ttft)
        ELSE avg_ttft
      END,
      avg_tps = CASE
        WHEN excluded.avg_tps IS NOT NULL
        THEN COALESCE((avg_tps * total_calls + excluded.avg_tps) / (total_calls + 1), excluded.avg_tps)
        ELSE avg_tps
      END,
      last_seen = excluded.last_seen
  `);

  const insertBatch = db.transaction((events: CostKeyEvent[], projectId: string) => {
    for (const event of events) {
      insertEvent.run(
        event.id,
        event.timestamp,
        projectId,
        event.provider,
        event.model,
        event.url,
        event.method,
        event.statusCode,
        event.usage?.inputTokens,
        event.usage?.outputTokens,
        event.usage?.totalTokens,
        event.usage?.reasoningTokens,
        event.usage?.cacheReadTokens,
        event.usage?.cacheCreationTokens,
        event.costUsd,
        event.durationMs,
        event.streaming ? 1 : 0,
        event.streamTiming?.ttft,
        event.streamTiming?.tps,
        event.streamTiming?.streamDuration,
        event.streamTiming?.chunkCount,
        event.callSite?.raw ?? null,
        event.callSite ? JSON.stringify(event.callSite.frames) : null,
        event.context?.traceId ?? null,
        event.context?.traceName ?? null,
        event.context ? JSON.stringify(event.context) : null,
        event.requestBody ? JSON.stringify(event.requestBody) : null,
        event.responseBody ? JSON.stringify(event.responseBody) : null,
      );

      // Update call site aggregations
      if (event.callSite && event.callSite.frames.length > 0) {
        const topFrame = event.callSite.frames[0];
        const key = `${topFrame.fileName ?? "unknown"}:${topFrame.functionName ?? "anonymous"}:${topFrame.lineNumber ?? 0}`;

        upsertCallSite.run(
          projectId,
          key,
          topFrame.fileName,
          topFrame.functionName,
          topFrame.lineNumber,
          event.provider,
          event.model,
          event.costUsd ?? 0,
          event.usage?.inputTokens ?? 0,
          event.usage?.outputTokens ?? 0,
          event.durationMs,
          event.streamTiming?.ttft ?? null,
          event.streamTiming?.tps ?? null,
          event.timestamp,
          event.timestamp,
        );
      }
    }
  });

  // POST /api/v1/events — main SDK ingest endpoint
  router.post("/api/v1/events", (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Missing or invalid authorization" });
        return;
      }

      const authKey = authHeader.slice(7);

      // Look up project by auth key
      const project = db
        .prepare("SELECT id FROM projects WHERE auth_key = ?")
        .get(authKey) as { id: string } | undefined;

      if (!project) {
        res.status(401).json({ error: "Invalid auth key" });
        return;
      }

      const payload = req.body as TransportPayload;

      if (!payload.events || !Array.isArray(payload.events)) {
        res.status(400).json({ error: "Invalid payload: missing events array" });
        return;
      }

      if (payload.events.length > 200) {
        res.status(413).json({ error: "Too many events in batch (max 200)" });
        return;
      }

      insertBatch(payload.events, project.id);

      res.status(202).json({
        accepted: payload.events.length,
      });
    } catch (err) {
      console.error("[costkey] Ingest error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

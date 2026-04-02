import type { Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import type { CostKeyEvent, TransportPayload, StackFrame } from "@costkey/shared";
import { computeCost } from "./pricing.js";

/**
 * Server-side stack frame filtering.
 * Strips AI SDK internals, HTTP clients, language runtime frames
 * so only user application code remains — works for ANY SDK language.
 */
/** File path patterns for internal/library frames */
const INTERNAL_FILE_PATTERNS = [
  // Python AI SDK internals
  "site-packages/anthropic/",
  "site-packages/openai/",
  "site-packages/google/",
  "site-packages/cohere/",
  "site-packages/mistralai/",
  "site-packages/groq/",
  "site-packages/together/",
  "site-packages/deepseek/",
  // Python HTTP clients
  "site-packages/httpx/",
  "site-packages/httpcore/",
  "site-packages/requests/",
  "site-packages/urllib3/",
  "site-packages/aiohttp/",
  // Python runtime / stdlib
  "/lib/python",
  "threading.py",
  "asyncio/",
  "concurrent/futures/",
  "_bootstrap",
  "importlib",
  // Node.js AI SDK internals
  "node_modules/openai/",
  "node_modules/@anthropic-ai/",
  "node_modules/@google/generative-ai/",
  "node_modules/cohere-ai/",
  // Node.js HTTP / runtime
  "node_modules/undici/",
  "node_modules/node-fetch/",
  "node:internal/",
  "node:async_hooks",
  // CostKey SDK internals
  "costkey/packages/sdk/",
  "node_modules/costkey/",
  "site-packages/costkey/",
];

/** Function name patterns that indicate library internals (Python SDK methods) */
const INTERNAL_FN_PATTERNS = [
  "self._client.send",
  "self._post",
  "self._request",
  "self.__request",
  "_base_client",
  "._post(",
  "._get(",
  "._put(",
  "._patch(",
  "._delete(",
  "._request(",
  "_send_single_request",
  "_send_handling",
  "_send",
  "wrapper return func(",
];

function filterFrames(frames: StackFrame[]): StackFrame[] {
  const filtered = frames.filter((frame) => {
    const file = frame.fileName ?? "";
    const fn = frame.functionName ?? "";
    if (!file && !fn) return false;
    // Check file path patterns
    if (INTERNAL_FILE_PATTERNS.some((p) => file.includes(p))) return false;
    // Check function name patterns
    if (INTERNAL_FN_PATTERNS.some((p) => fn.includes(p))) return false;
    return true;
  });
  return filtered.length > 0 ? filtered : frames;
}

export function createIngestRouter(pool: pg.Pool): Router {
  const router = createRouter();

  // POST /api/v1/events — main SDK ingest endpoint
  router.post("/api/v1/events", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Missing or invalid authorization" });
        return;
      }

      const authKey = authHeader.slice(7);
      const projResult = await pool.query(
        "SELECT id FROM projects WHERE auth_key = $1",
        [authKey],
      );

      if (projResult.rows.length === 0) {
        res.status(401).json({ error: "Invalid auth key" });
        return;
      }

      const projectId = projResult.rows[0].id;
      const payload = req.body as TransportPayload;

      if (!payload.events || !Array.isArray(payload.events)) {
        res.status(400).json({ error: "Invalid payload: missing events array" });
        return;
      }

      if (payload.events.length > 200) {
        res.status(413).json({ error: "Too many events in batch (max 200)" });
        return;
      }

      // Batch insert events
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        for (const event of payload.events) {
          // Server-side cost calculation — authoritative source
          const costUsd = computeCost(
            event.model,
            event.usage?.inputTokens ?? null,
            event.usage?.outputTokens ?? null,
            event.usage?.cacheReadTokens ?? null,
            event.usage?.cacheCreationTokens ?? null,
          ) ?? event.costUsd ?? null; // Fall back to SDK-calculated cost if server can't resolve

          // Filter stack frames server-side (strips SDK/library internals for all languages)
          const cleanFrames = event.callSite?.frames
            ? filterFrames(event.callSite.frames)
            : null;

          await client.query(
            `INSERT INTO events (
              id, timestamp, project_id, provider, model, url, method, status_code,
              input_tokens, output_tokens, total_tokens, reasoning_tokens,
              cache_read_tokens, cache_creation_tokens,
              cost_usd, duration_ms, streaming,
              ttft, tps, stream_duration, chunk_count,
              call_site_raw, call_site_frames,
              trace_id, trace_name, context, request_body, response_body
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
            ON CONFLICT (id) DO NOTHING`,
            [
              event.id, event.timestamp, projectId,
              event.provider, event.model, event.url, event.method, event.statusCode,
              event.usage?.inputTokens, event.usage?.outputTokens,
              event.usage?.totalTokens, event.usage?.reasoningTokens,
              event.usage?.cacheReadTokens, event.usage?.cacheCreationTokens,
              costUsd, event.durationMs, event.streaming,
              event.streamTiming?.ttft, event.streamTiming?.tps,
              event.streamTiming?.streamDuration, event.streamTiming?.chunkCount,
              event.callSite?.raw ?? null,
              cleanFrames ? JSON.stringify(cleanFrames) : null,
              event.context?.traceId ?? null,
              event.context?.traceName ?? null,
              event.context ? JSON.stringify(event.context) : null,
              event.requestBody ? JSON.stringify(event.requestBody) : null,
              event.responseBody ? JSON.stringify(event.responseBody) : null,
            ],
          );

          // Upsert call site stats (use filtered frames)
          if (cleanFrames && cleanFrames.length > 0) {
            const f = cleanFrames[0];
            const key = `${f.fileName ?? "unknown"}:${f.functionName ?? "anonymous"}:${f.lineNumber ?? 0}`;

            await client.query(
              `INSERT INTO call_site_stats (
                project_id, call_site_key, file_name, function_name, line_number,
                provider, model,
                total_calls, total_cost_usd, total_input_tokens, total_output_tokens,
                avg_duration_ms, avg_ttft, avg_tps, first_seen, last_seen
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,$14,$14)
              ON CONFLICT (project_id, call_site_key, model) DO UPDATE SET
                total_calls = call_site_stats.total_calls + 1,
                total_cost_usd = call_site_stats.total_cost_usd + EXCLUDED.total_cost_usd,
                total_input_tokens = call_site_stats.total_input_tokens + EXCLUDED.total_input_tokens,
                total_output_tokens = call_site_stats.total_output_tokens + EXCLUDED.total_output_tokens,
                avg_duration_ms = (call_site_stats.avg_duration_ms * call_site_stats.total_calls + EXCLUDED.avg_duration_ms) / (call_site_stats.total_calls + 1),
                avg_ttft = CASE WHEN EXCLUDED.avg_ttft IS NOT NULL
                  THEN COALESCE((call_site_stats.avg_ttft * call_site_stats.total_calls + EXCLUDED.avg_ttft) / (call_site_stats.total_calls + 1), EXCLUDED.avg_ttft)
                  ELSE call_site_stats.avg_ttft END,
                avg_tps = CASE WHEN EXCLUDED.avg_tps IS NOT NULL
                  THEN COALESCE((call_site_stats.avg_tps * call_site_stats.total_calls + EXCLUDED.avg_tps) / (call_site_stats.total_calls + 1), EXCLUDED.avg_tps)
                  ELSE call_site_stats.avg_tps END,
                last_seen = EXCLUDED.last_seen`,
              [
                projectId, key, f.fileName, f.functionName, f.lineNumber,
                event.provider, event.model,
                costUsd ?? 0,
                event.usage?.inputTokens ?? 0, event.usage?.outputTokens ?? 0,
                event.durationMs,
                event.streamTiming?.ttft ?? null,
                event.streamTiming?.tps ?? null,
                event.timestamp,
              ],
            );
          }
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      res.status(202).json({ accepted: payload.events.length });
    } catch (err) {
      console.error("[costkey] Ingest error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

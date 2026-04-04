import type { Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import type { CostKeyEvent, TransportPayload, StackFrame } from "@costkey/shared";
import { computeCost } from "./pricing.js";
import { translateFrames } from "./sourcemap-resolver.js";

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
  "node_modules/@google/genai/",
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

/** Function name patterns that indicate library internals (Python/Node SDK methods) */
const INTERNAL_FN_PATTERNS = [
  // Anthropic Python SDK
  "self._client.send",
  "self._post",
  "self._request",
  "self.__request",
  "_base_client",
  // OpenAI Python SDK
  "self._client._request",
  "_legacy_response",
  "APIRequestor",
  // Generic HTTP client patterns
  "._post(",
  "._get(",
  "._put(",
  "._patch(",
  "._delete(",
  "._request(",
  "_send_single_request",
  "_send_handling",
  "_send(",
  // Python decorators / wrappers
  "wrapper return func(",
  "decorator",
  // Google SDK
  "generate_content",
  "_generate_content",
  // General patterns
  "<module>",
  "<anonymous>",
  "run_until_complete",
  "_run_once",
];

export function filterFrames(frames: StackFrame[]): StackFrame[] {
  const filtered = frames.filter((frame) => {
    const file = frame.fileName ?? "";
    const fn = frame.functionName ?? "";
    if (!file && !fn) return false;
    if (INTERNAL_FILE_PATTERNS.some((p) => file.includes(p))) return false;
    if (INTERNAL_FN_PATTERNS.some((p) => fn.includes(p))) return false;
    return true;
  });
  return filtered.length > 0 ? filtered : frames;
}

/**
 * Find the most meaningful "business logic" frame from in-app frames.
 *
 * Real stack traces look like:
 *   [0] _messages_create_with_backoff  at anthropic_client.py  ← wrapper
 *   [1] call_haiku                     at anthropic_client.py  ← wrapper (same file)
 *   [2] _process_file_group            at stage2_haiku.py      ← BUSINESS LOGIC
 *   [3] run_pipeline                   at orchestrator.py      ← orchestrator
 *   [4] _run                           at main.py              ← entry point
 *
 * Algorithm:
 * 1. Filter out useless names (<module>, <anonymous>, main, _run)
 * 2. Find the first frame from a DIFFERENT FILE than frame[0]
 *    → This skips all wrappers in the same client file
 *    → The first different file is always the caller = business logic
 * 3. If all same file, use frame[0]
 */
/**
 * Function names that are universally wrappers — never business logic.
 * These get skipped when picking the business logic frame.
 * Only function names, not file paths (too aggressive).
 */
const WRAPPER_FN_NAMES = new Set([
  "retry", "withretry", "withbackoff", "callwithretry",
  "withretries", "retrywithtimeout", "retrywithbackoff",
  "ratelimit", "ratelimitcheck", "withratelimit",
  "withcache", "cached", "memoized",
  "wrapasync", "wrapfn", "decorator",
]);

function isWrapperFn(frame: StackFrame): boolean {
  const fn = (frame.functionName ?? "").split("\n")[0].trim().toLowerCase();
  return WRAPPER_FN_NAMES.has(fn);
}

export function findBusinessLogicFrame(frames: StackFrame[]): StackFrame {
  if (frames.length === 0) return frames[0];

  // Filter out useless names
  const useless = new Set(["<module>", "<anonymous>", "anonymous", "main", "_run", ""]);
  const meaningful = frames.filter((f) => {
    const fn = (f.functionName ?? "").split("\n")[0].trim();
    return fn && !useless.has(fn);
  });

  const pool = meaningful.length > 0 ? meaningful : frames;
  if (pool.length <= 1) return pool[0];

  // Find first frame from a different file, skipping known wrapper functions
  const innerFile = pool[0].fileName ?? "";
  for (let i = 1; i < pool.length; i++) {
    const file = pool[i].fileName ?? "";
    if (file && file !== innerFile && !isWrapperFn(pool[i])) return pool[i];
  }

  // Fallback: first frame from a different file (even if wrapper)
  for (let i = 1; i < pool.length; i++) {
    const file = pool[i].fileName ?? "";
    if (file && file !== innerFile) return pool[i];
  }

  // All same file — use frame[1] (caller of the wrapper)
  return pool.length >= 2 ? pool[1] : pool[0];
}

// ─── Call Graph Cache ────────────────────────────────────────────────
export const callGraphCache = new Map<string, Record<string, { score: number; fan_in: number; calls_ai: boolean; line: number }>>();

/**
 * Find the best business-logic frame using call graph data.
 * Matches frames against graph keys by suffix-matching file paths and function names.
 * Picks the frame with the LOWEST score (most business-logic-like).
 * Falls back to findBusinessLogicFrame if no matches found.
 */
export function findBusinessLogicFrameWithGraph(
  frames: StackFrame[],
  graph: Record<string, { score: number; fan_in: number; calls_ai: boolean }>,
): StackFrame {
  let bestFrame: StackFrame | null = null;
  let bestScore = Infinity;

  const graphKeys = Object.keys(graph);

  for (const frame of frames) {
    const frameFile = frame.fileName ?? "";
    const frameFn = (frame.functionName ?? "").split("\n")[0].trim();
    if (!frameFile && !frameFn) continue;

    for (const key of graphKeys) {
      // Graph keys are typically "file:function" or just file paths
      // Try to extract file and function parts
      const lastColon = key.lastIndexOf(":");
      let graphFile: string;
      let graphFn: string;
      if (lastColon > 0) {
        graphFile = key.slice(0, lastColon);
        graphFn = key.slice(lastColon + 1);
      } else {
        graphFile = key;
        graphFn = "";
      }

      // Match: frame fileName ends with graph key's file part
      const fileMatches = frameFile.endsWith(graphFile) || graphFile.endsWith(frameFile) ||
        (frameFile && graphFile && (
          frameFile.endsWith("/" + graphFile) || graphFile.endsWith("/" + frameFile)
        ));

      // Function names match (if graph has one)
      const fnMatches = !graphFn || frameFn === graphFn || frameFn.endsWith(graphFn);

      if (fileMatches && fnMatches) {
        const entry = graph[key];
        if (entry.score < bestScore) {
          bestScore = entry.score;
          bestFrame = frame;
        }
      }
    }
  }

  return bestFrame ?? findBusinessLogicFrame(frames);
}

/**
 * Load call graph cache from database. Called on startup.
 */
export async function loadCallGraphCache(pool: import("pg").Pool): Promise<void> {
  const cgResult = await pool.query("SELECT project_id, graph_data FROM call_graphs");
  for (const row of cgResult.rows) {
    callGraphCache.set(row.project_id, typeof row.graph_data === 'string' ? JSON.parse(row.graph_data) : row.graph_data);
  }
  console.log(`[costkey] Loaded ${cgResult.rows.length} call graphs`);
}

/** Max stored body size (100KB). Truncates large prompts/completions to avoid DB bloat. */
const MAX_BODY_BYTES = 100_000;

export function truncateBody(body: unknown): string | null {
  if (!body) return null;
  const json = JSON.stringify(body);
  if (json.length <= MAX_BODY_BYTES) return json;
  // Truncate and add marker
  return json.slice(0, MAX_BODY_BYTES) + '..."[TRUNCATED]"}';
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
      const release = payload.release ?? null;

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
          let cleanFrames = event.callSite?.frames
            ? filterFrames(event.callSite.frames)
            : null;

          // Translate minified frames using sourcemaps (if release + maps uploaded)
          if (cleanFrames && release) {
            try {
              const { translated, wasTranslated } = await translateFrames(
                pool, projectId, release, cleanFrames,
              );
              if (wasTranslated) cleanFrames = translated;
            } catch {
              // Sourcemap translation failure is non-fatal
            }
          }

          await client.query(
            `INSERT INTO events (
              id, timestamp, project_id, provider, model, url, method, status_code,
              input_tokens, output_tokens, total_tokens, reasoning_tokens,
              cache_read_tokens, cache_creation_tokens,
              cost_usd, duration_ms, streaming,
              ttft, tps, stream_duration, chunk_count,
              call_site_raw, call_site_frames,
              trace_id, trace_name, context, request_body, response_body, release
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
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
              truncateBody(event.requestBody),
              truncateBody(event.responseBody),
              release,
            ],
          );

          // Upsert call site stats — find the best "business logic" frame
          // Strategy: frame[0] is the direct API caller (usually a wrapper).
          // Walk up until we find a frame from a DIFFERENT file — that's the
          // business logic that actually matters. Works universally without
          // fragile function-name heuristics.
          if (cleanFrames && cleanFrames.length > 0) {
            const graph = callGraphCache.get(projectId);
            const f = graph
              ? findBusinessLogicFrameWithGraph(cleanFrames, graph)
              : findBusinessLogicFrame(cleanFrames);
            const cleanFn = (f.functionName ?? "anonymous").split("\n")[0].trim();
            const key = `${f.fileName ?? "unknown"}:${cleanFn}:${f.lineNumber ?? 0}`;
            const eventModel = event.model ?? "unknown"; // model is part of PK, can't be null

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
                projectId, key, f.fileName, cleanFn, f.lineNumber,
                event.provider, eventModel,
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

  // POST /api/v1/projects/:projectId/callgraph — upload call graph data
  router.post("/api/v1/projects/:projectId/callgraph", async (req, res) => {
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

      // Verify projectId in URL matches the auth key's project
      if (projectId !== req.params["projectId"]) {
        res.status(403).json({ error: "Auth key does not match project" });
        return;
      }

      const { functions, sdk_version } = req.body as { functions?: Record<string, unknown>; sdk_version?: string };
      if (!functions || typeof functions !== "object") {
        res.status(400).json({ error: "Invalid payload: missing functions object" });
        return;
      }

      // Upsert into call_graphs table
      await pool.query(
        `INSERT INTO call_graphs (project_id, graph_data, sdk_version)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id) DO UPDATE SET
           graph_data = EXCLUDED.graph_data,
           sdk_version = EXCLUDED.sdk_version,
           uploaded_at = NOW()`,
        [projectId, JSON.stringify(functions), sdk_version ?? null],
      );

      // Update in-memory cache
      callGraphCache.set(projectId, functions as Record<string, { score: number; fan_in: number; calls_ai: boolean; line: number }>);

      res.status(200).json({ accepted: Object.keys(functions).length });
    } catch (err) {
      console.error("[costkey] Call graph upload error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

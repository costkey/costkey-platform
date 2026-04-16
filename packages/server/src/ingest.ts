import type { Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import type { CostKeyEvent, TransportPayload, StackFrame } from "@costkey/shared";
import { computeCost } from "./pricing.js";
import { translateFrames } from "./sourcemap-resolver.js";
import { updateFrameStatsBatch, getImplicitGraph, invalidateImplicitGraph } from "./implicit-graph.js";

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
  // Python runtime / stdlib — see special handling in filterFrames
  // "/lib/python" is checked separately to exclude site-packages paths
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
  "node:events",
  "node:timers",
  // Frameworks
  ".next/",
  "node_modules/next/",
  "node_modules/express/",
  "node_modules/fastify/",
  "node_modules/hono/",
  "node_modules/koa/",
  "node_modules/@vercel/",
  "node_modules/@opentelemetry/",
  // CostKey SDK internals
  "costkey/packages/sdk/",
  "node_modules/costkey/",
  "site-packages/costkey/",
  // Webpack/Turbopack bundles the SDK into a single chunk where the original
  // node_modules path is encoded into the FILENAME (not a directory). The
  // node_modules/costkey/ pattern above misses these. Catch them by name.
  "node_modules_costkey",
  "_costkey_dist",
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
  // CostKey SDK patched fetch — V8 names it `G.globalThis.fetch` after webpack
  // minification. Guarantees we never attribute to ourselves even if the file
  // path check fails to recognize a new bundler output layout.
  "G.globalThis.fetch",
  // Future-proof marker for when the SDK starts naming its patched fetch
  // explicitly (e.g. __ck_patched_fetch__).
  "__ck_",
];

export function filterFrames(frames: StackFrame[]): StackFrame[] {
  const filtered = frames.filter((frame) => {
    const file = frame.fileName ?? "";
    const fn = frame.functionName ?? "";
    if (!file && !fn) return false;
    if (INTERNAL_FILE_PATTERNS.some((p) => file.includes(p))) return false;
    if (INTERNAL_FN_PATTERNS.some((p) => fn.includes(p))) return false;
    // Python stdlib: /lib/pythonX.Y/foo.py but NOT /lib/pythonX.Y/site-packages/
    if (file.includes("/lib/python") && !file.includes("site-packages")) return false;
    return true;
  });
  // Intentional: when every frame is internal (SDK/framework/runtime), return
  // an empty array instead of falling back to the raw stack. Downstream
  // findBusinessLogicFrame → undefined → bl_function stays null.
  //
  // The prior fallback caused catastrophic misattribution for webpack/serverless
  // deployments where the user's code is bundled so deeply that it never appears
  // in a 10-frame stack trace. We'd attribute costs to our own SDK's patched
  // fetch or the user's framework internals. Honest "unknown" beats loud wrong.
  return filtered;
}

/**
 * Get context about what filterFrames removed.
 * Returns the file of the innermost filtered frame (the SDK call),
 * used by findBusinessLogicFrame to decide if frame[0] was adjacent to the SDK.
 */
export function getFilterContext(original: StackFrame[], filtered: StackFrame[]): {
  /** Files that were removed by filtering */
  removedFiles: Set<string>;
  /** Was the innermost filtered frame[0] adjacent to the first surviving frame? */
  frame0WasAdjacentToSDK: boolean;
} {
  const kept = new Set(filtered.map(f => f.fileName ?? ""));
  const removedFiles = new Set<string>();
  for (const f of original) {
    const file = f.fileName ?? "";
    if (file && !kept.has(file)) removedFiles.add(file);
  }

  // Check adjacency: was the first surviving frame directly next to a filtered frame?
  let frame0WasAdjacentToSDK = false;
  if (filtered.length > 0 && removedFiles.size > 0) {
    const firstSurvivor = filtered[0];
    for (let i = 0; i < original.length; i++) {
      if (original[i] === firstSurvivor) {
        // Check if the frame before this one was filtered
        if (i > 0) {
          const prevFile = original[i - 1].fileName ?? "";
          if (removedFiles.has(prevFile)) frame0WasAdjacentToSDK = true;
        }
        break;
      }
    }
  }

  return { removedFiles, frame0WasAdjacentToSDK };
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
  "execute", "invoke", "call",
  "middleware", "pipe", "compose",
  "intercept", "proxy", "delegate",
  "runwithtimeout", "withtimeout",
  "trace", "instrument", "measure",
  "withauth", "authorize",
]);

function isWrapperFn(frame: StackFrame): boolean {
  const fn = (frame.functionName ?? "").split("\n")[0].trim().toLowerCase();
  // Strip leading underscores (Python convention: _retry, __retry)
  const stripped = fn.replace(/^_+/, "");
  return WRAPPER_FN_NAMES.has(fn) || WRAPPER_FN_NAMES.has(stripped);
}

/** Directory/file patterns that indicate infrastructure or service layers, not business logic */
const SERVICE_LAYER_PATTERNS = [
  "/infra/", "/infrastructure/",
  "/services/ai", "/services/llm", "/services/openai", "/services/anthropic",
  "/lib/ai", "/lib/llm", "/lib/openai", "/lib/anthropic",
  "/utils/ai", "/utils/llm", "/utils/openai", "/utils/anthropic",
  "/shared/ai", "/shared/llm",
  "/clients/", "/adapters/",
];

function isServiceLayer(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SERVICE_LAYER_PATTERNS.some((p) => lower.includes(p));
}

export function findBusinessLogicFrame(
  frames: StackFrame[],
  filterCtx?: { removedFiles: Set<string>; frame0WasAdjacentToSDK: boolean },
): StackFrame | undefined {
  if (frames.length === 0) return undefined;

  // Filter out useless names
  const useless = new Set(["<module>", "<anonymous>", "anonymous", "<lambda>", "main", "_run", ""]);
  const meaningful = frames.filter((f) => {
    const fn = (f.functionName ?? "").split("\n")[0].trim();
    return fn && !useless.has(fn);
  });

  const pool = meaningful.length > 0 ? meaningful : frames;
  if (pool.length <= 1) return pool[0];

  const innerFile = pool[0].fileName ?? "";

  // Fast-path: if frame[0] was DIRECTLY adjacent to a filtered SDK frame,
  // AND it's not a wrapper function or service layer, it's the actual
  // function that called the AI SDK — return it immediately.
  if (filterCtx?.frame0WasAdjacentToSDK && !filterCtx.removedFiles.has(innerFile)) {
    if (!isWrapperFn(pool[0]) && !isServiceLayer(innerFile)) {
      return pool[0];
    }
  }

  // Collect candidate frames from different files, skipping wrappers
  const candidates: StackFrame[] = [];
  for (let i = 1; i < pool.length; i++) {
    const file = pool[i].fileName ?? "";
    if (file && file !== innerFile && !isWrapperFn(pool[i]) && !isServiceLayer(file)) {
      candidates.push(pool[i]);
    }
  }
  // If we found candidates past service layers, pick the first one
  if (candidates.length > 0) return candidates[0];

  // Fallback: first frame from a different file, skipping wrappers but allowing service layers
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
): StackFrame | undefined {
  let bestFrame: StackFrame | null = null;
  let bestScore = Infinity;
  const scoredFrames: { frame: StackFrame; score: number }[] = [];

  const graphKeys = Object.keys(graph);

  for (const frame of frames) {
    const frameFile = frame.fileName ?? "";
    const frameFn = (frame.functionName ?? "").split("\n")[0].trim();
    if (!frameFile && !frameFn) continue;

    // Find the best graph match for this frame.
    // When multiple graph keys match, prefer the most specific (longest path),
    // then lowest score. This prevents short ambiguous keys like "utils.py"
    // from winning over specific keys like "app/utils.py".
    let frameScore = Infinity;
    let frameSpecificity = 0;
    const frameFileLower = frameFile.toLowerCase();
    for (const key of graphKeys) {
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

      // Case-insensitive file matching with path separator boundary
      const graphFileLower = graphFile.toLowerCase();
      const fileMatches = frameFileLower === graphFileLower ||
        (frameFileLower && graphFileLower && (
          frameFileLower.endsWith("/" + graphFileLower) || graphFileLower.endsWith("/" + frameFileLower)
        ));

      // Require exact match OR dotted suffix (Class.method matching "method")
      const fnMatches = !graphFn || frameFn === graphFn ||
        (frameFn.endsWith("." + graphFn));

      if (fileMatches && fnMatches) {
        const entry = graph[key];
        const specificity = graphFile.length;
        // Most specific match wins, then lowest score breaks ties
        if (specificity > frameSpecificity ||
            (specificity === frameSpecificity && entry.score < frameScore)) {
          frameScore = entry.score;
          frameSpecificity = specificity;
        }
      }
    }

    if (frameScore < Infinity) {
      scoredFrames.push({ frame, score: frameScore });
      if (frameScore < bestScore) {
        bestScore = frameScore;
        bestFrame = frame;
      }
    }
  }

  // Wrapper detection: if the graph picked a frame from the same file as frame[0],
  // AND there are 2+ frames from that file (typical wrapper pattern like
  // anthropic_client.py having both call_haiku and _messages_create_with_backoff),
  // pick the lowest-score frame from a DIFFERENT file instead.
  if (bestFrame) {
    const innerFile = frames[0]?.fileName ?? "";
    const bestFile = bestFrame.fileName ?? "";
    if (innerFile && bestFile && innerFile === bestFile) {
      const sameFileCount = frames.filter(f => (f.fileName ?? "") === innerFile).length;
      if (sameFileCount >= 2) {
        // Find lowest-score frame from a different file using graph data
        let altFrame: StackFrame | null = null;
        let altScore = Infinity;
        for (const scored of scoredFrames) {
          if ((scored.frame.fileName ?? "") !== innerFile && scored.score < altScore) {
            altFrame = scored.frame;
            altScore = scored.score;
          }
        }
        if (altFrame) return altFrame;
        // No scored frame from different file — fall back to heuristic
        const heuristicResult = findBusinessLogicFrame(frames);
        if (heuristicResult && (heuristicResult.fileName ?? "") !== innerFile) {
          return heuristicResult;
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
      const frameStatsBatch: Array<{
        frames: Array<{ fileName: string | null; functionName: string | null; lineNumber: number | null }>;
        callSiteKey: string;
      }> = [];
      try {
        await client.query("BEGIN");

        for (const event of payload.events) {
          // Fallback: extract model from URL path if SDK didn't resolve it
          // e.g. Google Gemini: /v1beta/models/gemini-2.5-flash:generateContent
          if (!event.model && event.url) {
            try {
              const urlPath = new URL(event.url).pathname;
              const modelMatch = urlPath.match(/\/models\/([^/:]+)/);
              if (modelMatch) event.model = modelMatch[1];
            } catch { /* invalid URL, ignore */ }
          }

          // Server-side cost calculation — authoritative source
          const costUsd = computeCost(
            event.model,
            event.usage?.inputTokens ?? null,
            event.usage?.outputTokens ?? null,
            event.usage?.cacheReadTokens ?? null,
            event.usage?.cacheCreationTokens ?? null,
          ) ?? event.costUsd ?? null; // Fall back to SDK-calculated cost if server can't resolve

          // Filter stack frames server-side (strips SDK/library internals for all languages)
          const rawFrames = event.callSite?.frames ?? null;
          let cleanFrames = rawFrames ? filterFrames(rawFrames) : null;
          const filterCtx = rawFrames && cleanFrames
            ? getFilterContext(rawFrames, cleanFrames) : undefined;

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

          // Compute business logic frame (single source of truth)
          // Priority: explicit call graph > implicit graph (from event data) > heuristic
          let blFunction: string | null = null;
          let blFile: string | null = null;
          let blLine: number | null = null;
          if (cleanFrames && cleanFrames.length > 0) {
            const explicitGraph = callGraphCache.get(projectId);
            let best;
            if (explicitGraph) {
              best = findBusinessLogicFrameWithGraph(cleanFrames, explicitGraph);
            } else {
              const implicitGraph = await getImplicitGraph(pool, projectId);
              best = implicitGraph
                ? findBusinessLogicFrameWithGraph(cleanFrames, implicitGraph)
                : findBusinessLogicFrame(cleanFrames, filterCtx);
            }
            if (best) {
              blFunction = (best.functionName ?? "").split("\n")[0].trim() || null;
              blFile = best.fileName ?? null;
              blLine = best.lineNumber ?? null;
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
              trace_id, trace_name, context, request_body, response_body, release,
              bl_function, bl_file, bl_line
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
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
              blFunction, blFile, blLine,
            ],
          );

          // Upsert call site stats and frame stats — use bl_ values (single source of truth)
          const callSiteKey = blFunction ? `${blFile ?? "unknown"}:${blFunction}:${blLine ?? 0}` : null;

          // Collect frame stats for batch insert after the loop
          if (cleanFrames && cleanFrames.length > 0 && callSiteKey) {
            frameStatsBatch.push({ frames: cleanFrames, callSiteKey });
          }

          if (blFunction) {
            const key = callSiteKey!;
            const eventModel = event.model ?? "unknown";

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
                projectId, key, blFile, blFunction, blLine,
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

        // Batch insert all frame stats in 2 queries (instead of 2 per event)
        if (frameStatsBatch.length > 0) {
          await updateFrameStatsBatch(client, projectId, frameStatsBatch);
        }

        await client.query("COMMIT");
        // Invalidate implicit graph cache after new data
        invalidateImplicitGraph(projectId);
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

  /**
   * GET /api/v1/projects/:projectId/config — SDK configuration endpoint
   *
   * Returns custom provider configurations for this project.
   * Uses Bearer auth (auth key) — called by the SDK, not the dashboard.
   *
   * SDK integration plan:
   * - On init, SDK fetches GET /config using the auth key
   * - Parses the providers list
   * - For each custom provider, calls registerExtractor() with a dynamically created extractor:
   *   - Matches the hostname
   *   - Extracts usage using the JSON paths (e.g., "usage.prompt_tokens" → walk the object)
   *   - Extracts model using the model path
   * - Caches the config with a 5-minute TTL, refreshes automatically
   * - If fetch fails, logs warning but doesn't block — uses whatever extractors are already registered
   */
  router.get("/api/v1/projects/:projectId/config", async (req, res) => {
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
      if (projectId !== req.params["projectId"]) {
        res.status(403).json({ error: "Auth key does not match project" });
        return;
      }

      const result = await pool.query(
        `SELECT id, name, hostname, usage_input_path, usage_output_path, model_path
        FROM custom_providers WHERE project_id = $1 AND enabled = TRUE
        ORDER BY created_at ASC`,
        [projectId],
      );

      const providers = result.rows.map((row: {
        id: string; name: string; hostname: string;
        usage_input_path: string; usage_output_path: string; model_path: string;
      }) => ({
        id: row.id,
        name: row.name,
        hostname: row.hostname,
        usageInputPath: row.usage_input_path,
        usageOutputPath: row.usage_output_path,
        modelPath: row.model_path,
      }));

      res.json({
        status: "ok",
        serverTime: new Date().toISOString(),
        providers,
      });
    } catch (err) {
      console.error("[costkey] Config endpoint error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

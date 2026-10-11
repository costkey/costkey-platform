import type { Router } from "express";
import { Router as createRouter } from "express";
import type pg from "pg";
import type { CostKeyEvent, TransportPayload, StackFrame } from "@costkey/shared";
import { resolveEventCostWithOverrides, resolveExplicitUsageCost } from "./billing.js";
import { translateFrames } from "./sourcemap-resolver.js";
import { updateFrameStatsBatch, getImplicitGraph, invalidateImplicitGraph } from "./implicit-graph.js";
import {
  AccountingConflictError,
  accountingLockKey,
  InvalidAccountingEventError,
  normalizeAccountingEvent,
  recordAccountingEvent,
} from "./accounting.js";
import { enrichFeatureContext } from "./feature-mappings.js";
import { scheduleFindingsRefresh } from "./findings.js";
import { redactCapturedContent, stripIngestEventPrivacy } from "./privacy.js";
import { applyCallTelemetry, hasCallTelemetry, type AppliedTelemetry } from "./telemetry/event.js";
import { expandLiveKitEvent, isLiveKitTelemetry, LiveKitPayloadError } from "./telemetry/livekit.js";
import { projectCustomExtractors } from "./telemetry/custom-providers.js";
import { callGraphFromUpload } from "./telemetry/callgraph.js";
import { stripOtelContent } from "./telemetry/otel.js";
import type { ServerExtractor } from "./telemetry/types.js";

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const obj = part as Record<string, unknown>;
      return typeof obj["text"] === "string" ? obj["text"] : "";
    })
    .filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

function extractSystemPrompt(body: unknown): string | null {
  if (!body) return null;
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const system = obj["system"] ?? obj["system_prompt"] ?? obj["systemPrompt"];
  const direct = textFromContent(system);
  if (direct) return direct;

  const systemInstruction = obj["system_instruction"] ?? obj["systemInstruction"];
  if (systemInstruction && typeof systemInstruction === "object") {
    const parts = (systemInstruction as Record<string, unknown>)["parts"];
    const fromParts = textFromContent(parts);
    if (fromParts) return fromParts;
  }

  const messages = obj["messages"];
  if (Array.isArray(messages)) {
    const prompts = messages
      .filter((msg): msg is Record<string, unknown> => !!msg && typeof msg === "object")
      .filter((msg) => msg["role"] === "system" || msg["role"] === "developer")
      .map((msg) => textFromContent(msg["content"]))
      .filter((text): text is string => !!text);
    if (prompts.length) return prompts.join("\n\n");
  }

  return null;
}

function collectToolResults(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return [];
  const results: unknown[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const msg = message as Record<string, unknown>;
    if (msg["role"] === "tool" || msg["role"] === "function") results.push(msg);
    const content = msg["content"];
    if (Array.isArray(content)) {
      results.push(
        ...content.filter((block) => !!block && typeof block === "object" && (block as Record<string, unknown>)["type"] === "tool_result"),
      );
    }
  }
  return results;
}

function collectResponseItems(responseBody: unknown): {
  toolCalls: unknown[];
  webSearches: unknown[];
  citations: unknown[];
} {
  const toolCalls: unknown[] = [];
  const webSearches: unknown[] = [];
  const citations: unknown[] = [];
  if (!responseBody || typeof responseBody !== "object") {
    return { toolCalls, webSearches, citations };
  }
  const body = responseBody as Record<string, unknown>;

  const choices = body["choices"];
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const message = (choice as Record<string, unknown>)["message"];
      if (message && typeof message === "object") {
        const msg = message as Record<string, unknown>;
        if (Array.isArray(msg["tool_calls"])) toolCalls.push(...msg["tool_calls"]);
        if (msg["function_call"]) toolCalls.push(msg["function_call"]);
        const annotations = msg["annotations"];
        if (Array.isArray(annotations)) citations.push(...annotations);
      }
    }
  }

  const output = body["output"];
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const type = String(obj["type"] ?? "");
      if (type.includes("function_call") || type.includes("tool_call")) toolCalls.push(obj);
      if (type.includes("web_search")) webSearches.push(obj);
      if (Array.isArray(obj["content"])) {
        for (const content of obj["content"]) {
          if (!content || typeof content !== "object") continue;
          const annotations = (content as Record<string, unknown>)["annotations"];
          if (Array.isArray(annotations)) citations.push(...annotations);
        }
      }
    }
  }

  const content = body["content"];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const obj = block as Record<string, unknown>;
      if (obj["type"] === "tool_use") toolCalls.push(obj);
      if (Array.isArray(obj["citations"])) citations.push(...obj["citations"]);
    }
  }

  const functionCalls = body["functionCalls"] ?? body["function_calls"];
  if (Array.isArray(functionCalls)) toolCalls.push(...functionCalls);

  const candidates = body["candidates"];
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const grounding = (candidate as Record<string, unknown>)["groundingMetadata"]
        ?? (candidate as Record<string, unknown>)["grounding_metadata"];
      if (grounding) webSearches.push(grounding);
    }
  }

  const usage = body["usage"];
  if (usage && typeof usage === "object") {
    const serverToolUse = (usage as Record<string, unknown>)["server_tool_use"];
    if (serverToolUse) webSearches.push({ usage: serverToolUse });
  }

  return { toolCalls, webSearches, citations };
}

function extractMetadata(requestBody: unknown, responseBody: unknown): CostKeyEvent["metadata"] {
  if ((!requestBody || typeof requestBody !== "object") && (!responseBody || typeof responseBody !== "object")) return null;
  const req = requestBody && typeof requestBody === "object" ? requestBody as Record<string, unknown> : {};
  const prompts = Array.isArray(req["messages"])
    ? req["messages"].map((message) => {
      if (!message || typeof message !== "object") return { role: "unknown", content: message };
      const msg = message as Record<string, unknown>;
      return { role: String(msg["role"] ?? "unknown"), content: msg["content"] };
    })
    : Array.isArray(req["contents"])
      ? req["contents"].map((content) => ({ role: String((content as Record<string, unknown>)["role"] ?? "user"), content }))
      : req["input"] != null
        ? [{ role: "input", content: req["input"] }]
        : undefined;
  const { toolCalls, webSearches, citations } = collectResponseItems(responseBody);
  const toolResults = collectToolResults(req["messages"]);
  const metadata: NonNullable<CostKeyEvent["metadata"]> = {};

  if (prompts?.length) metadata.prompts = prompts;
  if (Array.isArray(req["tools"]) && req["tools"].length) metadata.toolDefinitions = req["tools"];
  if (req["tool_choice"] != null || req["toolChoice"] != null) metadata.toolChoice = req["tool_choice"] ?? req["toolChoice"];
  if (toolCalls.length) metadata.toolCalls = toolCalls;
  if (toolResults.length) metadata.toolResults = toolResults;
  if (webSearches.length) metadata.webSearches = webSearches;
  if (citations.length) metadata.citations = citations;

  return Object.keys(metadata).length ? metadata : null;
}

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
  // AWS transport under boto3 (the Python SDK dropped these client-side)
  "site-packages/botocore/",
  "site-packages/aiobotocore/",
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
  // Provider SDKs the TypeScript SDK 0.6 dropped client-side
  "node_modules/@aws-sdk/",
  "node_modules/@smithy/",
  "node_modules/@ai-sdk/",
  "node_modules/@elevenlabs/",
  "node_modules/exa-js/",
  "node_modules/@mendable/firecrawl-js/",
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

/** Whether a frame is SDK, library, framework or runtime code rather than the application's. */
export function isInternalFrame(frame: StackFrame): boolean {
  const file = frame.fileName ?? "";
  const fn = frame.functionName ?? "";
  if (!file && !fn) return true;
  if (INTERNAL_FILE_PATTERNS.some((p) => file.includes(p))) return true;
  if (INTERNAL_FN_PATTERNS.some((p) => fn.includes(p))) return true;
  // Python stdlib: /lib/pythonX.Y/foo.py but NOT /lib/pythonX.Y/site-packages/
  if (file.includes("/lib/python") && !file.includes("site-packages")) return true;
  return false;
}

export function filterFrames(frames: StackFrame[]): StackFrame[] {
  const filtered = frames.filter((frame) => !isInternalFrame(frame));
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
  filterCtx?: { removedFiles: Set<string>; frame0WasAdjacentToSDK: boolean },
): StackFrame | undefined {
  let bestFrame: StackFrame | null = null;
  let bestScore = Infinity;
  const scoredFrames: { frame: StackFrame; score: number }[] = [];

  // If frame[0] sits DIRECTLY next to where we filtered out SDK frames, it's
  // the user's AI-calling function. The graph's edge-position penalty is
  // miscalibrated for this case — it was tuned against stacks that still
  // include SDK wrappers, so position 0 scores badly as "SDK-adjacent."
  // Post-filter, position 0 IS the business logic. Give it a negative score
  // adjustment so it beats deeper frames when they'd otherwise tie.
  //
  // We still defer to the graph when frame[0] is a known wrapper (by name or
  // by being in a service-layer path), because those patterns are reliable
  // signals that an orchestrator frame will be more useful.
  const F0_ADJUSTMENT = -3.0;
  const f0 = frames[0];
  const f0Qualifies = filterCtx?.frame0WasAdjacentToSDK
    && f0
    && !isWrapperFn(f0)
    && !isServiceLayer(f0.fileName ?? "");

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
      // Apply the adjacent-to-SDK bonus for frame[0] when it qualifies.
      const effectiveScore = (frame === f0 && f0Qualifies) ? frameScore + F0_ADJUSTMENT : frameScore;
      scoredFrames.push({ frame, score: effectiveScore });
      if (effectiveScore < bestScore) {
        bestScore = effectiveScore;
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
  const originalBytes = Buffer.byteLength(json, "utf8");
  if (originalBytes <= MAX_BODY_BYTES) return json;

  // JSONB rejects a raw slice because it can end in the middle of a string,
  // object, or UTF-8 sequence. Store the slice as a string inside a valid
  // envelope so one large prompt cannot abort the entire ingest transaction.
  const envelope = {
    __costkey_truncated__: true,
    original_bytes: originalBytes,
    notice: "[TRUNCATED]",
    preview: "",
  };
  const emptyEnvelopeBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  let previewBytes = Math.max(0, MAX_BODY_BYTES - emptyEnvelopeBytes);
  const source = Buffer.from(json, "utf8");
  let result = "";

  // JSON escaping can expand the preview, so tighten it until the serialized
  // envelope respects the byte limit. This normally completes in one pass.
  do {
    envelope.preview = source.subarray(0, previewBytes).toString("utf8");
    result = JSON.stringify(envelope);
    const excess = Buffer.byteLength(result, "utf8") - MAX_BODY_BYTES;
    if (excess <= 0) break;
    previewBytes = Math.max(0, previewBytes - excess);
  } while (previewBytes > 0);

  return result;
}

/** Store only the provider route; query strings commonly carry API keys. */
export function sanitizeEventUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export type ContentStatus = "captured" | "metadata_only" | "redacted" | "not_available" | "expired" | "unknown";

const MAX_CLIENT_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLIENT_EVENT_FUTURE_MS = 5 * 60 * 1000;

/** Keep provider pricing/accounting from being selected by an arbitrary DSN clock. */
export function trustedEventTimestamp(raw: unknown, now = new Date()): string {
  const receivedAt = Number.isFinite(now.getTime()) ? now : new Date();
  if (typeof raw !== "string") return receivedAt.toISOString();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return receivedAt.toISOString();
  const delta = parsed.getTime() - receivedAt.getTime();
  if (delta > MAX_CLIENT_EVENT_FUTURE_MS || delta < -MAX_CLIENT_EVENT_AGE_MS) return receivedAt.toISOString();
  return parsed.toISOString();
}

/**
 * Body fields are deliberately tracked independently from their values. A
 * null body may mean policy redaction, provider unavailability, or a
 * metadata-only project; keeping this status prevents the inspector from
 * presenting those materially different cases as one empty capture.
 */
export function contentStatusForEvent(
  event: Record<string, unknown>,
  settings?: { captureMode?: string | null; bodyCaptureEnabled?: boolean | null },
): ContentStatus {
  const explicitRaw = event["contentStatus"] ?? event["content_status"];
  const explicit = typeof explicitRaw === "string" ? explicitRaw.trim().toLowerCase() : "";
  if (["captured", "metadata_only", "redacted", "not_available", "expired", "unknown"].includes(explicit)) {
    return explicit as ContentStatus;
  }
  const hasBody = [event["requestBody"], event["responseBody"], event["systemPrompt"], event["request_body"], event["response_body"], event["system_prompt"]]
    .some((body) => body !== undefined && body !== null);
  if (hasBody) return "captured";
  const metadata = event["metadata"];
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)
    && ["prompt", "prompts", "completion", "response"].some((key) => Object.prototype.hasOwnProperty.call(metadata, key))) {
    return "captured";
  }
  if (settings?.captureMode === "metadata" || settings?.bodyCaptureEnabled === false) return "metadata_only";
  const bodyWasSpecified = ["requestBody", "responseBody", "systemPrompt", "request_body", "response_body", "system_prompt"]
    .some((key) => Object.prototype.hasOwnProperty.call(event, key));
  return bodyWasSpecified ? "not_available" : "unknown";
}

function eventCostBasis(
  event: CostKeyEvent,
  eventType: ReturnType<typeof normalizeAccountingEvent>["eventType"],
  cost: number | null,
  resolved?: { basis: "reported" | "estimated" | "unknown"; source: string | null; pricingId?: string | null },
): { basis: "reported" | "estimated" | "unknown"; source: string | null; currency: string } {
  if (cost === null) return { basis: "unknown", source: null, currency: "USD" };
  if (resolved) return { basis: resolved.basis, source: resolved.source, currency: "USD" };
  if (eventType === "usage") {
    return {
      basis: "estimated",
      source: "client_reported",
      currency: (typeof (event as unknown as Record<string, unknown>)["amount"] === "object"
        ? String(((event as unknown as Record<string, unknown>)["amount"] as Record<string, unknown>)?.["currency"] ?? "USD")
        : "USD").toUpperCase(),
    };
  }
  return {
    basis: "estimated",
    source: "client_reported",
    currency: "USD",
  };
}

/** Non-token units a provider reported with a call, kept small and numeric. */
export function nativeUnitsJson(usage: unknown): string | null {
  if (!usage || typeof usage !== "object") return null;
  const raw = (usage as Record<string, unknown>)["nativeUnits"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const units = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([key, value]) => /^[A-Za-z0-9_.-]{1,64}$/.test(key) && typeof value === "number" && Number.isFinite(value) && value >= 0)
      .slice(0, 32),
  );
  return Object.keys(units).length > 0 ? JSON.stringify(units) : null;
}

/** SDKs before 0.6 stamped a call when it finished rather than when it started. */
export function callTimestampIsEnd(sdkVersion: string | null): boolean {
  if (!sdkVersion) return true;
  const match = sdkVersion.match(/(\d+)\.(\d+)/);
  if (!match) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 0 && minor < 6;
}

const SPAN_CONTENT_KEYS = ["input", "output", "args", "arguments", "result", "prompt", "completion", "messages", "content"];

/** Metadata-only projects keep span structure and timing but never tool or agent payloads. */
export function stripSpanContent(event: Record<string, unknown>): void {
  // Raw OTel attributes (contract detail 9) nest their content under `otel`.
  stripOtelContent(event);
  const attributes = event["attributes"];
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return;
  stripOtelContent(attributes as Record<string, unknown>);
  for (const key of Object.keys(attributes)) {
    const leaf = key.split(".").pop() ?? key;
    if (SPAN_CONTENT_KEYS.includes(leaf.toLowerCase())) delete (attributes as Record<string, unknown>)[key];
  }
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

      const projectId = String((projResult.rows[0] as { id: string }).id);
      let projectSettings: {
        capture_mode?: string | null;
        body_capture_enabled?: boolean | null;
        redaction_enabled?: boolean | null;
        source_access_enabled?: boolean | null;
      } = {};
      try {
        const settings = await pool.query(
          "SELECT capture_mode, body_capture_enabled, redaction_enabled, source_access_enabled FROM project_settings WHERE project_id = $1",
          [projectId],
        );
        projectSettings = (settings.rows[0] as typeof projectSettings | undefined) ?? {};
      } catch {
        // Unknown settings must fail closed for privacy. The normal startup
        // path creates project_settings; this fallback only handles a staged
        // migration or transient query failure.
        projectSettings = { capture_mode: "metadata", body_capture_enabled: false, source_access_enabled: false };
      }
      const allowBody = projectSettings.capture_mode === "text" && projectSettings.body_capture_enabled !== false;
      const allowSource = projectSettings.source_access_enabled === true;
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

      const sdkVersion = typeof payload.sdkVersion === "string" ? payload.sdkVersion.slice(0, 40) : null;
      const legacyCallTimestamps = callTimestampIsEnd(sdkVersion);

      // Raw LiveKit rows (SDK 0.7) expand into one cumulative usage event per
      // component; `index` keeps rejections pointing at the sent event.
      const batch: Array<{ index: number; event: CostKeyEvent; expansionError?: Error }> = [];
      for (const [index, event] of payload.events.entries()) {
        const raw = event as unknown as Record<string, unknown>;
        if (!raw || typeof raw !== "object" || !isLiveKitTelemetry(raw)) {
          batch.push({ index, event });
          continue;
        }
        try {
          const expanded = expandLiveKitEvent(raw);
          for (const item of expanded) batch.push({ index, event: item as unknown as CostKeyEvent });
        } catch (error) {
          batch.push({ index, event, expansionError: error instanceof Error ? error : new LiveKitPayloadError(String(error)) });
        }
      }
      // Custom provider extractors are server config, read once per batch.
      const customExtractors: ServerExtractor[] = batch.some(({ event }) => event && typeof event === "object"
        && hasCallTelemetry(event as unknown as Record<string, unknown>))
        ? await projectCustomExtractors(pool, projectId).catch(() => [])
        : [];
      let acceptedCount = 0;
      const rejected: Array<{ index: number; id: string | null; code: string; error: string }> = [];

      // Batch insert events
      const client = await pool.connect();
      const frameStatsBatch: Array<{
        frames: Array<{ fileName: string | null; functionName: string | null; lineNumber: number | null }>;
        callSiteKey: string;
      }> = [];
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [accountingLockKey(projectId)]);

        for (const { index, event, expansionError } of batch) {
          const handleEvent = async (): Promise<void> => {
              if (expansionError) throw expansionError;
              const rawEvent = event as unknown as Record<string, unknown>;
              // The OpenAI Agents SDK posts its own traces to api.openai.com.
              // Those posts are not model calls; drop them (0.6 SDKs captured them).
              if (isAgentsTraceExport(rawEvent)) return;
              // SDK 0.7 sends raw telemetry: derive every normalized call field
              // from it (telemetry wins). Without it the legacy fields stand.
              const telemetry: AppliedTelemetry | null = rawEvent && typeof rawEvent === "object"
                ? applyCallTelemetry(rawEvent, { customExtractors, isInternalFrame })
                : null;
              // The DSN clock is useful for near-real-time ordering, but must not
              // select an arbitrary historical/future effective price interval.
              rawEvent.timestamp = trustedEventTimestamp(rawEvent.timestamp);
              // SDKs before 0.6 stamped calls when they finished. Store every
              // call at its start so traces, waterfalls and pricing agree.
              const rawType = rawEvent["eventType"] ?? rawEvent["event_type"];
              const durationMs = typeof rawEvent["durationMs"] === "number" ? rawEvent["durationMs"] : null;
              if (!telemetry && legacyCallTimestamps && (rawType === undefined || rawType === "call") && durationMs !== null && durationMs > 0) {
                rawEvent.timestamp = new Date(Date.parse(String(rawEvent.timestamp)) - durationMs).toISOString();
              }
              // Release filters read context.release; carry the batch release there.
              if (release) {
                const ctx = rawEvent["context"] && typeof rawEvent["context"] === "object" && !Array.isArray(rawEvent["context"])
                  ? rawEvent["context"] as Record<string, unknown>
                  : null;
                if (ctx && ctx["release"] === undefined) ctx["release"] = release;
                else if (!ctx && (rawType === undefined || rawType === "call")) rawEvent["context"] = { release };
              }
              // Enforce the setting again at the persistence boundary. This keeps
              // direct router mounts and a failed/missing privacy middleware from
              // ever writing captured body/source fields.
              if (rawEvent && typeof rawEvent === "object") {
                stripIngestEventPrivacy(rawEvent, {
                  allowBody,
                  allowSource,
                  redactionEnabled: projectSettings.redaction_enabled !== false,
                });
              }
              const contentStatus = contentStatusForEvent(rawEvent, {
                captureMode: projectSettings.capture_mode,
                bodyCaptureEnabled: projectSettings.body_capture_enabled,
              });
              let featureSource: "explicit" | "mapping" | "mapping_override" | "unknown" = "unknown";
              const initialContext = rawEvent["context"] && typeof rawEvent["context"] === "object"
                ? rawEvent["context"] as Record<string, unknown>
                : {};
              if (typeof initialContext["feature"] === "string" && initialContext["feature"].trim()) featureSource = "explicit";
              let featureMappingId: string | null = null;
              let featureMappingActionId: string | null = null;
              let featureOriginal: string | null = null;
              let accounting = normalizeAccountingEvent(rawEvent);
              if (accounting.eventType === "span") {
                // Spans are structure, not billable rows: they upsert into the
                // spans table and never touch events or call-site rollups.
                if (!allowBody) stripSpanContent(rawEvent);
                for (const key of ["startedAt", "endedAt"]) {
                  if (typeof rawEvent[key] === "string") rawEvent[key] = trustedEventTimestamp(rawEvent[key]);
                }
                await recordAccountingEvent(client, projectId, rawEvent);
                return;
              }
              if (accounting.eventType === "score") {
                // Scores annotate runs: they upsert into the scores table only.
                // A grader's comment is content, so it follows body capture.
                if (!allowBody) delete rawEvent["comment"];
                else if (projectSettings.redaction_enabled !== false && typeof rawEvent["comment"] === "string") {
                  rawEvent["comment"] = redactCapturedContent(rawEvent["comment"]);
                }
                await recordAccountingEvent(client, projectId, rawEvent);
                return;
              }
              // Fallback: extract model from URL path if SDK didn't resolve it
              // e.g. Google Gemini: /v1beta/models/gemini-2.5-flash:generateContent
              if (!event.model && event.url) {
                try {
                  const urlPath = new URL(event.url).pathname;
                  // Gemini: /models/<id>:generateContent; Bedrock: /model/<id>/invoke
                  const modelMatch = urlPath.match(/\/models?\/([^/:]+)/);
                  if (modelMatch) event.model = decodeURIComponent(modelMatch[1]);
                } catch { /* invalid URL, ignore */ }
              }

              const explicitAmount = accounting.eventType === "usage" && accounting.amountPresent
                && accounting.currency === "USD" ? accounting.amount : null;
              const explicitUnitValue = accounting.eventType === "usage"
                ? accounting.unitValue ?? (accounting.unitKind && accounting.usage
                  ? accounting.usage[accounting.unitKind] ?? accounting.usage[accounting.unit ?? ""] ?? null
                  : null)
                : null;
              if (accounting.eventType === "usage" && accounting.unitValue == null) accounting.unitValue = explicitUnitValue;
              const resolved = accounting.eventType === "call"
                ? await resolveEventCostWithOverrides(pool, projectId, event)
                : accounting.eventType === "usage"
                  ? await resolveExplicitUsageCost(pool, projectId, event, {
                    provider: accounting.provider,
                    model: accounting.model,
                    unitKind: accounting.unitKind,
                    unitValue: explicitUnitValue,
                    currency: accounting.currency,
                    amount: accounting.amount,
                    amountPresent: accounting.amountPresent,
                    amountKind: accounting.amountKind,
                  })
                  : { cost: explicitAmount, basis: explicitAmount === null ? "unknown" as const : "reported" as const, source: explicitAmount === null ? null : "explicit", pricingId: null, pricingDate: null };
              const costUsd = resolved.cost;
              const cost = eventCostBasis(event, accounting.eventType, costUsd, resolved);
              if (accounting.eventType === "usage") cost.currency = accounting.currency;
              if (resolved.pricingId && !accounting.pricingId) accounting.pricingId = resolved.pricingId;

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
                  best = findBusinessLogicFrameWithGraph(cleanFrames, explicitGraph, filterCtx);
                } else {
                  const implicitGraph = await getImplicitGraph(pool, projectId);
                  best = implicitGraph
                    ? findBusinessLogicFrameWithGraph(cleanFrames, implicitGraph, filterCtx)
                    : findBusinessLogicFrame(cleanFrames, filterCtx);
                }
                if (best) {
                  blFunction = (best.functionName ?? "").split("\n")[0].trim() || null;
                  blFile = best.fileName ?? null;
                  blLine = best.lineNumber ?? null;
                }

              }

              // Reusable mappings supply only missing business meaning. Explicit
              // SDK feature context remains authoritative unless a user performs
              // a separate historical override action.
              if (accounting.eventType === "call") {
                const enriched = await enrichFeatureContext(client, projectId, rawEvent, {
                  file: blFile,
                  function: blFunction,
                  sourceAccessEnabled: allowSource,
                });
                if (enriched !== rawEvent) {
                  rawEvent["context"] = enriched["context"];
                  event.context = enriched["context"] as CostKeyEvent["context"];
                  featureSource = enriched["featureSource"] === "mapping_override" ? "mapping_override" : "mapping";
                  featureMappingId = typeof enriched["featureMappingId"] === "string" ? enriched["featureMappingId"] : null;
                  // Re-read context-derived trace/group identity after mapping.
                  accounting = normalizeAccountingEvent(rawEvent);
                }
              }

              // A raw call that failed or was cancelled (AbortError, CancelledError,
              // non-2xx) records that outcome on the call row only; trace
              // lifecycle still comes from explicit lifecycle events.
              if (telemetry?.derived.outcome && accounting.eventType === "call") {
                accounting.lifecycle = telemetry.derived.outcome.lifecycle;
                accounting.errorType = telemetry.derived.outcome.errorType;
                const end = Date.parse(String(event.timestamp)) + (telemetry.derived.durationMs ?? 0);
                if (Number.isFinite(end)) accounting.lifecycleAt = new Date(end).toISOString();
              }
              // The raw envelope is kept for reprocessing with the same privacy
              // treatment as metadata: only where body capture is allowed, and
              // through the same credential redaction.
              const storedTelemetry = telemetry?.stored && allowBody
                ? JSON.stringify(projectSettings.redaction_enabled !== false
                  ? redactCapturedContent(telemetry.stored)
                  : telemetry.stored)
                : null;

              const inserted = await client.query(
                `INSERT INTO events (
                  id, timestamp, project_id, provider, model, url, method, status_code,
                  input_tokens, output_tokens, total_tokens, reasoning_tokens,
                  cache_read_tokens, cache_creation_tokens,
                  cost_usd, duration_ms, streaming,
                  ttft, tps, stream_duration, chunk_count,
                  call_site_raw, call_site_frames,
                  trace_id, trace_name, context, metadata, system_prompt, request_body, response_body, release,
                  bl_function, bl_file, bl_line, image_output_tokens,
                  event_type, source, request_model, attempt_id, parent_event_id,
                  charge_id, component_id, execution_id, group_id, group_name,
                  group_kind, phase, configuration, dataset_revision, case_id,
                  lifecycle_state, lifecycle_at, lifecycle_error_type, usage_event,
                  cost_basis, cost_source, cost_currency, unit_kind, unit_value,
                  unit, aggregation, revision, entity_type, entity_id, pricing_id, pricing_date, sequence,
                  content_status, feature_source, feature_mapping_id, feature_mapping_action_id, feature_original,
                  span_id, sdk_version, native_units, raw_telemetry
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56,$57,$58,$59,$60,$61,$62,$63,$64,$65,$66,$67,$68,$69,$70,$71,$72,$73,$74,$75,$76)
                ON CONFLICT (project_id, id) DO NOTHING`,
                [
                  event.id, event.timestamp, projectId,
                  event.provider ?? accounting.provider, event.model ?? accounting.model,
                  sanitizeEventUrl(event.url) ?? "", event.method ?? "POST", event.statusCode,
                  event.usage?.inputTokens, event.usage?.outputTokens,
                  event.usage?.totalTokens, event.usage?.reasoningTokens,
                  event.usage?.cacheReadTokens, event.usage?.cacheCreationTokens,
                  costUsd, event.durationMs, event.streaming,
                  event.streamTiming?.ttft, event.streamTiming?.tps,
                  event.streamTiming?.streamDuration, event.streamTiming?.chunkCount,
                  event.callSite?.raw ?? null,
                  cleanFrames ? JSON.stringify(cleanFrames) : null,
                  accounting.traceId,
                  accounting.traceName,
                  event.context ? JSON.stringify(event.context) : null,
                  truncateBody(event.metadata ?? extractMetadata(event.requestBody, event.responseBody)),
                  event.systemPrompt ?? extractSystemPrompt(event.requestBody),
                  truncateBody(event.requestBody),
                  truncateBody(event.responseBody),
                  release,
                  blFunction, blFile, blLine,
                  event.usage?.imageOutputTokens ?? null,
                  accounting.eventType,
                  accounting.source,
                  accounting.requestModel,
                  rawEvent["attemptId"] ?? rawEvent["attempt_id"] ?? null,
                  rawEvent["parentEventId"] ?? rawEvent["parent_event_id"] ?? null,
                  accounting.chargeId,
                  accounting.componentId,
                  accounting.executionId,
                  accounting.groupId ?? null,
                  accounting.groupName,
                  accounting.groupKind,
                  accounting.phase,
                  accounting.configuration ? JSON.stringify(accounting.configuration) : null,
                  accounting.datasetRevision,
                  accounting.caseId,
                  accounting.lifecycle,
                  accounting.lifecycleAt,
                  accounting.errorType,
                  accounting.eventType === "usage" ? JSON.stringify({
                    usage: accounting.usage,
                    billingUnits: rawEvent["billingUnits"] ?? rawEvent["billing_units"] ?? undefined,
                    amount: accounting.amountPresent ? { value: accounting.amount, currency: accounting.currency } : undefined,
                    pricingId: accounting.pricingId,
                  }) : null,
                  cost.basis,
                  cost.source,
                  cost.currency,
                  accounting.unitKind,
                  accounting.unitValue,
                  accounting.unit,
                  accounting.aggregation,
                  accounting.revision,
                  accounting.entityType,
                  accounting.entityId,
                  accounting.pricingId,
                  resolved.pricingDate ?? rawEvent["pricingDate"] ?? rawEvent["pricing_date"] ?? null,
                  accounting.sequence,
                  contentStatus,
                  featureSource,
                  featureMappingId,
                  featureMappingActionId,
                  featureOriginal,
                  accounting.spanId,
                  sdkVersion,
                  nativeUnitsJson(event.usage),
                  storedTelemetry,
                ],
              );

              if (inserted.rowCount === 0) return;

              await recordAccountingEvent(client, projectId, rawEvent);

              // Lifecycle and explicit usage envelopes are not provider calls and
              // must never inflate call-site rollups or call counts.
              if (accounting.eventType !== "call") return;

              // Upsert call site stats and frame stats — use bl_ values (single source of truth)
              const callSiteKey = blFunction ? `${blFile ?? "unknown"}:${blFunction}:${blLine ?? 0}` : null;


              if (blFunction) {
                const key = callSiteKey!;
                const eventModel = event.model ?? "unknown";

                await client.query(
                  `INSERT INTO call_site_stats (
                    project_id, call_site_key, file_name, function_name, line_number,
                    provider, model,
                    total_calls, total_cost_usd, total_input_tokens, total_output_tokens,
                    avg_duration_ms, avg_ttft, avg_tps, first_seen, last_seen,
                    priced_calls, unpriced_calls
                  ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16)
                  ON CONFLICT (project_id, call_site_key, model) DO UPDATE SET
                    total_calls = call_site_stats.total_calls + 1,
                    total_cost_usd = call_site_stats.total_cost_usd + EXCLUDED.total_cost_usd,
                    priced_calls = call_site_stats.priced_calls + EXCLUDED.priced_calls,
                    unpriced_calls = call_site_stats.unpriced_calls + EXCLUDED.unpriced_calls,
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
                    costUsd == null ? 0 : 1,
                    costUsd == null ? 1 : 0,
                  ],
                );
              }

              if (cleanFrames && cleanFrames.length > 0 && callSiteKey) {
                frameStatsBatch.push({ frames: cleanFrames, callSiteKey });
              }
          };
          // One savepoint per event: a bad or conflicting event is rejected on
          // its own instead of discarding the rest of the batch.
          await client.query("SAVEPOINT costkey_event");
          try {
            await handleEvent();
            await client.query("RELEASE SAVEPOINT costkey_event");
            acceptedCount += 1;
          } catch (err) {
            await client.query("ROLLBACK TO SAVEPOINT costkey_event");
            const known = err instanceof InvalidAccountingEventError || err instanceof AccountingConflictError;
            if (!known) console.error("[costkey] Ingest event error:", err);
            rejected.push({
              index,
              id: typeof (event as { id?: unknown }).id === "string" ? (event as { id: string }).id : null,
              code: known ? (err as InvalidAccountingEventError | AccountingConflictError).code : "ingest_error",
              error: known ? (err as Error).message : "This event could not be stored.",
            });
          }
        }

        // Batch insert all frame stats in 2 queries (instead of 2 per event)
        if (frameStatsBatch.length > 0) {
          await updateFrameStatsBatch(client, projectId, frameStatsBatch);
        }

        await client.query("COMMIT");
        // Invalidate implicit graph cache after new data
        invalidateImplicitGraph(projectId);
        // Findings are generated after durable accounting commit, coalesced so
        // a burst of events cannot trigger one full scan per request.
        scheduleFindingsRefresh(pool, projectId);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      if (acceptedCount === 0 && rejected.length > 0) {
        // Nothing was stored: keep the single-event error contract older SDKs expect.
        const first = rejected[0];
        const status = rejected.every((item) => item.code === "accounting_conflict") ? 409
          : rejected.every((item) => item.code !== "ingest_error") ? 400 : 500;
        res.status(status).json({ error: first.error, code: first.code, rejected });
        return;
      }
      res.status(202).json({ accepted: acceptedCount, ...(rejected.length > 0 ? { rejected } : {}) });
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

      const body = (req.body ?? {}) as { functions?: Record<string, unknown>; sdkVersion?: unknown; sdk_version?: unknown };
      const functions = body.functions;
      if (!functions || typeof functions !== "object" || Array.isArray(functions)) {
        res.status(400).json({ error: "Invalid payload: missing functions object" });
        return;
      }
      // Python sends `sdkVersion`; accept the snake_case spelling too.
      const versionValue = body.sdkVersion ?? body.sdk_version;
      const sdkVersion = typeof versionValue === "string" ? versionValue.slice(0, 40) : null;
      // SDK 0.7 uploads the raw graph and the server scores it; older SDKs
      // upload scores, kept as sent.
      const graph = callGraphFromUpload(functions);

      // Upsert into call_graphs table
      await pool.query(
        `INSERT INTO call_graphs (project_id, graph_data, sdk_version)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id) DO UPDATE SET
           graph_data = EXCLUDED.graph_data,
           sdk_version = EXCLUDED.sdk_version,
           uploaded_at = NOW()`,
        [projectId, JSON.stringify(graph), sdkVersion],
      );

      // Update in-memory cache
      callGraphCache.set(projectId, graph);

      res.status(200).json({ accepted: Object.keys(graph).length });
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

/** An OpenAI Agents SDK trace export captured as if it were a model call. */
export function isAgentsTraceExport(event: Record<string, unknown> | null | undefined): boolean {
  if (!event || typeof event !== "object") return false;
  const telemetry = event["telemetry"] as Record<string, unknown> | undefined;
  const request = telemetry && typeof telemetry === "object" ? telemetry["request"] as Record<string, unknown> | undefined : undefined;
  const candidates = [request?.["url"], event["url"]];
  return candidates.some((value) => {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return url.hostname === "api.openai.com" && url.pathname.startsWith("/v1/traces/");
    } catch {
      return false;
    }
  });
}

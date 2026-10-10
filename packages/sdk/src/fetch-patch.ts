import type {
  CostKeyEvent,
  NormalizedUsage,
  StreamTiming,
  BeforeSendHook,
  EventContext,
} from "./types.js";
import { Provider } from "./types.js";
import { findExtractor } from "./providers/registry.js";
import { captureCallSite } from "./stack.js";
import { getCurrentContext, importContext } from "./context.js";
import { Transport } from "./transport.js";
import { randomBytes } from "node:crypto";
import type {
  PolicyAdmissionClient,
} from "./policy.js";
import type {
  PolicyAdmissionRequest,
  PolicyAdmissionResult,
  PolicySettlementRequest,
} from "./types.js";
const TRACE_HEADER = "x-costkey-trace-id";
const TRACE_NAME_HEADER = "x-costkey-trace-name";
const CONTEXT_HEADER = "x-costkey-context";

export interface FetchPatchOptions {
  transport: Transport;
  projectId: string;
  captureBody: boolean;
  beforeSend: BeforeSendHook | null;
  defaultContext: EventContext;
  debug: boolean;
  policy?: PolicyAdmissionClient | null;
  captureBodyRef?: { current: boolean };
}

let originalFetch: typeof globalThis.fetch | null = null;
let isPatched = false;
const pendingCaptures = new Set<Promise<void>>();
const pendingPolicySettlements = new Set<Promise<void>>();

/**
 * Monkey-patch globalThis.fetch to intercept AI provider calls.
 * Non-AI calls pass through after a URL hostname check.
 */
export function patchFetch(options: FetchPatchOptions): void {
  if (isPatched) return;
  if (typeof globalThis.fetch !== "function") {
    if (options.debug) {
      console.warn("[costkey] globalThis.fetch not available, skipping patch");
    }
    return;
  }

  originalFetch = globalThis.fetch;
  isPatched = true;

  globalThis.fetch = async function costKeyFetchWrapper(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    // Parse URL from whatever fetch input format we got
    let url: URL;
    try {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      url = new URL(urlStr);
    } catch {
      // Can't parse URL — not our problem, pass through
      return originalFetch!(input, init);
    }

    // Fast path: not an AI provider URL
    const extractor = findExtractor(url);
    if (!extractor) {
      // Non-AI requests pass through untouched. Context propagation is an
      // explicit caller decision via CostKey.exportContext()/headers.
      return originalFetch!(input, init);
    }

    // ── AI call detected ──

    // Capture stack trace BEFORE the async call (otherwise we lose the caller's frames)
    const callSite = captureCallSite();
    const context = { ...options.defaultContext, ...getCurrentContext() };

    // An explicit trusted handoff may arrive as a carrier or the legacy trace
    // headers. Never manufacture a trace from stack frames: concurrent
    // requests through one function must keep independent identities.
    const requestHeaders =
      typeof Request !== "undefined" && input instanceof Request
        ? input.headers
        : undefined;
    const incomingContext = getHeader(init?.headers, CONTEXT_HEADER)
      ?? getHeader(requestHeaders, CONTEXT_HEADER);
    if (incomingContext) {
      const imported = importContext(incomingContext);
      for (const [key, value] of Object.entries(imported)) {
        if (context[key] === undefined) context[key] = value;
      }
    }
    if (!context.traceId) {
      const incomingTraceId = getHeader(init?.headers, TRACE_HEADER)
        ?? getHeader(requestHeaders, TRACE_HEADER);
      if (incomingTraceId) {
        context.traceId = incomingTraceId;
        const incomingName = getHeader(init?.headers, TRACE_NAME_HEADER)
          ?? getHeader(requestHeaders, TRACE_NAME_HEADER);
        if (incomingName) context.traceName = incomingName;
      }
    }

    // Explicit component adapters can mark an overlapping provider request as
    // the manual source of charge. Keep the request behavior intact while
    // avoiding an automatic duplicate event.
    if (["manual", "explicit", "disabled"].includes(String(context.costkeyCapture))) {
      return originalFetch!(
        removeContextHeadersFromRequest(input),
        removeContextHeaders(init),
      );
    }

    const startTime = performance.now();

    // Parse and potentially modify the request body
    let requestBody: unknown = null;
    let modifiedInit = removeContextHeaders(init);
    const forwardedInput = removeContextHeadersFromRequest(input);

    if (init?.body) {
      try {
        requestBody = JSON.parse(init.body as string);

        // Inject stream_options for providers that need it (OpenAI)
        if (extractor.injectStreamOptions) {
          const modified = extractor.injectStreamOptions(requestBody);
          if (modified !== requestBody) {
            modifiedInit = {
              ...modifiedInit,
              body: JSON.stringify(modified),
            };
          }
        }
      } catch {
        // Body isn't JSON or can't be parsed — that's fine
      }
    }

    const isStreaming =
      requestBody != null &&
      typeof requestBody === "object" &&
      (requestBody as Record<string, unknown>)["stream"] === true;

    // A caller may provide a per-attempt identity in the narrow context of a
    // provider call. Otherwise each observed request gets a fresh attempt ID;
    // the SDK never guesses retry/fallback parentage from timing or models.
    const explicitAttemptId =
      typeof context.attemptId === "string" && context.attemptId.trim()
        ? context.attemptId.trim()
        : undefined;
    const attemptId = explicitAttemptId ?? generateId();
    const captureBody = shouldCaptureBody(options);
    let admission: PolicyAdmissionResult | null = null;
    if (options.policy) {
      admission = await options.policy.admit({
        projectId: options.projectId,
        admissionId: attemptId,
        requestId: attemptId,
        provider: String(extractor.provider),
        model: extractor.extractModel(requestBody, null),
        traceId: context.traceId,
        executionId: context.executionId,
        context: policyContext(context),
      });
    }

    // Make the actual fetch call
    let response: Response;
    try {
      response = await originalFetch!(forwardedInput, modifiedInit);
    } catch (err) {
      // Fetch itself failed (network error, DNS, etc.)
      // Still try to record the failed call
      const durationMs = performance.now() - startTime;
      const event = buildEvent({
        projectId: options.projectId,
        extractor,
        url,
        method: init?.method ?? "POST",
        statusCode: null,
        requestBody,
        responseBody: null,
        captureBody,
        usage: null,
        model: extractor.extractModel(requestBody, null),
        providerRequestId: null,
        attemptId,
        durationMs,
        streaming: isStreaming,
        streamTiming: null,
        callSite,
        context,
      });
      if (options.policy && admission?.reservationId) {
        trackPolicySettlement(
          settlePolicy(
            options.policy,
            admission,
            options.projectId,
            attemptId,
            "unknown",
            null,
            true,
          ),
        );
      }
      await sendEvent(event, options, captureBody);
      throw err; // Re-throw — we never swallow user-facing errors
    }

    // For non-streaming responses: clone, read body, extract usage
    if (!isStreaming) {
      const pending = processNonStreamingResponse(
        response.clone(),
        {
          startTime,
          url,
          method: init?.method ?? "POST",
          statusCode: response.status,
          requestBody,
          callSite,
          context,
          extractor,
          attemptId,
          admission,
          captureBody,
        },
        options,
      );
      trackPendingCapture(pending);
      return response;
    }

    // For streaming responses: wrap the body to capture timing + final usage
    return processStreamingResponse(response, {
      startTime,
      url,
      method: init?.method ?? "POST",
      requestBody,
      callSite,
      context,
      extractor,
      attemptId,
      admission,
      captureBody,
      options,
    });
  };
}

/** Restore the original fetch. Used for cleanup/testing. */
export function unpatchFetch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
    isPatched = false;
  }
}

/** Wait for response-clone processing already started by fetch(). */
export async function flushPendingCaptures(): Promise<void> {
  const pending = [...pendingCaptures];
  if (pending.length === 0) return;
  const all = Promise.allSettled(pending);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      all,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve();
        }, 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (timedOut) {
    for (const promise of pending) pendingCaptures.delete(promise);
  }
}

/** Wait for policy reservations settled by completed provider calls. */
export async function flushPendingPolicy(): Promise<void> {
  const pending = [...pendingPolicySettlements];
  if (pending.length === 0) return;
  const all = Promise.allSettled(pending);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      all,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve();
        }, 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (timedOut) {
    for (const promise of pending) pendingPolicySettlements.delete(promise);
  }
}

function trackPendingCapture(pending: Promise<void>): void {
  pendingCaptures.add(pending);
  void pending.finally(() => pendingCaptures.delete(pending));
}

// ── Non-streaming response processing ──

interface ResponseMeta {
  startTime: number;
  url: URL;
  method: string;
  statusCode: number;
  requestBody: unknown;
  callSite: ReturnType<typeof captureCallSite>;
  context: EventContext;
  extractor: ReturnType<typeof findExtractor> & {};
  attemptId: string;
  admission: PolicyAdmissionResult | null;
  captureBody: boolean;
}

async function processNonStreamingResponse(
  clonedResponse: Response,
  meta: ResponseMeta,
  options: FetchPatchOptions,
): Promise<void> {
  try {
    const durationMs = performance.now() - meta.startTime;
    let responseBody: unknown = null;

    try {
      responseBody = await clonedResponse.json();
    } catch {
      // Response isn't JSON — still record the call, just without usage
    }

    const usage = responseBody
      ? meta.extractor.extractUsage(responseBody)
      : null;
    const model = meta.extractor.extractModel(meta.requestBody, responseBody);

    const event = buildEvent({
      projectId: options.projectId,
      extractor: meta.extractor,
      url: meta.url,
      method: meta.method,
      statusCode: meta.statusCode,
      requestBody: meta.requestBody,
      responseBody,
      captureBody: meta.captureBody,
      providerRequestId: extractProviderRequestId(responseBody),
      attemptId: meta.attemptId,
      usage,
      model,
      durationMs,
      streaming: false,
      streamTiming: null,
      callSite: meta.callSite,
      context: meta.context,
    });

    if (options.policy && meta.admission?.reservationId) {
      await settlePolicy(
        options.policy,
        meta.admission,
        options.projectId,
        meta.attemptId,
        meta.statusCode >= 200 && meta.statusCode < 300
          ? "success"
          : "unknown",
        usage,
        true,
      );
    }
    await sendEvent(event, options, meta.captureBody);
  } catch {
    if (options.policy && meta.admission?.reservationId) {
      trackPolicySettlement(
        settlePolicy(
          options.policy,
          meta.admission,
          options.projectId,
          meta.attemptId,
          "unknown",
          null,
          true,
        ),
      );
    }
    // Never crash user's app. Silently fail.
  }
}

function trackPolicySettlement(pending: Promise<void>): void {
  pendingPolicySettlements.add(pending);
  void pending.finally(() => pendingPolicySettlements.delete(pending));
}

async function settlePolicy(
  policy: PolicyAdmissionClient,
  admission: PolicyAdmissionResult,
  projectId: string,
  admissionId: string,
  outcome: PolicySettlementRequest["outcome"],
  usage: NormalizedUsage | null,
  providerAttempted: boolean,
): Promise<void> {
  if (!admission.reservationId) return;
  const actualUsage = usage ? compactUsage(usage) : undefined;
  const request: PolicySettlementRequest = {
    projectId,
    reservationId: admission.reservationId,
    settlementId: `${admissionId}:settlement`,
    outcome,
    actualCostUsd: usage?.costUsd ?? null,
    actualUsage,
    providerAttempted,
  };
  try {
    await policy.settle(request);
  } catch {
    // Settlement is best effort after the provider result. A missing or
    // ambiguous amount must not turn a successful application call into an
    // SDK exception; ask the server to retain the reservation for reconciliation.
    if (outcome !== "unknown") {
      try {
        await policy.settle({ ...request, outcome: "unknown" });
      } catch {
        // Policy settlement remains durably unknown until a later retry.
      }
    }
  }
}

function compactUsage(usage: NormalizedUsage): Record<string, number | null> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

function policyContext(context: EventContext): EventContext {
  const safe: EventContext = {};
  for (const key of POLICY_CONTEXT_KEYS) {
    const value = context[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

const POLICY_CONTEXT_KEYS: Array<keyof EventContext> = [
  "traceId",
  "traceName",
  "groupId",
  "groupName",
  "groupKind",
  "executionId",
  "feature",
  "customer",
  "customerId",
  "environment",
  "service",
  "release",
  "function",
  "operation",
  "phase",
  "caseId",
  "datasetRevision",
  "conversationId",
  "voiceSessionId",
];

// ── Streaming response processing ──

interface StreamMeta {
  startTime: number;
  url: URL;
  method: string;
  requestBody: unknown;
  callSite: ReturnType<typeof captureCallSite>;
  context: EventContext;
  extractor: ReturnType<typeof findExtractor> & {};
  attemptId: string;
  admission: PolicyAdmissionResult | null;
  captureBody: boolean;
  options: FetchPatchOptions;
}

function processStreamingResponse(
  response: Response,
  meta: StreamMeta,
): Response {
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let streamFinished = false;
  let resolveStream!: () => void;
  const streamCompletion = new Promise<void>((resolve) => {
    resolveStream = resolve;
  });
  trackPendingCapture(streamCompletion);
  const finishStream = (): void => {
    if (streamFinished) return;
    streamFinished = true;
    resolveStream();
  };

  let firstChunkTime: number | null = null;
  let chunkCount = 0;
  let accumulatedText = "";
  let lastUsage: NormalizedUsage | null = null;

  const wrappedStream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();

          // Stream complete — build and send event
          const endTime = performance.now();
          const durationMs = endTime - meta.startTime;

          // Try to parse accumulated SSE data for usage (from the final chunks)
          if (!lastUsage) {
            lastUsage = extractUsageFromSSE(accumulatedText, meta.extractor);
          }

          const streamTiming: StreamTiming = {
            ttft: firstChunkTime
              ? firstChunkTime - meta.startTime
              : null,
            tps:
              lastUsage?.outputTokens && firstChunkTime
                ? lastUsage.outputTokens /
                  ((endTime - firstChunkTime) / 1000)
                : null,
            streamDuration: durationMs,
            chunkCount,
          };

          const model = extractModelFromSSE(
            accumulatedText,
            meta.requestBody,
            meta.extractor,
          );

          const event = buildEvent({
            projectId: meta.options.projectId,
            extractor: meta.extractor,
            url: meta.url,
            method: meta.method,
            statusCode: response.status,
            requestBody: meta.requestBody,
            responseBody: null, // Don't capture full stream body
            captureBody: meta.captureBody,
            providerRequestId: extractProviderRequestIdFromSSE(accumulatedText),
            attemptId: meta.attemptId,
            usage: lastUsage,
            model,
            durationMs,
            streaming: true,
            streamTiming,
            callSite: meta.callSite,
            context: meta.context,
          });

          if (meta.options.policy && meta.admission?.reservationId) {
            trackPolicySettlement(
              settlePolicy(
                meta.options.policy,
                meta.admission,
                meta.options.projectId,
                meta.attemptId,
                response.status >= 200 && response.status < 300
                  ? "success"
                  : "unknown",
                lastUsage,
                true,
              ),
            );
          }
          await sendEvent(event, meta.options, meta.captureBody);
          finishStream();
          return;
        }

        // Pass chunk through immediately — zero buffering delay for user
        controller.enqueue(value);

        chunkCount++;
        if (firstChunkTime === null) {
          firstChunkTime = performance.now();
        }

        // Accumulate text for SSE parsing (usage extraction)
        accumulatedText += decoder.decode(value, { stream: true });
      } catch (err) {
        if (meta.options.policy && meta.admission?.reservationId) {
          trackPolicySettlement(
            settlePolicy(
              meta.options.policy,
              meta.admission,
              meta.options.projectId,
              meta.attemptId,
              "unknown",
              null,
              true,
            ),
          );
        }
        finishStream();
        controller.error(err);
      }
    },

    cancel() {
      void reader.cancel().finally(finishStream);
    },
  });

  // Return a new Response with our wrapped stream but same headers/status
  return new Response(wrappedStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Try to extract usage from accumulated SSE text (looks for the last data: line with usage) */
function extractUsageFromSSE(
  sseText: string,
  extractor: ReturnType<typeof findExtractor> & {},
): NormalizedUsage | null {
  const lines = sseText.split("\n");
  // Scan from the end — usage is in the final chunks
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data);
      const usage = extractor.extractUsage(parsed);
      if (usage) return usage;
    } catch {
      // Not valid JSON, skip
    }
  }
  return null;
}

/** Try to extract model name from accumulated SSE text */
function extractModelFromSSE(
  sseText: string,
  requestBody: unknown,
  extractor: ReturnType<typeof findExtractor> & {},
): string | null {
  const lines = sseText.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data);
      const model = extractor.extractModel(requestBody, parsed);
      if (model) return model;
    } catch {
      continue;
    }
  }
  return null;
}

function extractProviderRequestIdFromSSE(sseText: string): string | null {
  const lines = sseText.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    try {
      const id = extractProviderRequestId(JSON.parse(data));
      if (id) return id;
    } catch {
      // Ignore incomplete/non-JSON SSE chunks.
    }
  }
  return null;
}

// ── Event building ──

interface BuildEventParams {
  projectId: string;
  extractor: ReturnType<typeof findExtractor> & {};
  url: URL;
  method: string;
  statusCode: number | null;
  requestBody: unknown;
  responseBody: unknown;
  /** Whether body-bearing metadata/content is allowed onto telemetry. */
  captureBody: boolean;
  providerRequestId?: string | null;
  attemptId?: string;
  usage: NormalizedUsage | null;
  model: string | null;
  durationMs: number;
  streaming: boolean;
  streamTiming: StreamTiming | null;
  callSite: ReturnType<typeof captureCallSite>;
  context: EventContext;
}

function shouldCaptureBody(options: FetchPatchOptions): boolean {
  return options.captureBodyRef?.current ?? options.captureBody;
}

function buildEvent(params: BuildEventParams): CostKeyEvent {
  const systemPrompt = params.captureBody ? extractSystemPrompt(params.requestBody) : null;
  const eventId = params.attemptId ?? generateId();
  const providerRequestId =
    params.providerRequestId ?? extractProviderRequestId(params.responseBody);
  const requestModel = params.extractor.extractModel(params.requestBody, null);
  return {
    id: eventId,
    eventType: "call",
    source: "auto",
    timestamp: new Date().toISOString(),
    projectId: params.projectId,
    provider: params.extractor.provider,
    model: params.model,
    url: sanitizeTelemetryUrl(params.url),
    method: params.method,
    statusCode: params.statusCode,
    usage: params.usage,
    // Routers can return the exact billed amount, including image/request fees.
    // The server validates and prefers this over its static fallback table.
    costUsd: params.usage?.costUsd ?? null,
    durationMs: Math.round(params.durationMs * 100) / 100,
    streaming: params.streaming,
    streamTiming: params.streamTiming,
    callSite: params.callSite,
    context: params.context,
    requestModel: requestModel !== params.model ? requestModel : null,
    attemptId: eventId,
    parentEventId:
      typeof params.context.parentEventId === "string" && params.context.parentEventId.trim()
        ? params.context.parentEventId.trim()
        : null,
    providerRequestId,
    chargeId: providerRequestId,
    groupId: typeof params.context.groupId === "string" ? params.context.groupId : null,
    groupName: typeof params.context.groupName === "string" ? params.context.groupName : null,
    groupKind: typeof params.context.groupKind === "string" ? params.context.groupKind : null,
    executionId: typeof params.context.executionId === "string" ? params.context.executionId : null,
    phase: typeof params.context.phase === "string" ? params.context.phase : null,
    datasetRevision: typeof params.context.datasetRevision === "string" ? params.context.datasetRevision : null,
    caseId: typeof params.context.caseId === "string" ? params.context.caseId : null,
    metadata: params.captureBody
      ? captureBody(extractMetadata(params.requestBody, params.responseBody)) as CostKeyEvent["metadata"]
      : extractSafeMetadata(params.requestBody, params.responseBody),
    systemPrompt: systemPrompt ? (sanitizeCapturedValue(scrubCredentials(systemPrompt)) as string) : null,
    requestBody: params.captureBody && params.requestBody
      ? captureBody(params.requestBody)
      : null,
    responseBody: params.captureBody && params.responseBody
      ? captureBody(params.responseBody)
      : null,
  };
}

/**
 * Keep telemetry bounded before it is put on the wire. Multimodal providers
 * commonly return megabytes of base64 image data; forwarding that data a second
 * time in the CostKey batch can exceed the ingest/proxy limit and abort the
 * connection. Preserve the useful shape and media metadata, never the bytes.
 */
const MAX_CAPTURED_BODY_BYTES = 32 * 1024;
const MAX_CAPTURED_TEXT_CHARS = 16 * 1024;
const BINARY_VALUE_KEYS = new Set([
  "b64_json", "base64", "base64_data", "image_data", "inline_data", "bytes",
]);
const IMAGE_DATA_URI = /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?,/i;

function captureBody(body: unknown): unknown {
  const prepared = sanitizeCapturedValue(scrubCredentials(body));
  const json = JSON.stringify(prepared);
  if (json == null || Buffer.byteLength(json, "utf8") <= MAX_CAPTURED_BODY_BYTES) {
    return prepared;
  }

  const originalBytes = Buffer.byteLength(json, "utf8");
  const source = Buffer.from(json, "utf8");
  let previewBytes = MAX_CAPTURED_BODY_BYTES / 2;
  const envelope = {
    __costkey_truncated__: true,
    original_bytes: originalBytes,
    preview: source.subarray(0, previewBytes).toString("utf8"),
  };
  while (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_CAPTURED_BODY_BYTES) {
    previewBytes = Math.floor(previewBytes / 2);
    envelope.preview = source.subarray(0, previewBytes).toString("utf8");
  }
  return envelope;
}

function sanitizeCapturedValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    const image = value.match(IMAGE_DATA_URI);
    if (image) {
      const comma = value.indexOf(",");
      const encodedBytes = Math.max(0, value.length - comma - 1);
      const approxBytes = Math.floor(encodedBytes * 3 / 4);
      return `[image data omitted: ${image[1]}; ~${approxBytes} bytes]`;
    }

    if (key && BINARY_VALUE_KEYS.has(key.toLowerCase()) && value.length > 256) {
      return `[binary data omitted: ${value.length} chars]`;
    }

    if (value.length > MAX_CAPTURED_TEXT_CHARS) {
      return `${value.slice(0, MAX_CAPTURED_TEXT_CHARS)}… [truncated from ${value.length} chars]`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCapturedValue(item, key));
  }

  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const mimeType = typeof objectValue["media_type"] === "string"
      ? objectValue["media_type"]
      : typeof objectValue["mimeType"] === "string"
      ? objectValue["mimeType"]
      : typeof objectValue["mime_type"] === "string"
        ? objectValue["mime_type"]
        : null;
    const imagePayload = (mimeType?.toLowerCase().startsWith("image/") ?? false)
      || objectValue["type"] === "image"
      || objectValue["type"] === "input_image"
      || objectValue["type"] === "base64";
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (imagePayload && entryKey.toLowerCase() === "data" && typeof entryValue === "string") {
        const encodedBytes = entryValue.length;
        result[entryKey] = `[image data omitted: ${mimeType ?? "image/*"}; ~${Math.floor(encodedBytes * 3 / 4)} bytes]`;
      } else {
        result[entryKey] = sanitizeCapturedValue(entryValue, entryKey);
      }
    }
    return result;
  }

  return value;
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
  if (!responseBody || typeof responseBody !== "object") return { toolCalls, webSearches, citations };
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
        if (Array.isArray(msg["annotations"])) citations.push(...msg["annotations"]);
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
 * Metadata-only capture must not smuggle prompt/tool content through the
 * metadata side channel. Keep only bounded structural facts that are useful
 * for coverage/debugging; provider/model/usage remain first-class event
 * fields. In particular, do not copy arbitrary role/type values because a
 * malformed provider payload can put user content in those fields too.
 */
function extractSafeMetadata(
  requestBody: unknown,
  responseBody: unknown,
): CostKeyEvent["metadata"] {
  const request = requestBody && typeof requestBody === "object"
    ? requestBody as Record<string, unknown>
    : {};
  const response = responseBody && typeof responseBody === "object"
    ? responseBody as Record<string, unknown>
    : {};
  const summary: Record<string, unknown> = {};

  const messages = Array.isArray(request["messages"]) ? request["messages"] : null;
  if (messages) {
    summary.promptCount = messages.length;
    summary.promptRoles = messages.map((message) => {
      if (!message || typeof message !== "object") return "unknown";
      const role = (message as Record<string, unknown>)["role"];
      return role === "system" || role === "developer" || role === "user"
        || role === "assistant" || role === "tool" || role === "function"
        ? role
        : "unknown";
    });
  } else if (Array.isArray(request["contents"])) {
    summary.promptCount = request["contents"].length;
  } else if (request["input"] !== undefined && request["input"] !== null) {
    summary.promptCount = 1;
  }

  if (Array.isArray(request["tools"])) summary.toolDefinitionCount = request["tools"].length;
  if (Object.prototype.hasOwnProperty.call(request, "tool_choice")
    || Object.prototype.hasOwnProperty.call(request, "toolChoice")) {
    summary.hasToolChoice = true;
  }

  if (Array.isArray(response["choices"])) summary.choiceCount = response["choices"].length;
  if (Array.isArray(response["output"])) summary.outputItemCount = response["output"].length;
  if (Array.isArray(response["content"])) summary.responseContentCount = response["content"].length;
  if (Array.isArray(response["candidates"])) summary.candidateCount = response["candidates"].length;

  return Object.keys(summary).length ? { raw: summary } : null;
}

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
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;

  const direct = textFromContent(obj["system"] ?? obj["system_prompt"] ?? obj["systemPrompt"]);
  if (direct) return direct;

  const systemInstruction = obj["system_instruction"] ?? obj["systemInstruction"];
  if (systemInstruction && typeof systemInstruction === "object") {
    const fromParts = textFromContent((systemInstruction as Record<string, unknown>)["parts"]);
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

async function sendEvent(
  event: CostKeyEvent,
  options: FetchPatchOptions,
  captureBody = shouldCaptureBody(options),
): Promise<void> {
  try {
    let finalEvent: CostKeyEvent | null = event;

    if (options.beforeSend) {
      try {
        finalEvent = await options.beforeSend(event);
      } catch (err) {
        if (options.debug) {
          console.warn("[costkey] beforeSend hook failed; dropping event");
        }
        return; // Drop the event if beforeSend throws
      }
    }

    if (finalEvent && !captureBody) {
      // A user hook may mutate an event after it was built. Re-assert the
      // request-time privacy decision at the final wire boundary so a
      // metadata-only project cannot accidentally send body fields through a
      // legacy hook.
      finalEvent = {
        ...finalEvent,
        requestBody: null,
        responseBody: null,
        systemPrompt: null,
        metadata: options.beforeSend ? null : finalEvent.metadata ?? null,
      };
    }

    if (finalEvent && isPatched) {
      options.transport.enqueue(finalEvent);
    }
  } catch {
    // Never crash. Ever.
  }
}

/**
 * Built-in credential scrubber. Runs automatically on every event.
 * Removes any values that look like API keys, tokens, or secrets
 * from captured request/response bodies.
 */
function scrubCredentials(body: unknown): unknown {
  // Patterns that look like API keys/secrets
  const SECRET_PATTERNS = [
    /^sk-[a-zA-Z0-9]{20,}$/,           // OpenAI keys
    /^sk-ant-[a-zA-Z0-9-]{20,}$/,      // Anthropic keys
    /^AIza[a-zA-Z0-9_-]{30,}$/,        // Google API keys
    /^Bearer\s+.{20,}$/,               // Bearer tokens
    /^xox[bpras]-[a-zA-Z0-9-]{20,}$/,  // Slack tokens
    /^ghp_[a-zA-Z0-9]{30,}$/,          // GitHub tokens
    /^eyJ[a-zA-Z0-9_-]{20,}/,          // JWTs
  ];

  const SECRET_KEYS = new Set([
    "api_key", "apikey", "api-key",
    "secret", "secret_key", "secretkey",
    "token", "access_token", "refresh_token",
    "password", "passwd", "credential",
    "authorization", "auth",
    "private_key", "privatekey",
  ]);

  if (typeof body === "string") {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(body)) return "[REDACTED]";
    }
    return body;
  }
  if (body == null || typeof body !== "object") return body;

  function scrub(obj: unknown): unknown {
    if (obj == null) return obj;
    if (typeof obj === "string") {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(obj)) return "[REDACTED]";
      }
      return obj;
    }
    if (Array.isArray(obj)) return obj.map(scrub);
    if (typeof obj === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (SECRET_KEYS.has(key.toLowerCase())) {
          result[key] = "[REDACTED]";
        } else {
          result[key] = scrub(value);
        }
      }
      return result;
    }
    return obj;
  }

  return scrub(body);
}

/** Generate a random event ID */
function generateId(): string {
  return randomBytes(16).toString("hex");
}

/** Read a stable provider request ID from a response body when available. */
function extractProviderRequestId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const object = body as Record<string, unknown>;
  for (const key of ["id", "request_id", "requestId", "response_id", "responseId"]) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** Strip userinfo, query parameters, and fragments before telemetry leaves the process. */
function sanitizeTelemetryUrl(url: URL): string {
  const safe = new URL(url.toString());
  safe.username = "";
  safe.password = "";
  safe.search = "";
  safe.hash = "";
  return safe.toString();
}

/** Remove CostKey's explicit carrier headers before calling a provider. */
function removeContextHeaders(init: RequestInit | undefined): RequestInit | undefined {
  if (!init?.headers) return init;
  const headers = new Headers(init.headers);
  let changed = false;
  for (const name of [CONTEXT_HEADER, TRACE_HEADER, TRACE_NAME_HEADER]) {
    if (headers.has(name)) {
      headers.delete(name);
      changed = true;
    }
  }
  return changed ? { ...init, headers } : init;
}

function removeContextHeadersFromRequest(
  input: string | URL | Request,
): string | URL | Request {
  if (
    typeof Request === "undefined" ||
    !(input instanceof Request)
  ) {
    return input;
  }
  const headers = new Headers(input.headers);
  let changed = false;
  for (const name of [CONTEXT_HEADER, TRACE_HEADER, TRACE_NAME_HEADER]) {
    if (headers.has(name)) {
      headers.delete(name);
      changed = true;
    }
  }
  if (!changed) return input;
  try {
    return new Request(input, { headers });
  } catch {
    return input;
  }
}

/** Read a header value from various header formats */
function getHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;

  if (headers instanceof Headers) {
    return headers.get(name);
  }

  if (Array.isArray(headers)) {
    const entry = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return entry ? entry[1] : null;
  }

  if (typeof headers === "object") {
    const h = headers as Record<string, string>;
    for (const [k, v] of Object.entries(h)) {
      if (k.toLowerCase() === name.toLowerCase()) return v;
    }
  }

  return null;
}

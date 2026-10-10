import type { EventContext, ExtractorCall, NormalizedUsage, StreamTiming } from "./types.js";
import { bedrockExtractor } from "./providers/bedrock.js";
import { StreamUsage, isCaptureActive, recordObservedCall } from "./fetch-patch.js";
import { captureCallSite } from "./stack.js";
import { getCurrentContext, withContext } from "./context.js";

/**
 * AWS SDK v3 (`@aws-sdk/client-bedrock-runtime`) sends requests through
 * Node's http module, not fetch, so the fetch patch never sees them. This
 * helper adds middleware to a BedrockRuntimeClient instead: Converse and
 * InvokeModel usage is read from the deserialized output (or the
 * x-amzn-bedrock-*-token-count headers), and ConverseStream /
 * InvokeModelWithResponseStream output streams are wrapped so usage is
 * recorded when the caller finishes reading them. No AWS SDK import is
 * needed; the client is duck-typed.
 */

type Handler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
type HandlerContext = Record<string | symbol, unknown>;
type Middleware = (next: Handler, context: HandlerContext) => Handler;

/** Structural subset of an AWS SDK v3 client. */
export interface BedrockClientLike {
  middlewareStack: {
    add(middleware: Middleware, options: Record<string, unknown>): unknown;
  };
}

type Operation = "converse" | "converse-stream" | "invoke" | "invoke-with-response-stream";

interface CallerState {
  callSite: ReturnType<typeof captureCallSite>;
  context: EventContext;
}

const CALLER = Symbol("costkey.bedrock.caller");
const COMMAND_OPERATIONS: Record<string, Operation> = {
  ConverseCommand: "converse",
  ConverseStreamCommand: "converse-stream",
  InvokeModelCommand: "invoke",
  InvokeModelWithResponseStreamCommand: "invoke-with-response-stream",
};
const instrumented = new WeakSet<object>();
const utf8 = new TextDecoder();

/**
 * Record usage for every Converse, ConverseStream, InvokeModel and
 * InvokeModelWithResponseStream call a BedrockRuntimeClient makes. Returns
 * the same client; calling it twice is a no-op.
 */
export function instrumentBedrockClient<T>(client: T): T {
  try {
    if (!client || typeof client !== "object" || instrumented.has(client)) return client;
    const stack = (client as Partial<BedrockClientLike>).middlewareStack;
    if (!stack || typeof stack.add !== "function") return client;
    // Runs synchronously inside client.send(), so the caller's frames are
    // still on the stack.
    stack.add(captureCaller, {
      step: "initialize",
      priority: "high",
      name: "costkeyBedrockCaller",
      override: true,
    });
    // Outside the SDK's deserializer: sees the parsed output and the raw
    // response, once per attempt (retries run in finalizeRequest, above).
    stack.add(recordBedrockCall, {
      step: "deserialize",
      priority: "high",
      name: "costkeyBedrockUsage",
      override: true,
    });
    instrumented.add(client);
  } catch {
    // Instrumentation never breaks the client.
  }
  return client;
}

const captureCaller: Middleware = (next, handlerContext) => (args) => {
  try {
    if (isCaptureActive()) {
      handlerContext[CALLER] = { callSite: captureCallSite(), context: getCurrentContext() } satisfies CallerState;
    }
  } catch {
    // Call-site capture is best effort.
  }
  return next(args);
};

const recordBedrockCall: Middleware = (next, handlerContext) => async (args) => {
  let operation: Operation | null = null;
  let caller: CallerState | undefined;
  try {
    operation = bedrockOperation(args["request"], handlerContext["commandName"]);
    caller = handlerContext[CALLER] as CallerState | undefined;
  } catch {
    operation = null;
  }
  const context = caller?.context ?? getCurrentContext();
  if (!operation || !isCaptureActive() || isManualCapture(context)) return next(args);

  const startTime = performance.now();
  const startedAt = new Date().toISOString();
  let call: ExtractorCall;
  try {
    const input = asRecord(args["input"]);
    call = {
      url: requestUrl(args["request"], input, operation),
      method: "POST",
      requestBody: requestBodyOf(input, operation),
      statusCode: null,
      responseHeaders: null,
    };
  } catch {
    return next(args);
  }
  const report = (
    observed: Pick<ExtractorCall, "statusCode" | "responseHeaders">,
    responseBody: unknown,
    usage: NormalizedUsage | null,
    streamTiming: StreamTiming | null = null,
  ): void => {
    const finalCall = { ...call, ...observed };
    recordObservedCall({
      extractor: bedrockExtractor,
      call: finalCall,
      responseBody,
      usage,
      model: bedrockExtractor.extractModel(call.requestBody, responseBody, finalCall),
      providerRequestId: finalCall.responseHeaders?.get("x-amzn-requestid") ?? null,
      startedAt,
      durationMs: performance.now() - startTime,
      streaming: operation === "converse-stream" || operation === "invoke-with-response-stream",
      streamTiming,
      callSite: caller?.callSite ?? null,
      context,
    });
  };

  let result: Record<string, unknown>;
  try {
    // A client configured with a fetch-based handler must not also be
    // recorded by the fetch patch.
    result = await withContext({ costkeyCapture: "manual" }, () => next(args));
  } catch (error) {
    try {
      report({ statusCode: errorStatus(error), responseHeaders: null }, null, null);
    } catch {
      // Recording never replaces the provider error.
    }
    throw error;
  }

  try {
    const response = asRecord(result["response"]);
    const output = asRecord(result["output"]);
    const observed = {
      statusCode: asNumber(response?.["statusCode"])
        ?? asNumber(asRecord(output?.["$metadata"])?.["httpStatusCode"]),
      responseHeaders: toHeaders(response?.["headers"]),
    };
    const streamKey = operation === "converse-stream" ? "stream"
      : operation === "invoke-with-response-stream" ? "body"
      : null;

    if (streamKey) {
      const source = output?.[streamKey];
      if (output && isAsyncIterable(source)) {
        const streamUsage = new StreamUsage(bedrockExtractor, { ...call, ...observed });
        output[streamKey] = observeStream(source, streamUsage, (firstEventAt, events) => {
          const endTime = performance.now();
          const usage = streamUsage.finish();
          report(observed, null, usage, {
            ttft: firstEventAt != null ? firstEventAt - startTime : null,
            tps: usage?.outputTokens && firstEventAt != null && endTime > firstEventAt
              ? usage.outputTokens / ((endTime - firstEventAt) / 1000)
              : null,
            streamDuration: endTime - startTime,
            chunkCount: events,
          });
        });
      } else {
        report(observed, null, null);
      }
    } else {
      const responseBody = operation === "invoke"
        ? parseJsonBytes(output?.["body"])
        : jsonSafe(withoutMetadata(output));
      const usage = bedrockExtractor.extractUsage(responseBody, { ...call, ...observed });
      report(observed, responseBody, usage);
    }
  } catch {
    // The caller always gets the SDK's result.
  }
  return result;
};

/**
 * Pass every stream event through unchanged; record once when the caller
 * finishes, stops early or the stream fails.
 */
async function* observeStream(
  source: AsyncIterable<unknown>,
  usage: StreamUsage,
  onEnd: (firstEventAt: number | null, events: number) => void,
): AsyncGenerator<unknown, void, undefined> {
  let firstEventAt: number | null = null;
  let events = 0;
  try {
    for await (const event of source) {
      events++;
      firstEventAt ??= performance.now();
      try {
        usage.add(streamEventRecord(event));
      } catch {
        // Skip an event whose payload can't be read.
      }
      yield event;
    }
  } finally {
    try {
      onEnd(firstEventAt, events);
    } catch {
      // Never surface a recording failure to the caller.
    }
  }
}

/**
 * ConverseStream events are `{ metadata: { usage, metrics } }` among others;
 * InvokeModelWithResponseStream events are `{ chunk: { bytes } }` holding the
 * model's own JSON chunk.
 */
function streamEventRecord(event: unknown): unknown {
  const record = asRecord(event);
  const metadata = asRecord(record?.["metadata"]);
  if (metadata) return metadata;
  const chunk = asRecord(record?.["chunk"]);
  if (!chunk) return null;
  const bytes = chunk["bytes"];
  if (bytes instanceof Uint8Array) return JSON.parse(utf8.decode(bytes)) as unknown;
  if (typeof bytes === "string") return JSON.parse(Buffer.from(bytes, "base64").toString("utf8")) as unknown;
  return null;
}

function bedrockOperation(request: unknown, commandName: unknown): Operation | null {
  const path = asRecord(request)?.["path"];
  if (typeof path === "string") {
    const match = path.match(/\/(converse-stream|converse|invoke-with-response-stream|invoke)\/?$/);
    if (match) return match[1] as Operation;
  }
  return typeof commandName === "string" ? COMMAND_OPERATIONS[commandName] ?? null : null;
}

function requestUrl(request: unknown, input: Record<string, unknown> | null, operation: Operation): URL {
  const http = asRecord(request);
  if (http && typeof http["hostname"] === "string" && typeof http["path"] === "string") {
    const protocol = typeof http["protocol"] === "string" && http["protocol"]
      ? http["protocol"].replace(/:?$/, ":")
      : "https:";
    const port = typeof http["port"] === "number" ? `:${http["port"]}` : "";
    try {
      return new URL(`${protocol}//${http["hostname"]}${port}${http["path"]}`);
    } catch {
      // Fall through to a synthetic Bedrock URL.
    }
  }
  const modelId = typeof input?.["modelId"] === "string" ? input["modelId"] : "unknown";
  return new URL(`https://bedrock-runtime.amazonaws.com/model/${encodeURIComponent(modelId)}/${operation}`);
}

/** Converse input is the request; InvokeModel's request is its JSON `body`. */
function requestBodyOf(input: Record<string, unknown> | null, operation: Operation): unknown {
  if (!input) return null;
  if (operation === "converse" || operation === "converse-stream") return jsonSafe(input);
  const body = input["body"];
  const parsed = asRecord(typeof body === "string" ? parseJson(body) : parseJsonBytes(body)) ?? {};
  return typeof input["modelId"] === "string" ? { ...parsed, modelId: input["modelId"] } : parsed;
}

function errorStatus(error: unknown): number | null {
  const record = asRecord(error);
  return asNumber(asRecord(record?.["$metadata"])?.["httpStatusCode"])
    ?? asNumber(asRecord(record?.["$response"])?.["statusCode"]);
}

function toHeaders(value: unknown): Headers | null {
  const record = asRecord(value);
  if (!record) return null;
  const headers = new Headers();
  for (const [name, raw] of Object.entries(record)) {
    if (typeof raw === "string") {
      try {
        headers.set(name, raw);
      } catch {
        // Skip a header value fetch's Headers rejects.
      }
    }
  }
  return headers;
}

function withoutMetadata(output: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!output) return null;
  const { $metadata: _metadata, ...rest } = output;
  return rest;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function parseJsonBytes(value: unknown): unknown {
  return value instanceof Uint8Array ? parseJson(utf8.decode(value)) : null;
}

/**
 * Command input and output can hold raw bytes (images, documents); keep the
 * shape for telemetry but never the bytes.
 */
function jsonSafe(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth > 32) return null;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[binary data omitted: ${value.byteLength} bytes]`;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, depth + 1));
  if (typeof value === "object") {
    if (isAsyncIterable(value)) return null;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === "function") continue;
      result[key] = jsonSafe(entry, depth + 1);
    }
    return result;
  }
  return null;
}

function isManualCapture(context: EventContext): boolean {
  return ["manual", "explicit", "disabled"].includes(String(context.costkeyCapture));
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === "function";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

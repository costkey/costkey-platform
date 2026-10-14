/** Supported AI providers */
export enum Provider {
  OpenAI = "openai",
  Anthropic = "anthropic",
  Google = "google",
  Azure = "azure",
  Groq = "groq",
  xAI = "xai",
  Mistral = "mistral",
  DeepSeek = "deepseek",
  Cohere = "cohere",
  Together = "together",
  Fireworks = "fireworks",
  Perplexity = "perplexity",
  Cerebras = "cerebras",
  OpenRouter = "openrouter",
  Bedrock = "bedrock",
  Unknown = "unknown",
}

/** Normalized usage extracted from any provider's response */
export interface NormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Reasoning/thinking tokens (OpenAI o-series, Anthropic extended thinking) */
  reasoningTokens: number | null;
  /** Cache-related tokens (Anthropic prompt caching) */
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** Provider-reported total cost in USD (for routers such as OpenRouter). */
  costUsd?: number | null;
  /** Image tokens included in outputTokens; absent means the breakdown is unknown. */
  imageOutputTokens?: number | null;
  /** Non-token billing units: characters, audioSeconds, searchQueries, credits... */
  nativeUnits?: Record<string, number> | null;
}

/** Timing data for streaming responses */
export interface StreamTiming {
  /** Time to first byte/token in ms */
  ttft: number | null;
  /** Tokens per second (output) */
  tps: number | null;
  /** Total stream duration in ms */
  streamDuration: number | null;
  /** Number of chunks received */
  chunkCount: number;
}

/** Captured call site from stack trace */
export interface CallSite {
  /** Raw stack trace string */
  raw: string;
  /** Parsed frames (outermost first) */
  frames: StackFrame[];
}

export interface StackFrame {
  functionName: string | null;
  fileName: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  /** The source line of the frame (in-app frames only, when the SDK could read it). */
  contextLine?: string;
  /** Up to 3 source lines before contextLine. */
  preContext?: string[];
  /** Up to 3 source lines after contextLine. */
  postContext?: string[];
}

/** User-provided context via withContext() or manual tags */
export interface EventContext {
  task?: string;
  team?: string;
  /** Auto-generated trace ID for grouping calls within a request/operation */
  traceId?: string;
  /** Human-readable trace name (e.g., route path, job name) */
  traceName?: string;
  [key: string]: string | number | boolean | undefined;
}

/** Provider-normalized prompt/tool/agent details captured from request/response payloads */
export interface EventMetadata {
  prompts?: Array<{ role: string; content: unknown }>;
  toolDefinitions?: unknown[];
  toolChoice?: unknown;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  webSearches?: unknown[];
  citations?: unknown[];
  agent?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

/** The core event that the SDK ships to costkey.dev */
export interface CostKeyEvent {
  /** Unique event ID */
  id: string;
  /** ISO timestamp */
  timestamp: string;
  /** Project identifier from DSN */
  projectId: string;

  /** Provider that served this request */
  provider: Provider;
  /** Model name as returned by the provider */
  model: string | null;
  /** The full request URL */
  url: string;
  /** HTTP method */
  method: string;
  /** HTTP status code of the response */
  statusCode: number | null;

  /** Normalized token usage */
  usage: NormalizedUsage | null;
  /** Estimated cost in USD */
  costUsd: number | null;

  /** Total request duration in ms */
  durationMs: number;
  /** Whether this was a streaming request */
  streaming: boolean;
  /** Streaming timing metrics */
  streamTiming: StreamTiming | null;

  /** Call site captured from stack trace */
  callSite: CallSite | null;
  /** User-provided context */
  context: EventContext;

  /** Normalized provider metadata for prompts, tools, sources, and agent traces */
  metadata?: EventMetadata | null;
  /** Normalized system/developer instruction prompt extracted from the request */
  systemPrompt?: string | null;
  /** Request body (prompt) — captured if captureBody is enabled */
  requestBody: unknown | null;
  /** Response body (completion) — captured if captureBody is enabled */
  responseBody: unknown | null;
  /** Raw call telemetry (SDK 0.7+). When present the server derives the normalized fields from it. */
  telemetry?: CallTelemetry | null;
}

/** Provider extractor interface — one per AI provider */
export interface ProviderExtractor {
  /** Provider identifier */
  provider: Provider;
  /** Check if a URL belongs to this provider */
  match(url: URL): boolean;
  /** Extract normalized usage from the response body */
  extractUsage(body: unknown): NormalizedUsage | null;
  /** Extract the model name from request or response body */
  extractModel(requestBody: unknown, responseBody: unknown): string | null;
  /** Optionally modify request body before sending (e.g., inject stream_options) */
  injectStreamOptions?(requestBody: unknown): unknown;
}

// ── Raw telemetry contract v1 (see packages/shared/RAW_TELEMETRY.md) ──

/** A string replaced by its length in Unicode code points. */
export interface SkeletonString {
  $s: number;
}

/** A subtree cut at depth 12 or by the 64 KB size cap. */
export interface SkeletonTruncated {
  $trunc: true;
}

/** The count of array items dropped after the first 8 (arrays over 32 items). */
export interface SkeletonMore {
  $more: number;
}

/** A binary body (audio, images, octet-stream), by size. */
export interface SkeletonBytes {
  $bytes: number;
}

/** One part of a multipart form body. */
export interface SkeletonMultipartPart {
  name: string;
  /** File parts: the filename as a skeleton string. */
  filename?: SkeletonString | string;
  contentType?: string;
  /** File parts: the size in bytes. */
  bytes?: number;
  /** Text parts: the value, following the string rule with `name` as its key. */
  value?: SkeletonString | string;
}

/** A multipart form body. */
export interface SkeletonMultipart {
  $multipart: SkeletonMultipartPart[];
}

export type SkeletonMarker = SkeletonString | SkeletonTruncated | SkeletonMore | SkeletonBytes | SkeletonMultipart;

/**
 * A body with its content removed: object keys kept, numbers, booleans and
 * null verbatim, strings verbatim only for allowlisted keys.
 */
export type SkeletonValue =
  | null
  | boolean
  | number
  | string
  | SkeletonMarker
  | SkeletonValue[]
  | { [key: string]: SkeletonValue };

export type TelemetryStreamFormat = "sse" | "ndjson" | "json-array" | "aws-eventstream";

export interface TelemetryRequest {
  method: string;
  /** Secrets stripped from the query; the rest of the query is kept. */
  url: string;
  /** Allowlisted request headers, lowercased keys. */
  headers?: Record<string, string>;
  body: SkeletonValue;
  /** Size of the request body as sent. */
  bytes?: number | null;
}

export interface TelemetryResponse {
  status: number | null;
  /** Every response header except the credential denylist, lowercased keys. */
  headers?: Record<string, string>;
  /** Null when the response was streamed. */
  body: SkeletonValue;
  bytes?: number | null;
}

export interface TelemetryStream {
  format: TelemetryStreamFormat;
  /** Every record up to 200; over 200, the first 20 and the last 50. */
  chunks: SkeletonValue[];
  /** The real number of records. */
  chunkCount: number;
  /** ms from request start to the first chunk. */
  firstChunkMs: number | null;
  /** ms from request start to the last chunk. */
  lastChunkMs: number | null;
}

/** A transport failure: never the message. */
export interface TelemetryError {
  /** The raw exception class or JS error name, such as AbortError or CancelledError. */
  name: string;
  code?: string | null;
}

/** Everything an SDK observed about one provider call; the server derives the rest. */
export interface CallTelemetry {
  v: 1;
  /** Set for calls not observed over HTTP, for example "claude-agent-sdk". */
  source?: string | null;
  request: TelemetryRequest | null;
  response: TelemetryResponse | null;
  stream: TelemetryStream | null;
  error: TelemetryError | null;
  startedAt: string;
  durationMs: number | null;
}

/** Hook called before an event is sent — return null to drop the event */
export type BeforeSendHook = (
  event: CostKeyEvent,
) => CostKeyEvent | null | Promise<CostKeyEvent | null>;

/** SDK configuration options */
export interface CostKeyOptions {
  /** DSN in format https://<key>@costkey.dev/<project-id>. Falls back to COSTKEY_DSN env var. Omit both to disable (test mode). */
  dsn?: string;
  /** Capture request/response bodies (default: true; media bytes are omitted and captures are bounded) */
  captureBody?: boolean;
  /** Hook to modify/filter events before sending */
  beforeSend?: BeforeSendHook;
  /** Max events to buffer before flushing (default: 50) */
  maxBatchSize?: number;
  /** Flush interval in ms (default: 5000) */
  flushInterval?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Additional default context applied to all events */
  defaultContext?: EventContext;
  /** Release version — used for sourcemap translation on the server */
  release?: string;
}

/** Batched payload sent to the ingest API */
export interface TransportPayload {
  /** SDK version */
  sdkVersion: string;
  /** Release version (for sourcemap translation); the commit SHA unless set */
  release?: string;
  /** Full commit SHA of the running code, when the SDK can find it */
  commit?: string;
  /** Source repository as an https URL, when the SDK can find it */
  repository?: string;
  /** Events in this batch */
  events: CostKeyEvent[];
}

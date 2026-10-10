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
  ElevenLabs = "elevenlabs",
  Rumik = "rumik",
  Exa = "exa",
  Firecrawl = "firecrawl",
  Typesafe = "typesafe",
  // OpenAI-compatible inference hosts
  DeepInfra = "deepinfra",
  Nvidia = "nvidia",
  SambaNova = "sambanova",
  Novita = "novita",
  Hyperbolic = "hyperbolic",
  Nebius = "nebius",
  Alibaba = "alibaba",
  Moonshot = "moonshot",
  ZAI = "zai",
  MiniMax = "minimax",
  HuggingFace = "huggingface",
  Baseten = "baseten",
  Lambda = "lambda",
  Featherless = "featherless",
  Friendli = "friendli",
  AI21 = "ai21",
  Upstage = "upstage",
  Sarvam = "sarvam",
  Cloudflare = "cloudflare",
  Vercel = "vercel",
  Ollama = "ollama",
  // Speech, embeddings and search
  Deepgram = "deepgram",
  AssemblyAI = "assemblyai",
  Cartesia = "cartesia",
  Voyage = "voyage",
  Jina = "jina",
  Tavily = "tavily",
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
  /**
   * Non-token billable units the server prices from its catalog: `characters`,
   * `audioSeconds`, `searchQueries`, `searchResults`, `groundingRequests`,
   * `mapsGroundingRequests`, `credits`, `pages`, `images`, `requests`.
   * Absent means none were observed, not zero.
   */
  nativeUnits?: Record<string, number>;
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
}

/** User-provided context via withContext() or manual tags */
export interface EventContext {
  task?: string;
  team?: string;
  /** Auto-generated trace ID for grouping calls within a request/operation */
  traceId?: string;
  /** Human-readable trace name (e.g., route path, job name) */
  traceName?: string;
  /** Stable grouped-work identity (batch, experiment, or evaluation suite). */
  groupId?: string;
  groupName?: string;
  /** Group kind supplied by the application (for example `batch`). */
  groupKind?: string;
  /** Fresh invocation identity for grouped work. */
  executionId?: string;
  /** Explicit provider/framework attempt identity for one call or component. */
  attemptId?: string;
  /** Explicit relationship to a known parent attempt/event. */
  parentEventId?: string;
  /** Conversation identity supplied by the application or integration. */
  conversationId?: string;
  /** Voice session identity supplied by the application or integration. */
  voiceSessionId?: string;
  /** The span (agent, step, tool...) the current code runs inside. */
  spanId?: string;
  /** Name of the nearest enclosing agent span; calls inherit it for cost slicing. */
  agent?: string;
  /** Name of the nearest enclosing tool span. */
  tool?: string;
  /** End user the work is done for (first-class attribution). */
  userId?: string;
  [key: string]: string | number | boolean | undefined;
}

/** Values that are safe to carry over an explicit service/queue handoff. */
export type ContextCarrier = Pick<
  EventContext,
  | "traceId"
  | "traceName"
  | "groupId"
  | "groupName"
  | "groupKind"
  | "executionId"
  | "feature"
  | "customer"
  | "customerId"
  | "environment"
  | "service"
  | "release"
  | "function"
  | "operation"
  | "phase"
  | "caseId"
  | "datasetRevision"
  | "conversationId"
  | "voiceSessionId"
  | "spanId"
  | "agent"
  | "tool"
  | "userId"
>;

export type TraceLifecycle = "started" | "completed" | "failed" | "cancelled";

/** What a span represents. Calls inside a span are attributed to it. */
export type SpanKind =
  | "agent"
  | "step"
  | "tool"
  | "workflow"
  | "task"
  | "judge"
  | "retrieval"
  | "handoff"
  | "guardrail"
  | "chain"
  | "custom";

export type SpanStatus = "running" | "ok" | "error" | "cancelled";

export type SpanAttributeValue = string | number | boolean | null;

export interface SpanOptions {
  /** Stable, low-cardinality name: the agent, tool or step name. */
  name: string;
  kind?: SpanKind;
  /** Small searchable attributes (model, step number, tool version...). */
  attributes?: Record<string, SpanAttributeValue>;
  /** Input payload; only sent when body capture is enabled. */
  input?: unknown;
  /** Resume a span started in another process (for example after a pause). */
  spanId?: string;
  /** Explicit parent when it can't be inherited (a resumed child span). */
  parentSpanId?: string;
  /** Additional labels merged into inherited context for calls in this span. */
  context?: EventContext;
}

/** Handle passed to the span callback. */
export interface SpanHandle {
  readonly id: string;
  readonly traceId: string;
  /** Add or update an attribute; sent with the span's end. */
  setAttribute(key: string, value: SpanAttributeValue): void;
  /** Record the span's output; only sent when body capture is enabled. */
  setOutput(value: unknown): void;
}

export interface CostKeySpanEvent {
  id: string;
  timestamp: string;
  projectId: string;
  eventType: "span";
  source: "explicit";
  kind: SpanKind;
  name: string;
  status: SpanStatus;
  traceId: string;
  traceName?: string;
  parentSpanId?: string;
  executionId?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  errorType?: string;
  attributes?: Record<string, unknown>;
  context: EventContext;
}
export type ExecutionLifecycle = TraceLifecycle;

export interface TraceOptions {
  /** Human-readable operation name. */
  name?: string;
  /** Reuse a compatible upstream trace identity when one already exists. */
  traceId?: string;
  /** Additional boundary labels merged into inherited context. */
  context?: EventContext;
}

export interface ExecutionOptions {
  /** Stable group name reused by later invocations. */
  name: string;
  /** Optional explicit stable group name when `name` is a display label. */
  groupName?: string;
  /** Group kind, such as `batch`, `experiment`, or `evaluation`. */
  kind?: string;
  /** Explicit invocation identity supplied by an external runner. */
  executionId?: string;
  /** Optional stable group identifier when a name is not globally unique. */
  groupId?: string;
  /** Expected item count supplied by the runner. */
  expectedItems?: number;
  /** Items the runner completed when this invocation ended or was updated. */
  completedItems?: number;
  /** Items the runner failed when this invocation ended or was updated. */
  failedItems?: number;
  /** Configuration/variant metadata supplied by the runner. */
  configuration?: Record<string, unknown>;
  datasetRevision?: string;
  caseId?: string;
  phase?: string;
  /** Additional boundary labels merged into inherited context. */
  context?: EventContext;
}

interface LifecycleEventBase {
  id: string;
  timestamp: string;
  projectId: string;
  eventType: "lifecycle";
  source: "explicit";
  entityType: "trace" | "execution";
  entityId: string;
  lifecycle: TraceLifecycle;
  /** Per-entity ordering fence; repeated/resumed scopes advance it. */
  sequence: number;
  traceId?: string;
  traceName?: string;
  groupId?: string;
  groupName?: string;
  groupKind?: string;
  executionId?: string;
  phase?: string;
  datasetRevision?: string;
  caseId?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  errorType?: string;
  expectedItems?: number;
  completedItems?: number;
  failedItems?: number;
  configuration?: Record<string, unknown>;
  context: EventContext;
  provider?: Provider | string;
  model?: string | null;
  url?: string;
  method?: string;
  statusCode?: number | null;
  usage?: NormalizedUsage | UsageUnits | null;
  costUsd?: number | null;
  streaming?: boolean;
  streamTiming?: StreamTiming | null;
  callSite?: CallSite | null;
  metadata?: EventMetadata | null;
  systemPrompt?: string | null;
  requestBody?: unknown | null;
  responseBody?: unknown | null;
}

export type CostKeyLifecycleEvent = LifecycleEventBase;

export type UsageAggregation = "delta" | "cumulative";

export interface UsageAmount {
  value: number;
  currency: string;
}

export type UsageUnits = Record<string, number | null>;

export type PolicyMode = "monitor" | "enforce";

export type PolicyRefusalReason =
  | "budget_exhausted"
  | "price_unavailable"
  | "decision_unavailable"
  | "unsupported_integration"
  | "unbounded_request"
  | "missing_context"
  | "idempotency_conflict"
  | (string & {});

export interface PolicyIntegrationProof {
  supported: boolean;
  admissionSupported: boolean;
  capabilityVersion?: string;
  verified: boolean;
}

export interface PolicyUsageBounds {
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
  maxCacheReadTokens?: number | null;
  maxCacheCreationTokens?: number | null;
  maxImageOutputTokens?: number | null;
  maxAudioSeconds?: number | null;
  maxCharacters?: number | null;
  maxImages?: number | null;
}

export interface PolicyAdmissionRequest {
  projectId: string;
  admissionId: string;
  requestId?: string | null;
  provider: string;
  model?: string | null;
  traceId?: string | null;
  executionId?: string | null;
  scope?: Record<string, string>;
  context?: EventContext;
  integration?: PolicyIntegrationProof;
  usageBounds?: PolicyUsageBounds;
  claimedCostUsd?: number | null;
  providerRequest?: unknown;
}

export interface PolicyAdmissionResult {
  decision: "allow" | "refuse";
  replay?: boolean;
  providerCallAllowed?: boolean;
  reservationId?: string | null;
  reservation?: Record<string, unknown> | null;
  policyId?: string;
  policyVersion?: number | null;
  reason?: PolicyRefusalReason;
  message?: string;
  scope?: Record<string, string>;
  allowance?: Record<string, unknown>;
  window?: string;
  retryAt?: string | null;
  policies?: Array<Record<string, unknown>>;
}

export interface PolicySettlementRequest {
  projectId: string;
  reservationId: string;
  settlementId: string;
  outcome: "success" | "failed" | "cancelled" | "unknown";
  actualCostUsd?: number | null;
  actualUsage?: Record<string, number | null>;
  providerAttempted?: boolean;
}

export type PolicyAdmissionHandler = (
  request: PolicyAdmissionRequest,
) => PolicyAdmissionResult | boolean | Promise<PolicyAdmissionResult | boolean>;

export interface PolicyOptions {
  /** Monitor makes no blocking decision; enforce fails closed. */
  mode?: PolicyMode;
  /** Optional custom handler. Without it, the DSN-authenticated endpoint is used. */
  admission?: PolicyAdmissionHandler;
  /** Override the DSN-derived endpoint for a trusted compatible server. */
  endpoint?: string;
  /** Request timeout for admission/settlement calls. */
  timeout?: number;
  integration?: PolicyIntegrationProof;
  scope?: Record<string, string>;
  usageBounds?: PolicyUsageBounds;
  claimedCostUsd?: number | null;
}

export interface RuntimeCaptureConfig {
  projectId: string;
  capture: {
    mode: "metadata" | "text";
    bodyCaptureEnabled: boolean;
    redactionEnabled: boolean;
    bodyRetentionDays?: number;
    metadataRetentionDays?: number;
  };
  providers?: Array<Record<string, unknown>>;
}

export interface RecordUsageEvent {
  /** Caller-supplied stable event/envelope identity. */
  id: string;
  /** Stable component identity, for example `tts:session-42`. */
  componentId?: string;
  /** Migration alias for componentId. */
  component?: string;
  /** Stable billable charge identity used to reconcile auto/manual reports. */
  chargeId?: string;
  /** Provider request identity when an explicit adapter can observe it. */
  providerRequestId?: string;
  /** Logical attempt identity when the provider/framework exposes one. */
  attemptId?: string;
  /** Parent event identity for a manual component attached to an auto call. */
  parentEventId?: string;
  /** Monotonic component revision. */
  revision: number;
  /** Whether usage is an increment or a total snapshot. */
  aggregation: UsageAggregation;
  /** Provider or custom component that produced the usage. */
  provider?: Provider | string;
  model?: string | null;
  /** Native usage units; omission is unknown, not zero. */
  usage?: UsageUnits | NormalizedUsage | null;
  /** Migration alias for usage. */
  nativeUsage?: UsageUnits | NormalizedUsage | null;
  nativeUnits?: UsageUnits | NormalizedUsage | null;
  /** Optional exact billable-unit map for adapters with multiple unit families. */
  billingUnits?: UsageUnits | null;
  /** Reported monetary amount and currency. */
  amount?: UsageAmount | number | null;
  /** Alias accepted for adapters that call the amount a cost. */
  cost?: UsageAmount | number | null;
  /** Convenience alias for a USD-reported amount. */
  costUsd?: number | null;
  /** Currency for scalar amount/costUsd aliases. */
  currency?: string;
  /** Stable pricing/rate identity when amount is not directly reported. */
  pricingId?: string;
  amountKind?: "reported" | "estimated";
  unitKind?: string;
  unitValue?: number;
  unit?: string;
  timestamp?: string | Date;
  context?: EventContext | ContextCarrier;
  traceId?: string;
  executionId?: string;
  metadata?: Record<string, unknown>;
}

export interface CostKeyUsageEvent {
  id: string;
  timestamp: string;
  projectId: string;
  eventType: "usage";
  source: "explicit";
  component?: string;
  componentId: string;
  chargeId: string;
  revision: number;
  aggregation: UsageAggregation;
  provider: Provider | string;
  model: string | null;
  providerRequestId?: string | null;
  attemptId?: string | null;
  parentEventId?: string | null;
  usage: UsageUnits | null;
  nativeUsage: UsageUnits | null;
  billingUnits?: UsageUnits | null;
  amount?: UsageAmount | null;
  costUsd: number | null;
  currency: string;
  pricingId?: string;
  amountKind?: "reported" | "estimated";
  unitKind?: string;
  unitValue?: number;
  unit?: string;
  context: EventContext;
  traceId?: string;
  executionId?: string;
  metadata?: Record<string, unknown>;
  usageEvent: Record<string, unknown>;
  groupId?: string;
  groupName?: string;
  groupKind?: string;
  phase?: string;
  datasetRevision?: string;
  caseId?: string;
  url?: string;
  method?: string;
  statusCode?: number | null;
  durationMs?: number;
  streaming?: boolean;
  streamTiming?: StreamTiming | null;
  callSite?: CallSite | null;
  requestBody?: unknown | null;
  responseBody?: unknown | null;
}

export type CostKeyTelemetryEvent =
  | CostKeyEvent
  | CostKeyLifecycleEvent
  | CostKeyUsageEvent
  | CostKeySpanEvent;

export type BeforeSendEventHook = (
  event: CostKeyLifecycleEvent | CostKeyUsageEvent | CostKeySpanEvent,
) =>
  | CostKeyLifecycleEvent
  | CostKeyUsageEvent
  | CostKeySpanEvent
  | null
  | Promise<CostKeyLifecycleEvent | CostKeyUsageEvent | CostKeySpanEvent | null>;

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
  /** Event discriminator; omitted by older SDK-created call records. */
  eventType?: "call";
  source?: "auto" | "explicit";
  /** Provider request identity when the response exposes one. */
  providerRequestId?: string | null;
  /** Stable charge identity for explicit adapter reconciliation when known. */
  chargeId?: string | null;
  /** Stable attempt identity; generated per observed request unless supplied explicitly. */
  attemptId?: string | null;
  /** Known parent attempt/event for a retry or fallback; never inferred by the SDK. */
  /** The span this call ran inside. */
  spanId?: string | null;
  parentEventId?: string | null;
  entityType?: "trace" | "execution" | null;
  entityId?: string | null;
  lifecycle?: TraceLifecycle | null;
  startedAt?: string | null;
  endedAt?: string | null;
  errorType?: string | null;
  expectedItems?: number | null;
  completedItems?: number | null;
  failedItems?: number | null;
  componentId?: string | null;
  /** Legacy inbound alias; SDK usage records use id as caller identity. */
  callerId?: string | null;
  revision?: number | null;
  aggregation?: UsageAggregation | null;
  nativeUsage?: UsageUnits | null;
  amount?: UsageAmount | null;
  pricingId?: string | null;
  unit?: string | null;
  usageEvent?: Record<string, unknown> | null;
  requestModel?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  groupKind?: string | null;
  executionId?: string | null;
  phase?: string | null;
  configuration?: Record<string, unknown> | null;
  datasetRevision?: string | null;
  caseId?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
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
}

/**
 * Request and response facts beyond the JSON body. Providers that bill by
 * request size (TTS characters, search result counts) or report usage in
 * headers read it from here.
 */
export interface ExtractorCall {
  url: URL;
  method: string;
  /** Parsed JSON request body (or string fields of a FormData body). */
  requestBody: unknown;
  /** HTTP status; null before a response exists. */
  statusCode: number | null;
  /** Response headers; null before a response exists. */
  responseHeaders: Headers | null;
}

/** Provider extractor interface — one per AI provider */
export interface ProviderExtractor {
  /** Provider identifier */
  provider: Provider;
  /** Check if a URL belongs to this provider */
  match(url: URL): boolean;
  /**
   * Extract normalized usage from the response body. The body is null when
   * it was not read (audio/binary responses); `call` is absent for callers
   * that only have a body.
   */
  extractUsage(body: unknown, call?: ExtractorCall): NormalizedUsage | null;
  /** Extract the model name from request or response body */
  extractModel(requestBody: unknown, responseBody: unknown, call?: ExtractorCall): string | null;
  /** Optionally modify request body before sending (e.g., inject stream_options) */
  injectStreamOptions?(requestBody: unknown): unknown;
  /**
   * Return false when the response body must not be read (audio or other
   * binary output). By default JSON and text bodies are read.
   */
  readResponseBody?(call: ExtractorCall): boolean;
  /**
   * Units computed over a whole stream rather than merged chunk by chunk,
   * such as distinct search queries across Gemini chunks.
   */
  extractStreamUnits?(records: unknown[]): Record<string, number> | null;
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
  /** Hook for additive lifecycle and explicit usage records. */
  beforeSendEvent?: BeforeSendEventHook;
  /** Explicit pre-call policy admission; omitted means observation only. */
  policy?: PolicyOptions;
  /** Runtime privacy/provider configuration is fetched asynchronously. */
  configRefreshInterval?: number;
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
  /** Release version (for sourcemap translation) */
  release?: string;
  /** Events in this batch */
  events: CostKeyTelemetryEvent[];
}

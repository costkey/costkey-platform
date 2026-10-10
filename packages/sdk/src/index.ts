import type {
  BeforeSendEventHook,
  BeforeSendHook,
  ContextCarrier,
  CostKeyEvent,
  CostKeyLifecycleEvent,
  CostKeyUsageEvent,
  CostKeySpanEvent,
  EventContext,
  ExecutionOptions,
  NormalizedUsage,
  ProviderExtractor,
  RecordUsageEvent,
  TraceOptions,
  RuntimeCaptureConfig,
  UsageAmount,
  UsageUnits,
} from "./types.js";
import { parseDSN } from "./dsn.js";
import { flushPendingCaptures, flushPendingPolicy, patchFetch, unpatchFetch } from "./fetch-patch.js";
import { Transport } from "./transport.js";
import {
  exportContext,
  exportContextHeaders,
  getCurrentContext,
  getCurrentTraceId,
  importContext,
  resetLifecycleState,
  setLifecycleEmitter,
  setSpanEmitter,
  startExecution,
  startSpan,
  startTrace,
  agent,
  step,
  tool,
  instrumentTools,
  withContext,
  type LifecycleRecord,
  type SpanRecord,
} from "./context.js";
import { registerExtractor, unregisterExtractor } from "./providers/registry.js";
import { Provider as ProviderValue } from "./types.js";
import { randomBytes } from "node:crypto";
import { CostKeyPolicyClient, CostKeyPolicyRefused, type PolicyAdmissionClient } from "./policy.js";
import { recordLiveKitUsage, recordLiveKitSessionUsage } from "./livekit.js";
import { instrumentBedrockClient } from "./bedrock-client.js";

export type {
  BeforeSendEventHook,
  CostKeyOptions,
  EventContext,
  BeforeSendHook,
  ProviderExtractor,
  ExtractorCall,
  ContextCarrier,
  TraceOptions,
  ExecutionOptions,
  RecordUsageEvent,
  UsageAmount,
  UsageUnits,
  CostKeyTelemetryEvent,
  CostKeyLifecycleEvent,
  CostKeyUsageEvent,
  CostKeySpanEvent,
  SpanKind,
  SpanStatus,
  SpanOptions,
  SpanHandle,
  SpanAttributeValue,
  PolicyMode,
  PolicyRefusalReason,
  PolicyIntegrationProof,
  PolicyUsageBounds,
  PolicyAdmissionRequest,
  PolicyAdmissionResult,
  PolicySettlementRequest,
  PolicyAdmissionHandler,
  PolicyOptions,
  RuntimeCaptureConfig,
} from "./types.js";
export { Provider } from "./types.js";
export { CostKeyPolicyClient, CostKeyPolicyRefused } from "./policy.js";
export type { PolicyAdmissionClient } from "./policy.js";
export type {
  CostKeyEvent,
  NormalizedUsage,
  CallSite,
  StreamTiming,
  EventMetadata,
  UsageAggregation,
  TransportPayload,
} from "./types.js";

let transport: Transport | null = null;
let initialized = false;
let projectId: string | null = null;
let defaultContext: EventContext = {};
let additiveBeforeSend: BeforeSendEventHook | null = null;
let policyClient: PolicyAdmissionClient | null = null;
let debugEnabled = false;
let captureBodyRef: { current: boolean } | null = null;
let localCaptureBodyDisabled = false;
let localCaptureBody = true;
let configRefreshTimer: ReturnType<typeof setInterval> | null = null;
let configRequest: Promise<void> | null = null;
let configSyncActive = false;
let configGeneration = 0;
const runtimeExtractors = new Map<string, ProviderExtractor>();

interface UsageLedgerEntry {
  aggregation: RecordUsageEvent["aggregation"];
  componentId: string;
  revisions: Map<number, string>;
  latestCumulativeRevision: number | undefined;
}

const usageLedger = new Map<string, UsageLedgerEntry>();
const usageEnvelopeLedger = new Map<string, string>();
const additivePending = new Set<Promise<void>>();
const MAX_USAGE_CHARGES = 2048;
const MAX_USAGE_REVISIONS_PER_CHARGE = 1024;
const MAX_USAGE_ENVELOPES = 4096;

/**
 * Initialize CostKey. Call this once at app startup.
 */
function init(options: import("./types.js").CostKeyOptions): void {
  if (initialized) {
    if (options.debug) {
      console.warn("[costkey] Already initialized, skipping");
    }
    return;
  }

  const dsnString =
    options.dsn ||
    (typeof process !== "undefined" ? process.env?.["COSTKEY_DSN"] : undefined);

  // Test mode: if no DSN is provided (or explicitly set to empty), silently no-op.
  if (!dsnString) {
    initialized = true;
    return;
  }

  const dsn = parseDSN(dsnString);
  projectId = dsn.projectId;
  defaultContext = { ...(options.defaultContext ?? {}) };
  additiveBeforeSend = options.beforeSendEvent ?? null;
  debugEnabled = options.debug ?? false;
  localCaptureBodyDisabled = options.captureBody === false;
  localCaptureBody = options.captureBody ?? true;
  // Fail closed until the DSN-authenticated runtime configuration is known.
  captureBodyRef = { current: false };
  configSyncActive = true;
  policyClient = options.policy
    ? new CostKeyPolicyClient({
        endpoint:
          options.policy.endpoint ??
          dsn.endpoint.replace(/\/api\/v1\/events\/?$/, "/api/v1/sdk/policy/admit"),
        authKey: dsn.authKey,
        policy: options.policy,
      })
    : null;

  transport = new Transport({
    endpoint: dsn.endpoint,
    authKey: dsn.authKey,
    maxBatchSize: options.maxBatchSize ?? 50,
    flushInterval: options.flushInterval ?? 5000,
    debug: options.debug ?? false,
    release: options.release,
  });

  setLifecycleEmitter((record) => {
    const currentTransport = transport;
    const currentProjectId = projectId;
    if (!currentTransport || !currentProjectId) return;
    const event = buildLifecycleEvent(record, currentProjectId, defaultContext);
    trackAdditiveEvent(event, currentTransport, additiveBeforeSend, options.debug ?? false);
  });
  setSpanEmitter((record) => {
    const currentTransport = transport;
    const currentProjectId = projectId;
    if (!currentTransport || !currentProjectId) return;
    const event = buildSpanEvent(record, currentProjectId, defaultContext, captureBodyRef?.current === true);
    trackAdditiveEvent(event, currentTransport, additiveBeforeSend, options.debug ?? false);
  });

  patchFetch({
    transport,
    projectId: dsn.projectId,
    captureBody: false,
    captureBodyRef,
    beforeSend: options.beforeSend ?? null,
    defaultContext,
    debug: options.debug ?? false,
    policy: policyClient,
  });

  transport.start();
  initialized = true;

  startRuntimeConfigSync(
    dsn.endpoint,
    dsn.authKey,
    dsn.projectId,
    options.configRefreshInterval,
    options.debug ?? false,
  );

  if (options.debug) {
    console.log(`[costkey] Initialized for project ${dsn.projectId}`);
  }
}

function startRuntimeConfigSync(
  eventsEndpoint: string,
  authKey: string,
  project: string,
  refreshInterval: number | undefined,
  debug: boolean,
): void {
  stopRuntimeConfigSync();
  const generation = ++configGeneration;
  const target = eventsEndpoint.replace(/\/api\/v1\/events\/?$/, "")
    + `/api/v1/projects/${encodeURIComponent(project)}/config`;
  void refreshRuntimeConfig(target, authKey, project, debug, generation);

  const interval = Number.isFinite(refreshInterval) && (refreshInterval ?? 0) > 0
    ? refreshInterval as number
    : 60_000;
  configRefreshTimer = setInterval(() => {
    void refreshRuntimeConfig(target, authKey, project, debug, generation);
  }, interval);
  if (typeof configRefreshTimer === "object" && "unref" in configRefreshTimer) {
    configRefreshTimer.unref();
  }
}

function stopRuntimeConfigSync(): void {
  if (configRefreshTimer) {
    clearInterval(configRefreshTimer);
    configRefreshTimer = null;
  }
  configRequest = null;
}

async function refreshRuntimeConfig(
  target: string,
  authKey: string,
  project: string,
  debug: boolean,
  generation: number,
): Promise<void> {
  if (!configSyncActive || generation !== configGeneration || configRequest) return;
  const request = fetchRuntimeConfig(target, authKey, project, debug, generation);
  configRequest = request;
  try {
    await request;
  } finally {
    if (configRequest === request) configRequest = null;
  }
}

async function fetchRuntimeConfig(
  target: string,
  authKey: string,
  project: string,
  debug: boolean,
  generation: number,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  if (typeof timeout === "object" && "unref" in timeout) timeout.unref();
  try {
    const response = await fetch(target, {
      headers: { Authorization: `Bearer ${authKey}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`runtime config HTTP ${response.status}`);
    const config = normalizeRuntimeConfig(await response.json(), project);
    if (!config) throw new Error("runtime config response is invalid");
    if (!configSyncActive || generation !== configGeneration || projectId !== project || !captureBodyRef) return;

    // Remote metadata-only is always stronger than a local true/default. An
    // explicit local false remains the strongest opt-out when remote text is on.
    const remoteAllowsBodies =
      config.capture.mode === "text" && config.capture.bodyCaptureEnabled;
    captureBodyRef.current =
      !localCaptureBodyDisabled && localCaptureBody && remoteAllowsBodies;
    applyRuntimeProviders(config.providers ?? []);
  } catch (error) {
    if (configSyncActive && generation === configGeneration && projectId === project && captureBodyRef) {
      // A missing/revoked config fails closed for payload content but does not
      // block provider execution or discard metadata/usage observations.
      captureBodyRef.current = false;
    }
    if (debug) console.warn("[costkey] runtime capture config unavailable; using metadata-only capture");
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRuntimeConfig(
  value: unknown,
  project: string,
): RuntimeCaptureConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (object["projectId"] !== project) return null;
  const capture = object["capture"];
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) return null;
  const captureObject = capture as Record<string, unknown>;
  if (
    (captureObject["mode"] !== "metadata" && captureObject["mode"] !== "text") ||
    typeof captureObject["bodyCaptureEnabled"] !== "boolean" ||
    typeof captureObject["redactionEnabled"] !== "boolean"
  ) return null;
  const providers = object["providers"];
  return {
    projectId: project,
    capture: {
      mode: captureObject["mode"],
      bodyCaptureEnabled: captureObject["bodyCaptureEnabled"],
      redactionEnabled: captureObject["redactionEnabled"],
      ...(typeof captureObject["bodyRetentionDays"] === "number"
        ? { bodyRetentionDays: captureObject["bodyRetentionDays"] }
        : {}),
      ...(typeof captureObject["metadataRetentionDays"] === "number"
        ? { metadataRetentionDays: captureObject["metadataRetentionDays"] }
        : {}),
    },
    providers: Array.isArray(providers)
      ? providers.filter((provider): provider is Record<string, unknown> =>
          !!provider && typeof provider === "object" && !Array.isArray(provider))
      : [],
  };
}

function applyRuntimeProviders(providers: Array<Record<string, unknown>>): void {
  clearRuntimeProviders();
  for (const provider of providers) {
    const id = runtimeProviderString(provider, "id") ?? runtimeProviderString(provider, "hostname");
    const extractor = createRuntimeExtractor(provider);
    if (!id || !extractor) continue;
    runtimeExtractors.set(id, extractor);
    registerExtractor(extractor);
  }
}

function clearRuntimeProviders(): void {
  for (const extractor of runtimeExtractors.values()) unregisterExtractor(extractor);
  runtimeExtractors.clear();
}

function createRuntimeExtractor(
  provider: Record<string, unknown>,
): ProviderExtractor | null {
  const configuredHostname = runtimeProviderString(provider, "hostname");
  if (!configuredHostname) return null;
  const inputPath = runtimeProviderString(provider, "usageInputPath", "usage_input_path");
  const outputPath = runtimeProviderString(provider, "usageOutputPath", "usage_output_path");
  const modelPath = runtimeProviderString(provider, "modelPath", "model_path");
  const hostname = configuredHostname.toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  return {
    provider: ProviderValue.Unknown,
    match(url: URL): boolean {
      if (hostname.startsWith("*.")) return url.hostname.endsWith(hostname.slice(1));
      return url.hostname === hostname || url.host === hostname;
    },
    extractUsage(body: unknown): NormalizedUsage | null {
      const inputTokens = finiteRuntimeNumber(readRuntimePath(body, inputPath));
      const outputTokens = finiteRuntimeNumber(readRuntimePath(body, outputPath));
      if (inputTokens == null && outputTokens == null) return null;
      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens != null && outputTokens != null
          ? inputTokens + outputTokens
          : null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      };
    },
    extractModel(requestBody: unknown, responseBody: unknown): string | null {
      return runtimeProviderString(readRuntimePath(responseBody, modelPath), "value")
        ?? runtimeProviderString(readRuntimePath(requestBody, modelPath), "value")
        ?? runtimeProviderString(responseBody, "model")
        ?? runtimeProviderString(requestBody, "model");
    },
  };
}

function runtimeProviderString(
  value: unknown,
  ...keys: string[]
): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function readRuntimePath(value: unknown, path: string | null): unknown {
  if (!path) return undefined;
  return path.split(".").filter(Boolean).reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function finiteRuntimeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Alias for init — familiar to MLflow users. */
const autolog = init;

/**
 * Record usage from a provider/framework component that CostKey cannot observe
 * automatically. The caller owns identity and revision; delivery is async.
 */
function recordUsage(input: RecordUsageEvent): Promise<void> {
  const event = normalizeUsageEvent(input, projectId, defaultContext);
  if (!transport || !projectId) return Promise.resolve();
  const shouldSend = acceptUsage(event);
  if (!shouldSend) return Promise.resolve();
  return trackAdditiveEvent(event, transport, additiveBeforeSend, false);
}

/** Flush all pending events and shut down the SDK. */
async function shutdown(): Promise<void> {
  configSyncActive = false;
  configGeneration++;
  stopRuntimeConfigSync();
  setLifecycleEmitter(null);
  setSpanEmitter(null);
  await flushPendingCaptures();
  await flushPendingPolicy();
  const droppedAdditive = await drainAdditiveEvents();
  if (droppedAdditive > 0 && debugEnabled) {
    console.warn(`[costkey] Dropped ${droppedAdditive} additive event(s) after bounded hook wait`);
  }
  if (transport) {
    await transport.flush();
    transport.stop();
    transport = null;
  }
  unpatchFetch();
  projectId = null;
  defaultContext = {};
  additiveBeforeSend = null;
  policyClient = null;
  debugEnabled = false;
  captureBodyRef = null;
  localCaptureBodyDisabled = false;
  localCaptureBody = true;
  clearRuntimeProviders();
  usageLedger.clear();
  usageEnvelopeLedger.clear();
  resetLifecycleState();
  initialized = false;
}

/** Flush all pending events without shutting down. */
async function flush(): Promise<void> {
  await flushPendingCaptures();
  await flushPendingPolicy();
  const droppedAdditive = await drainAdditiveEvents();
  if (droppedAdditive > 0 && debugEnabled) {
    console.warn(`[costkey] Dropped ${droppedAdditive} additive event(s) after bounded hook wait`);
  }
  if (transport) await transport.flush();
}

const MAX_SPAN_PAYLOAD_CHARS = 2_000;

/** Span input/output are content: bounded, and only sent when capture is on. */
function spanPayload(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    return undefined;
  }
  return text.length > MAX_SPAN_PAYLOAD_CHARS ? `${text.slice(0, MAX_SPAN_PAYLOAD_CHARS)}…` : text;
}

function buildSpanEvent(
  record: SpanRecord,
  currentProjectId: string,
  currentDefaultContext: EventContext,
  capture: boolean,
): CostKeySpanEvent {
  const attributes: Record<string, unknown> = { ...record.attributes };
  if (capture) {
    const input = spanPayload(record.input);
    const output = spanPayload(record.output);
    if (input !== undefined) attributes["input"] = input;
    if (output !== undefined) attributes["output"] = output;
  }
  return {
    id: record.id,
    timestamp: record.endedAt ?? record.startedAt,
    projectId: currentProjectId,
    eventType: "span",
    source: "explicit",
    kind: record.kind,
    name: record.name,
    status: record.status,
    traceId: record.traceId,
    ...(record.traceName ? { traceName: record.traceName } : {}),
    ...(record.parentSpanId ? { parentSpanId: record.parentSpanId } : {}),
    ...(record.executionId ? { executionId: record.executionId } : {}),
    startedAt: record.startedAt,
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.errorType ? { errorType: record.errorType } : {}),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    context: { ...currentDefaultContext, ...record.context },
  };
}

function buildLifecycleEvent(
  record: LifecycleRecord,
  currentProjectId: string,
  currentDefaultContext: EventContext,
): CostKeyLifecycleEvent {
  return {
    id: generateId("lc"),
    timestamp: record.endedAt ?? record.startedAt,
    projectId: currentProjectId,
    eventType: "lifecycle",
    source: "explicit",
    entityType: record.entityType,
    entityId: record.entityId,
    lifecycle: record.lifecycle,
    sequence: record.sequence,
    traceId: record.traceId,
    traceName: record.traceName,
    groupId: record.groupId,
    groupName: record.groupName,
    groupKind: record.groupKind,
    executionId: record.executionId,
    phase: typeof record.context.phase === "string" ? record.context.phase : undefined,
    datasetRevision: typeof record.context.datasetRevision === "string" ? record.context.datasetRevision : undefined,
    caseId: typeof record.context.caseId === "string" ? record.context.caseId : undefined,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs ?? 0,
    ...(record.errorType ? { errorType: record.errorType } : {}),
    expectedItems: record.expectedItems,
    completedItems: record.completedItems,
    failedItems: record.failedItems,
    configuration: record.configuration,
    context: { ...currentDefaultContext, ...record.context },
    provider: "unknown",
    model: null,
    url: "",
    method: "POST",
    statusCode: null,
    usage: null,
    costUsd: null,
    streaming: false,
    streamTiming: null,
    callSite: null,
    metadata: null,
    systemPrompt: null,
    requestBody: null,
    responseBody: null,
  };
}

function normalizeUsageEvent(
  input: RecordUsageEvent,
  currentProjectId: string | null,
  currentDefaultContext: EventContext,
): CostKeyUsageEvent {
  if (!input || typeof input !== "object") {
    throw new TypeError("CostKey.recordUsage() requires an event object");
  }
  if (typeof input.id !== "string" || !input.id.trim()) {
    throw new TypeError("CostKey.recordUsage() requires a caller-supplied id");
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new RangeError("CostKey.recordUsage() revision must be a non-negative integer");
  }
  if (input.aggregation !== "delta" && input.aggregation !== "cumulative") {
    throw new TypeError("CostKey.recordUsage() aggregation must be delta or cumulative");
  }
  if (
    input.amountKind !== undefined &&
    input.amountKind !== "reported" &&
    input.amountKind !== "estimated"
  ) {
    throw new TypeError("CostKey.recordUsage() amountKind must be reported or estimated");
  }
  const provider = nonEmpty(input.provider) ?? "unknown";
  if (!provider) throw new TypeError("CostKey.recordUsage() provider is invalid");

  const rawInput = input as RecordUsageEvent & Record<string, unknown>;
  const componentId = nonEmpty(input.componentId) ?? nonEmpty(input.component);
  if (!componentId) {
    throw new TypeError("CostKey.recordUsage() requires componentId");
  }
  const chargeId = nonEmpty(input.chargeId) ?? componentId;
  const usage = normalizeUsageUnits(input.usage ?? input.nativeUsage ?? input.nativeUnits);
  const billingUnits = normalizeUsageUnits(input.billingUnits);
  const amount = normalizeAmount(
    (input.amount ?? input.cost) as UsageAmount | number | null | undefined,
    rawInput,
  );
  const currency = amount?.currency ?? normalizeCurrency(input.currency ?? "USD");
  const context = {
    ...currentDefaultContext,
    ...getCurrentContext(),
    ...(input.context ? importContextForUsage(input.context) : {}),
  };
  if (input.traceId !== undefined) context.traceId = input.traceId;
  if (input.executionId !== undefined) context.executionId = input.executionId;

  const timestamp = normalizeTimestamp(input.timestamp);
  const metadata = normalizeMetadata(input.metadata);
  const usageEvent: Record<string, unknown> = {
    component: componentId,
    componentId,
    chargeId,
    providerRequestId: nonEmpty(input.providerRequestId),
    attemptId: nonEmpty(input.attemptId),
    parentEventId: nonEmpty(input.parentEventId),
    provider,
    model: input.model ?? null,
    unitKind: nonEmpty(input.unitKind) ?? nonEmpty(input.unit),
    unit: nonEmpty(input.unit),
    amount: amount?.value,
    currency,
    aggregation: input.aggregation,
    revision: input.revision,
    pricingId: nonEmpty(input.pricingId),
    ...(billingUnits ? { billingUnits } : {}),
  };
  if (input.unitValue !== undefined) {
    if (
      typeof input.unitValue !== "number" ||
      !Number.isFinite(input.unitValue) ||
      input.unitValue < 0
    ) {
      throw new TypeError("CostKey.recordUsage() unitValue must be a non-negative number");
    }
    usageEvent.unitValue = input.unitValue;
  } else if ((input.unitKind || input.unit) && usage) {
    const numericValues = Object.values(usage).filter(
      (value): value is number => typeof value === "number",
    );
    if (numericValues.length === 1) usageEvent.unitValue = numericValues[0];
  }
  const unitValues = usageEvent["unitValue"];
  return {
    id: input.id,
    timestamp,
    projectId: currentProjectId ?? "",
    eventType: "usage",
    source: "explicit",
    component: componentId,
    componentId,
    chargeId,
    revision: input.revision,
    aggregation: input.aggregation,
    provider,
    model: input.model ?? null,
    providerRequestId: nonEmpty(input.providerRequestId) ?? null,
    attemptId: nonEmpty(input.attemptId) ?? null,
    parentEventId: nonEmpty(input.parentEventId) ?? null,
    usage,
    nativeUsage: usage,
    ...(billingUnits ? { billingUnits } : {}),
    ...(amount ? { amount } : {}),
    costUsd: amount?.currency === "USD" ? amount.value : null,
    currency,
    amountKind: input.amountKind ?? "reported",
    unitKind: nonEmpty(input.unitKind) ?? nonEmpty(input.unit),
    unitValue: typeof unitValues === "number" ? unitValues : undefined,
    pricingId: nonEmpty(input.pricingId),
    unit: nonEmpty(input.unit),
    traceId: context.traceId,
    executionId: context.executionId,
    context,
    metadata,
    usageEvent,
    groupId: typeof context.groupId === "string" ? context.groupId : undefined,
    groupName: typeof context.groupName === "string" ? context.groupName : undefined,
    groupKind: typeof context.groupKind === "string" ? context.groupKind : undefined,
    phase: typeof context.phase === "string" ? context.phase : undefined,
    datasetRevision: typeof context.datasetRevision === "string" ? context.datasetRevision : undefined,
    caseId: typeof context.caseId === "string" ? context.caseId : undefined,
    url: "",
    method: "POST",
    statusCode: null,
    durationMs: 0,
    streaming: false,
    streamTiming: null,
    callSite: null,
    requestBody: null,
    responseBody: null,
  };
}

function acceptUsage(event: CostKeyUsageEvent): boolean {
  const identityHash = stableSerialize({
    componentId: event.componentId,
    chargeId: event.chargeId,
    revision: event.revision,
    aggregation: event.aggregation,
    provider: event.provider,
    model: event.model,
    providerRequestId: event.providerRequestId,
    attemptId: event.attemptId,
    parentEventId: event.parentEventId,
    usage: event.usage,
    billingUnits: event.billingUnits,
    amount: event.amount,
    amountKind: event.amountKind,
    pricingId: event.pricingId,
    unitKind: event.unitKind,
    unitValue: event.unitValue,
    unit: event.unit,
    traceId: event.traceId,
    executionId: event.executionId,
    context: event.context,
    metadata: event.metadata,
  });
  // The caller-supplied id is the envelope identity. Generated timestamps are
  // intentionally excluded so an idempotent retry without an explicit
  // timestamp is not treated as a conflicting revision.
  const { id: _id, timestamp: _timestamp, ...envelopeFields } = event;
  const envelopeHash = stableSerialize(envelopeFields);
  const priorEnvelope = usageEnvelopeLedger.get(event.id);
  if (priorEnvelope !== undefined) {
    if (priorEnvelope !== envelopeHash) {
      throw new UsageConflictError(`usage event id ${event.id} was reused with different data`);
    }
    return false;
  }

  const entry = usageLedger.get(event.chargeId) ?? {
    aggregation: event.aggregation,
    componentId: event.componentId,
    revisions: new Map<number, string>(),
    latestCumulativeRevision: undefined,
  };
  if (entry.aggregation !== event.aggregation) {
    throw new UsageConflictError(`charge ${event.chargeId} cannot switch aggregation mode`);
  }
  if (entry.componentId !== event.componentId) {
    throw new UsageConflictError(`charge ${event.chargeId} changed component identity`);
  }

  const priorRevision = entry.revisions.get(event.revision);
  if (priorRevision !== undefined) {
    if (priorRevision !== identityHash) {
      throw new UsageConflictError(
        `charge ${event.chargeId} revision ${event.revision} was reused with different data`,
      );
    }
    usageEnvelopeLedger.set(event.id, envelopeHash);
    return false;
  }

  if (
    event.aggregation === "cumulative" &&
    entry.latestCumulativeRevision !== undefined &&
    event.revision < entry.latestCumulativeRevision
  ) {
    // The server applies the same latest-revision fence. Remember this envelope
    // so a duplicate stale update is still idempotent within this process.
    usageEnvelopeLedger.set(event.id, envelopeHash);
    entry.revisions.set(event.revision, identityHash);
    usageLedger.set(event.chargeId, entry);
    trimUsageLedger(event.chargeId);
    return false;
  }

  entry.revisions.set(event.revision, identityHash);
  if (event.aggregation === "cumulative") {
    entry.latestCumulativeRevision = Math.max(
      entry.latestCumulativeRevision ?? event.revision,
      event.revision,
    );
  }
  usageLedger.set(event.chargeId, entry);
  usageEnvelopeLedger.set(event.id, envelopeHash);
  trimUsageLedger(event.chargeId);
  return true;
}

function trimUsageLedger(currentChargeId: string): void {
  const current = usageLedger.get(currentChargeId);
  if (current && current.revisions.size > MAX_USAGE_REVISIONS_PER_CHARGE) {
    const oldest = current.revisions.keys().next().value as number | undefined;
    if (oldest !== undefined) current.revisions.delete(oldest);
  }
  while (usageLedger.size > MAX_USAGE_CHARGES) {
    const oldest = usageLedger.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    usageLedger.delete(oldest);
  }
  while (usageEnvelopeLedger.size > MAX_USAGE_ENVELOPES) {
    const oldest = usageEnvelopeLedger.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    usageEnvelopeLedger.delete(oldest);
  }
}

async function sendAdditiveEvent(
  event: CostKeyLifecycleEvent | CostKeyUsageEvent | CostKeySpanEvent,
  currentTransport: Transport,
  hook: BeforeSendEventHook | null,
  debug: boolean,
): Promise<void> {
  try {
    let finalEvent: CostKeyLifecycleEvent | CostKeyUsageEvent | CostKeySpanEvent | null = event;
    if (hook) {
      try {
        finalEvent = await hook(event);
      } catch {
        if (debug) console.warn("[costkey] beforeSendEvent hook failed; dropping event");
        return;
      }
    }
    if (finalEvent && transport === currentTransport) currentTransport.enqueue(finalEvent);
  } catch {
    if (debug) console.warn("[costkey] failed to enqueue event; dropping event");
  }
}

function trackAdditiveEvent(
  event: CostKeyLifecycleEvent | CostKeyUsageEvent | CostKeySpanEvent,
  currentTransport: Transport,
  hook: BeforeSendEventHook | null,
  debug: boolean,
): Promise<void> {
  const pending = sendAdditiveEvent(event, currentTransport, hook, debug);
  additivePending.add(pending);
  void pending.finally(() => additivePending.delete(pending));
  return pending;
}

async function drainAdditiveEvents(): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (additivePending.size > 0) {
    const pending = [...additivePending];
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return dropPendingAdditive(pending);
    }
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
          }, remaining);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (timedOut) {
      return dropPendingAdditive(pending);
    }
  }
  return 0;
}

function dropPendingAdditive(pending: readonly Promise<void>[]): number {
  let dropped = 0;
  for (const promise of pending) {
    if (additivePending.delete(promise)) dropped++;
  }
  return dropped;
}

function normalizeUsageUnits(value: unknown): UsageUnits | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("CostKey.recordUsage() usage must be an object");
  }
  const result: UsageUnits = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (candidate === null) {
      result[key] = null;
      continue;
    }
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
      throw new TypeError(`CostKey.recordUsage() usage.${key} must be a non-negative number or null`);
    }
    result[key] = candidate;
  }
  return result;
}

function normalizeAmount(
  value: UsageAmount | number | null | undefined,
  aliases: Record<string, unknown>,
): UsageAmount | null {
  let candidate: unknown = value;
  if (candidate == null && typeof aliases["costUsd"] === "number") {
    candidate = { value: aliases["costUsd"], currency: aliases["currency"] ?? "USD" };
  }
  if (candidate == null) return null;
  if (typeof candidate === "number") {
    candidate = { value: candidate, currency: aliases["currency"] ?? "USD" };
  }
  if (typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("CostKey.recordUsage() amount must include value and currency");
  }
  const object = candidate as Record<string, unknown>;
  const amount = object["value"] ?? object["amount"];
  const currency = object["currency"];
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new TypeError("CostKey.recordUsage() amount.value must be a non-negative number");
  }
  if (typeof currency !== "string" || !currency.trim()) {
    throw new TypeError("CostKey.recordUsage() amount.currency is required");
  }
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{2,9}$/.test(normalizedCurrency)) {
    throw new TypeError("CostKey.recordUsage() amount.currency must be an ISO-like code");
  }
  return { value: amount, currency: normalizedCurrency };
}

function normalizeCurrency(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("CostKey.recordUsage() currency is required");
  }
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{2,9}$/.test(currency)) {
    throw new TypeError("CostKey.recordUsage() currency must be an ISO-like code");
  }
  return currency;
}

function normalizeTimestamp(timestamp: string | Date | undefined): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError("CostKey.recordUsage() timestamp is invalid");
  return date.toISOString();
}

function normalizeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("CostKey.recordUsage() metadata must be an object");
  }
  try {
    const safe = JSON.parse(JSON.stringify(value)) as unknown;
    return safe && typeof safe === "object" && !Array.isArray(safe)
      ? safe as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function importContextForUsage(input: EventContext | ContextCarrier): EventContext {
  return importContext(input);
}

function stableSerialize(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (ancestors.has(value)) return '"[Circular]"';
  ancestors.add(value);
  if (Array.isArray(value)) {
    const serialized = `[${value.map((item) => stableSerialize(item, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return serialized;
  }
  const object = value as Record<string, unknown>;
  const serialized = `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(object[key], ancestors)}`)
    .join(",")}}`;
  ancestors.delete(value);
  return serialized;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export class UsageConflictError extends Error {
  readonly name = "UsageConflictError";
}

export const CostKey = {
  init,
  autolog,
  shutdown,
  flush,
  withContext,
  startTrace,
  startExecution,
  startSpan,
  agent,
  step,
  tool,
  instrumentTools,
  recordUsage,
  exportContext,
  exportContextHeaders,
  getCurrentContext,
  getCurrentTraceId,
  registerExtractor,
  recordLiveKitUsage,
  recordLiveKitSessionUsage,
  instrumentBedrockClient,
} as const;

export default CostKey;

export { recordLiveKitUsage, recordLiveKitSessionUsage } from "./livekit.js";
export { instrumentBedrockClient } from "./bedrock-client.js";
export type { BedrockClientLike } from "./bedrock-client.js";
export type {
  LiveKitModelUsage,
  LiveKitSessionUsageUpdatedEvent,
  LiveKitUsageOptions,
  LiveKitUsageComponent,
} from "./livekit.js";
